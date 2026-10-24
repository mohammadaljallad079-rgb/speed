import { writeJournal as writeSharedJournal, type PostingClient as SharedPostingClient } from "./manual-posting";

/**
 * Customer-receipt posting (Execution 31).
 *
 * Collecting a sales/rental invoice settles the receivable: it is
 *   Dr Cash / Bank
 *   Cr Accounts Receivable (12001)
 * and it must NEVER credit revenue again - revenue was already recognised when
 * the invoice was issued (`sales-posting.ts`). Two rental pages posted a
 * customer receipt as `Dr Cash / Cr Revenue`, which would double-count revenue,
 * and wrote non-canonical column names (`entry_number`/`date`/`reference_no`)
 * that no report reads. This module is the single, correct posting for a
 * customer receipt, mirroring `payment-posting.ts` (supplier) and
 * `sales-posting.ts` (sale).
 *
 * The pure builder is separated from the DB call so the debit/credit shape can
 * be unit-tested without a database; the DB call takes an injectable client.
 */

export const RECEIPT_ACCOUNT_CODES = {
  cash: "11001",
  bank: "11002",
  ar: "12001",
} as const;

/** Cash hits the cash account; every other method hits bank. */
export function cashBankCodeForMethod(method: string): string {
  return method === "cash" ? RECEIPT_ACCOUNT_CODES.cash : RECEIPT_ACCOUNT_CODES.bank;
}

export type ReceiptJournalLine = {
  account_id: string;
  debit: number;
  credit: number;
  description: string;
  line_order: number;
};

export type ReceiptJournal = {
  header: {
    journal_number: string;
    entry_date: string;
    reference_number: string;
    description: string;
    total_debit: number;
    total_credit: number;
    is_balanced: true;
    status: "posted";
    entry_type: "customer_receipt";
  };
  lines: ReceiptJournalLine[];
};

const money = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

/**
 * Build the balanced journal for a customer receipt:
 *   Dr Cash / Bank   amount
 *   Cr AR (12001)    amount
 * Returns null for a non-positive amount or a missing account, so a caller can
 * never post a zero-value or half-resolved receipt.
 */
export function buildReceiptJournal(params: {
  journalNumber: string;
  receiptNumber: string;
  amount: number;
  paymentDate: string;
  description: string;
  cashAccountId: string;
  arAccountId: string;
}): ReceiptJournal | null {
  const { journalNumber, receiptNumber, amount, paymentDate, description, cashAccountId, arAccountId } = params;
  const value = money(amount);
  if (!(value > 0) || !cashAccountId || !arAccountId) return null;
  return {
    header: {
      journal_number: journalNumber,
      entry_date: paymentDate,
      reference_number: receiptNumber,
      description,
      total_debit: value,
      total_credit: value,
      is_balanced: true,
      status: "posted",
      entry_type: "customer_receipt",
    },
    lines: [
      { account_id: cashAccountId, debit: value, credit: 0, description, line_order: 1 },
      { account_id: arAccountId, debit: 0, credit: value, description, line_order: 2 },
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
export type ReceiptPostingClient = { from: (table: string) => Builder };

const msg = (e: unknown) => String((e as { message?: string })?.message ?? e);

/**
 * Post a customer receipt to the ledger. Resolves cash/bank and AR by their
 * fixed codes, writes the header and the two lines. Throws if an account cannot
 * be resolved or a write fails, so the caller can compensate rather than leave
 * the receipt recorded without its GL entry.
 */
export async function postCustomerReceipt(
  client: ReceiptPostingClient,
  params: {
    journalNumber: string;
    receiptNumber: string;
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
    .in("code", [cashCode, RECEIPT_ACCOUNT_CODES.ar]);
  if (accErr) throw new Error("Could not load cash/AR accounts: " + msg(accErr));
  const rows = (accounts as Array<{ id: string; code: string }>) || [];
  const cashAccountId = rows.find((a) => a.code === cashCode)?.id;
  const arAccountId = rows.find((a) => a.code === RECEIPT_ACCOUNT_CODES.ar)?.id;

  const journal = buildReceiptJournal({
    journalNumber: params.journalNumber,
    receiptNumber: params.receiptNumber,
    amount: params.amount,
    paymentDate: params.paymentDate,
    description: params.description,
    cashAccountId: cashAccountId as string,
    arAccountId: arAccountId as string,
  });
  if (!journal) throw new Error("Cannot post a receipt without a positive amount and resolvable accounts.");

  // Shared atomic writer (migration 011). A private header/lines pair here would
  // be a second posting path with its own orphan window.
  const journalId = await writeSharedJournal(client as unknown as SharedPostingClient, journal);
  return { journalId };
}
