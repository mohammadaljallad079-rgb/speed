/**
 * Expense posting.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * An expense was written straight into the `expenses` table - by the browser on
 * `/accounting/expenses` and `/expenses`, and by `POST /api/expenses` - and NO
 * journal was ever created for it. Every report that is derived from the ledger
 * therefore omitted every expense: profit and loss, the trial balance, the
 * balance sheet and the cash flow all showed a company that never spent
 * anything, while the expense list showed the money leaving. The only report
 * that saw expenses read the `expenses` table directly (`reports/vat`), which is
 * exactly how the two views were able to disagree.
 *
 * This module owns the one journal an expense posts:
 *
 *   Dr expense account            taxable
 *   Dr Input VAT (24001)          vat      (when resolvable)
 *       Cr Cash (11001) / Bank (11002)   amount      - cash paid now
 *       Cr Accounts Payable (21001)      amount      - bought on credit
 *
 * A credit purchase (payment_term = 'credit') credits the payable instead of
 * cash/bank, so a supplier bill is not treated as money already gone. The amount
 * is what was actually paid or owed (the stored `total`), and the VAT is split
 * out only when the chart has an input-VAT account - the same "fall back rather
 * than invent an account" rule the debit-note and sales-return paths use. The
 * entry balances or nothing is written.
 *
 * The pure builder is separated from the DB write, as in `payment-posting.ts`,
 * so the debit/credit shape is testable without a database.
 */

import { writeJournal, type PostingClient } from "./manual-posting";
import { resolveAccountIdsForTenant, resolveOptionalAccountIds, type AccountClient } from "./account-resolution";
import type { ManualJournal } from "./manual-postings";

export const EXPENSE_ACCOUNT_CODES = {
  cash: "11001",
  bank: "11002",
  payable: "21001",
  inputVat: "24001",
} as const;

const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

export type ExpenseJournal = ManualJournal;

/** Cash hits the cash account; every other method hits bank. */
export function cashBankCodeForMethod(method: string): string {
  return method === "cash" ? EXPENSE_ACCOUNT_CODES.cash : EXPENSE_ACCOUNT_CODES.bank;
}

/** A credit purchase owes the supplier instead of paying now. */
export function isCreditPurchase(paymentTerm: string | null | undefined): boolean {
  return String(paymentTerm ?? "").toLowerCase() === "credit";
}

/**
 * Build the balanced journal for an expense.
 *
 * Returns null when the amount is not positive, the expense or settlement
 * account is missing, or the two sides do not agree - so a caller can never post
 * a zero-value, account-less or unbalanced expense.
 */
export function buildExpenseJournal(params: {
  journalNumber: string;
  referenceNumber: string;
  date: string;
  description: string;
  /** The amount actually paid or owed, VAT inclusive (the stored `total`). */
  amount: number;
  vatAmount?: number;
  expenseAccountId: string;
  /** Cash/bank account, used when the expense was not bought on credit. */
  settlementAccountId?: string | null;
  /** Accounts payable, used when the expense was bought on credit. */
  payableAccountId?: string | null;
  onCredit?: boolean;
  vatAccountId?: string | null;
}): ExpenseJournal | null {
  const { journalNumber, referenceNumber, date, description, expenseAccountId } = params;
  const amount = round3(params.amount);
  if (!(amount > 0)) return null;
  if (!journalNumber || !expenseAccountId) return null;

  const creditAccountId = params.onCredit ? params.payableAccountId : params.settlementAccountId;
  if (!creditAccountId) return null;

  // VAT can only be split out when an account to hold it was resolved AND it is
  // less than the total (the remainder must stay positive).
  const requestedVat = round3(Math.max(params.vatAmount ?? 0, 0));
  const vat = params.vatAccountId && requestedVat > 0 && requestedVat < amount ? requestedVat : 0;
  const taxable = round3(amount - vat);

  const lines = [
    { account_id: expenseAccountId, debit: taxable, credit: 0, description },
    { account_id: creditAccountId, debit: 0, credit: amount, description },
  ];
  if (vat > 0) {
    lines.splice(1, 0, { account_id: params.vatAccountId as string, debit: vat, credit: 0, description });
  }

  const debit = round3(lines.reduce((s, l) => s + l.debit, 0));
  const credit = round3(lines.reduce((s, l) => s + l.credit, 0));
  if (debit !== credit) return null;

  return {
    header: {
      journal_number: journalNumber,
      entry_date: date,
      reference_number: referenceNumber,
      description,
      total_debit: debit,
      total_credit: credit,
      is_balanced: true,
      status: "posted",
      entry_type: "expense",
    },
    lines,
  };
}

/**
 * The posted expense journal for an expense, or null. Idempotency guard,
 * TENANT-SCOPED: the reference is the expense row's own id, which is unique, but
 * the tenant filter keeps the query on the caller's own ledger.
 */
