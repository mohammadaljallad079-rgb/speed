/**
 * Unified sales posting service.
 *
 * Execution 29 (Item 10) found that sales invoices were posted to the ledger
 * from the browser (`sales/new`), one page at a time, with no shared service and
 * no idempotency guard: a double-click, a network resend or a React re-render
 * could insert a SECOND posted journal for the same invoice, silently doubling
 * revenue. This module is the single server-side posting path for a sale, so the
 * invariants that matter live in ONE place:
 *
 *   - Revenue is recognised once, at issue:
 *       Dr Cash/Bank (advance) + Dr AR (remaining) = Cr Revenue + Cr Output VAT.
 *   - Posting is idempotent by (entry_type='sale_invoice', reference_number):
 *     a retry returns the existing journal instead of inserting a second one.
 *   - The journal is always balanced, or nothing is written.
 *   - A posted sale is reversed (not deleted/edited) by mirroring the original
 *     entry under entry_type='sale_reversal'; the reversal is itself idempotent.
 *
 * The pure builders are separated from the DB calls (as in `payment-posting.ts`)
 * so the debit/credit shape and the balance invariant can be unit-tested without
 * a database; the DB functions take an injectable client so tests can drive them
 * with a PostgREST-like recording stub.
 */

/** Fixed system account codes, verified against the live chart. */
export const SALE_ACCOUNT_CODES = {
  cash: "11001",
  bank: "11002",
  ar: "12001",
  revenue: "41002",
  vat: "24000",
} as const;

export type SaleJournalLine = {
  account_id: string;
  debit: number;
  credit: number;
  description: string;
  customer_id: string;
  line_order: number;
};

export type SaleJournal = {
  header: {
    journal_number: string;
    entry_date: string;
    reference_number: string;
    description: string;
    total_debit: number;
    total_credit: number;
    is_balanced: true;
    status: "posted";
    entry_type: "sale_invoice" | "sale_reversal";
  };
  lines: SaleJournalLine[];
};

export type SaleAmounts = {
  /** Pre-discount, pre-VAT line amount. */
  amount: number;
  discount: number;
  vat: number;
  /** Portion received immediately (Dr Cash/Bank). */
  advancePayment: number;
  /** Portion left on account (Dr AR). */
  remaining: number;
};

const money = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Cash hits the cash account; every other method hits bank. */
export function cashBankCodeForMethod(method: string): string {
  return method === "cash" ? SALE_ACCOUNT_CODES.cash : SALE_ACCOUNT_CODES.bank;
}

export type SaleAccountIds = {
  revenueAccountId: string;
  vatAccountId: string;
  arAccountId: string;
  cashAccountId: string;
};

/**
 * Build the balanced journal for issuing a sale invoice:
 *   Dr Cash/Bank (advance) + Dr AR (remaining)
 *   Cr Revenue (amount − discount) + Cr Output VAT (vat)
 * Returns null when the entry would not balance or an account is missing, so a
 * caller can never post an unbalanced or half-resolved sale.
 */
export function buildSaleJournal(
  input: SaleAmounts & {
    journalNumber: string;
    invoiceNumber: string;
    entryDate: string;
    description: string;
    customerId: string;
    paymentMethod: string;
    accounts: SaleAccountIds;
  },
): SaleJournal | null {
  const amount = money(input.amount);
  const discount = money(input.discount);
  const vat = money(input.vat);
  const advance = money(input.advancePayment);
  const remaining = money(input.remaining);
  const revenue = money(amount - discount);
  const total = money(revenue + vat);
  const { accounts } = input;

  if (total <= 0) return null;
  if (!accounts.revenueAccountId || !accounts.arAccountId || !accounts.cashAccountId) return null;
  if (vat > 0 && !accounts.vatAccountId) return null;
  // The split must reconstruct the total exactly, or the journal is wrong.
  if (money(advance + remaining) !== total) return null;

  const lines: SaleJournalLine[] = [];
  let order = 1;
  if (advance > 0) {
    lines.push({ account_id: accounts.cashAccountId, debit: advance, credit: 0, description: input.description, customer_id: input.customerId, line_order: order++ });
  }
  if (remaining > 0) {
    lines.push({ account_id: accounts.arAccountId, debit: remaining, credit: 0, description: input.description, customer_id: input.customerId, line_order: order++ });
  }
  lines.push({ account_id: accounts.revenueAccountId, debit: 0, credit: revenue, description: input.description, customer_id: input.customerId, line_order: order++ });
  if (vat > 0) {
    lines.push({ account_id: accounts.vatAccountId, debit: 0, credit: vat, description: input.description, customer_id: input.customerId, line_order: order++ });
  }

  const debit = money(lines.reduce((s, l) => s + l.debit, 0));
  const credit = money(lines.reduce((s, l) => s + l.credit, 0));
  if (debit !== credit || debit !== total) return null;

  return {
    header: {
      journal_number: input.journalNumber,
      entry_date: input.entryDate,
      reference_number: input.invoiceNumber,
      description: input.description,
      total_debit: debit,
      total_credit: credit,
      is_balanced: true,
      status: "posted",
      entry_type: "sale_invoice",
    },
    lines,
  };
}

/**
 * Build the reversal of a posted sale (mirror image, same amounts):
 *   Cr Cash/Bank (advance) + Cr AR (remaining)
 *   Dr Revenue + Dr Output VAT
 * Returns null when it would not balance or an account is missing.
 */
