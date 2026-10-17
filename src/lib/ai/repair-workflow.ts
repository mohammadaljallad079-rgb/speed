import { can } from "@/lib/auth/policy";
import type { AuthContext } from "@/lib/auth/types";
import type { ReportingDb } from "@/lib/reporting/data";
import { loadReportData } from "@/lib/reporting/data";
import { getReportDefinition, isReportKind } from "@/lib/reporting/definitions";
import type { ReportKind } from "@/lib/reporting/types";
import { buildPreview, resolvePlan, type AssistantContext } from "@/lib/reporting/assistant";
import type { FormatTemplate } from "@/lib/reporting/plan";
import { validateReport, type ValidationColumn } from "@/lib/reporting/validation";
import { classifyRepairRequest, type RepairClassification } from "./policy";
import {
  getRepairAction,
  planFingerprint,
  stableFingerprint,
  validateRepairInput,
  type RepairActionId,
  type RepairEffect,
  type RepairInput,
  type RepairPlan,
} from "./repair-catalog";

/**
 * Safe AI repair workflow (Execution 21, Phase R1).
 *
 * The full cycle: request → diagnosis → allowed action → preview → approval →
 * execute → verify → audit. Every step is server-side and re-checked at
 * execution time. The model may only *choose* an action id from the catalogue;
 * it never supplies SQL, code or free-form parameters. Nothing here writes
 * accounting data — the only persisted effect is a tenant-scoped report-format
 * template in the existing settings store.
 *
 * All infrastructure is injected (`RepairDeps`) so the cycle is unit-testable
 * without a live database or provider.
 */

export interface FormatTemplateLike {
  name: string;
  kind: ReportKind;
}

export interface RepairDeps {
  db: ReportingDb;
  tenantId: string | null;
  companyName?: string | null;
  /** Existing template store (injected; production passes the settings store). */
  loadTemplates: (tenantId: string | null) => Promise<FormatTemplateLike[]>;
  saveTemplate: (tenantId: string | null, template: FormatTemplate) => Promise<unknown>;
  /** Clock, so expiry is deterministic in tests. */
  now?: () => number;
}

export type RepairProposalStatus =
  | "ready"
  | "needs_approval"
  | "forbidden"
  | "unknown_action"
  | "invalid_input";

export interface RepairPreview {
  action: RepairActionId;
  kind: ReportKind | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  diff: string[];
  dataSource: string;
  rowCount: number;
  /** Deterministic findings (validation only). */
  issues?: unknown[];
}

export interface RepairProposal {
  proposalId: string;
  action: RepairActionId;
  kind: ReportKind | null;
  params: RepairPlan["params"];
  effect: RepairEffect;
  requiresApproval: boolean;
  status: RepairProposalStatus;
  diagnosis: RepairClassification;
  titleAr: string;
  titleEn: string;
  preview: RepairPreview | null;
  /** Binds an approval to the exact plan content. */
  fingerprint: string;
  /** Fingerprint of the preview result, to detect a change before execution. */
  contentFingerprint: string;
  expiresAt: string;
  error?: { code: string; ar: string; en: string };
}

export type RepairExecutionStatus =
  | "verified"
  | "rejected"
  | "conflict"
  | "expired"
  | "forbidden"
  | "duplicate"
  | "failed";

export interface RepairApproval {
  proposalId: string;
  approved: boolean;
  /** Must equal the proposal fingerprint; a mismatch means the plan changed. */
  fingerprint: string;
  idempotencyKey?: string;
}

export interface RepairVerification {
  ok: boolean;
  detailAr: string;
  detailEn: string;
  dataSource?: string;
}

export interface RepairExecutionResult {
  ok: boolean;
  status: RepairExecutionStatus;
  proposalId: string;
  action: RepairActionId;
  changed: Record<string, unknown> | null;
  verification: RepairVerification;
  idempotencyKey: string;
  /** Audit reference; the route logs it and returns it to the caller. */
  reference: string;
  error?: { code: string; ar: string; en: string };
}

/** Best-effort idempotency port. A durable store would need a settings row. */
export interface IdempotencyPort {
  has(key: string): boolean;
  mark(key: string, reference: string): void;
}

