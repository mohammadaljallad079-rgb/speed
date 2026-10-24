import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { AGENTS, resolveAgent } from "@/lib/ai/agents";
import { REPAIR_ACTIONS } from "@/lib/ai/repair-catalog";
import { createResilientRepairStore, createSupabaseRepairStore, type SupabaseClientLike } from "@/lib/ai/repair-store";
import { buildAiOversight, type RepairHistoryReader } from "@/lib/super-admin/ai-oversight";
import type { DevRequestDb } from "@/lib/ai/dev-requests";
import type { AdminDb } from "@/lib/super-admin/service";

export const dynamic = "force-dynamic";

/**
 * Global AI oversight for the Super Admin console.
 *
 * Global-only (`requireSuperAdmin`). It reports the AI capability catalogue
 * (agents, repair actions) and a per-company usage summary — counts and statuses
 * only, never a company's prompts, financial figures or API keys.
 */
const repairStore = createResilientRepairStore(
  createSupabaseRepairStore(supabaseAdmin as unknown as SupabaseClientLike),
);
const readRepairs: RepairHistoryReader = (tenantId, limit) => repairStore.history(tenantId, limit);

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { requireSuperAdmin: true });

    const admin = supabaseAdmin as unknown as AdminDb;
    const { data: tenantRows, error } = await admin.from("tenants").select("id");
    if (error) throw error;
    const tenantIds = ((tenantRows ?? []) as Array<{ id: string }>).map((t) => t.id);

    const oversight = await buildAiOversight(
      supabaseAdmin as unknown as DevRequestDb,
      tenantIds,
      readRepairs,
    );

    const agents = AGENTS.map((a) => {
      const effective = resolveAgent(context, a.id);
      return {
        id: a.id,
        nameEn: a.nameEn,
        nameAr: a.nameAr,
        task: a.task,
        requiresHumanReview: a.requiresHumanReview,
        toolCount: effective ? effective.tools.length : 0,
      };
    });

    await logAudit(context, {
      action: "export",
      entity: "super_admin_ai",
      metadata: { tenants: tenantIds.length, pending: oversight.totals.pendingApprovals },
    });

    return NextResponse.json({
      success: true,
      ...oversight,
      agents,
      repairActions: REPAIR_ACTIONS.map((a) => ({
        id: a.id,
        titleAr: a.titleAr,
        titleEn: a.titleEn,
        effect: a.effect,
        risk: a.risk,
        requiresApproval: a.requiresApproval,
        modules: a.modules,
      })),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
