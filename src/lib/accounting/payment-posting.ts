/**
 * Supplier-payment posting.
 *
 * A payment to a supplier must reduce accounts payable (AP) and reduce
 * cash/bank - it must never touch revenue. This module owns that single
 * posting, so a supplier payment can never again be recorded in
 * `supplier_payments` without a matching journal (the defect Execution 15
 * found: the page updated the bill's `paid_amount` but wrote no GL entry).
 *
 * The pure builder is separated from the DB call so the debit/credit shape can
 * be unit-tested without a database. The DB call takes an injectable client,
 * mirroring `nextDocumentNumber`, so tests can drive it with a recording stub.
 */

export const AP_ACCOUNT_CODE = "21001";
export const CASH_ACCOUNT_CODE = "11001";
export const BANK_ACCOUNT_CODE = "11002";

/** Cash payments hit the cash account; every other method hits bank. */
export function cashBankCodeForMethod(method: string): string {
  return method === "cash" ? CASH_ACCOUNT_CODE : BANK_ACCOUNT_CODE;
}

export type SupplierPaymentJournalLine = {
  account_id: string;
  debit: number;
  credit: number;
  description: string;
  supplier_id: string;
  line_order: number;
};

export type SupplierPaymentJournal = {
  header: {
    journal_number: string;
    entry_date: string;
    reference_number: string;
    description: string;
    total_debit: number;
    total_credit: number;
    is_balanced: true;
    status: "posted";
    entry_type: "supplier_payment" | "supplier_payment_reversal";
  };
  lines: SupplierPaymentJournalLine[];
};

/**
 * Build the balanced journal for a supplier payment:
 *   Dr Accounts Payable (21001)  amount
 *   Cr Cash / Bank (11001/11002) amount
 * Returns null for a non-positive amount, so a caller can never post a
 * zero-value or negative settlement.
 */
export function buildSupplierPaymentJournal(params: {
  journalNumber: string;
  paymentNumber: string;
  supplierId: string;
  amount: number;
  paymentDate: string;
  description: string;
  apAccountId: string;
  cashAccountId: string;
}): SupplierPaymentJournal | null {
  const { journalNumber, paymentNumber, supplierId, amount, paymentDate, description, apAccountId, cashAccountId } = params;
  if (!(amount > 0) || !apAccountId || !cashAccountId) return null;
  return {
    header: {
      journal_number: journalNumber,
      entry_date: paymentDate,
      reference_number: paymentNumber,
      description,
      total_debit: amount,
      total_credit: amount,
      is_balanced: true,
      status: "posted",
      entry_type: "supplier_payment",
    },
    lines: [
      { account_id: apAccountId, debit: amount, credit: 0, description, supplier_id: supplierId, line_order: 1 },
      { account_id: cashAccountId, debit: 0, credit: amount, description, supplier_id: supplierId, line_order: 2 },
    ],
  };
}

type QueryResult = { data: unknown; error: unknown };
type Builder = {
  select: (cols?: string) => Builder;
  in: (col: string, vals: unknown[]) => Builder;
  insert: (row: unknown) => Builder;
  delete: () => Builder;
  eq: (col: string, val: unknown) => Builder;
  single: () => PromiseLike<QueryResult>;
  then: PromiseLike<QueryResult>["then"];
};
type PostingClient = { from: (table: string) => Builder };

/**
 * Build the mirror journal that reverses a posted supplier payment:
 *   Dr Cash / Bank (11001/11002)  amount
 *   Cr Accounts Payable (21001)   amount
 *
 * A posted payment is never deleted — deleting the rows would erase the fact
 * that money moved. The reversal is its own `entry_type` so both the original
 * and its undoing stay visible in the ledger. Returns null for a non-positive
 * amount or a missing account, so a caller can never post an empty reversal.
 */
export function buildSupplierPaymentReversalJournal(params: {
  journalNumber: string;
  paymentNumber: string;
  supplierId: string;
  amount: number;
  paymentDate: string;
  description: string;
  apAccountId: string;
  cashAccountId: string;
}): SupplierPaymentJournal | null {
  const { journalNumber, paymentNumber, supplierId, amount, paymentDate, description, apAccountId, cashAccountId } = params;
  if (!(amount > 0) || !apAccountId || !cashAccountId) return null;
  return {
    header: {
      journal_number: journalNumber,
      entry_date: paymentDate,
      reference_number: paymentNumber,
      description,
      total_debit: amount,
      total_credit: amount,
      is_balanced: true,
      status: "posted",
      entry_type: "supplier_payment_reversal",
    },
    lines: [
      { account_id: cashAccountId, debit: amount, credit: 0, description, supplier_id: supplierId, line_order: 1 },
      { account_id: apAccountId, debit: 0, credit: amount, description, supplier_id: supplierId, line_order: 2 },
    ],
  };
}

/**
 * Post a supplier payment to the ledger. Resolves AP and cash/bank by their
 * codes (the codes are fixed system accounts, verified against the live chart),
 * then writes the header and the two lines.
 *
 * Throws if the accounts cannot be resolved or either write fails, so the
 * caller can compensate (remove the payment row) rather than leave the payment
 * recorded without its GL entry.
 */
export async function postSupplierPayment(
  client: PostingClient,
  params: {
    journalNumber: string;
    paymentNumber: string;
    supplierId: string;
    amount: number;
    paymentDate: string;
    paymentMethod: string;
    description: string;
  },
): Promise<{ journalId: string }> {
  const cashCode = cashBankCodeForMethod(params.paymentMethod);
  const { data: accounts, error: accErr } = await client
    .from("accounts")
    .select("id,code")
    .in("code", [AP_ACCOUNT_CODE, cashCode]);
  if (accErr) throw new Error("Could not load AP/cash accounts: " + String((accErr as { message?: string }).message ?? accErr));
  const rows = (accounts as Array<{ id: string; code: string }>) || [];
  const apAccountId = rows.find((a) => a.code === AP_ACCOUNT_CODE)?.id;
  const cashAccountId = rows.find((a) => a.code === cashCode)?.id;

  const journal = buildSupplierPaymentJournal({
    journalNumber: params.journalNumber,
    paymentNumber: params.paymentNumber,
    supplierId: params.supplierId,
    amount: params.amount,
    paymentDate: params.paymentDate,
    description: params.description,
    apAccountId: apAccountId as string,
    cashAccountId: cashAccountId as string,
  });
  if (!journal) throw new Error("Cannot post a supplier payment without a positive amount and resolvable accounts.");

  const { data: header, error: headerErr } = await client.from("journal_entries").insert(journal.header).select("id").single();
  if (headerErr) throw headerErr;
  const journalId = (header as { id: string }).id;

  const { error: linesErr } = await client
    .from("journal_lines")
    .insert(journal.lines.map((l) => ({ ...l, journal_entry_id: journalId })));
  if (linesErr) {
    // Best-effort removal of the orphan header so a failed line write does not
    // leave an unbalanced entry behind.
    await client.from("journal_entries").delete().eq("id", journalId);
    throw linesErr;
  }
  return { journalId };
}
