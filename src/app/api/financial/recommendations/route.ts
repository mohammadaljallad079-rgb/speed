import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireContext, toErrorResponse } from "@/lib/auth";

/**
 * AI recommendations.
 * Privileged (service-role) endpoint; requires `reports.view`, tenant-scoped.
 */

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "reports", action: "view" });

    let query = supabaseAdmin
      .from("ai_recommendations")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(20);
    if (context.tenantId) query = query.eq("company_id", context.tenantId);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ success: true, data: data || [] });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
