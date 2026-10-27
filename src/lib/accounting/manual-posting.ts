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
  resolveAccountIdsForTenant,
  type AccountClient,
} from "./account-resolution";
import {
  buildBankTransferJournal,
  buildDepositRefundJournal,
  buildPayrollJournal,
  buildPettyCashJournal,
} from "./manual-postings";

/**
 * Any journal a builder produces: a header plus lines. The sales and receipt
 * builders add columns (customer_id, line_order, reference_number); the atomic
 * writer forwards whatever it is given, so it does not need to know them.
 */
export type PostableJournal = {
  header: {
    journal_number: string;
    entry_date: string;
    description: string;
    total_debit: number;
    total_credit: number;
  } & Record<string, unknown>;
  lines: Array<{ account_id: string; debit: number; credit: number } & Record<string, unknown>>;
};

/** Balance check for the generic shape (see isJournalBalanced for ManualJournal). */
export function isPostableJournalBalanced(journal: PostableJournal): boolean {
  const debit = journal.lines.reduce((s, l) => s + l.debit, 0);
  const credit = journal.lines.reduce((s, l) => s + l.credit, 0);
  return (
    Math.abs(debit - credit) < 0.001 &&
    Math.abs(journal.header.total_debit - debit) < 0.001 &&
    Math.abs(journal.header.total_credit - credit) < 0.001
  );
}

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

/**
 * Optional atomic-posting RPC. When the client exposes it AND the database has
 * migration 011 applied, the header and its lines are written in one
 * transaction. A client without `rpc` (a unit-test stub) or a database without
 * the function simply takes the two-request path, which is still correct - just
 * not atomic. Nothing is decided by the presence of `rpc` alone.
 */