/** In-memory idempotency store with a TTL (default 15 minutes). */
export function createMemoryIdempotency(ttlMs = 15 * 60_000): IdempotencyPort {
  const seen = new Map<string, number>();
  const sweep = () => {
    const cutoff = Date.now() - ttlMs;
    for (const [k, t] of seen) if (t < cutoff) seen.delete(k);
  };
  return {
    has(key) {
      sweep();
      return seen.has(key);
    },
    mark(key) {
      seen.set(key, Date.now());
    },
  };
}

const PROPOSAL_TTL_MS = 15 * 60_000;

const DATA_SOURCE: Record<ReportKind, string> = {
  vat_report: "invoices + purchase_invoices + expenses (vat_amount)",
  sales_report: "invoices",
  purchases_report: "purchase_invoices",
  expenses_report: "expenses",
  trial_balance: "journal_entries + journal_lines",
};

function toValidationColumns(kind: ReportKind): ValidationColumn[] {
  const def = getReportDefinition(kind);
  if (!def) return [];
  return def.columns.map((c) => ({ key: c.key, labelAr: c.labelAr, labelEn: c.labelEn, type: c.type, total: c.total }));
}

function sumTotals(kind: ReportKind, rows: Record<string, unknown>[]): Record<string, number> {
  const def = getReportDefinition(kind);
  const totals: Record<string, number> = {};
  for (const c of def?.columns ?? []) {
    if (!c.total) continue;
    totals[c.key] = Math.round(rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) * 1000) / 1000;
  }
  return totals;
}

function planToTemplate(kind: ReportKind, name: string, prompt: string): FormatTemplate {
  const { plan } = resolvePlan({ kind, prompt, from: null, to: null });
  return {
    name,
    kind,
    plan: {
      direction: plan.direction,
      columns: plan.columns,
      hiddenColumns: plan.hiddenColumns,
      rightAlignColumns: plan.rightAlignColumns,
      headerFill: plan.headerFill,
      bandedRows: plan.bandedRows,
      boldTotals: plan.boldTotals,
      addTotals: plan.addTotals,
      freezeHeader: plan.freezeHeader,
      autoFilter: plan.autoFilter,
      columnWidths: plan.columnWidths,
      titleEn: plan.titleEn,
      titleAr: plan.titleAr,
    },
  };
}

async function buildPreviewFor(
  action: RepairActionId,
  plan: RepairPlan,
  deps: RepairDeps,
): Promise<RepairPreview> {
  const kind = plan.kind ?? "sales_report";
  const ctx: AssistantContext = { db: deps.db, tenantId: deps.tenantId, companyName: deps.companyName ?? null };

  if (action === "report_validation") {
    const data = await loadReportData(deps.db, kind, {
      tenantId: deps.tenantId,
      companyName: deps.companyName ?? null,
      from: plan.params.from ?? null,
      to: plan.params.to ?? null,
    });
    const rows = data.rows as unknown as Record<string, unknown>[];
    const columns = toValidationColumns(kind);
    const totals = sumTotals(kind, rows);
    const issues = validateReport({
      columns,
      rows,
      totals,
      sourceCount: rows.length,
      period: { from: plan.params.from ?? null, to: plan.params.to ?? null },
    });
    const errorCount = issues.filter((i) => i.severity === "error").length;
    const warningCount = issues.filter((i) => i.severity === "warning").length;
    return {
      action,
      kind,
      before: { issues: null },
      after: { errorCount, warningCount, rowCount: rows.length, totals },
      diff: issues.map((i) => `${i.severity}: ${i.titleEn}`),
      dataSource: DATA_SOURCE[kind],
      rowCount: rows.length,
      issues,
    };
  }

  if (action === "report_format_preview" || action === "save_report_format_template") {
    const prompt = plan.params.prompt ?? "";
    const preview = await buildPreview(ctx, { kind, prompt, from: plan.params.from ?? null, to: plan.params.to ?? null });
    const beforeCols = getReportDefinition(kind)?.columns.map((c) => c.key) ?? [];
    const afterCols = preview.columns.map((c) => c.key);
    return {
      action,
      kind,
      before: { columns: beforeCols },
      after: { columns: afterCols, hidden: preview.plan.hiddenColumns, direction: preview.plan.direction },
      diff: preview.diff.changes,
      dataSource: DATA_SOURCE[kind],
      rowCount: preview.rowCount,
    };
  }

  return { action, kind, before: {}, after: {}, diff: [], dataSource: DATA_SOURCE[kind], rowCount: 0 };
}

