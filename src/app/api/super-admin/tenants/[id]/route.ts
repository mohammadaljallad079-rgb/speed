import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/auth/errors";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertSuperAdmin, listTenantUsers, type AdminDb } from "@/lib/super-admin/service";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A single company and its users, for the Super Admin tenant detail view.
 *
 * Global-only (`requireSuperAdmin`). The id is validated as a UUID before it
 * reaches a query, and a company that does not exist returns 404 rather than an
 * empty success — so the console can tell "no such company" from "no users".
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { requireSuperAdmin: true });
    assertSuperAdmin(context);
    const { id } = await params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid tenant id");

    const db = supabaseAdmin as unknown as AdminDb;
    const { data, error } = await db.from("tenants").select("id, name, name_en, created_at").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) throw notFound("Company not found");

    const users = await listTenantUsers(db, id);
    await logAudit(context, {
      action: "export",
      entity: "super_admin_tenant",
      entityId: id,
      metadata: { users: users.length },
    });

    return NextResponse.json({ success: true, tenant: data, users });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
