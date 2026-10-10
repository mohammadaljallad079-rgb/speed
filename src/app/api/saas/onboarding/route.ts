import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { validateOnboarding } from "@/lib/saas/provisioning";

/**
 * Tenant onboarding.
 *
 * Runs after signup, when the owner has a session. Every write is scoped to the
 * caller's OWN tenant, resolved from the authenticated context — the request body
 * never supplies a `tenant_id`. The route is idempotent: it may be re-run safely
 * from the onboarding wizard (each step may call it).
 *
 * Steps supported (all optional except the implicit default financial year):
 *   1. Company name            -> tenants.name
 *   2. Business info           -> settings(company_profile) for the tenant
 *   3. Default financial year  -> financial_years (created only when absent)
 *   4. Optional branch         -> branches (created only when a name is given)
 */
export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { requireAdmin: true });
    const tenantId = context.tenantId;

    if (!tenantId) {
      return NextResponse.json(
        { error: "No company is associated with this account", code: "no_tenant" },
        { status: 409 },
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) ?? {};
    } catch {
      body = {};
    }

    const parsed = validateOnboarding(body);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error, field: parsed.field, code: "validation_error" },
        { status: 400 },
      );
    }

    const { companyName, phone, address, financialYear, branchName } = parsed.data;
    const applied: string[] = [];

    // 1. Company name — the caller's own tenant row only.
    if (companyName) {
      const { error } = await supabaseAdmin
        .from("tenants")
        .update({ name: companyName, name_en: companyName })
        .eq("id", tenantId);
      if (error) throw error;
      applied.push("company");
    }

    // 2. Business information — stored as the tenant's company profile.
    if (phone || address || companyName) {
      const profile = { name: companyName ?? undefined, phone: phone ?? undefined, address: address ?? undefined };
      const { data: existing } = await supabaseAdmin
        .from("settings")
        .select("id")
        .eq("key", "company_profile")
        .eq("tenant_id", tenantId)
        .maybeSingle();

      if (existing) {
        await supabaseAdmin
          .from("settings")
          .update({ value: profile, updated_at: new Date().toISOString() })
          .eq("id", (existing as { id: string }).id);
      } else {
        await supabaseAdmin
          .from("settings")
          .insert({ key: "company_profile", value: profile, tenant_id: tenantId });
      }
      applied.push("business_info");
    }

    // 3. Default financial year — created only when the tenant has none.
    if (financialYear) {
      const { data: existingYear } = await supabaseAdmin
        .from("financial_years")
        .select("id")
        .eq("tenant_id", tenantId)
        .limit(1)
        .maybeSingle();

      if (!existingYear) {
        await supabaseAdmin.from("financial_years").insert({
          name: financialYear.name,
          start_date: financialYear.start_date,
          end_date: financialYear.end_date,
          is_current: true,
          status: "open",
          tenant_id: tenantId,
        });
        applied.push("financial_year");
      }
    }

    // 4. Optional branch — created only when the tenant has none.
    if (branchName) {
      const { data: existingBranch } = await supabaseAdmin
        .from("branches")
        .select("id")
        .eq("tenant_id", tenantId)
        .limit(1)
        .maybeSingle();

      if (!existingBranch) {
        await supabaseAdmin.from("branches").insert({ name: branchName, tenant_id: tenantId });
        applied.push("branch");
      }
    }

    await logAudit(context, {
      action: "update",
      entity: "tenants",
      entityId: tenantId,
      metadata: { event: "onboarding", applied },
    });

    return NextResponse.json({ success: true, applied });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
