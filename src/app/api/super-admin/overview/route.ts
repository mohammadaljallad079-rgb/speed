import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildOverview, type AdminDb } from "@/lib/super-admin/service";

export const dynamic = "force-dynamic";

/**
 * Global Super Admin overview.
 *
 * Guarded by `requireSuperAdmin`: a company administrator is rejected with 403,
 * and an anonymous caller with 401 (the middleware gate). Every read runs on the
 * service-role client and returns an aggregate/derived shape — no credentials,
 * no password material.
 */
export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { requireSuperAdmin: true });
    const overview = await buildOverview(supabaseAdmin as unknown as AdminDb);
    await logAudit(context, {
      action: "export",
      entity: "super_admin_overview",
      metadata: { tenants: overview.totals.tenants, users: overview.totals.users },
    });
    return NextResponse.json({ success: true, ...overview });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
