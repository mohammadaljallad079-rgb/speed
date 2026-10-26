import { writeJournal as writeSharedJournal, type PostingClient as SharedPostingClient } from "./manual-posting";
import { resolveAccountIdsForTenant, type AccountClient } from "./account-resolution";

/**
 * Depreciation posting service.
 *
 * WHY
 * ---
 * The depreciation screen computed a schedule in the browser and wrote nothing
 * to the ledger. Depreciation is an expense, so a schedule that is not posted
 * leaves the P&L overstating profit, the balance sheet missing the accumulated
 * depreciation contra-asset, and the fixed-asset book value disagreeing with the
 * books. This module is the single path that turns a schedule into a journal:
 *
 *   Dr Depreciation expense (52001)      amount
 *   Cr Accumulated depreciation (14001)  amount
 *
 * Accumulated depreciation is a CONTRA-ASSET (credit-nature, type `asset`), which
 * is what lets the balance sheet show "cost less accumulated depreciation"
 * without a second asset account per vehicle.
 *
 * Invariants, matching the other posting services:
 *   - The pure builder is separated from the DB write, so the shape and the
 *     balance invariant are testable without a database.
 *   - Posting is idempotent by (entry_type='depreciation', reference_number):
 *     re-posting a period returns the existing journal (`created:false`), so a
 *     retry cannot depreciate an asset twice.
 *   - A journal is written only when it balances, or nothing is written.
 *   - The amount is clamped so accumulated depreciation never exceeds the
 *     depreciable base (cost less salvage).
 */

/** Fixed system account codes. */
export const DEPRECIATION_ACCOUNT_CODES = {
  /** Accumulated depreciation - contra-asset, credit nature. */
  accumulated: "14001",
  /** Depreciation expense - P&L. */
  expense: "52001",
} as const;

export type DepreciationMethod = "straight_line" | "declining_balance";

export type DepreciationJournalLine = {
  account_id: string;
  debit: number;
  credit: number;
  description: string;
  line_order: number;
};

export type DepreciationJournal = {
  header: {
    journal_number: string;
    entry_date: string;
    reference_number: string;
    description: string;
    total_debit: number;
    total_credit: number;
    is_balanced: true;
    status: "posted";
    entry_type: "depreciation";
  };
  lines: DepreciationJournalLine[];
};

const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

export type DepreciationInput = {
  method: DepreciationMethod | string;
  /** Acquisition cost. */
  cost: number;
  /** Expected residual value; never depreciated. */
  salvageValue: number;
  usefulLifeYears: number;
  /** Required for the declining-balance method, as a percentage (e.g. 20). */
  annualRate?: number;
  /** Accumulated depreciation already posted for this asset. */
  accumulatedToDate: number;
};

/**
 * Depreciation for one period (a year by default), never taking the accumulated
 * total above the depreciable base.
 *
 * Straight line is `(cost − salvage) / usefulLife`. Declining balance is
 * `rate% x book value`, which naturally decelerates; it is capped at the
 * remaining depreciable amount so the final year cannot overshoot salvage.
 *
 * Returns 0 for a non-positive life, a fully depreciated asset, or a rate that
 * is not positive, so a caller can never post a zero or negative charge.
 */
export function calculateDepreciation(
  input: DepreciationInput,
  periodYears = 1,
): number {
  const cost = round3(input.cost);
  const salvage = round3(input.salvageValue);
  const accumulated = round3(input.accumulatedToDate);
  const life = Number(input.usefulLifeYears) || 0;

  const depreciableBase = round3(cost - salvage);
  if (depreciableBase <= 0 || life <= 0) return 0;

  const remaining = round3(depreciableBase - accumulated);
  if (remaining <= 0) return 0;

  let charge: number;
  if (input.method === "declining_balance") {
    const rate = (Number(input.annualRate) || 0) / 100;
    if (rate <= 0) return 0;
    const bookValue = round3(cost - accumulated);
    charge = round3(bookValue * rate * periodYears);
  } else {
    charge = round3((depreciableBase / life) * periodYears);
  }

  if (charge <= 0) return 0;
  return round3(Math.min(charge, remaining));
}

