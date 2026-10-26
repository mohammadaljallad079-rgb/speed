import type { AuthContext } from "@/lib/auth/types";
import {
  assertDateInOpenFinancialYear,
  assertReferences,
  assertWritableTenant,
  getActiveFinancialYear,
  REF_CUSTOMER,
  REF_INVOICE,
  REF_RENTAL_CONTRACT,
} from "@/lib/auth";
import { nextDocumentNumber } from "@/lib/numbering";
import { buildReceiptJournal, cashBankCodeForMethod, RECEIPT_ACCOUNT_CODES } from "@/lib/accounting/receipt-posting";
import { resolveAccountIdsForTenant, type AccountClient } from "@/lib/accounting/account-resolution";

/**
 * The single server-side customer-receipt service.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three browser pages recorded a customer receipt by writing to `payments`,
 * updating `invoices.paid_amount` and then posting the journal - three separate
 * HTTP requests from the browser, with the GL posting wrapped in a `try/catch`
 * that only showed an alert. A failure in the journal call therefore left a
 * receipt that was recorded but not posted, and the page still said "Payment
 * recorded successfully". That is the release-blocking defect: the ledger and
 * the payments list disagreed, and the user was told the opposite.
 *
 * A browser cannot fix this. Only the server can make the three writes one
 * transaction, and only the server can be trusted with the tenant.
 *
 * WHAT IT GUARANTEES
 * ------------------
 *   * Identity, tenant and permissions come from the AuthContext the caller
 *     resolved from the session - never from the request body.
 *   * The customer, the contract and the invoice are verified to belong to the
 *     caller's tenant BEFORE any write.
 *   * The payment row, the journal and the invoice settlement are written by ONE
 *     database function (`post_customer_receipt`, migration 015) in ONE
 *     transaction. There is no window in which a receipt exists without its
 *     journal.
 *   * It is idempotent by receipt number: a retry returns the existing receipt
 *     rather than recording a second one, and the database's tenant-scoped
 *     unique index is the backstop if two requests race.
 *   * It refuses an overpayment rather than silently accepting one.
 */