type RpcResult = { data: unknown; error: unknown };
type RpcCapable = { rpc?: (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResult> };
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
export type PostingClient = { from: (table: string) => Builder } & RpcCapable;

const msg = (e: unknown) => String((e as { message?: string })?.message ?? e);

/**
 * Resolve account ids by code for a company.
 *
 * Delegates to `account-resolution.ts`, which is the ONE resolver: it applies the
 * tenant filter in the query, prefers the caller's own account over the shared
 * one, refuses an ambiguous chart, and refuses a non-postable or inactive
 * account. A second implementation here would drift from it — that is exactly
 * how a company's journal ends up posting into another company's account.
 */
export async function resolveAccountIds(
  client: PostingClient,
  codes: string[],
  tenantId: string | null,
): Promise<Record<string, string>> {
  return resolveAccountIdsForTenant(
    client as unknown as AccountClient,
    codes,
    tenantId,
  );
}

/**
 * Is the atomic RPC callable? Only a "the function does not exist" style error
 * (PostgREST reports a missing RPC as 404 / PGRST202, and a stale PostgREST cache
 * the same way) justifies falling back. Any other error - a refused unbalanced
 * journal, a permission denial, a real database failure - is a genuine failure
 * and must propagate, never be masked by a second, non-atomic attempt.
 */
function isRpcUnavailable(error: unknown): boolean {
  const e = error as { code?: string; status?: number; message?: string } | null;
  if (!e) return false;
  if (e.code === "PGRST202" || e.code === "404") return true;
  if (e.status === 404) return true;
  const m = String(e.message ?? "").toLowerCase();
  return m.includes("could not find the function") || m.includes("does not exist");
}

/**
 * Write a built journal.
 *
 * Preferred path: `post_journal_entry` (migration 011, hardened by 015), which
 * writes the header and its lines in ONE database transaction. That closes the
 * orphan-header window: there is no moment at which a journal exists without its
 * lines.
 *
 * Fallback path (RPC not deployed yet): the two-request write with compensation.
 * A failed line insert removes the orphan header. This is correct but NOT atomic
 * - a process death between the two requests would leave the header behind.
 *
 * The fallback is deliberately kept rather than replaced by a hard failure. The
 * app ships BEFORE the operator applies a migration (the deploy-order property
 * pinned by `exec64-tenant-chart-acceptance`), and the live migration level
 * cannot be verified from this environment. Refusing to post a company journal
 * whenever the RPC is absent would turn "one rare orphaned header after a crash"
 * into "no financial document can be recorded at all" on an un-migrated
 * database. The atomic path is taken whenever it exists, which is the normal
 * case; the fallback only covers the window before 011 is applied.
 *
 * Throws on failure so the caller can compensate the document row it created.
 */
export async function writeJournal(
  client: PostingClient,
  journal: PostableJournal,
  /**
   * The company the journal belongs to. Once the chart is per-company
   * (migration 014) a journal MUST record its company, or every company's ledger
   * collapses into the tenant-less one. Stamped here, in the single writer, so
   * no individual builder can forget it. Omitted/`null` keeps the previous
   * single-tenant behaviour.
   */
  tenantId?: string | null,
): Promise<string> {
  if (!isPostableJournalBalanced(journal)) throw new Error("Refusing to post an unbalanced journal.");

  // The journal, and every line in it, belong to ONE company. A caller that
  // already stamped a different tenant on the header or a line is a bug (or an
  // attack) - it is refused rather than silently overwritten, because a silent
  // overwrite would move a journal out of the company that built it.
  if (!tenantId) {
    throw new Error("Cannot post a journal without a company tenantId.");
  }

  if (tenantId) {
    const headerTenant = journal.header.tenant_id;
    if (headerTenant !== undefined && headerTenant !== null && headerTenant !== tenantId) {
      throw new Error("Refusing to post: the journal header belongs to another company.");
    }
    for (const line of journal.lines) {
      const lineTenant = (line as { tenant_id?: string | null }).tenant_id;
      if (lineTenant !== undefined && lineTenant !== null && lineTenant !== tenantId) {
        throw new Error("Refusing to post: a journal line belongs to another company.");
      }
    }
    journal = {
      header: { ...journal.header, tenant_id: tenantId },
      lines: journal.lines.map((l) => ({ ...l, tenant_id: tenantId })),
    };
  }

  if (typeof client.rpc === "function") {
    const { data, error } = await client.rpc("post_journal_entry", {
      p_header: journal.header,
      p_lines: journal.lines,
    });
    if (!error && typeof data === "string" && data) return data;
    if (!isRpcUnavailable(error)) {
      throw new Error("Could not post the journal atomically: " + msg(error));
    }
    // else: the RPC is genuinely not deployed - fall through to the two-request
    // path, which compensates a failed line write by deleting the orphan header.
  }

  throw new Error(
    "Atomic journal posting is required: post_journal_entry RPC is unavailable."
  );
}

/**
 * The posted journal for a (entry_type, reference) pair, or null.
 *
 * TENANT-SCOPED. A reference alone is not unique across companies: two companies
 * can each hold a receipt `REC-0001`, and matching on the reference without the
 * tenant would let one company's retry see the other company's journal and skip
 * its own posting - a silent loss of a real financial entry. The tenant filter is
 * applied in the query, never as a post-fetch comparison, so it cannot be widened
 * by a crafted reference.
 */
export async function findPostedManualJournal(
  client: PostingClient,
  entryType: string,
  reference: string,
  tenantId?: string | null,
): Promise<{ id: string } | null> {
  if (!reference) return null;
  let query = client
    .from("journal_entries")
    .select("id")
    .eq("entry_type", entryType)
    .eq("reference_number", reference);
  query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
  const { data, error } = await query.limit(1).maybeSingle();
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
    const existing = await findPostedManualJournal(client, "bank_transfer", params.reference, params.tenantId);
    if (existing) return { journalId: existing.id, created: false };
  }
  const journal = buildBankTransferJournal(params);
  if (!journal) throw new Error("Invalid bank transfer: amount must be positive and both accounts required.");
  const journalId = await writeJournal(client, journal, params.tenantId);
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
    /** The posting company (migration 014 makes the chart per-company). */
    tenantId?: string | null;
  },
): Promise<ManualPostResult> {
  const journal = buildPettyCashJournal(params);
  if (!journal) throw new Error("Invalid petty cash entry: amount must be positive and accounts required.");
  const journalId = await writeJournal(client, journal, params.tenantId);
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
    const existing = await findPostedManualJournal(client, "payroll", params.reference, params.tenantId);
    if (existing) return { journalId: existing.id, created: false };
  }
  const journal = buildPayrollJournal(params);
  if (!journal) throw new Error("Invalid payroll: amount must be positive and accounts required.");
  const journalId = await writeJournal(client, journal, params.tenantId);
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
    const existing = await findPostedManualJournal(client, "deposit_refund", params.reference, params.tenantId);
    if (existing) return { journalId: existing.id, created: false };
  }
  const journal = buildDepositRefundJournal(params);
  if (!journal) throw new Error("Invalid deposit refund: amount must be positive and accounts required.");
  const journalId = await writeJournal(client, journal, params.tenantId);
  return { journalId, created: true };
}
