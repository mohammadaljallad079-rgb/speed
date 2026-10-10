import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireContext, toErrorResponse } from "@/lib/auth";

/**
 * Financial kpis read endpoint.
 *
 * Privileged (service-role) endpoint; requires `reports.view`. Results are
 * scoped to the caller's company/tenant so financial data never crosses tenants.
 */

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "reports", action: "view" });

    let query = supabaseAdmin
      .from("kpi_results")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (context.tenantId) query = query.eq("company_id", context.tenantId);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ success: true, data: data || [] });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