export async function findPostedExpenseJournal(
  client: PostingClient,
  referenceNumber: string,
  tenantId?: string | null,
): Promise<{ id: string } | null> {
  if (!referenceNumber) return null;
  let query = client
    .from("journal_entries")
    .select("id")
    .eq("entry_type", "expense")
    .eq("reference_number", referenceNumber);
  query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error || !data) return null;
  return data as { id: string };
}

/**
 * Post an expense to the ledger.
 *
 * Throws when the accounts cannot be resolved or a write fails, so the caller
 * can compensate by removing the expense row rather than leave an expense with
 * no ledger effect.
 */
export async function postExpense(
  client: PostingClient,
  params: {
    journalNumber: string;
    /** The expense row's id - a stable, unique idempotency key. */
    referenceNumber: string;
    date: string;
    description: string;
    amount: number;
    vatAmount?: number;
    expenseAccountId: string;
    paymentMethod?: string | null;
    paymentTerm?: string | null;
    tenantId?: string | null;
  },
): Promise<{ journalId: string; created: boolean }> {
  const existing = await findPostedExpenseJournal(client, params.referenceNumber, params.tenantId);
  if (existing) return { journalId: existing.id, created: false };

  const onCredit = isCreditPurchase(params.paymentTerm);
  const settlementCode = cashBankCodeForMethod(params.paymentMethod || "cash");
  // The settlement account (and the payable, for a credit purchase) is REQUIRED.
  const resolved = await resolveAccountIdsForTenant(
    client as unknown as AccountClient,
    [settlementCode, EXPENSE_ACCOUNT_CODES.payable],
    params.tenantId ?? null,
  );
  // Input VAT is OPTIONAL: a chart without a 24001 row still records the
  // expense, it simply carries no VAT line.
  const optional = await resolveOptionalAccountIds(
    client as unknown as AccountClient,
    [EXPENSE_ACCOUNT_CODES.inputVat],
    params.tenantId ?? null,
  );

  const journal = buildExpenseJournal({
    journalNumber: params.journalNumber,
    referenceNumber: params.referenceNumber,
    date: params.date,
    description: params.description,
    amount: params.amount,
    vatAmount: params.vatAmount,
    expenseAccountId: params.expenseAccountId,
    settlementAccountId: resolved[settlementCode] ?? null,
    payableAccountId: resolved[EXPENSE_ACCOUNT_CODES.payable] ?? null,
    onCredit,
    vatAccountId: optional[EXPENSE_ACCOUNT_CODES.inputVat] ?? null,
  });
  if (!journal) {
    throw new Error("Cannot post an expense without a positive amount and resolvable accounts.");
  }

  const journalId = await writeJournal(client, journal, params.tenantId ?? null);
  return { journalId, created: true };
}

/**
 * Build the mirror of an expense journal: every line's debit and credit swapped,
 * so the reversal cancels the expense exactly.
 *
 * Returns null when the source journal is missing or unbalanced - a reversal
 * must mirror something real, never be invented.
 */
export function buildExpenseReversalJournal(
  original: ManualJournal,
  params: { journalNumber: string; date: string; description: string },
): ExpenseJournal | null {
  if (!params.journalNumber || !original?.lines?.length) return null;
  const lines = original.lines.map((l) => ({
    account_id: l.account_id,
    debit: round3(l.credit),
    credit: round3(l.debit),
    description: params.description,
  }));
  const debit = round3(lines.reduce((s, l) => s + l.debit, 0));
  const credit = round3(lines.reduce((s, l) => s + l.credit, 0));
  if (debit !== credit || debit <= 0) return null;

  return {
    header: {
      journal_number: params.journalNumber,
      entry_date: params.date,
      reference_number: original.header.reference_number,
      description: params.description,
      total_debit: debit,
      total_credit: credit,
      is_balanced: true,
      status: "posted",
      entry_type: "expense_reversal",
    },
    lines,
  };
}

/**
 * Read an expense journal's lines and write its mirror.
 *
 * Throws when the journal cannot be read or the mirror cannot be built, so the
 * caller can refuse the operation instead of leaving a half-cancelled expense.
 */
export async function reverseExpense(
  client: PostingClient,
  params: { journalId: string; journalNumber: string; date: string; description: string; tenantId?: string | null },
): Promise<string> {
  const { data: lines } = await client
    .from("journal_lines")
    .select("account_id,debit,credit")
    .eq("journal_entry_id", params.journalId);
  const original: ManualJournal = {
    header: { reference_number: null } as ManualJournal["header"],
    lines: ((lines as any[]) ?? []).map((l) => ({
      account_id: String(l.account_id),
      debit: Number(l.debit ?? 0),
      credit: Number(l.credit ?? 0),
      description: params.description,
    })),
  };
  const journal = buildExpenseReversalJournal(original, {
    journalNumber: params.journalNumber,
    date: params.date,
    description: params.description,
  });
  if (!journal) throw new Error("Cannot reverse the expense: its journal could not be read.");
  return writeJournal(client, journal, params.tenantId ?? null);
}
