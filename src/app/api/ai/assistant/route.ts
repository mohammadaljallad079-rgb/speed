import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { ReportingDb } from "@/lib/reporting/data";
import { answerQuestion } from "@/lib/ai/assistant";
import { makeComplete, resolveEffectiveAi } from "@/lib/ai/server";
import { detectWriteIntent, redactSecrets } from "@/lib/ai/policy";
import { checkLimits, summarizeUsage, type UsageDb } from "@/lib/ai/usage";
import { loadPlatformAiConfig, type PlatformAiDb } from "@/lib/ai/platform-settings";
import { loadTenantPlan } from "@/lib/saas/tenant-plan";
import { planGrants } from "@/lib/saas/entitlements";

/**
 * In-ERP assistant endpoint.
 *
 * Read/analysis only. Identity, tenant and permissions come from the session
 * via `requireContext`; the request body can only carry the question, an
 * optional screen name and a date range. Answers are grounded in real,
 * permission-gated tool results and every request is audited.
 *
 * The provider credential is resolved at request time: a company's own key wins,
 * otherwise the platform configuration the Super Admin saved applies. Limits are
 * enforced BEFORE the provider call so an over-quota tenant is refused without
 * incurring a charge.
 */

export const dynamic = "force-dynamic";

const MAX_PROMPT = 2000;

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "reports", action: "view" });

    // The subscription package decides whether the company may use the assistant
    // at all. A super admin is the platform operator and is never gated.
    const plan = context.isSuperAdmin ? "enterprise" : await loadTenantPlan(supabaseAdmin as never, context.tenantId);
    if (!planGrants(plan, "aiAssistant")) {
      return NextResponse.json(
        { error: "Your subscription package does not include the AI assistant", code: "plan_upgrade_required", plan },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const prompt = String(body.prompt ?? "").slice(0, MAX_PROMPT).trim();
    if (!prompt) {
      return NextResponse.json({ error: "A question is required", code: "bad_request" }, { status: 400 });
    }
    const screen = body.screen ? String(body.screen).slice(0, 60) : null;
    const from = body.from ? String(body.from) : null;
    const to = body.to ? String(body.to) : null;

    // Resolve the effective provider: the company's own key, else the platform's.
    const { settings, source } = await resolveEffectiveAi(
      supabaseAdmin as unknown as PlatformAiDb,
      context.tenantId,
    );

    // Enforce the platform limits before spending anything. A refused request is
    // reported explicitly rather than silently degraded.
    const platform = await loadPlatformAiConfig(supabaseAdmin as unknown as PlatformAiDb);
    if (settings.enabled === true && !context.isSuperAdmin) {
      const platformUsage = await summarizeUsage(supabaseAdmin as unknown as UsageDb, { allTenants: true, limit: 5000 });
      // The company's own consumption today, scoped to its tenant.
      const companyUsage = await summarizeUsage(supabaseAdmin as unknown as UsageDb, {
        tenantId: context.tenantId,
        limit: 2000,
      });
      const limit = checkLimits(platform.limits, platformUsage, companyUsage.today.totalTokens);
      if (!limit.allowed) {
        await logAudit(context, {
          action: "export",
          entity: "ai_assistant",
          metadata: { blocked: "limit", reason: limit.reason, screen },
        });
        return NextResponse.json(
          { error: limit.message, code: "ai_limit_reached", reason: limit.reason },
          { status: 429 },
        );
      }
    }

    const complete = makeComplete(settings);

    const result = await answerQuestion(
      context,
      { db: supabaseAdmin as unknown as ReportingDb, tenantId: context.tenantId, prompt, screen, from, to },
      { complete },
    );

    await logAudit(context, {
      action: "export",
      entity: "ai_assistant",
      metadata: {
        screen,
        provider: result.provider ?? "none",
        config_source: source,
        degraded: result.degraded,
        sources: result.sources.length,
        blocked_write_intent: detectWriteIntent(prompt).blocked,
        model: result.usage?.model ?? null,
        tokens_in: result.usage?.inputTokens ?? 0,
        tokens_out: result.usage?.outputTokens ?? 0,
        cost_usd: result.usage?.costUsd ?? null,
      },
    });

    return NextResponse.json({
      success: true,
      answer: redactSecrets(result.answer),
      sources: result.sources,
      degraded: result.degraded,
      requiresApproval: result.requiresApproval,
      configSource: source,
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