/** Book value after a charge: cost less accumulated depreciation. */
export function bookValueAfter(cost: number, accumulatedToDate: number): number {
  return round3(round3(cost) - round3(accumulatedToDate));
}

/**
 * Build the balanced depreciation journal. Returns null when the amount is not
 * positive or an account is missing, so a caller cannot post a zero-value or
 * unbalanced entry.
 */
export function buildDepreciationJournal(params: {
  journalNumber: string;
  reference: string;
  date: string;
  description: string;
  amount: number;
  accumulatedAccountId: string;
  expenseAccountId: string;
}): DepreciationJournal | null {
  const amount = round3(params.amount);
  if (amount <= 0) return null;
  if (!params.journalNumber || !params.accumulatedAccountId || !params.expenseAccountId) return null;

  return {
    header: {
      journal_number: params.journalNumber,
      entry_date: params.date,
      reference_number: params.reference,
      description: params.description,
      total_debit: amount,
      total_credit: amount,
      is_balanced: true,
      status: "posted",
      entry_type: "depreciation",
    },
    lines: [
      { account_id: params.expenseAccountId, debit: amount, credit: 0, description: params.description, line_order: 1 },
      { account_id: params.accumulatedAccountId, debit: 0, credit: amount, description: params.description, line_order: 2 },
    ],
  };
}

/** A client with just the PostgREST surface these functions use. */
export type DepreciationClient = {
  from: (table: string) => any;
};

const msg = (e: unknown) => String((e as { message?: string })?.message ?? e);

/** Resolve the two fixed depreciation accounts by code; throws if either is missing. */
export async function resolveDepreciationAccounts(
  client: DepreciationClient,
  tenantId: string | null = null,
): Promise<{ accumulatedAccountId: string; expenseAccountId: string }> {
  const ids = await resolveAccountIdsForTenant(
    client as unknown as AccountClient,
    [DEPRECIATION_ACCOUNT_CODES.accumulated, DEPRECIATION_ACCOUNT_CODES.expense],
    tenantId,
  );
  return {
    accumulatedAccountId: ids[DEPRECIATION_ACCOUNT_CODES.accumulated],
    expenseAccountId: ids[DEPRECIATION_ACCOUNT_CODES.expense],
  };
}

/** The posted depreciation journal for a reference, or null. */
export async function findPostedDepreciation(
  client: DepreciationClient,
  referenceNumber: string,
): Promise<{ id: string } | null> {
  if (!referenceNumber) return null;
  const { data, error } = await client
    .from("journal_entries")
    .select("id")
    .eq("entry_type", "depreciation")
    .eq("reference_number", referenceNumber)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as { id: string };
}

/**
 * Post one depreciation charge. Idempotent by reference: if a posted
 * `depreciation` journal already exists for this reference it is returned
 * unchanged (`created:false`), so a retry cannot charge depreciation twice.
 */
export async function postDepreciation(
  client: DepreciationClient,
  input: {
    journalNumber: string;
    reference: string;
    date: string;
    description: string;
    amount: number;
    /** The posting company (migration 014 makes the chart per-company). */
    tenantId?: string | null;
  },
): Promise<{ journalId: string; created: boolean }> {
  const existing = await findPostedDepreciation(client, input.reference);
  if (existing) return { journalId: existing.id, created: false };

  const accounts = await resolveDepreciationAccounts(client, input.tenantId ?? null);
  const journal = buildDepreciationJournal({ ...input, ...accounts });
  if (!journal) {
    throw new Error("Cannot post depreciation that does not balance (check the amount and accounts).");
  }

  // Shared atomic writer (migration 011): header + lines in one transaction, so
  // a failed line write cannot leave an orphan header behind.
  const journalId = await writeSharedJournal(client as unknown as SharedPostingClient, journal, input.tenantId ?? null);
  return { journalId, created: true };
}
