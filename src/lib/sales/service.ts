import type { AuthContext } from "@/lib/auth/types";
import {
  assertDateInOpenFinancialYear,
  assertReferences,
  assertWritableTenant,
  getActiveFinancialYear,
  REF_CUSTOMER,
  REF_RENTAL_CONTRACT,
} from "@/lib/auth";
import { nextDocumentNumber } from "@/lib/numbering";
import { postSaleInvoice, SALE_ACCOUNT_CODES, type SaleAmounts } from "@/lib/accounting/sales-posting";

/**
 * The single server-side sale/rental invoice issue service.
 *
 * This is the ONE path that mints a sale or rental invoice. The HTTP route
 * (`POST /api/invoices`) and the AI agent both call it, so an invoice created by
 * the agent cannot take a different route through the ledger than one created by
 * the form. Everything that used to be duplicated between callers lives here:
 * reference checks, the financial-year guard, row-locked numbering, the
 * invoice+journal atomic pair, the derived paid amount/status and the advance
 * receipt.
 *
 * Identity, tenant and permissions are never parameters — they come from the
 * `AuthContext` the caller resolved from the session.
 */

export interface SalesDb {
  from(table: string): any;
}

export type IssueInvoiceInput = {
  customer_id: string;
  rental_contract_id?: string | null;
  invoice_number?: string;
  invoice_date?: string;
  due_date?: string | null;
  amount: number | string;
  discount?: number | string;
  discount_amount?: number | string;
  vat?: number | string;
  vat_tax_id?: string | null;
  advance_payment?: number | string;
  paid_amount?: number | string;
  payment_method?: string;
  payment_term?: string | null;
  notes?: string | null;
  invoice_type?: string;
  rental_days?: number | string;
  payment_type?: string | null;
  /** Ignored when it contradicts the session; kept only for parity with the route. */
  tenant_id?: unknown;
};

export type IssueInvoiceResult = {
  id: string;
  invoice_number: string;
  total_amount: number;
  status: string;
  journal_id?: string;
  journal_created?: boolean;
  idempotent?: boolean;
};

export class SalesError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Issues a sale or rental invoice, together with its balanced journal.
 *
 * Idempotent for a rental by contract id: a retry returns the existing invoice
 * rather than minting a second one and a second journal.
 */
