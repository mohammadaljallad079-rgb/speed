import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireContext, scopeToCompany, toErrorResponse } from "@/lib/auth";

/**
 * Financial ratios read endpoint.
 *
 * Privileged (service-role) endpoint; requires `reports.view`. Results are
 * scoped to the caller's company/tenant so financial data never crosses tenants.
 */

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "reports", action: "view" });

    let query = supabaseAdmin
      .from("financial_ratios")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    query = scopeToCompany(query, context);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ success: true, data: data || [] });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
