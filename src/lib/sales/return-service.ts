import type { AuthContext } from "@/lib/auth/types";
import {
  assertDateInOpenFinancialYear,
  assertReference,
  assertWritableTenant,
  getActiveFinancialYear,
  REF_INVOICE,
} from "@/lib/auth";
import { nextDocumentNumber } from "@/lib/numbering";
import { postSalesReturn } from "@/lib/accounting/sales-return-posting";

/**
 * The single server-side sales-return service.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/app/sales/returns/page.tsx` recorded a return from the BROWSER as two
 * independent writes - insert `sales_returns`, then update `invoices.paid_amount`
 * and `status` - and posted NO journal at all. The return reduced the invoice's
 * paid amount while the ledger still showed the collection: the receivable was
 * never restored, revenue was never reversed, and the trial balance and balance
 * sheet disagreed with the sales screens. The browser also chose the tenant, and
 * two writes cannot be atomic.
 *
 * WHAT IT GUARANTEES
 * ------------------
 *   * Identity, tenant and permission come from the AuthContext, never the body.
 *   * The invoice is verified to belong to the caller's tenant BEFORE any write.
 *   * The return row, the invoice settlement and the ledger journal are written
 *     together; a failure compensates the writes that already happened, so a
 *     return is never left without its ledger effect.
 *   * It is idempotent by return number: a retry returns the existing return
 *     rather than creating a second one and a second journal.
 *   * A return may not exceed what the customer actually paid, and may not be
 *     taken against an invoice the caller cannot see.
 */

export interface SalesReturnDb {
  from(table: string): any;
}

export type CreateSalesReturnInput = {
  invoice_id: string;
  return_number?: string;
  return_date?: string;
  amount: number | string;
  vat_amount?: number | string;
  reason?: string | null;
  /** Ignored when it contradicts the session; kept only for parity with the route. */
  tenant_id?: unknown;
};

export type CreateSalesReturnResult = {
  id: string;
  return_number: string;
  amount: number;
  journal_id: string | null;
  invoice_id: string;
  invoice_paid_amount: number;
  invoice_status: string;
  idempotent: boolean;
};

