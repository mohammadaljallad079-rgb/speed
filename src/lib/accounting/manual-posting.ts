/**
 * Server-side posting for the "manual" financial screens.
 *
 * WHY
 * ---
 * Bank transfer, petty cash, payroll and rental deposit refund each built their
 * journal in the browser and inserted `journal_entries` / `journal_lines`
 * directly. The pure *shape* was already extracted into `manual-postings.ts`
 * (Exec 17), but the write itself stayed client-side: the browser chose the
 * accounts, allocated the number and posted. That is the defect Exec 35 closes.
 *
 * This module owns the DB-bound half. It:
 *   - resolves the fixed system accounts by code, scoped to the caller's tenant
 *     (falling back to the shared, tenant-less chart), so a caller cannot post
 *     into another tenant's accounts;
 *   - writes header + lines with the same compensation the sale/payment services
 *     use (a failed line write removes the orphan header);
 *   - looks up an existing journal by (entry_type, reference) so a retry is
 *     idempotent and cannot double-post;
 *   - never writes `accounts.balance` itself — the caller may nudge the cache
 *     through `applyAccountBalanceDelta`, which is non-authoritative.
 *
 * The builders stay pure and tested; this layer only adds the database write.
 */

import {
  buildBankTransferJournal,
  buildDepositRefundJournal,
  buildPayrollJournal,
  buildPettyCashJournal,
  isJournalBalanced,
  type ManualJournal,
} from "./manual-postings";

/** System account codes used by the manual screens. */
export const MANUAL_ACCOUNT_CODES = {
  cash: "11001",
  bank: "11002",
  pettyCash: "11003",
  depositLiability: "25000",
  salariesExpense: "51003",
  vehicleFleet: "13001",
  bankLoan: "22001",
} as const;

type QueryResult = { data: unknown; error: unknown };
type Builder = {
  select: (cols?: string) => Builder;
  eq: (col: string, val: unknown) => Builder;
  is: (col: string, val: unknown) => Builder;
  in: (col: string, vals: unknown[]) => Builder;
  or: (filter: string) => Builder;
  insert: (row: unknown) => Builder;
  delete: () => Builder;
  limit: (n: number) => Builder;
  maybeSingle: () => PromiseLike<QueryResult>;
  single: () => PromiseLike<QueryResult>;
  then: PromiseLike<QueryResult>["then"];
};
export type PostingClient = { from: (table: string) => Builder };

const msg = (e: unknown) => String((e as { message?: string })?.message ?? e);

/**
 * Resolve account ids by code for a tenant. A tenant-scoped account is
 * preferred; the shared (tenant-less) chart is the fallback, mirroring the RLS
 * predicate. Throws when a requested code is absent, so a caller can never post
 * a line against a missing/undefined account.
 */
export async function resolveAccountIds(
  client: PostingClient,
  codes: string[],
  tenantId: string | null,
): Promise<Record<string, string>> {
  let query = client.from("accounts").select("id,code,tenant_id").in("code", codes);
  if (tenantId) query = query.or(`tenant_id.eq.${tenantId},tenant_id.is.null`);
  else query = query.is("tenant_id", null);

  const { data, error } = await query;
  if (error) throw new Error("Could not load accounts: " + msg(error));
  const rows = (data as Array<{ id: string; code: string; tenant_id: string | null }>) || [];

  const resolved: Record<string, string> = {};
  for (const code of codes) {
    const own = rows.find((r) => r.code === code && r.tenant_id === tenantId);
    const shared = rows.find((r) => r.code === code);
    const id = (own ?? shared)?.id;
    if (!id) throw new Error(`Account ${code} is not present in the chart of accounts.`);
    resolved[code] = id;
  }
  return resolved;
}

/**
 * Write a built journal. If the line insert fails the orphan header is removed,
 * so a failed posting never leaves an unbalanced entry behind. Throws on failure
 * so the caller can compensate the document row it created.
 */
