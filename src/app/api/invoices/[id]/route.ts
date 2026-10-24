import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { decideInvoiceDeletion } from "@/lib/accounting/invoice-guards";
import { conflict, forbidden, logAudit, notFound, requireContext, toErrorResponse } from "@/lib/auth";

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
    if (context.tenantId) query = query.eq("tenant_id", context.tenantId);

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
    if (context.tenantId) query = query.eq("tenant_id", context.tenantId);
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