let counter = 0;

/**
 * Proposes a repair: validates the action + input, checks permission, computes a
 * deterministic preview, and returns a proposal carrying its fingerprints.
 * Nothing is written. `deps.now` keeps expiry deterministic in tests.
 */
export async function proposeRepair(
  context: AuthContext,
  action: string,
  input: RepairInput,
  deps: RepairDeps,
): Promise<RepairProposal> {
  const now = deps.now ?? Date.now;
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const diagnosis = classifyRepairRequest(prompt);

  const spec = getRepairAction(action);
  if (!spec) {
    return {
      proposalId: `rep_${now().toString(36)}_${(counter++).toString(36)}`,
      action: action as RepairActionId,
      kind: null,
      params: {},
      effect: "read",
      requiresApproval: true,
      status: "unknown_action",
      diagnosis,
      titleAr: "إجراء غير معروف",
      titleEn: "Unknown action",
      preview: null,
      fingerprint: "",
      contentFingerprint: "",
      expiresAt: new Date(now() + PROPOSAL_TTL_MS).toISOString(),
      error: { code: "unknown_action", ar: "الإجراء غير موجود في الكتالوج.", en: "The action is not in the catalogue." },
    };
  }

  const base = {
    proposalId: `rep_${now().toString(36)}_${(counter++).toString(36)}`,
    action: spec.id,
    effect: spec.effect,
    requiresApproval: spec.requiresApproval,
    diagnosis,
    titleAr: spec.titleAr,
    titleEn: spec.titleEn,
    expiresAt: new Date(now() + PROPOSAL_TTL_MS).toISOString(),
  };

  if (!can(context, spec.permission.module, spec.permission.action)) {
    return {
      ...base,
      kind: null,
      params: {},
      status: "forbidden",
      preview: null,
      fingerprint: "",
      contentFingerprint: "",
      error: { code: "forbidden", ar: "لا تملك صلاحية هذا الإجراء.", en: "You are not permitted to run this action." },
    };
  }

  const validated = validateRepairInput(spec.id, input);
  if (!validated.ok || !validated.plan) {
    return {
      ...base,
      kind: null,
      params: {},
      status: "invalid_input",
      preview: null,
      fingerprint: "",
      contentFingerprint: "",
      error: validated.error,
    };
  }
  const plan = validated.plan;

  const preview = await buildPreviewFor(spec.id, plan, deps);
  const fingerprint = planFingerprint(plan);
  const contentFingerprint = stableFingerprint(preview.after);

  return {
    ...base,
    kind: plan.kind ?? null,
    params: plan.params,
    status: spec.effect === "read" ? "ready" : "needs_approval",
    preview,
    fingerprint,
    contentFingerprint,
  };
}

export interface ExecuteOptions {
  idempotency?: IdempotencyPort;
  /** Override the idempotency key (otherwise the proposal id is used). */
  idempotencyKey?: string;
}

/**
 * Executes an approved proposal. Re-checks the permission, the approval, the
 * plan fingerprint (approval must match the exact plan) and the preview content
 * (a change since preview aborts with `conflict`). Write actions are verified
 * after execution; a failed verification is never reported as success.
 */