export function buildSaleReversalJournal(
  input: SaleAmounts & {
    journalNumber: string;
    invoiceNumber: string;
    entryDate: string;
    description: string;
    customerId: string;
    /** The method the original sale was received with; selects cash vs bank. */
    paymentMethod: string;
    accounts: SaleAccountIds;
  },
): SaleJournal | null {
  const forward = buildSaleJournal(input);
  if (!forward) return null;
  // Mirror: swap debit and credit on every line.
  const lines: SaleJournalLine[] = forward.lines.map((l) => ({
    ...l,
    debit: l.credit,
    credit: l.debit,
  }));
  const debit = money(lines.reduce((s, l) => s + l.debit, 0));
  const credit = money(lines.reduce((s, l) => s + l.credit, 0));
  if (debit !== credit) return null;
  return {
    header: {
      journal_number: input.journalNumber,
      entry_date: input.entryDate,
      reference_number: input.invoiceNumber,
      description: input.description,
      total_debit: debit,
      total_credit: credit,
      is_balanced: true,
      status: "posted",
      entry_type: "sale_reversal",
    },
    lines,
  };
}

// ---------------------------------------------------------------------------
// DB-bound functions (injectable client, mirrors payment-posting.ts)
// ---------------------------------------------------------------------------

type QueryResult = { data: unknown; error: unknown };
type Builder = {
  select: (cols?: string) => Builder;
  eq: (col: string, val: unknown) => Builder;
  in: (col: string, vals: unknown[]) => Builder;
  insert: (row: unknown) => Builder;
  delete: () => Builder;
  limit: (n: number) => Builder;
  maybeSingle: () => PromiseLike<QueryResult>;
  single: () => PromiseLike<QueryResult>;
  then: PromiseLike<QueryResult>["then"];
};
export type PostingClient = { from: (table: string) => Builder };

const msg = (e: unknown) => String((e as { message?: string })?.message ?? e);

/** Resolve the fixed sale accounts by code; throws if any is missing. */
export async function resolveSaleAccounts(
  client: PostingClient,
  paymentMethod: string,
): Promise<SaleAccountIds> {
  const cashCode = cashBankCodeForMethod(paymentMethod);
  const { data, error } = await client
    .from("accounts")
    .select("id,code")
    .in("code", [cashCode, SALE_ACCOUNT_CODES.ar, SALE_ACCOUNT_CODES.revenue, SALE_ACCOUNT_CODES.vat]);
  if (error) throw new Error("Could not load sale accounts: " + msg(error));
  const rows = (data as Array<{ id: string; code: string }>) || [];
  const by = (code: string) => rows.find((a) => a.code === code)?.id;
  const ids: SaleAccountIds = {
    revenueAccountId: by(SALE_ACCOUNT_CODES.revenue) as string,
    vatAccountId: by(SALE_ACCOUNT_CODES.vat) as string,
    arAccountId: by(SALE_ACCOUNT_CODES.ar) as string,
    cashAccountId: by(cashCode) as string,
  };
  if (!ids.revenueAccountId || !ids.arAccountId || !ids.cashAccountId) {
    throw new Error("Cannot post a sale without the revenue/AR/cash accounts present in the chart.");
  }
  return ids;
}

/** The posted journal for a document reference, or null. */
export async function findPostedJournal(
  client: PostingClient,
  entryType: "sale_invoice" | "sale_reversal",
  referenceNumber: string,
): Promise<{ id: string } | null> {
  if (!referenceNumber) return null;
  const { data, error } = await client
    .from("journal_entries")
    .select("id")
    .eq("entry_type", entryType)
    .eq("reference_number", referenceNumber)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as { id: string };
}

/**
 * Write a built journal (header + lines) atomically-enough: if the line insert
 * fails, the orphan header is removed so no unbalanced entry survives. Throws on
 * any failure so the caller can compensate.
 */
async function writeJournal(client: PostingClient, journal: SaleJournal): Promise<string> {
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

/**
 * Post a sale invoice. Idempotent by reference: if a posted `sale_invoice`
 * journal already exists for this invoice number, it is returned unchanged
 * (`created:false`) so a retry can never double revenue.
 */
export async function postSaleInvoice(
  client: PostingClient,
  input: SaleAmounts & {
    journalNumber: string;
    invoiceNumber: string;
    entryDate: string;
    description: string;
    customerId: string;
    paymentMethod: string;
  },
): Promise<{ journalId: string; created: boolean }> {
  const existing = await findPostedJournal(client, "sale_invoice", input.invoiceNumber);
  if (existing) return { journalId: existing.id, created: false };

  const accounts = await resolveSaleAccounts(client, input.paymentMethod);
  const journal = buildSaleJournal({ ...input, accounts });
  if (!journal) throw new Error("Cannot post a sale that does not balance (check amounts and accounts).");
  const journalId = await writeJournal(client, journal);
  return { journalId, created: true };
}

/**
 * Reverse a posted sale invoice. Idempotent by reference: if a `sale_reversal`
 * already exists for this invoice number it is returned unchanged. Returns null
 * when there is nothing to reverse (no posted sale).
 */
export async function reverseSaleInvoice(
  client: PostingClient,
  input: SaleAmounts & {
    journalNumber: string;
    invoiceNumber: string;
    entryDate: string;
    description: string;
    customerId: string;
    paymentMethod: string;
  },
): Promise<{ journalId: string; created: boolean } | null> {
  const already = await findPostedJournal(client, "sale_reversal", input.invoiceNumber);
  if (already) return { journalId: already.id, created: false };

  const posted = await findPostedJournal(client, "sale_invoice", input.invoiceNumber);
  if (!posted) return null;

  const accounts = await resolveSaleAccounts(client, input.paymentMethod);
  const journal = buildSaleReversalJournal({ ...input, accounts });
  if (!journal) throw new Error("Cannot reverse a sale that does not balance.");
  const journalId = await writeJournal(client, journal);
  return { journalId, created: true };
}
