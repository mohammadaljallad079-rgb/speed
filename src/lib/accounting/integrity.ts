/**
 * Ledger integrity detection.
 *
 * Pure functions that answer the four questions Execution 15 flagged as
 * untested: are there duplicate journals, orphaned lines, unbalanced entries,
 * and stale document balances? They only read arrays the caller already has -
 * no database, no writes, nothing destructive - so they can run in a report
 * banner or in tests without touching production data.
 */

export type JournalHeader = {
  id: string;
  entry_type?: string | null;
  reference_number?: string | null;
  total_debit?: number | null;
  total_credit?: number | null;
};

export type JournalLineRef = {
  id: string;
  journal_entry_id: string | null;
  debit?: number | null;
  credit?: number | null;
};

export type InvoiceBalance = {
  id: string;
  invoice_number?: string | null;
  total_amount?: number | null;
  paid_amount?: number | null;
};

export type PaymentRef = {
  invoice_id: string | null;
  amount?: number | null;
};

const EPS = 0.001;
const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Journals that share the same (entry_type, reference_number) - a retry that double-posted. */
export function findDuplicateJournals(entries: JournalHeader[]): JournalHeader[][] {
  const groups = new Map<string, JournalHeader[]>();
  for (const e of entries) {
    const type = e.entry_type ?? "";
    const ref = e.reference_number ?? "";
    if (!ref) continue;
    const key = `${type}::${ref}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else groups.set(key, [e]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Lines whose parent journal is not in the supplied set - an orphaned reference. */
export function findOrphanedLines(lines: JournalLineRef[], entries: JournalHeader[]): JournalLineRef[] {
  const known = new Set(entries.map((e) => e.id));
  return lines.filter((l) => !l.journal_entry_id || !known.has(l.journal_entry_id));
}

/** Entries where total_debit !== total_credit. */
export function findUnbalancedEntries(entries: JournalHeader[]): JournalHeader[] {
  return entries.filter((e) => Math.abs(money(e.total_debit) - money(e.total_credit)) > EPS);
}

/** Lines where sum(debit) !== sum(credit) within one entry. */
export function findUnbalancedLineGroups(lines: JournalLineRef[]): { journal_entry_id: string; debit: number; credit: number }[] {
  const byEntry = new Map<string, { debit: number; credit: number }>();
  for (const l of lines) {
    if (!l.journal_entry_id) continue;
    const acc = byEntry.get(l.journal_entry_id) ?? { debit: 0, credit: 0 };
    acc.debit += money(l.debit);
    acc.credit += money(l.credit);
    byEntry.set(l.journal_entry_id, acc);
  }
  const out: { journal_entry_id: string; debit: number; credit: number }[] = [];
  for (const [id, v] of byEntry) {
    if (Math.abs(v.debit - v.credit) > EPS) out.push({ journal_entry_id: id, debit: v.debit, credit: v.credit });
  }
  return out;
}

/** Invoices whose stored paid_amount differs from the sum of their payments. */
export function findStaleInvoiceBalances(
  invoices: InvoiceBalance[],
  payments: PaymentRef[],
): { invoice: InvoiceBalance; storedPaid: number; actualPaid: number }[] {
  const actual = new Map<string, number>();
  for (const p of payments) {
    if (!p.invoice_id) continue;
    actual.set(p.invoice_id, (actual.get(p.invoice_id) ?? 0) + money(p.amount));
  }
  const out: { invoice: InvoiceBalance; storedPaid: number; actualPaid: number }[] = [];
  for (const inv of invoices) {
    const storedPaid = money(inv.paid_amount);
    const actualPaid = actual.get(inv.id) ?? 0;
    if (Math.abs(storedPaid - actualPaid) > EPS) out.push({ invoice: inv, storedPaid, actualPaid });
  }
  return out;
}

export type IntegrityReport = {
  duplicateJournals: JournalHeader[][];
  orphanedLines: JournalLineRef[];
  unbalancedEntries: JournalHeader[];
  unbalancedLineGroups: { journal_entry_id: string; debit: number; credit: number }[];
  staleInvoiceBalances: { invoice: InvoiceBalance; storedPaid: number; actualPaid: number }[];
  ok: boolean;
};

/** Run every check at once. */
export function scanIntegrity(input: {
  entries: JournalHeader[];
  lines: JournalLineRef[];
  invoices?: InvoiceBalance[];
  payments?: PaymentRef[];
}): IntegrityReport {
  const duplicateJournals = findDuplicateJournals(input.entries);
  const orphanedLines = findOrphanedLines(input.lines, input.entries);
  const unbalancedEntries = findUnbalancedEntries(input.entries);
  const unbalancedLineGroups = findUnbalancedLineGroups(input.lines);
  const staleInvoiceBalances = input.invoices
    ? findStaleInvoiceBalances(input.invoices, input.payments ?? [])
    : [];
  const ok =
    duplicateJournals.length === 0 &&
    orphanedLines.length === 0 &&
    unbalancedEntries.length === 0 &&
    unbalancedLineGroups.length === 0 &&
    staleInvoiceBalances.length === 0;
  return { duplicateJournals, orphanedLines, unbalancedEntries, unbalancedLineGroups, staleInvoiceBalances, ok };
}