export async function issueInvoice(
  db: SalesDb,
  context: AuthContext,
  input: IssueInvoiceInput,
): Promise<IssueInvoiceResult> {
  const customerId = input.customer_id;
  if (!customerId || typeof customerId !== "string") {
    throw new SalesError("bad_request", "customer_id is required");
  }

  const amount = num(input.amount);
  if (amount <= 0) throw new SalesError("bad_request", "amount must be positive");

  const discount = input.discount_amount !== undefined ? num(input.discount_amount) : num(input.discount);
  const vat = num(input.vat);
  const revenue = round3(amount - discount);
  const total = round3(revenue + vat);
  if (total <= 0) throw new SalesError("bad_request", "total must be positive");

  const advancePayment = Math.min(Math.max(num(input.advance_payment), 0), total);
  const paymentMethod = input.payment_method || "cash";
  const invoiceDate = input.invoice_date ?? new Date().toISOString().slice(0, 10);

  const isRental = input.invoice_type === "rental";
  const isExtension = input.invoice_type === "extension";
  const postsAsRental = isRental || isExtension;
  const invoiceType = isRental ? "rental" : isExtension ? "extension" : "sale";

  await assertReferences(
    [REF_CUSTOMER, REF_RENTAL_CONTRACT],
    { customer_id: customerId, rental_contract_id: input.rental_contract_id ?? undefined },
    context,
  );

  // A contract may be invoiced exactly once as a rental: a retry (double click,
  // network retry, agent re-run) must not mint a second invoice + journal.
  if (isRental && input.rental_contract_id) {
    let existingQuery = db
      .from("invoices")
      .select("id,invoice_number,total_amount,status")
      .eq("rental_contract_id", input.rental_contract_id)
      .eq("invoice_type", "rental");
    existingQuery = context.tenantId
      ? existingQuery.eq("tenant_id", context.tenantId)
      : existingQuery.is("tenant_id", null);
    const { data: existing } = await existingQuery.maybeSingle();
    if (existing) {
      return {
        id: existing.id,
        invoice_number: existing.invoice_number,
        total_amount: existing.total_amount,
        status: existing.status,
        idempotent: true,
      };
    }
  }

  const tenantId = assertWritableTenant(context, input.tenant_id);
  const year = await getActiveFinancialYear(context.tenantId);
  assertDateInOpenFinancialYear(year, invoiceDate, "invoice date");

  const invoiceNumber =
    (typeof input.invoice_number === "string" && input.invoice_number.trim()) ||
    (await nextDocumentNumber(
      db as never,
      isRental ? "rental_invoice" : "sale_invoice",
      isRental ? "RI" : "SI",
    ));

  // Paid amount and status are DERIVED, never trusted: a caller-supplied
  // paid_amount could otherwise contradict the advance the journal posts.
  const paidAmount = round3(
    Math.min(Math.max(input.paid_amount !== undefined ? num(input.paid_amount) : advancePayment, 0), total),
  );
  const remainingAfterPaid = round3(total - paidAmount);
  const status = remainingAfterPaid <= 0 ? "paid" : paidAmount > 0 ? "partial" : "pending";

  const invoiceRow: Record<string, unknown> = {
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    due_date: input.due_date || null,
    status,
    invoice_type: invoiceType,
    customer_id: customerId,
    rental_contract_id: input.rental_contract_id || null,
    amount,
    total_amount: total,
    discount_amount: discount,
    vat_amount: vat,
    vat_tax_id: typeof input.vat_tax_id === "string" && input.vat_tax_id ? input.vat_tax_id : null,
    paid_amount: paidAmount,
    payment_method: paymentMethod,
    payment_term: input.payment_term || null,
    notes: input.notes || null,
  };
  if (postsAsRental && typeof input.payment_type === "string" && input.payment_type) {
    invoiceRow.payment_type = input.payment_type;
  }
  if (postsAsRental && input.rental_days !== undefined) invoiceRow.rental_days = num(input.rental_days);
  if (tenantId) invoiceRow.tenant_id = tenantId;
  if (context.financialYearId) invoiceRow.financial_year_id = context.financialYearId;

  let createdInvoiceId: string | null = null;
  let createdJournalId: string | null = null;
  try {
    const { data: invoice, error: invErr } = await db
      .from("invoices")
      .insert([invoiceRow])
      .select("id,invoice_number")
      .single();
    if (invErr) throw invErr;
    const invoiceId: string = invoice.id;
    createdInvoiceId = invoiceId;

    const amounts: SaleAmounts = { amount, discount, vat, advancePayment: paidAmount, remaining: remainingAfterPaid };
    const journalNumber = await nextDocumentNumber(db as never, "journal_entry", "JV");
    const { journalId, created } = await postSaleInvoice(db as never, {
      ...amounts,
      journalNumber,
      invoiceNumber,
      entryDate: invoiceDate,
      description: postsAsRental ? `Rental invoice - ${invoiceNumber}` : `Sale invoice - ${invoiceNumber}`,
      customerId,
      paymentMethod,
      entryType: postsAsRental ? "rental_invoice" : "sale_invoice",
      revenueCode: postsAsRental ? SALE_ACCOUNT_CODES.rentalRevenue : SALE_ACCOUNT_CODES.revenue,
      tenantId,
    });
    // Only a journal THIS call created may be compensated away on failure: a
    // `created:false` journal already existed and deleting it would destroy a
    // real posting.
    if (created) createdJournalId = journalId;

    if (paidAmount > 0) {
      const receiptNumber = await nextDocumentNumber(db as never, "receipt", "REC");
      const paymentRow: Record<string, unknown> = {
        receipt_number: receiptNumber,
        invoice_id: invoiceId,
        customer_id: customerId,
        payment_type: "receipt",
        amount: paidAmount,
        payment_method: paymentMethod,
        payment_date: invoiceDate,
        status: "completed",
      };
      if (tenantId) paymentRow.tenant_id = tenantId;
      if (input.rental_contract_id) paymentRow.rental_contract_id = input.rental_contract_id;
      if (context.financialYearId) paymentRow.financial_year_id = context.financialYearId;
      const { error: payErr } = await db.from("payments").insert(paymentRow);
      if (payErr) throw payErr;
    }

    return {
      id: invoiceId,
      invoice_number: invoiceNumber,
      total_amount: total,
      status,
      journal_id: journalId,
      journal_created: created,
    };
  } catch (error) {
    // An invoice without its journal reports revenue the ledger never saw.
    if (createdInvoiceId) {
      try {
        if (createdJournalId) {
          await db.from("journal_lines").delete().eq("journal_entry_id", createdJournalId);
          await db.from("journal_entries").delete().eq("id", createdJournalId);
        }
        await db.from("invoices").delete().eq("id", createdInvoiceId);
      } catch {
        /* best effort compensation */
      }
    }
    throw error;
  }
}

/** Reads an invoice the caller may see (own tenant or the tenant-less install). */
export async function loadInvoiceForContext(
  db: SalesDb,
  context: AuthContext,
  invoiceId: string,
): Promise<Record<string, unknown> | null> {
  let query = db
    .from("invoices")
    .select("id,invoice_number,status,amount,total_amount,vat_amount,discount_amount,paid_amount,invoice_date,customer_id,invoice_type")
    .eq("id", invoiceId);
  query = context.tenantId ? query.eq("tenant_id", context.tenantId) : query.is("tenant_id", null);
  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;
  return data as Record<string, unknown>;
}
