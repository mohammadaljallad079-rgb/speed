import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import { reverseSaleInvoice, SALE_ACCOUNT_CODES, type SaleAmounts } from "@/lib/accounting/sales-posting";
import {
  badRequest,
  logAudit,
  notFound,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Reverse a posted sale invoice (Exec 29, Item 4 + 11).
 *
 * A posted invoice must never be edited or deleted in place: the ledger would
 * keep describing a document that no longer matches. The supported change is a
 * reversal, which mirrors the original journal and marks the invoice cancelled.
 * The operation is idempotent by invoice number, so a retry cannot reverse twice.
 *
 * Nothing is trusted from the body: the invoice, its amounts and its tenant are
 * read from the database under the caller's tenant scope.
 */

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await requireContext(request, { module: "invoices", action: "edit" });
    const { id } = await params;

    let query = supabaseAdmin.from("invoices").select("*").eq("id", id);
    query = context.tenantId

      ? query.eq("tenant_id", context.tenantId)

      : query.is("tenant_id", null);
    const { data: invoice, error } = await query.maybeSingle();
    if (error) throw error;
    if (!invoice) throw notFound("Invoice not found");

    const inv = invoice as Record<string, unknown>;
    if (inv.status === "cancelled") {
      return NextResponse.json({ ok: true, already_cancelled: true });
    }
    const invoiceNumber = String(inv.invoice_number ?? "");
    if (!invoiceNumber) throw badRequest("Invoice has no number to reverse");

    const amount = round3(Number(inv.amount ?? (Number(inv.total_amount ?? 0) - Number(inv.vat_amount ?? 0))));
    const discount = round3(Number(inv.discount_amount ?? 0));
    const vat = round3(Number(inv.vat_amount ?? 0));
    const total = round3(Number(inv.total_amount ?? amount - discount + vat));
    const advancePayment = round3(Number(inv.paid_amount ?? 0));
    const remaining = round3(total - advancePayment);
    const amounts: SaleAmounts = { amount, discount, vat, advancePayment, remaining };
    const paymentMethod = String(inv.payment_method ?? "cash");
    const entryDate = new Date().toISOString().slice(0, 10);
    // Mirror the invoice's own type: a rental invoice was posted as
    // `rental_invoice` (revenue 41001) and must be reversed as `rental_reversal`.
    const isRental = String(inv.invoice_type ?? "sale") === "rental";

    const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
    const result = await reverseSaleInvoice(supabaseAdmin as never, {
      ...amounts,
      journalNumber,
      invoiceNumber,
      entryDate,
      description: `Reversal - ${invoiceNumber}`,
      customerId: String(inv.customer_id ?? ""),
      paymentMethod,
      entryType: isRental ? "rental_reversal" : "sale_reversal",
      revenueCode: isRental ? SALE_ACCOUNT_CODES.rentalRevenue : SALE_ACCOUNT_CODES.revenue,
    });

    const { error: updErr } = await supabaseAdmin
      .from("invoices")
      .update({ status: "cancelled" })
      .eq("id", id);
    if (updErr) throw updErr;

    await logAudit(context, {
      action: "update",
      entity: "invoices",
      entityId: id,
      metadata: { reversal: true, invoice_number: invoiceNumber, journal_id: result?.journalId ?? null },
    });

    return NextResponse.json({ ok: true, journal_id: result?.journalId ?? null, created: result?.created ?? false });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
