import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assertWritableTenant, badRequest, logAudit, notFound, requireContext, toErrorResponse } from "@/lib/auth";

/**
 * Edit and delete a supplier.
 *
 * `/suppliers` wrote the row with the browser client: the insert never set
 * `tenant_id` (an orphan), the delete was scoped by `id` alone, and a delete
 * hard-removed a supplier that purchase bills, payments or debit notes still
 * referenced. Both operations now come here, where the tenant comes from the
 * session, the lookup AND the write are tenant-scoped, and a referenced supplier
 * is refused instead of orphaned.
 */

const ALLOWED_FIELDS = [
  "name",
  "phone",
  "email",
  "address",
  "trn_number",
  "contact_person",
  "payment_terms",
  "opening_balance",
  "notes",
] as const;

/** Tables that hold a `supplier_id`; a supplier they name must not be deleted. */
const DEPENDENT_TABLES = ["purchase_invoices", "supplier_payments", "debit_notes"] as const;

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "suppliers", action: "edit" });
    const { id } = await params;

    let findQuery = supabaseAdmin.from("suppliers").select("id,name,tenant_id").eq("id", id);
    findQuery = context.tenantId
      ? findQuery.eq("tenant_id", context.tenantId)
      : findQuery.is("tenant_id", null);
    const { data: current, error } = await findQuery.maybeSingle();
    if (error) throw error;
    if (!current) throw notFound("Supplier not found");

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) throw badRequest("No editable fields were supplied.");
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw badRequest("name cannot be empty");
      patch.name = name;
    }

    const tenantId = assertWritableTenant(context, body.tenant_id);
    let updateQuery = supabaseAdmin.from("suppliers").update(patch).eq("id", id);
    updateQuery = tenantId
      ? updateQuery.eq("tenant_id", tenantId)
      : updateQuery.is("tenant_id", null);
    const { error: updErr } = await updateQuery;
    if (updErr) throw updErr;

    await logAudit(context, {
      action: "update",
      entity: "suppliers",
      entityId: id,
      metadata: { name: patch.name ?? (current as { name?: string }).name ?? null },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "suppliers", action: "delete" });
    const { id } = await params;

    let findQuery = supabaseAdmin.from("suppliers").select("id,name,tenant_id").eq("id", id);
    findQuery = context.tenantId
      ? findQuery.eq("tenant_id", context.tenantId)
      : findQuery.is("tenant_id", null);
    const { data: current, error } = await findQuery.maybeSingle();
    if (error) throw error;
    if (!current) throw notFound("Supplier not found");

    for (const table of DEPENDENT_TABLES) {
      const { data: dependent, error: depErr } = await supabaseAdmin
        .from(table)
        .select("id")
        .eq("supplier_id", id)
        .limit(1);
      if (depErr) continue; // a table that does not exist here counts as none
      if (dependent && dependent.length > 0) {
        return NextResponse.json(
          {
            error: `This supplier is referenced by ${table} and cannot be deleted. Deactivate it instead.`,
            code: "has_dependents",
          },
          { status: 409 },
        );
      }
    }

    let deleteQuery = supabaseAdmin.from("suppliers").delete().eq("id", id);
    deleteQuery = context.tenantId
      ? deleteQuery.eq("tenant_id", context.tenantId)
      : deleteQuery.is("tenant_id", null);
    const { error: delErr } = await deleteQuery;
    if (delErr) throw delErr;

    await logAudit(context, {
      action: "delete",
      entity: "suppliers",
      entityId: id,
      metadata: { name: (current as { name?: string }).name ?? null },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
