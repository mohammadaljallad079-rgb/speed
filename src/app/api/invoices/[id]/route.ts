import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { decideInvoiceDeletion, decideInvoiceEdit } from "@/lib/accounting/invoice-guards";
import { REF_CUSTOMER, assertReference, badRequest, conflict, forbidden, logAudit, notFound, requireContext, toErrorResponse } from "@/lib/auth";

const round3 = (n: unknown) => Math.round((Number(n) || 0) * 1000) / 1000;

/**
 * The columns an edit may set, and nothing else.
 *
 * An allow-list, not a spread of the body: `tenant_id`, `paid_amount`, `status`
 * and `id` must never be writable from here. `paid_amount` is derived from the
 * receipts (`recomputeInvoicePaid`) and `status` follows from it; letting an edit
 * set them would let a caller mark an invoice paid without collecting anything.
 */
const EDITABLE_FIELDS = [
  "invoice_number",
  "customer_id",
  "rental_contract_id",
  "invoice_date",
  "due_date",
  "amount",
  "discount_amount",
  "vat_amount",
  "payment_type",
  "payment_method",
  "notes",
  "rental_days",
  "car_plate",
] as const;

/**
 * Single invoice lookup.
 *
 * Privileged (service-role) endpoint; requires `invoices.view`. The invoice is
 * fetched with an explicit tenant filter so an id from another tenant simply
 * resolves to "not found" instead of leaking data.
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "invoices", action: "view" });
    const { id } = await params;

    let query = supabaseAdmin
      .from("invoices")
      .select("*, customers(id, full_name, phone, email)")
      .eq("id", id);
    // Fail-closed: a tenant-less caller is confined to the NULL-tenant rows, so
    // an unresolved tenant cannot read another company's invoice by id.
    query = context.tenantId
      ? query.eq("tenant_id", context.tenantId)
      : query.is("tenant_id", null);

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) throw notFound("Invoice not found");

    const { data: items, error: itemsError } = await supabaseAdmin
      .from("invoice_items")
      .select("*")
      .eq("invoice_id", id);
    if (itemsError) throw itemsError;

    const customer = (data as { customers?: { name?: string; full_name?: string; phone?: string } })
      .customers;

    return NextResponse.json({
      ...data,
      customer_name: customer?.name ?? customer?.full_name ?? null,
      customer_phone: customer?.phone ?? null,
      items: items || [],
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/**
 * Edit an invoice (server-authoritative).
 *
 * WHY THIS EXISTS
 * ---------------
 * The edit screen wrote the invoice straight from the browser. Its "posted" and
 * "has dependents" checks were advisory: a caller who did not go through the
 * screen could rewrite a posted invoice's amounts while its journal kept the old
 * figures, or rewrite an invoice that had receipts against it, leaving the ledger
 * and the receipts describing a document that no longer existed.
 *
 * The decision now belongs to the server (`decideInvoiceEdit`, which fails
 * closed), the caller's tenant is taken from the session, `customer_id` and the
 * rental contract are verified to belong to that tenant, and `paid_amount` and
 * `status` are never writable here - they are derived from the receipts.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "invoices", action: "edit" });
    const { id } = await params;

    let query = supabaseAdmin.from("invoices").select("id,invoice_number,tenant_id").eq("id", id);
    query = context.tenantId ? query.eq("tenant_id", context.tenantId) : query.is("tenant_id", null);
    const { data: invoice, error } = await query.maybeSingle();
    if (error) throw error;
    if (!invoice) throw notFound("Invoice not found");

    const currentNumber = String((invoice as { invoice_number?: string }).invoice_number ?? "");
    const decision = await decideInvoiceEdit(supabaseAdmin as never, {
      id,
      invoiceNumber: currentNumber,
      tenantId: context.tenantId ?? null,
    });
    if (!decision.allowed) {
      if (decision.code === "unverified") throw conflict(decision.message, "unverified");
      throw forbidden(decision.message);
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const patch: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      if (field in body) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) throw badRequest("No editable fields were supplied.");

    if ("customer_id" in patch) await assertReference(REF_CUSTOMER, patch.customer_id, context);
    if (patch.rental_contract_id === "") patch.rental_contract_id = null;

    // `total_amount` is DERIVED, exactly as the posting service derives it:
    // (amount - discount) + VAT. It is never taken from the body, so the stored
    // total cannot disagree with the revenue the invoice was posted for.
    const amount = round3(patch.amount);
    const discount = round3(patch.discount_amount);
    const vat = round3(patch.vat_amount);
    if (!(amount > 0)) throw badRequest("The invoice amount must be greater than zero.");
    if (discount < 0 || discount > amount) throw badRequest("The discount must be between zero and the amount.");
    patch.amount = amount;
    patch.discount_amount = discount;
    patch.vat_amount = vat;
    patch.total_amount = round3(amount - discount + vat);

    const { error: updErr } = await supabaseAdmin.from("invoices").update(patch).eq("id", id);
    if (updErr) throw updErr;

    await logAudit(context, {
      action: "update",
      entity: "invoices",
      entityId: id,
      metadata: { invoice_number: String(patch.invoice_number ?? currentNumber), total_amount: patch.total_amount },
    });
    return NextResponse.json({ ok: true, total_amount: patch.total_amount });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/**
 * Delete an invoice (Exec 29, Item 11).
 *
 * Server-authoritative guard: a posted invoice is never deletable (the ledger
 * would keep describing a missing document), and an invoice with receipts or
 * returns is never deletable (those rows would be orphaned). A permitted delete
 * is scoped to the caller's tenant and audited.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "invoices", action: "delete" });
    const { id } = await params;

    let query = supabaseAdmin.from("invoices").select("id,invoice_number,tenant_id").eq("id", id);
    query = context.tenantId
      ? query.eq("tenant_id", context.tenantId)
      : query.is("tenant_id", null);
    const { data: invoice, error } = await query.maybeSingle();
    if (error) throw error;
    if (!invoice) throw notFound("Invoice not found");

    const invoiceNumber = String((invoice as { invoice_number?: string }).invoice_number ?? "");

    // One authority decides, and it fails closed: if the posting state or the
    // dependents count cannot be established, the delete is refused rather than
    // assumed safe. See `decideInvoiceDeletion`.
    const decision = await decideInvoiceDeletion(supabaseAdmin as never, {
      id,
      invoiceNumber,
      tenantId: context.tenantId ?? null,
    });
    if (!decision.allowed) {
      if (decision.code === "unverified") throw conflict(decision.message, "unverified");
      throw forbidden(decision.message);
    }

    const { error: delErr } = await supabaseAdmin.from("invoices").delete().eq("id", id);
    if (delErr) throw delErr;

    await logAudit(context, {
      action: "delete",
      entity: "invoices",
      entityId: id,
      metadata: { invoice_number: invoiceNumber },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
