import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireContext, toErrorResponse } from "@/lib/auth";

/**
 * Financial health score.
 * Privileged (service-role) endpoint; requires `reports.view`, tenant-scoped.
 */

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "reports", action: "view" });

    let query = supabaseAdmin
      .from("financial_health_score")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1);
    if (context.tenantId) query = query.eq("company_id", context.tenantId);

    const { data, error } = await query.maybeSingle();
    if (error) throw error;

    return NextResponse.json({ success: true, data });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