export async function executeRepair(
  context: AuthContext,
  proposal: RepairProposal,
  approval: RepairApproval | null,
  deps: RepairDeps,
  options: ExecuteOptions = {},
): Promise<RepairExecutionResult> {
  const now = deps.now ?? Date.now;
  const idempotencyKey = options.idempotencyKey ?? approval?.idempotencyKey ?? proposal.proposalId;
  const reference = `rep_${proposal.action}_${idempotencyKey}`;
  const spec = getRepairAction(proposal.action);

  const fail = (
    status: RepairExecutionStatus,
    code: string,
    ar: string,
    en: string,
    verification: RepairVerification = { ok: false, detailAr: ar, detailEn: en },
  ): RepairExecutionResult => ({
    ok: false,
    status,
    proposalId: proposal.proposalId,
    action: proposal.action,
    changed: null,
    verification,
    idempotencyKey,
    reference,
    error: { code, ar, en },
  });

  // 1. The action must still be known.
  if (!spec) return fail("failed", "unknown_action", "إجراء غير معروف.", "Unknown action.");

  // 2. Permission is re-checked at execution time, not only at proposal time.
  if (!can(context, spec.permission.module, spec.permission.action)) {
    return fail("forbidden", "forbidden", "لا تملك صلاحية التنفيذ.", "You are not permitted to execute this action.");
  }

  // 3. Expiry.
  if (new Date(proposal.expiresAt).getTime() < now()) {
    return fail("expired", "expired", "انتهت صلاحية المعاينة؛ أعد المعاينة.", "The preview expired; preview again.");
  }

  // 4. Explicit approval for a write; the approval must match the exact plan.
  if (proposal.requiresApproval) {
    if (!approval?.approved) {
      return fail("rejected", "approval_required", "يتطلب هذا الإجراء موافقة صريحة.", "This action requires an explicit approval.");
    }
    if (approval.fingerprint !== proposal.fingerprint) {
      return fail("conflict", "plan_changed", "تغيّرت خطة الإصلاح بعد الموافقة؛ أعد المعاينة والموافقة.", "The repair plan changed after approval; preview and approve again.");
    }
  }

  // 5. Idempotency: never run the same action twice for the same key.
  if (options.idempotency?.has(idempotencyKey)) {
    return fail("duplicate", "duplicate", "تم تنفيذ هذا الإجراء مسبقًا.", "This action was already executed.");
  }

  // 6. Re-compute the preview and refuse if the content changed since preview.
  const fresh = await buildPreviewFor(proposal.action, {
    action: proposal.action,
    kind: proposal.kind ?? undefined,
    params: proposal.params,
    effect: proposal.effect,
    requiresApproval: proposal.requiresApproval,
  }, deps);
  if (stableFingerprint(fresh.after) !== proposal.contentFingerprint) {
    return fail("conflict", "data_changed", "تغيّرت البيانات بعد المعاينة؛ أعد المعاينة.", "Data changed since the preview; preview again.");
  }

  // 7. Execute. Reads have nothing to persist; the only write is a template.
  if (proposal.effect === "read") {
    options.idempotency?.mark(idempotencyKey, reference);
    return {
      ok: true,
      status: "verified",
      proposalId: proposal.proposalId,
      action: proposal.action,
      changed: fresh.after,
      verification: { ok: true, detailAr: "نتيجة القراءة/التحقق جاهزة.", detailEn: "Read/validation result is ready.", dataSource: fresh.dataSource },
      idempotencyKey,
      reference,
    };
  }

  // Write: save the format template, then verify it is actually stored.
  const name = proposal.params.name ?? "";
  const kind = proposal.kind;
  if (!kind || !isReportKind(kind) || !name) {
    return fail("failed", "bad_request", "مدخلات القالب غير صالحة.", "Invalid template input.");
  }
  try {
    const template = planToTemplate(kind, name, proposal.params.prompt ?? "");
    await deps.saveTemplate(deps.tenantId, template);
  } catch (error) {
    return fail("failed", "save_failed", "فشل حفظ القالب.", "Failed to save the template.", {
      ok: false,
      detailAr: `فشل الحفظ: ${(error as Error).message}`,
      detailEn: `Save failed: ${(error as Error).message}`,
    });
  }

  const templates = await deps.loadTemplates(deps.tenantId);
  const stored = templates.some((t) => t.name.toLowerCase() === name.toLowerCase());
  options.idempotency?.mark(idempotencyKey, reference);
  if (!stored) {
    return fail("failed", "verification_failed", "لم يتم العثور على القالب بعد الحفظ.", "The template was not found after saving.", {
      ok: false,
      detailAr: "فشل التحقق بعد التنفيذ.",
      detailEn: "Post-execution verification failed.",
    });
  }
  return {
    ok: true,
    status: "verified",
    proposalId: proposal.proposalId,
    action: proposal.action,
    changed: fresh.after,
    verification: { ok: true, detailAr: "تم حفظ القالب والتحقق منه.", detailEn: "Template saved and verified.", dataSource: "settings:report_format_templates" },
    idempotencyKey,
    reference,
  };
}
