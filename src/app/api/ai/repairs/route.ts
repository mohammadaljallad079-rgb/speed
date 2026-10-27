import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { ReportingDb } from "@/lib/reporting/data";
import { loadTemplates, saveTemplate, type SettingsDb } from "@/lib/reporting/templates";
import type { TemplateDb } from "@/lib/templates/document-template-store";
import {
  allowedRepairActions,
  getRepairAction,
  isDocumentTemplateRequest,
  selectDocumentTemplateActions,
  selectRepairActions,
} from "@/lib/ai/repair-catalog";
import { createResilientRepairStore, createSupabaseRepairStore, type SupabaseClientLike } from "@/lib/ai/repair-store";
import { createSupabaseFinancePort } from "@/lib/ai/finance-port";
import { loadTenantPlan } from "@/lib/saas/tenant-plan";
import { planAllowsEffect } from "@/lib/saas/entitlements";
import { DOCUMENT_KINDS, DOCUMENT_LABELS } from "@/lib/templates/document-templates";
import {
  createMemoryIdempotency,
  executeRepair,
  proposeRepair,
  type RepairDeps,
  type RepairProposal,
} from "@/lib/ai/repair-workflow";

/**
 * Safe AI repair endpoint (Execution 21, Phase R1).
 *
 * POST ?op=catalog  → the actions the caller may run.
 * POST ?op=propose  → diagnosis + candidate actions + a deterministic preview.
 * POST ?op=execute  → executes an approved proposal through the server only.
 *
 * Identity, tenant and permissions always come from the session via
 * `requireContext`; nothing is taken from the body. Execution re-checks the
 * permission, the approval and the plan fingerprint. Every step is audited.
 * The only persisted effect is a tenant-scoped report-format template.
 */

export const dynamic = "force-dynamic";

// Best-effort, per-process idempotency used only when no durable store is
// available. The durable store (`ai_repair_executions`, migration 006) is the
// source of truth for cross-request/restart safety; the audit trail remains the
// authoritative record of what ran.
const idempotency = createMemoryIdempotency();
const repairStore = createResilientRepairStore(
  createSupabaseRepairStore(supabaseAdmin as unknown as SupabaseClientLike),
);

function buildDeps(context: { tenantId: string | null }): RepairDeps {
  return {
    db: supabaseAdmin as unknown as ReportingDb,
    tenantId: context.tenantId,
    loadTemplates: (tenantId) => loadTemplates(supabaseAdmin as unknown as SettingsDb, tenantId),
    saveTemplate: (tenantId, template) => saveTemplate(supabaseAdmin as unknown as SettingsDb, tenantId, template),
    templates: supabaseAdmin as unknown as TemplateDb,
    // Financial writes go through the same services the HTTP routes use.
    finance: createSupabaseFinancePort(supabaseAdmin as never),
  };
}

/**
 * The tenant's package, read server-side from the session tenant. A super admin
 * is the platform operator and is never gated by a company package.
 */
