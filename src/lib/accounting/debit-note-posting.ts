/**
 * Debit-note posting.
 *
 * A supplier debit note is the mirror of a supplier bill: the supplier owes the
 * company (a return, a price correction, a credit). Execution 54 found the
 * screen inserted `debit_notes` from the browser with NO journal at all, so a
 * debit note reduced nothing in the ledger while `supplier-statements` and the
 * purchases dashboard still showed it — the books and the screens disagreed.
 *
 * This module owns the one journal a debit note posts:
 *
 *   Dr Accounts Payable (21001)              amount
 *       Cr expense / asset account                       taxable
 *       Cr Input VAT (24001)                             vat   (when resolvable)
 *
 * The credit side is the account the original bill debited, so a debit note
 * cancels exactly what the purchase charged. When the chart has no input-VAT
 * account the whole amount is credited to the expense account instead — the same
 * "fall back rather than invent an account" rule the sales-return path uses for
 * account 41003. Either way the entry balances or nothing is written.
 *
 * The pure builder is separated from the DB write, as in `payment-posting.ts`,
 * so the debit/credit shape is testable without a database.
 */

import { writeJournal, type PostingClient } from "./manual-posting";
import type { ManualJournal } from "./manual-postings";

export const DEBIT_NOTE_ACCOUNT_CODES = {
  payable: "21001",
  inputVat: "24001",
} as const;

export type DebitNoteJournalLine = {
  account_id: string;
  debit: number;
  credit: number;
  description: string;
};

export type DebitNoteJournal = ManualJournal;

const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

/**
 * Build the balanced journal for a supplier debit note.
 *
 * Returns null when the amount is not positive, the payable or expense account
 * is missing, or the two sides do not agree — so a caller can never post a
 * zero-value, account-less or unbalanced note.
 *
 * `vatAccountId` is optional: when absent (or when the note carries no VAT) the
 * full amount is credited to the expense account.
 */
export function buildDebitNoteJournal(params: {
  journalNumber: string;
  noteNumber: string;
  date: string;
  description: string;
  amount: number;
  vatAmount?: number;
  payableAccountId: string;
  /** The account the original bill debited. Required whenever `taxable > 0`. */
  expenseAccountId?: string | null;
  vatAccountId?: string | null;
}): DebitNoteJournal | null {
  const { journalNumber, noteNumber, date, description, payableAccountId, expenseAccountId } = params;
  const amount = round3(params.amount);
  if (!(amount > 0)) return null;
  if (!journalNumber || !payableAccountId) return null;

  // VAT can only be split out when an account to hold it was resolved AND it is
  // less than the note total (the remainder must stay positive).
  const requestedVat = round3(Math.max(params.vatAmount ?? 0, 0));
  const vat = params.vatAccountId && requestedVat > 0 && requestedVat < amount ? requestedVat : 0;
  const taxable = round3(amount - vat);
  // With no account to credit the taxable part there is nothing to post.
  if (taxable > 0 && !expenseAccountId) return null;

  const lines: DebitNoteJournalLine[] = [
    { account_id: payableAccountId, debit: amount, credit: 0, description },
  ];
  if (taxable > 0) {
    lines.push({ account_id: expenseAccountId as string, debit: 0, credit: taxable, description });
  }
  if (vat > 0) {
    lines.push({ account_id: params.vatAccountId as string, debit: 0, credit: vat, description });
  }

  const debit = round3(lines.reduce((s, l) => s + l.debit, 0));
  const credit = round3(lines.reduce((s, l) => s + l.credit, 0));
  if (debit !== credit) return null;

  return {
    header: {
      journal_number: journalNumber,
      entry_date: date,
      reference_number: noteNumber,
      description,
      total_debit: debit,
      total_credit: credit,
      is_balanced: true,
      status: "posted",
      entry_type: "debit_note",
    },
    lines,
  };
}

/** The posted debit-note journal for a note number, or null. Idempotency guard. */
export async function findPostedDebitNoteJournal(
  client: PostingClient,
  noteNumber: string,
): Promise<{ id: string } | null> {
  if (!noteNumber) return null;
  const { data, error } = await client
    .from("journal_entries")
    .select("id")
    .eq("entry_type", "debit_note")
    .eq("reference_number", noteNumber)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as { id: string };
}

/**
 * Post a debit note to the ledger.
 *
 * Throws when the accounts cannot be resolved or a write fails, so the caller
 * can compensate by removing the note row rather than leave a note with no
 * ledger effect.
 */
export async function postDebitNote(
  client: PostingClient,
  params: {
    journalNumber: string;
    noteNumber: string;
    date: string;
    description: string;
    amount: number;
    vatAmount?: number;
    expenseAccountId?: string | null;
    vatAccountId?: string | null;
  },
): Promise<{ journalId: string; created: boolean }> {
  const existing = await findPostedDebitNoteJournal(client, params.noteNumber);
  if (existing) return { journalId: existing.id, created: false };

  const { data: accounts, error: accErr } = await client
    .from("accounts")
    .select("id,code")
    .eq("code", DEBIT_NOTE_ACCOUNT_CODES.payable);
  if (accErr) throw new Error("Could not load the accounts-payable account: " + String((accErr as { message?: string })?.message ?? accErr));
  const payableAccountId = (accounts as Array<{ id: string; code: string }> | null)?.[0]?.id;
  if (!payableAccountId) throw new Error(`Account ${DEBIT_NOTE_ACCOUNT_CODES.payable} is not present in the chart of accounts.`);

  const journal = buildDebitNoteJournal({
    journalNumber: params.journalNumber,
    noteNumber: params.noteNumber,
    date: params.date,
    description: params.description,
    amount: params.amount,
    vatAmount: params.vatAmount,
    payableAccountId,
    expenseAccountId: params.expenseAccountId,
    vatAccountId: params.vatAccountId ?? null,
  });
  if (!journal) throw new Error("Cannot post a debit note without a positive amount and resolvable accounts.");

  const journalId = await writeJournal(client, journal);
  return { journalId, created: true };
}