export async function writeJournal(client: PostingClient, journal: ManualJournal): Promise<string> {
  if (!isJournalBalanced(journal)) throw new Error("Refusing to post an unbalanced journal.");
  const { data: header, error: headerErr } = await client
    .from("journal_entries")
    .insert(journal.header)
    .select("id")
    .single();
  if (headerErr) throw headerErr;
  const journalId = (header as { id: string }).id;

  const { error: linesErr } = await client
    .from("journal_lines")
    .insert(journal.lines.map((l) => ({ ...l, journal_entry_id: journalId })));
  if (linesErr) {
    await client.from("journal_entries").delete().eq("id", journalId);
    throw linesErr;
  }
  return journalId;
}

/** The posted journal for a (entry_type, reference) pair, or null. */
export async function findPostedManualJournal(
  client: PostingClient,
  entryType: string,
  reference: string,
): Promise<{ id: string } | null> {
  if (!reference) return null;
  const { data, error } = await client
    .from("journal_entries")
    .select("id")
    .eq("entry_type", entryType)
    .eq("reference_number", reference)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as { id: string };
}

// ---------------------------------------------------------------------------
// Typed postings
// ---------------------------------------------------------------------------

export type ManualPostResult = { journalId: string; created: boolean };

/** Bank transfer: Dr destination / Cr source. Never revenue or expense. */
export async function postBankTransfer(
  client: PostingClient,
  params: {
    journalNumber: string;
    tenantId: string | null;
    date: string;
    description: string;
    amount: number;
    fromAccountId: string;
    toAccountId: string;
    reference?: string | null;
  },
): Promise<ManualPostResult> {
  if (params.reference) {
    const existing = await findPostedManualJournal(client, "bank_transfer", params.reference);
    if (existing) return { journalId: existing.id, created: false };
  }
  const journal = buildBankTransferJournal(params);
  if (!journal) throw new Error("Invalid bank transfer: amount must be positive and both accounts required.");
  const journalId = await writeJournal(client, journal);
  return { journalId, created: true };
}

/** Petty cash fund/expense. Shape preserved from the screen's builder. */
export async function postPettyCash(
  client: PostingClient,
  params: {
    journalNumber: string;
    date: string;
    description: string;
    amount: number;
    kind: "fund" | "expense";
    pettyAccountId: string;
    /** The other leg: main cash for a fund, the expense account for an expense. */
    expenseAccountId: string;
    fundDescription: string;
    expenseDescription: string;
  },
): Promise<ManualPostResult> {
  const journal = buildPettyCashJournal(params);
  if (!journal) throw new Error("Invalid petty cash entry: amount must be positive and accounts required.");
  const journalId = await writeJournal(client, journal);
  return { journalId, created: true };
}

/** Payroll: Dr salaries expense / Cr cash. */
export async function postPayroll(
  client: PostingClient,
  params: {
    journalNumber: string;
    tenantId: string | null;
    date: string;
    description: string;
    amount: number;
    salaryAccountId: string;
    cashAccountId: string;
    reference?: string | null;
  },
): Promise<ManualPostResult> {
  if (params.reference) {
    const existing = await findPostedManualJournal(client, "payroll", params.reference);
    if (existing) return { journalId: existing.id, created: false };
  }
  const journal = buildPayrollJournal(params);
  if (!journal) throw new Error("Invalid payroll: amount must be positive and accounts required.");
  const journalId = await writeJournal(client, journal);
  return { journalId, created: true };
}

/** Deposit refund: Dr deposit liability / Cr cash. Never rental revenue. */
export async function postDepositRefund(
  client: PostingClient,
  params: {
    journalNumber: string;
    tenantId: string | null;
    date: string;
    description: string;
    amount: number;
    depositAccountId: string;
    cashAccountId: string;
    reference?: string | null;
  },
): Promise<ManualPostResult> {
  if (params.reference) {
    const existing = await findPostedManualJournal(client, "deposit_refund", params.reference);
    if (existing) return { journalId: existing.id, created: false };
  }
  const journal = buildDepositRefundJournal(params);
  if (!journal) throw new Error("Invalid deposit refund: amount must be positive and accounts required.");
  const journalId = await writeJournal(client, journal);
  return { journalId, created: true };
}
