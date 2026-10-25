import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/auth/errors";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertRoleChangeAllowed, assertRoleTargetEditable, assertSuperAdmin } from "@/lib/super-admin/policy";
import { setUserActive, setUserRole, type AdminDb } from "@/lib/super-admin/service";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Global Super Admin user administration.
 *
 * `requireSuperAdmin` + `assertSuperAdmin` reject a company administrator with
 * 403. Only two fields may be changed from here — `is_active` and a
 * company-scoped `role` — and the role may never be `super_admin` (that is a
 * provisioning action, enforced again by migration 004). Tenant assignment is
 * deliberately not editable from the console, so it cannot be used to move a
 * user between companies.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { requireSuperAdmin: true });
    assertSuperAdmin(context);
    const { id } = await params;
    if (!UUID_RE.test(id)) throw badRequest("Invalid user id");

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const db = supabaseAdmin as unknown as AdminDb;

    const { data: existing, error: readError } = await db
      .from("users")
      .select("id, role, tenant_id, is_active")
      .eq("id", id)
      .maybeSingle();
    if (readError) throw readError;
    if (!existing) throw notFound("User not found");
    const currentRole = (existing as { role?: unknown }).role;

    const changed: string[] = [];

    if (body.is_active !== undefined) {
      const isActive = body.is_active === true;
      await setUserActive(db, id, isActive);
      changed.push("is_active");
    }

    if (body.role !== undefined) {
      // Both directions matter: the requested role may not be `super_admin`, and
      // the target may not currently BE one (demotion is the same privilege
      // change). Provisioning owns the global role.
      assertRoleTargetEditable(currentRole);
      assertRoleChangeAllowed(body.role);
      await setUserRole(db, id, body.role);
      changed.push("role");
    }

    if (changed.length === 0) throw badRequest("Nothing to update");

    await logAudit(context, {
      action: changed.includes("role") ? "permission_change" : "update",
      entity: "users",
      entityId: id,
      metadata: { changed },
    });

    return NextResponse.json({ success: true, changed });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
