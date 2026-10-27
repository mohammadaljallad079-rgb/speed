import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  assertWritableTenant,
  badRequest,
  logAudit,
  notFound,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";
import { CUSTOMER_EDITABLE_FIELDS, CUSTOMER_DEPENDENT_TABLES } from "@/lib/customers/fields";

/**
 * Edit a customer.
 *
 * `/customers` wrote the row with the browser client, so the update was scoped
 * only by `id`: any authenticated caller could rename or re-point a customer
 * belonging to another company, and the tenant could not be corrected on a row
 * that had been created as an orphan. The lookup and the update are now scoped
 * to the caller's tenant (or the NULL tenant), so a foreign id is a 404, and the
 * tenant comes from the session.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "customers", action: "edit" });
    const { id } = await params;

    let findQuery = supabaseAdmin.from("customers").select("id,full_name,tenant_id").eq("id", id);
    findQuery = context.tenantId
      ? findQuery.eq("tenant_id", context.tenantId)
      : findQuery.is("tenant_id", null);
    const { data: current, error } = await findQuery.maybeSingle();
    if (error) throw error;
    if (!current) throw notFound("Customer not found");

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const field of CUSTOMER_EDITABLE_FIELDS) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) throw badRequest("No editable fields were supplied.");

    if (patch.full_name !== undefined) {
      const name = String(patch.full_name).trim();
      if (!name) throw badRequest("full_name cannot be empty");
      patch.full_name = name;
    }

    const tenantId = assertWritableTenant(context, body.tenant_id);

    let updateQuery = supabaseAdmin.from("customers").update(patch).eq("id", id);
    updateQuery = tenantId
      ? updateQuery.eq("tenant_id", tenantId)
      : updateQuery.is("tenant_id", null);
    const { error: updErr } = await updateQuery;
    if (updErr) throw updErr;

    await logAudit(context, {
      action: "update",
      entity: "customers",
      entityId: id,
      metadata: { full_name: patch.full_name ?? (current as { full_name?: string }).full_name ?? null },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/**
 * Delete a customer.
 *
 * A customer a document references must not be hard-deleted: `invoices`,
 * `rental_contracts` and `payments` keep a `customer_id`, and removing the row
 * would leave those documents pointing at nothing. The count is taken first and
 * the delete is refused when any document still names the customer.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "customers", action: "delete" });
    const { id } = await params;

    let findQuery = supabaseAdmin.from("customers").select("id,full_name,tenant_id").eq("id", id);
    findQuery = context.tenantId
      ? findQuery.eq("tenant_id", context.tenantId)
      : findQuery.is("tenant_id", null);
    const { data: current, error } = await findQuery.maybeSingle();
    if (error) throw error;
    if (!current) throw notFound("Customer not found");

    for (const table of CUSTOMER_DEPENDENT_TABLES) {
      let q = supabaseAdmin.from(table).select("id").eq("customer_id", id).limit(1);
      const { data: dependent, error: depErr } = await q;
      if (depErr) continue; // a table that does not exist here counts as none
      if (dependent && dependent.length > 0) {
        return NextResponse.json(
          {
            error: `This customer is referenced by ${table} and cannot be deleted. Deactivate it instead.`,
            code: "has_dependents",
          },
          { status: 409 },
        );
      }
    }

    let deleteQuery = supabaseAdmin.from("customers").delete().eq("id", id);
    deleteQuery = context.tenantId
      ? deleteQuery.eq("tenant_id", context.tenantId)
      : deleteQuery.is("tenant_id", null);
    const { error: delErr } = await deleteQuery;
    if (delErr) throw delErr;

    await logAudit(context, {
      action: "delete",
      entity: "customers",
      entityId: id,
      metadata: { full_name: (current as { full_name?: string }).full_name ?? null },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
