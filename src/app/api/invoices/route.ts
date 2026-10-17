import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import {
  postSaleInvoice,
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
  vat?: number | string;
  advance_payment?: number | string;
  payment_method?: string;
  payment_term?: string | null;
  notes?: string | null;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function POST(request: Request) {
  let createdInvoiceId: string | null = null;
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
    const discount = num(body.discount);
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

    // Cross-tenant foreign keys are an application-layer responsibility: verify
    // the referenced customer/contract belong to the caller's tenant.
    await assertReferences(
      [REF_CUSTOMER, REF_RENTAL_CONTRACT],
      { customer_id: customerId, rental_contract_id: body.rental_contract_id ?? undefined },
      context,
    );

    const tenantId = assertWritableTenant(context, (body as { tenant_id?: unknown }).tenant_id);
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, invoiceDate, "invoice date");

    const invoiceNumber =
      (typeof body.invoice_number === "string" && body.invoice_number.trim()) ||
      (await nextDocumentNumber(supabaseAdmin as never, "sale_invoice", "SI"));

    const status = advancePayment <= 0 ? "pending" : remaining <= 0 ? "paid" : "partial";

    const invoiceRow: Record<string, unknown> = {
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      due_date: body.due_date || null,
      status,
      invoice_type: "sale",
      customer_id: customerId,
      rental_contract_id: body.rental_contract_id || null,
      total_amount: total,
      discount_amount: discount,
      vat_amount: vat,
      paid_amount: 0,
      payment_method: paymentMethod,
      payment_term: body.payment_term || null,
      notes: body.notes || null,
    };
    if (tenantId) invoiceRow.tenant_id = tenantId;
    if (context.financialYearId) invoiceRow.financial_year_id = context.financialYearId;

    const { data: invoice, error: invErr } = await supabaseAdmin
      .from("invoices")
      .insert([invoiceRow])
      .select("id,invoice_number")
      .single();
    if (invErr) throw invErr;
    createdInvoiceId = (invoice as { id: string }).id;

    const amounts: SaleAmounts = { amount, discount, vat, advancePayment, remaining };
    const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
    const { journalId, created } = await postSaleInvoice(supabaseAdmin as never, {
      ...amounts,
      journalNumber,
      invoiceNumber,
      entryDate: invoiceDate,
      description: `Sale invoice - ${invoiceNumber}`,
      customerId,
      paymentMethod,
    });

    // Record the advance receipt as a payment row (settles AR; not revenue).
    if (advancePayment > 0) {
      const receiptNumber = await nextDocumentNumber(supabaseAdmin as never, "receipt", "REC");
      const paymentRow: Record<string, unknown> = {
        receipt_number: receiptNumber,
        invoice_id: createdInvoiceId,
        customer_id: customerId,
        payment_type: "receipt",
        amount: advancePayment,
        payment_method: paymentMethod,
        payment_date: invoiceDate,
        status: "completed",
      };
      if (tenantId) paymentRow.tenant_id = tenantId;
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
        await supabaseAdmin.from("invoices").delete().eq("id", createdInvoiceId);
      } catch {
        /* best effort */
      }
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
