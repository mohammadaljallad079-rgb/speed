/**
 * Sales-return posting.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * `src/app/sales/returns/page.tsx` created a sales return in the BROWSER as two
 * independent writes:
 *
 *   1. insert `sales_returns`  (anon client, status 'pending', no `tenant_id`)
 *   2. update `invoices`       (anon client: paid_amount down, status 'returned')
 *
 * and posted NO journal at all. A return therefore reduced the invoice's paid
 * amount while the ledger still showed the full collection: the receivable was
 * never restored, revenue was never reversed, and the trial balance and the
 * balance sheet silently disagreed with the sales screens. The browser also
 * chose the tenant, and two writes cannot be atomic.
 *
 * This module owns the one journal a sales return posts:
 *
 *   Dr Sales Returns / Revenue   taxable
 *   Dr Output VAT                vat     (when resolvable)
 *       Cr Accounts Receivable             total
 *
 * The credit is always the receivable: a return reduces what the customer owes
 * (or restores what they paid), it never touches cash. Revenue is recognised
 * once, at issue (`sales-posting.ts`), so a return reverses it rather than
 * re-recognising it.
 *
 * Account 41003 (sales returns, a contra-revenue account) may not exist on a
 * live install. When it does not, the debit falls back to 41002 (sales revenue)
 * - the same rule `postSaleInvoice` uses - so the entry still balances instead
 * of the return being impossible to record.
 *
 * The pure builder is separated from the DB write, as in `payment-posting.ts`,
 * so the debit/credit shape is testable without a database.
 */

import { writeJournal, type PostingClient } from "./manual-posting";
import { resolveAccountIdsForTenant, type AccountClient } from "./account-resolution";
import type { ManualJournal } from "./manual-postings";

export const SALES_RETURN_ACCOUNT_CODES = {
  ar: "12001",
  salesReturns: "41003",
  salesRevenue: "41002",
  outputVat: "24000",
} as const;

const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

export type SalesReturnJournal = ManualJournal;

/**
 * Build the balanced journal for a sales return.
 *
 * Returns null when the amount is not positive, the receivable account is
 * missing, there is no account to debit, or the two sides do not agree - so a
 * caller can never post a zero-value, account-less or unbalanced return.
 *
 * `vatAccountId` is optional: when absent (or when the return carries no VAT)
 * the whole amount is debited to the revenue account, so the entry still
 * balances against the receivable.
 */
export function buildSalesReturnJournal(params: {
  journalNumber: string;
  returnNumber: string;
  date: string;
  description: string;
  /** The full amount credited to the receivable (VAT inclusive). */
  amount: number;
  vatAmount?: number;
  arAccountId: string;
  /**
   * The contra-revenue account to debit. `salesReturnsAccountId` is preferred;
   * when the caller has no 41003 the revenue account is used instead.
   */
  salesReturnsAccountId?: string | null;
  salesRevenueAccountId?: string | null;
  vatAccountId?: string | null;
}): SalesReturnJournal | null {
  const { journalNumber, returnNumber, date, description, arAccountId } = params;
  const amount = round3(params.amount);
  if (!(amount > 0)) return null;
  if (!journalNumber || !arAccountId) return null;

  // Prefer the contra-revenue account; fall back to revenue when it is absent.
  const debitAccountId = params.salesReturnsAccountId || params.salesRevenueAccountId || null;
  if (!debitAccountId) return null;

  // VAT can only be split out when an account to hold it was resolved AND it is
  // less than the total (the remainder must stay positive).
  const requestedVat = round3(Math.max(params.vatAmount ?? 0, 0));
  const vat = params.vatAccountId && requestedVat > 0 && requestedVat < amount ? requestedVat : 0;
  const taxable = round3(amount - vat);

  const lines = [
    { account_id: debitAccountId, debit: taxable, credit: 0, description },
    { account_id: arAccountId, debit: 0, credit: amount, description },
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
      reference_number: returnNumber,
      description,
      total_debit: debit,
      total_credit: credit,
      is_balanced: true,
      status: "posted",
      entry_type: "sales_return",
    },
    lines,
  };
}

/**
 * The posted sales-return journal for a return number, or null. Idempotency
 * guard, TENANT-SCOPED: two companies can each hold a return `SR-0001`, so
 * matching on the number alone would let one company's retry see the other's
 * journal and skip its own posting.
 */
export async function findPostedSalesReturnJournal(
  client: PostingClient,
  returnNumber: string,
  tenantId?: string | null,
): Promise<{ id: string } | null> {
  if (!returnNumber) return null;
  let query = client
    .from("journal_entries")
    .select("id")
    .eq("entry_type", "sales_return")
    .eq("reference_number", returnNumber);
  query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error || !data) return null;
  return data as { id: string };
}

/**
 * Post a sales return to the ledger.
 *
 * Throws when the accounts cannot be resolved or a write fails, so the caller
 * can compensate by removing the return row rather than leave a return with no
 * ledger effect.
 */
export async function postSalesReturn(
  client: PostingClient,
  params: {
    journalNumber: string;
    returnNumber: string;
    date: string;
    description: string;
    amount: number;
    vatAmount?: number;
    tenantId?: string | null;
  },
): Promise<{ journalId: string; created: boolean }> {
  const existing = await findPostedSalesReturnJournal(client, params.returnNumber, params.tenantId);
  if (existing) return { journalId: existing.id, created: false };

  // 41003 may not exist on a live install; resolve it together with its
  // fallback so a missing contra account never blocks the return.
  const resolved = await resolveAccountIdsForTenant(
    client as unknown as AccountClient,
    [
      SALES_RETURN_ACCOUNT_CODES.ar,
      SALES_RETURN_ACCOUNT_CODES.salesReturns,
      SALES_RETURN_ACCOUNT_CODES.salesRevenue,
      SALES_RETURN_ACCOUNT_CODES.outputVat,
    ],
    params.tenantId ?? null,
  );

  const journal = buildSalesReturnJournal({
    journalNumber: params.journalNumber,
    returnNumber: params.returnNumber,
    date: params.date,
    description: params.description,
    amount: params.amount,
    vatAmount: params.vatAmount,
    arAccountId: resolved[SALES_RETURN_ACCOUNT_CODES.ar],
    salesReturnsAccountId: resolved[SALES_RETURN_ACCOUNT_CODES.salesReturns] ?? null,
    salesRevenueAccountId: resolved[SALES_RETURN_ACCOUNT_CODES.salesRevenue] ?? null,
    vatAccountId: resolved[SALES_RETURN_ACCOUNT_CODES.outputVat] ?? null,
  });
  if (!journal) {
    throw new Error("Cannot post a sales return without a positive amount and resolvable accounts.");
  }

  const journalId = await writeJournal(client, journal, params.tenantId ?? null);
  return { journalId, created: true };
}
