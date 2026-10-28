import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { badRequest, forbidden, logAudit, requireContext, toErrorResponse } from "@/lib/auth";

/**
 * Update the signed-in customer's own identity documents.
 *
 * The customer portal wrote `customers` with the browser client, which is a
 * tenant-owned table. The row is resolved from the SESSION (the context's own
 * `customerId`, read from `users.customer_id`) and never from the request, so a
 * client can only ever update its own record - the previous browser write
 * trusted a client-held id, and the tenant was never asserted.
 *
 * Gating is by ROLE, not by the ERP permission matrix: `client` holds no
 * permissions at all (`DEFAULT_ROLE_PERMISSIONS.client` is empty) by design, so
 * a `customers.edit` check can never pass for the only role this route exists
 * for. That made the endpoint unconditionally 403 and, because the dashboard
 * treats a failed profile write as fatal, silently blocked EVERY booking. The
 * `client` role is itself the authorisation: the write is confined to the
 * caller's own customer row, so no ERP capability is granted here.
 */

const ALLOWED_FIELDS = [
  "cpr_number",
  "driver_license",
  "cpr_image_url",
  "license_image_url",
] as const;

export async function PUT(request: Request) {
  try {
    const context = await requireContext(request, { allowRoles: ["client"] });

    // `resolveAuthContext` already reads `users.customer_id` for a portal user.
    const customerId = context.customerId;
    if (!customerId) throw forbidden("No customer profile is linked to this account.");

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) throw badRequest("No editable fields were supplied.");

    // Scope the write to the caller's own customer row AND its tenant, so a
    // re-pointed `customer_id` cannot reach another company's record.
    let updateQuery = supabaseAdmin.from("customers").update(patch).eq("id", customerId);
    updateQuery = context.tenantId
      ? updateQuery.eq("tenant_id", context.tenantId)
      : updateQuery.is("tenant_id", null);
    const { error: updErr } = await updateQuery;
    if (updErr) throw updErr;

    await logAudit(context, {
      action: "update",
      entity: "customers",
      entityId: customerId,
      metadata: { fields: Object.keys(patch) },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
