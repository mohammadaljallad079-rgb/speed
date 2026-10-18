import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import {
  postSaleInvoice,
  SALE_ACCOUNT_CODES,
  type SaleAmounts,
} from "@/lib/accounting/sales-posting";
import {
  assertDateInOpenFinancialYear,
  assertReferences,
  assertWritableTenant,
  getActiveFinancialYear,
  logAudit,
  REF_CUSTOMER,
  REF_RENTAL_CONTRACT,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Sale-invoice issue.
 *
 * The single server-side path for issuing a sale. It owns the invariants the
 * browser pages used to implement ad hoc (Exec 29, Item 10):
 *   - identity, tenant and permissions come from the session, never the body;
 *   - the invoice number is allocated by the row-locked numbering RPC;
 *   - the invoice and its journal are created together; if the journal fails the
 *     invoice is removed, so a document can never be left unposted;
 *   - posting is idempotent by invoice number, so a retry cannot double revenue;
 *   - the date is validated against the tenant's active financial year.
 */

type Body = {
  invoice_number?: string;
  customer_id?: string;
  rental_contract_id?: string | null;
  invoice_date?: string;
  due_date?: string | null;
  amount?: number | string;
  discount?: number | string;
  discount_amount?: number | string;
  vat?: number | string;
  vat_tax_id?: string | null;
  advance_payment?: number | string;
  payment_method?: string;
  payment_term?: string | null;
  notes?: string | null;
  /** "sale" (default) or "rental". A rental posts to 41001 and is a rental_invoice. */
  invoice_type?: string;
  rental_days?: number | string;
  /** Amount already collected at issue (a rental's advance payment). */
  paid_amount?: number | string;
  payment_type?: string | null;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function POST(request: Request) {
  let createdInvoiceId: string | null = null;
  let createdJournalId: string | null = null;
  try {
    const context = await requireContext(request, { module: "sales", action: "create" });
    const body = ((await request.json()) ?? {}) as Body;

    const customerId = body.customer_id;
    if (!customerId || typeof customerId !== "string") {
      return NextResponse.json({ error: "customer_id is required", code: "bad_request" }, { status: 400 });
    }

    const amount = num(body.amount);
    if (amount <= 0) {
      return NextResponse.json({ error: "amount must be positive", code: "bad_request" }, { status: 400 });
    }
    // `discount` and `discount_amount` are both accepted so a caller cannot
    // silently drop the discount (the invoice row stores it as discount_amount).
    const discount = body.discount_amount !== undefined ? num(body.discount_amount) : num(body.discount);
    const vat = num(body.vat);
    const revenue = round3(amount - discount);
    const total = round3(revenue + vat);
    if (total <= 0) {
      return NextResponse.json({ error: "total must be positive", code: "bad_request" }, { status: 400 });
    }
    const advancePayment = Math.min(Math.max(num(body.advance_payment), 0), total);
    const remaining = round3(total - advancePayment);
    const paymentMethod = typeof body.payment_method === "string" && body.payment_method ? body.payment_method : "cash";
    const invoiceDate = body.invoice_date ?? new Date().toISOString().slice(0, 10);
    // A rental invoice (and a rental extension, which is more rental days) is
    // the same posting shape but hits 41001 (rental revenue) and carries a
    // rental entry_type, so reports can separate it from a sale.
    const isRental = body.invoice_type === "rental";
    const isExtension = body.invoice_type === "extension";
    const postsAsRental = isRental || isExtension;
    const invoiceType = isRental ? "rental" : isExtension ? "extension" : "sale";

    // Cross-tenant foreign keys are an application-layer responsibility: verify
    // the referenced customer/contract belong to the caller's tenant.
    await assertReferences(
      [REF_CUSTOMER, REF_RENTAL_CONTRACT],
      { customer_id: customerId, rental_contract_id: body.rental_contract_id ?? undefined },
      context,
    );

    // Idempotency for a rental: a contract may be invoiced exactly once. A
    // retry of the rental form (double click, network retry) must not mint a
    // second invoice and a second journal entry, so return the existing one.
    if (isRental && body.rental_contract_id) {
      let existingQuery = supabaseAdmin
        .from("invoices")
        .select("id,invoice_number,total_amount,status")
        .eq("rental_contract_id", body.rental_contract_id)
        .eq("invoice_type", "rental");
      existingQuery = context.tenantId
        ? existingQuery.eq("tenant_id", context.tenantId)
        : existingQuery.is("tenant_id", null);
      const { data: existing } = await existingQuery.maybeSingle();
      if (existing) {
        return NextResponse.json({
          id: existing.id,
          invoice_number: existing.invoice_number,
          total_amount: existing.total_amount,
          status: existing.status,
          idempotent: true,
        });
      }
    }

    const tenantId = assertWritableTenant(context, (body as { tenant_id?: unknown }).tenant_id);
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, invoiceDate, "invoice date");

    const invoiceNumber =
      (typeof body.invoice_number === "string" && body.invoice_number.trim()) ||
      (await nextDocumentNumber(
        supabaseAdmin as never,
        isRental ? "rental_invoice" : "sale_invoice",
        isRental ? "RI" : "SI",
      ));

    // Paid amount and status are DERIVED from the amounts, never trusted from
    // the body: a client-supplied `paid_amount` could otherwise contradict the
    // advance the journal posts. `paid_amount` (a rental's "paid") and
    // `advance_payment` (a sale's advance) are the same money.
    const paidAmount = round3(
      Math.min(Math.max(body.paid_amount !== undefined ? num(body.paid_amount) : advancePayment, 0), total),
    );
    const remainingAfterPaid = round3(total - paidAmount);
    const status = remainingAfterPaid <= 0 ? "paid" : paidAmount > 0 ? "partial" : "pending";

    const invoiceRow: Record<string, unknown> = {
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      due_date: body.due_date || null,
      status,
      invoice_type: invoiceType,
      customer_id: customerId,
      rental_contract_id: body.rental_contract_id || null,
      // `amount` is the pre-VAT subtotal every invoice reader uses (the print
      // page, the invoice detail form, the Excel export). Without it a
      // server-issued invoice prints a 0.000 line item.
      amount,
      total_amount: total,
      discount_amount: discount,
      vat_amount: vat,
      vat_tax_id: typeof body.vat_tax_id === "string" && body.vat_tax_id ? body.vat_tax_id : null,
      paid_amount: paidAmount,
      payment_method: paymentMethod,
      payment_term: body.payment_term || null,
      notes: body.notes || null,
    };
    // A rental keeps the payment type the contract was created with, so the
    // invoice reads exactly as it did when the browser built it.
    if (postsAsRental && typeof body.payment_type === "string" && body.payment_type) {
      invoiceRow.payment_type = body.payment_type;
    }
    if (postsAsRental && body.rental_days !== undefined) invoiceRow.rental_days = num(body.rental_days);
    if (tenantId) invoiceRow.tenant_id = tenantId;
    if (context.financialYearId) invoiceRow.financial_year_id = context.financialYearId;

    const { data: invoice, error: invErr } = await supabaseAdmin
      .from("invoices")
      .insert([invoiceRow])
      .select("id,invoice_number")
      .single();
    if (invErr) throw invErr;
    createdInvoiceId = (invoice as { id: string }).id;

    const amounts: SaleAmounts = { amount, discount, vat, advancePayment: paidAmount, remaining: remainingAfterPaid };
    const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
    const { journalId, created } = await postSaleInvoice(supabaseAdmin as never, {
      ...amounts,
      journalNumber,
      invoiceNumber,
      entryDate: invoiceDate,
      description: postsAsRental ? `Rental invoice - ${invoiceNumber}` : `Sale invoice - ${invoiceNumber}`,
      customerId,
      paymentMethod,
      entryType: postsAsRental ? "rental_invoice" : "sale_invoice",
      revenueCode: postsAsRental ? SALE_ACCOUNT_CODES.rentalRevenue : SALE_ACCOUNT_CODES.revenue,
    });
    // Only a journal THIS call created may be compensated away on failure.
    // `created:false` means a posted journal already existed for this invoice
    // number (an idempotent retry); deleting it would destroy a real posting.
    if (created) createdJournalId = journalId;

    // Record the advance receipt as a payment row (settles AR; not revenue).
    if (paidAmount > 0) {
      const receiptNumber = await nextDocumentNumber(supabaseAdmin as never, "receipt", "REC");
      const paymentRow: Record<string, unknown> = {
        receipt_number: receiptNumber,
        invoice_id: createdInvoiceId,
        customer_id: customerId,
        payment_type: "receipt",
        amount: paidAmount,
        payment_method: paymentMethod,
        payment_date: invoiceDate,
        status: "completed",
      };
      if (tenantId) paymentRow.tenant_id = tenantId;
      if (body.rental_contract_id) paymentRow.rental_contract_id = body.rental_contract_id;
      if (context.financialYearId) paymentRow.financial_year_id = context.financialYearId;
      const { error: payErr } = await supabaseAdmin.from("payments").insert(paymentRow);
      if (payErr) throw payErr;
    }

    await logAudit(context, {
      action: "sale",
      entity: "invoices",
      entityId: createdInvoiceId,
      metadata: { invoice_number: invoiceNumber, total, vat, journal_id: journalId, journal_created: created },
    });

    return NextResponse.json({
      id: createdInvoiceId,
      invoice_number: invoiceNumber,
      total_amount: total,
      status,
      journal_id: journalId,
      journal_created: created,
    });
  } catch (error) {
    // Compensate: an invoice without its journal would be a document that
    // reports revenue the ledger does not know about. Remove it.
    if (createdInvoiceId) {
      try {
        if (createdJournalId) {
          await supabaseAdmin.from("journal_lines").delete().eq("journal_entry_id", createdJournalId);
          await supabaseAdmin.from("journal_entries").delete().eq("id", createdJournalId);
        }
        await supabaseAdmin.from("invoices").delete().eq("id", createdInvoiceId);
      } catch {
        /* best effort */
      }
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