export interface ReceiptDb {
  from(table: string): any;
  rpc?(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export type RecordReceiptInput = {
  receipt_number?: string;
  customer_id: string;
  invoice_id?: string | null;
  rental_contract_id?: string | null;
  amount: number | string;
  payment_method?: string;
  payment_date?: string;
  payment_type?: string | null;
  notes?: string | null;
  car_plate?: string | null;
  /** Ignored when it contradicts the session; kept only for parity with the route. */
  tenant_id?: unknown;
};

export type RecordReceiptResult = {
  payment_id: string;
  receipt_number: string;
  amount: number;
  journal_id: string | null;
  invoice_id: string | null;
  invoice_paid_amount: number | null;
  invoice_status: string | null;
  idempotent: boolean;
};

/**
 * The two checks that reach the database outside the injected client. Both are
 * injectable so the workflow can be exercised against a stub - the same
 * dependency-injection rule the rest of the accounting services follow.
 */
export interface ReceiptDeps {
  /** Verifies each reference belongs to the caller's company. */
  assertRefs?: typeof assertReferences;
  /** The caller's active financial year, or null when none is configured. */
  getYear?: typeof getActiveFinancialYear;
}

const DEFAULT_DEPS: Required<ReceiptDeps> = {
  assertRefs: assertReferences,
  getYear: getActiveFinancialYear,
};

export class ReceiptError extends Error {
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
const msg = (e: unknown) => String((e as { message?: string })?.message ?? e);

/** Postgres raised by the atomic function - recognisable, and safe to surface. */
function isAtomicRpcUnavailable(error: unknown): boolean {
  const e = error as { code?: string; status?: number; message?: string } | null;
  if (!e) return false;
  if (e.code === "PGRST202" || e.code === "404") return true;
  if (e.status === 404) return true;
  const m = String(e.message ?? "").toLowerCase();
  return m.includes("could not find the function") || m.includes("does not exist");
}

/**
 * Records a customer receipt: the payment, its ledger posting and the invoice
 * settlement, atomically.
 */
export async function recordReceipt(
  db: ReceiptDb,
  context: AuthContext,
  input: RecordReceiptInput,
  deps: ReceiptDeps = {},
): Promise<RecordReceiptResult> {
  const { assertRefs, getYear } = { ...DEFAULT_DEPS, ...deps };
  const customerId = input.customer_id;
  if (!customerId || typeof customerId !== "string") {
    throw new ReceiptError("bad_request", "customer_id is required");
  }

  const amount = round3(num(input.amount));
  if (amount <= 0) throw new ReceiptError("bad_request", "amount must be positive");

  const paymentDate = input.payment_date ?? new Date().toISOString().slice(0, 10);
  const paymentMethod = input.payment_method || "cash";
  const paymentType = input.payment_type || "receipt";
  const invoiceId = typeof input.invoice_id === "string" && input.invoice_id ? input.invoice_id : null;
  const contractId =
    typeof input.rental_contract_id === "string" && input.rental_contract_id ? input.rental_contract_id : null;

  // Every reference must belong to the caller's tenant. This is the check the
  // browser could not make and did not make: a crafted customer_id/invoice_id
  // pointing at another company's row is rejected here.
  await assertRefs(
    [REF_CUSTOMER, REF_INVOICE, REF_RENTAL_CONTRACT],
    { customer_id: customerId, invoice_id: invoiceId ?? undefined, rental_contract_id: contractId ?? undefined },
    context,
  );

  const tenantId = assertWritableTenant(context, input.tenant_id);

  // Financial-year guard: the same one /api/invoices applies. A tenant with no
  // configured year is skipped (backward compatible).
  const year = await getYear(context.tenantId);
  assertDateInOpenFinancialYear(year, paymentDate, "payment date");

  // ---- Load the invoice, tenant-scoped, to validate the settlement. ---------
  let invoiceTotal = 0;
  let invoicePaid = 0;
  if (invoiceId) {
    let invQuery = db
      .from("invoices")
      .select("id,invoice_number,total_amount,paid_amount,status")
      .eq("id", invoiceId);
    invQuery = context.tenantId ? invQuery.eq("tenant_id", context.tenantId) : invQuery.is("tenant_id", null);
    const { data: invoice, error: invErr } = await invQuery.maybeSingle();
    if (invErr) throw invErr;
    if (!invoice) throw new ReceiptError("not_found", "The invoice does not belong to this company.");
    invoiceTotal = round3(num(invoice.total_amount));
    invoicePaid = round3(num(invoice.paid_amount));
    const remaining = round3(invoiceTotal - invoicePaid);
    // An overpayment is refused rather than silently accepted: it would settle
    // the receivable past zero and leave a negative balance no report explains.
    if (amount > remaining + 0.001) {
      throw new ReceiptError(
        "overpayment",
        `The amount (${amount}) exceeds the outstanding balance (${remaining}) on invoice ${invoice.invoice_number}.`,
      );
    }
  }

  // ---- Resolve the accounts the journal will post to. ----------------------
  const cashCode = cashBankCodeForMethod(paymentMethod);
  const ids = await resolveAccountIdsForTenant(
    db as unknown as AccountClient,
    [cashCode, RECEIPT_ACCOUNT_CODES.ar],
    context.tenantId,
  );
  const cashAccountId = ids[cashCode];
  const arAccountId = ids[RECEIPT_ACCOUNT_CODES.ar];
  if (!cashAccountId || !arAccountId) {
    throw new ReceiptError(
      "account_missing",
      "The cash/bank or accounts-receivable account could not be resolved for this company.",
    );
  }

  // ---- Idempotency: has this receipt number already been recorded? ---------
  const receiptNumber =
    (typeof input.receipt_number === "string" && input.receipt_number.trim()) ||
    (await nextDocumentNumber(db as never, "receipt", "REC"));

  {
    let existingQuery = db
      .from("payments")
      .select("id,receipt_number,amount,invoice_id")
      .eq("receipt_number", receiptNumber);
    existingQuery = context.tenantId
      ? existingQuery.eq("tenant_id", context.tenantId)
      : existingQuery.is("tenant_id", null);
    const { data: existing } = await existingQuery.maybeSingle();
    if (existing) {
      return {
        payment_id: existing.id,
        receipt_number: existing.receipt_number,
        amount: round3(num(existing.amount)),
        journal_id: null,
        invoice_id: existing.invoice_id ?? null,
        invoice_paid_amount: null,
        invoice_status: null,
        idempotent: true,
      };
    }
  }

  const journalNumber = await nextDocumentNumber(db as never, "journal_entry", "JV");
  const description = `Payment received - ${receiptNumber}`;
  const journal = buildReceiptJournal({
    journalNumber,
    receiptNumber,
    amount,
    paymentDate,
    description,
    cashAccountId,
    arAccountId,
  });
  if (!journal) throw new ReceiptError("bad_request", "Cannot build a balanced receipt journal.");

  const paymentRow: Record<string, unknown> = {
    receipt_number: receiptNumber,
    customer_id: customerId,
    invoice_id: invoiceId,
    amount,
    payment_method: paymentMethod,
    payment_date: paymentDate,
    payment_type: paymentType,
    notes: input.notes ?? null,
    status: "completed",
  };
  if (contractId) paymentRow.rental_contract_id = contractId;
  if (input.car_plate) paymentRow.car_plate = input.car_plate;
  if (tenantId) paymentRow.tenant_id = tenantId;
  if (context.financialYearId) paymentRow.financial_year_id = context.financialYearId;

  // ---- ONE atomic call: payment + journal + settlement. --------------------
  // The header/lines carry the tenant, so the hardened post_journal_entry
  // re-verifies every account against this company.
  const header = { ...journal.header, tenant_id: tenantId ?? undefined };
  const lines = journal.lines.map((l) => ({ ...l, tenant_id: tenantId ?? undefined }));

  if (typeof db.rpc !== "function") {
    throw new ReceiptError(
      "rpc_unavailable",
      "The atomic receipt function is not available; a receipt may not be recorded without its ledger posting.",
    );
  }

  const { data, error } = await db.rpc("post_customer_receipt", {
    p_payment: paymentRow,
    p_header: header,
    p_lines: lines,
  });

  if (error) {
    if (isAtomicRpcUnavailable(error)) {
      throw new ReceiptError(
        "rpc_unavailable",
        "The atomic receipt function (post_customer_receipt) is not deployed; apply migration 015. " +
          "A receipt may not be recorded without its ledger posting.",
      );
    }
    throw new ReceiptError("posting_failed", msg(error));
  }

  const result = (data ?? {}) as {
    payment_id?: string;
    journal_id?: string;
    invoice_paid_amount?: number | string | null;
    invoice_status?: string | null;
  };
  if (!result.payment_id || !result.journal_id) {
    throw new ReceiptError("posting_failed", "The receipt was not fully written (no payment id or journal id).");
  }

  return {
    payment_id: result.payment_id,
    receipt_number: receiptNumber,
    amount,
    journal_id: result.journal_id,
    invoice_id: invoiceId,
    invoice_paid_amount: result.invoice_paid_amount == null ? null : round3(num(result.invoice_paid_amount)),
    invoice_status: result.invoice_status ?? null,
    idempotent: false,
  };
}