export class SalesReturnError extends Error {
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
 * Derive the invoice status after a return.
 *
 * Mirrors the rule the screen used, so the visible status does not change for
 * existing users: nothing left to refund is `returned`, anything else is
 * `partial_return`.
 */
export function statusAfterReturn(newPaid: number): string {
  return round3(newPaid) <= 0 ? "returned" : "partial_return";
}

/** Record a sales return, its invoice settlement and its ledger journal. */
export async function createSalesReturn(
  db: SalesReturnDb,
  context: AuthContext,
  input: CreateSalesReturnInput,
): Promise<CreateSalesReturnResult> {
  const invoiceId = input.invoice_id;
  if (!invoiceId || typeof invoiceId !== "string") {
    throw new SalesReturnError("bad_request", "invoice_id is required");
  }
  const amount = round3(num(input.amount));
  if (!(amount > 0)) throw new SalesReturnError("bad_request", "amount must be greater than zero");
  const vatAmount = round3(Math.max(num(input.vat_amount), 0));
  if (vatAmount >= amount) {
    throw new SalesReturnError("bad_request", "vat_amount must be less than the return amount");
  }
  const returnDate = input.return_date ?? new Date().toISOString().slice(0, 10);

  // The invoice must belong to the caller's company. `assertReference` applies
  // the tenant scope in the query, so a foreign invoice id is a 422 rather than
  // a row the caller can read.
  await assertReference(REF_INVOICE, invoiceId, context, db as never);

  let invoiceQuery = db
    .from("invoices")
    .select("id,invoice_number,customer_id,paid_amount,total_amount,status")
    .eq("id", invoiceId);
  invoiceQuery = context.tenantId
    ? invoiceQuery.eq("tenant_id", context.tenantId)
    : invoiceQuery.is("tenant_id", null);
  const { data: invoice, error: invReadErr } = await invoiceQuery.maybeSingle();
  if (invReadErr) throw invReadErr;
  if (!invoice) throw new SalesReturnError("not_found", "Invoice not found");

  const invoiceNumber = String(invoice.invoice_number ?? "");
  const paidAmount = round3(num(invoice.paid_amount));
  const customerId = invoice.customer_id ?? null;

  const tenantId = assertWritableTenant(context, input.tenant_id);
  const year = await getActiveFinancialYear(context.tenantId);
  assertDateInOpenFinancialYear(year, returnDate, "return date");

  const returnNumber =
    (typeof input.return_number === "string" && input.return_number.trim()) ||
    (await nextDocumentNumber(db as never, "sales_return", "SR"));

  // Idempotency comes FIRST, before the amount guard. A retry of a legitimate
  // return arrives after the first attempt already reduced the invoice's paid
  // amount, so checking the amount first would refuse the retry with a
  // misleading "exceeds the amount paid" error instead of reporting the return
  // that already exists.
  let existingQuery = db
    .from("sales_returns")
    .select("id,return_number,amount,invoice_id")
    .eq("return_number", returnNumber);
  existingQuery = context.tenantId
    ? existingQuery.eq("tenant_id", context.tenantId)
    : existingQuery.is("tenant_id", null);
  const { data: existing } = await existingQuery.maybeSingle();
  if (existing) {
    return {
      id: String(existing.id),
      return_number: String(existing.return_number ?? returnNumber),
      amount: round3(num(existing.amount)),
      journal_id: null,
      invoice_id: invoiceId,
      invoice_paid_amount: paidAmount,
      invoice_status: String(invoice.status ?? ""),
      idempotent: true,
    };
  }

  if (amount > paidAmount) {
    throw new SalesReturnError(
      "bad_request",
      "The return amount cannot exceed the amount the customer has paid on this invoice.",
    );
  }

  const returnRow: Record<string, unknown> = {
    invoice_id: invoiceId,
    invoice_number: invoiceNumber,
    customer_id: customerId,
    return_number: returnNumber,
    return_date: returnDate,
    amount,
    vat_amount: vatAmount,
    reason: input.reason || null,
    status: "pending",
  };
  if (tenantId) returnRow.tenant_id = tenantId;
  if (context.financialYearId) returnRow.financial_year_id = context.financialYearId;

  const newPaid = round3(Math.max(0, paidAmount - amount));
  const newStatus = statusAfterReturn(newPaid);

  let createdReturnId: string | null = null;
  let createdJournalId: string | null = null;
  try {
    const { data: ret, error: retErr } = await db
      .from("sales_returns")
      .insert([returnRow])
      .select("id")
      .single();
    if (retErr) throw retErr;
    createdReturnId = (ret as { id: string }).id;

    // The journal goes BEFORE the invoice settlement: if the posting fails, the
    // invoice's paid amount is still intact and only the return row needs to be
    // removed. Doing it the other way round would leave a reduced paid amount
    // with no journal - the exact defect this service closes.
    const journalNumber = await nextDocumentNumber(db as never, "journal_entry", "JV");
    const posted = await postSalesReturn(db as never, {
      journalNumber,
      returnNumber,
      date: returnDate,
      description: `Sales return - ${returnNumber} (invoice ${invoiceNumber})`,
      amount,
      vatAmount,
      tenantId,
    });
    if (posted.created) createdJournalId = posted.journalId;

    const { error: updErr } = await db
      .from("invoices")
      .update({ paid_amount: newPaid, status: newStatus })
      .eq("id", invoiceId);
    if (updErr) throw updErr;

    return {
      id: createdReturnId,
      return_number: returnNumber,
      amount,
      journal_id: createdJournalId,
      invoice_id: invoiceId,
      invoice_paid_amount: newPaid,
      invoice_status: newStatus,
      idempotent: false,
    };
  } catch (error) {
    // Compensate: remove the return row and the journal this call created. The
    // invoice settlement is the last write, so it never needs undoing here.
    if (createdJournalId) {
      try {
        await db.from("journal_entries").delete().eq("id", createdJournalId);
      } catch {
        /* best effort */
      }
    }
    if (createdReturnId) {
      try {
        await db.from("sales_returns").delete().eq("id", createdReturnId);
      } catch {
        /* best effort */
      }
    }
    throw error;
  }
}