async function resolvePlan(context: { tenantId: string | null; isSuperAdmin?: boolean }): Promise<string> {
  if (context.isSuperAdmin) return "enterprise";
  return loadTenantPlan(supabaseAdmin as never, context.tenantId);
}

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "reports", action: "view" });
    const url = new URL(request.url);
    const op = url.searchParams.get("op") ?? "catalog";
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    if (op === "catalog") {
      const plan = await resolvePlan(context);
      return NextResponse.json({
        success: true,
        plan,
        documentKinds: DOCUMENT_KINDS.map((k) => ({ kind: k, ...DOCUMENT_LABELS[k] })),
        // The package filters the catalogue: a package that does not grant
        // financial writes never sees a financial action, even for an admin.
        actions: allowedRepairActions(context)
          .filter((a) => planAllowsEffect(plan, a.effect))
          .map((a) => ({
          id: a.id,
          titleAr: a.titleAr,
          titleEn: a.titleEn,
          modules: a.modules,
          effect: a.effect,
          risk: a.risk,
          requiresApproval: a.requiresApproval,
          inputSchema: a.inputSchema,
            descriptionAr: a.descriptionAr,
            descriptionEn: a.descriptionEn,
          })),
      });
    }

    if (op === "propose") {
      const prompt = String(body.prompt ?? "").slice(0, 4000);
      const plan = await resolvePlan(context);
      // A document-design request routes to the document-template actions;
      // everything else routes to the report/repair actions. Deterministic.
      const allCandidates = isDocumentTemplateRequest(prompt)
        ? selectDocumentTemplateActions(context, prompt)
        : selectRepairActions(context, prompt);
      // The package decides which candidates are visible: an action whose effect
      // the plan does not grant is never offered.
      const candidates = allCandidates.filter((c) => {
        const spec = getRepairAction(c.action);
        return spec ? planAllowsEffect(plan, spec.effect) : false;
      });
      const chosenId = body.action ? String(body.action) : candidates[0]?.action;
      if (!chosenId) {
        return NextResponse.json(
          { success: false, error: "No permitted repair action applies to this request", code: "no_action" },
          { status: 400 },
        );
      }
      const chosenSpec = getRepairAction(chosenId);
      if (chosenSpec && !planAllowsEffect(plan, chosenSpec.effect)) {
        return NextResponse.json(
          {
            success: false,
            error: "Your subscription package does not include this capability",
            code: "plan_upgrade_required",
            plan,
          },
          { status: 403 },
        );
      }
      const proposal = await proposeRepair(
        context,
        chosenId,
        {
          prompt,
          name: body.name,
          from: body.from,
          to: body.to,
          documentKind: body.documentKind,
          customerId: body.customerId,
          contractId: body.contractId,
          amount: body.amount,
          vat: body.vat,
          discount: body.discount,
          paymentMethod: typeof body.paymentMethod === "string" ? body.paymentMethod : undefined,
          invoiceType: body.invoiceType,
          invoiceNumber: body.invoiceNumber,
          newEndDate: body.newEndDate,
        },
        buildDeps(context),
      );
      await logAudit(context, {
        action: "export",
        entity: "ai_repair_proposal",
        entityId: proposal.proposalId,
        metadata: {
          action: proposal.action,
          status: proposal.status,
          kind: proposal.kind,
          effect: proposal.effect,
          requires_approval: proposal.requiresApproval,
          candidates: candidates.map((c) => c.action),
        },
      });
      return NextResponse.json({ success: true, proposal, candidates });
    }

    if (op === "execute") {
      const proposal = body.proposal as RepairProposal | undefined;
      if (!proposal || typeof proposal !== "object" || !proposal.action || !proposal.proposalId) {
        return NextResponse.json({ success: false, error: "A proposal is required", code: "bad_request" }, { status: 400 });
      }
      const approval = (body.approval ?? null) as { approved?: boolean; fingerprint?: string; idempotencyKey?: string } | null;
      // Re-check the package at execution time: a plan downgraded after the
      // proposal was created must not let the approved write through.
      const execPlan = await resolvePlan(context);
      const execSpec = getRepairAction(String(proposal.action));
      if (execSpec && !planAllowsEffect(execPlan, execSpec.effect)) {
        return NextResponse.json(
          {
            success: false,
            result: {
              ok: false,
              status: "forbidden",
              proposalId: proposal.proposalId,
              action: proposal.action,
              changed: null,
              verification: { ok: false, detailAr: "الباقة الحالية لا تشمل هذه القدرة.", detailEn: "The current package does not include this capability." },
              idempotencyKey: approval?.idempotencyKey ?? proposal.proposalId,
              reference: `plan_${proposal.proposalId}`,
              error: { code: "plan_upgrade_required", ar: "الباقة الحالية لا تشمل هذه القدرة.", en: "The current package does not include this capability." },
            },
          },
          { status: 403 },
        );
      }
      const result = await executeRepair(
        context,
        proposal,
        approval
          ? {
              proposalId: proposal.proposalId,
              approved: approval.approved === true,
              fingerprint: String(approval.fingerprint ?? ""),
              idempotencyKey: approval.idempotencyKey ? String(approval.idempotencyKey) : undefined,
            }
          : null,
        buildDeps(context),
        { idempotency, store: repairStore },
      );
      await logAudit(context, {
        action: result.ok ? "update" : "export",
        entity: "ai_repair_execution",
        entityId: proposal.proposalId,
        metadata: {
          action: proposal.action,
          status: result.status,
          verified: result.verification.ok,
          idempotency_key: result.idempotencyKey,
          reference: result.reference,
          // Log the shape of the change, not raw financial values.
          changed_keys: result.changed ? Object.keys(result.changed).slice(0, 20) : [],
          reason: result.error?.code ?? null,
        },
      });
      const status =
        result.status === "forbidden"
          ? 403
          : result.error?.code === "unknown_action"
            ? 400
            : result.status === "conflict" || result.status === "duplicate" || result.status === "expired" || result.status === "in_progress" || result.status === "unresolved"
              ? 409
              : 200;
      return NextResponse.json({ success: result.ok, result }, { status });
    }

    if (op === "history") {
      const records = await repairStore.history(context.tenantId, 50);
      return NextResponse.json({
        success: true,
        records: records.map((r) => ({
          proposalId: r.proposalId,
          action: r.action,
          status: r.status,
          verificationOk: r.verificationOk,
          reference: r.reference,
          changedKeys: r.changedKeys,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      });
    }

    return NextResponse.json({ success: false, error: "Unknown operation", code: "bad_request" }, { status: 400 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "reports", action: "view" });
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    if (action) {
      const spec = getRepairAction(action);
      if (!spec) return NextResponse.json({ success: false, error: "Unknown action", code: "not_found" }, { status: 404 });
      return NextResponse.json({ success: true, action: spec });
    }
    return NextResponse.json({
      success: true,
      actions: allowedRepairActions(context).map((a) => ({ id: a.id, titleAr: a.titleAr, titleEn: a.titleEn, effect: a.effect, risk: a.risk })),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
