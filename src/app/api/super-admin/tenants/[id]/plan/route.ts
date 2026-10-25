import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/auth/errors";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertSuperAdmin } from "@/lib/super-admin/service";
import { PLANS, PLAN_IDS, capabilitiesFor, isPlanId } from "@/lib/saas/entitlements";
import { loadTenantPlan, saveTenantPlan } from "@/lib/saas/tenant-plan";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The subscription package of a company, and the capability matrix.
 *
 * Global-only (`requireSuperAdmin`): assigning a package is what decides whether
 * a company may use the AI assistant, the AI agent and financial writes, so it is
 * never a company-admin action. `GET` returns the current package plus every
 * package's capabilities (so the console renders the real matrix, not a guess);
 * `PUT` assigns one.
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { requireSuperAdmin: true });
    assertSuperAdmin(context);
    const { id } = await params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid tenant id");

    const plan = await loadTenantPlan(supabaseAdmin as never, id);
    return NextResponse.json({
      success: true,
      tenantId: id,
      plan,
      capabilities: capabilitiesFor(plan),
      packages: PLAN_IDS.map((p) => ({ ...PLANS[p], id: p })),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { requireSuperAdmin: true });
    assertSuperAdmin(context);
    const { id } = await params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid tenant id");

    const body = ((await request.json().catch(() => ({}))) ?? {}) as { plan?: unknown };
    if (!isPlanId(body.plan)) {
      throw badRequest(`plan must be one of: ${PLAN_IDS.join(", ")}`);
    }

    // The company must exist: assigning a package to a non-existent tenant would
    // silently create a settings row nothing ever reads.
    const { data: tenant } = await supabaseAdmin.from("tenants").select("id").eq("id", id).maybeSingle();
    if (!tenant) throw notFound("Company not found");

    const result = await saveTenantPlan(supabaseAdmin as never, id, body.plan);
    if (!result.ok) throw badRequest(result.error ?? "Could not save the package");

    await logAudit(context, {
      action: "update",
      entity: "tenant_plan",
      entityId: id,
      metadata: { plan: body.plan, capabilities: capabilitiesFor(body.plan) },
    });

    return NextResponse.json({
      success: true,
      tenantId: id,
      plan: body.plan,
      capabilities: capabilitiesFor(body.plan),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
