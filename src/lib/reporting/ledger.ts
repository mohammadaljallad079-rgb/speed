/**
 * Ledger derivation engine (pure, infrastructure-free).
 *
 * One place that turns `journal_entries` + `journal_lines` into the figures the
 * General Ledger, Trial Balance, Profit & Loss, Balance Sheet and Cash Flow all
 * depend on: per-account movements, opening/closing balances, a running account
 * statement, and the "does it balance" check.
 *
 * Every report derives from `journal_lines`; `accounts.balance` is a cache and is
 * never authoritative (Execution 17). Keeping the arithmetic here — rather than
 * repeating it in each page — is what stops two reports from disagreeing about
 * the same ledger.
 *
 * Nothing here reads a database or writes a row. The caller passes the arrays it
 * already loaded, so the engine is unit-testable and safe to run in a banner.
 */

/** How many decimals a money value is rounded to (BHD uses 3). */
const SCALE = 1000;
const EPS = 0.0005;

export const round3 = (n: number): number => Math.round((Number(n) || 0) * SCALE) / SCALE;

const num = (v: unknown): number => {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? x : 0;
};

export type LedgerAccountType = "asset" | "liability" | "equity" | "revenue" | "expense" | string;

export interface LedgerAccount {
  id: string;
  code?: string | null;
  name?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
  type?: LedgerAccountType | null;
  is_active?: boolean | null;
}

export interface LedgerEntry {
  id: string;
  entry_date?: string | null;
  journal_number?: string | null;
  reference_number?: string | null;
  description?: string | null;
  entry_type?: string | null;
  status?: string | null;
}

export interface LedgerLine {
  id?: string;
  journal_entry_id?: string | null;
  account_id?: string | null;
  debit?: number | string | null;
  credit?: number | string | null;
  description?: string | null;
  line_order?: number | null;
}

/**
 * Debit-nature accounts (assets, expenses) increase on the debit side; the rest
 * (liabilities, equity, revenue) increase on the credit side. An unknown type is
 * treated as debit-nature so a mislabelled account still produces a sign rather
 * than silently vanishing from the report.
 */
export function isDebitNature(type: LedgerAccountType | null | undefined): boolean {
  return type === "asset" || type === "expense" || !type;
}

/** Balance on the account's own normal side: positive means "as expected". */
export function signedBalance(type: LedgerAccountType | null | undefined, debit: number, credit: number): number {
  const d = num(debit);
  const c = num(credit);
  return round3(isDebitNature(type) ? d - c : c - d);
}

/** An entry counts only when it is not a cancelled document. */
export function isCountableEntry(entry: LedgerEntry): boolean {
  return entry.status !== "cancelled";
}

export interface LedgerMovement {
  accountId: string;
  code: string;
  name: string;
  nameAr: string;
  type: LedgerAccountType;
  openingDebit: number;
  openingCredit: number;
  /** Opening balance on the account's normal side (before the period). */
  openingBalance: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
  /** Closing balance on the account's normal side (negative = contra). */
  closingBalance: number;
}

export interface TrialBalanceTotals {
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
}

export interface TrialBalance {
  rows: LedgerMovement[];
  totals: TrialBalanceTotals;
  /** True when total closing debits equal total closing credits. */
  balanced: boolean;
  /** closingDebit − closingCredit; zero on a balanced ledger. */
  difference: number;
}

/** Split a signed balance into a debit or credit column. */
function splitColumns(type: LedgerAccountType, balance: number): { debit: number; credit: number } {
  const debitNature = isDebitNature(type);
  // `signedBalance` already returns the balance on the normal side, so a
  // negative value means the account sits on the opposite side.
  if (balance >= 0) {
    return debitNature ? { debit: round3(balance), credit: 0 } : { debit: 0, credit: round3(balance) };
  }
  const magnitude = round3(Math.abs(balance));
  return debitNature ? { debit: 0, credit: magnitude } : { debit: magnitude, credit: 0 };
}

/**
 * Build a trial balance for a period.
 *
 * `from` is inclusive, `to` is inclusive; entries strictly before `from` form the
 * opening balance. Entries without a date are treated as period movements so an
 * undated legacy row is never dropped from the report.
 */
export function buildTrialBalance(
  accounts: LedgerAccount[],
  entries: LedgerEntry[],
  lines: LedgerLine[],
  period: { from?: string | null; to?: string | null } = {},
): TrialBalance {
  const from = period.from || null;
  const to = period.to || null;

  const entryById = new Map<string, LedgerEntry>();
  for (const entry of entries) {
    if (isCountableEntry(entry)) entryById.set(entry.id, entry);
  }

  const opening = new Map<string, { debit: number; credit: number }>();
  const movement = new Map<string, { debit: number; credit: number }>();

  for (const line of lines) {
    const entry = line.journal_entry_id ? entryById.get(line.journal_entry_id) : undefined;
    if (!entry) continue;
    const date = entry.entry_date ?? null;
    const isOpening = Boolean(date && from && date < from);
    const isPeriod = !isOpening && (!date || !to || date <= to);
    if (!isOpening && !isPeriod) continue;

    const bucket = isOpening ? opening : movement;
    const accountId = String(line.account_id ?? "");
    if (!accountId) continue;
    const current = bucket.get(accountId) ?? { debit: 0, credit: 0 };
    current.debit = round3(current.debit + num(line.debit));
    current.credit = round3(current.credit + num(line.credit));
    bucket.set(accountId, current);
  }

  const rows: LedgerMovement[] = [];
  for (const account of accounts) {
    const open = opening.get(account.id) ?? { debit: 0, credit: 0 };
    const move = movement.get(account.id) ?? { debit: 0, credit: 0 };
    const closingBalance = signedBalance(
      account.type,
      open.debit + move.debit,
      open.credit + move.credit,
    );
    const closing = splitColumns(account.type ?? "", closingBalance);
    rows.push({
      accountId: account.id,
      code: account.code ?? "",
      name: account.name_en || account.name || account.code || "",
      nameAr: account.name_ar || account.name || "",
      type: account.type ?? "",
      openingDebit: open.debit,
      openingCredit: open.credit,
      openingBalance: signedBalance(account.type, open.debit, open.credit),
      periodDebit: move.debit,
      periodCredit: move.credit,
      closingDebit: closing.debit,
      closingCredit: closing.credit,
      closingBalance,
    });
  }

  const totals = rows.reduce<TrialBalanceTotals>(
    (acc, r) => ({
      openingDebit: round3(acc.openingDebit + r.openingDebit),
      openingCredit: round3(acc.openingCredit + r.openingCredit),
      periodDebit: round3(acc.periodDebit + r.periodDebit),
      periodCredit: round3(acc.periodCredit + r.periodCredit),
      closingDebit: round3(acc.closingDebit + r.closingDebit),
      closingCredit: round3(acc.closingCredit + r.closingCredit),
    }),
    { openingDebit: 0, openingCredit: 0, periodDebit: 0, periodCredit: 0, closingDebit: 0, closingCredit: 0 },
  );

  const difference = round3(totals.closingDebit - totals.closingCredit);
  return { rows, totals, balanced: Math.abs(difference) < EPS, difference };
}

export interface LedgerStatementRow {
  entryId: string;
  date: string;
  journalNumber: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  /** Running balance on the account's normal side, inclusive of this row. */
  balance: number;
}

export interface AccountStatement {
  accountId: string;
  openingBalance: number;
  rows: LedgerStatementRow[];
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
}

/**
 * Build one account's ledger statement: opening balance, then every movement in
 * date order with a running balance on the account's normal side.
 */
export function buildAccountStatement(
  account: LedgerAccount,
  entries: LedgerEntry[],
  lines: LedgerLine[],
  period: { from?: string | null; to?: string | null } = {},
): AccountStatement {
  const from = period.from || null;
  const to = period.to || null;
  const entryById = new Map<string, LedgerEntry>();
  for (const entry of entries) if (isCountableEntry(entry)) entryById.set(entry.id, entry);

  let openingDebit = 0;
  let openingCredit = 0;
  const periodRows: LedgerStatementRow[] = [];

  for (const line of lines) {
    if (String(line.account_id ?? "") !== account.id) continue;
    const entry = line.journal_entry_id ? entryById.get(line.journal_entry_id) : undefined;
    if (!entry) continue;
    const date = entry.entry_date ?? "";
    const debit = round3(num(line.debit));
    const credit = round3(num(line.credit));

    if (from && date && date < from) {
      openingDebit = round3(openingDebit + debit);
      openingCredit = round3(openingCredit + credit);
      continue;
    }
    if (to && date && date > to) continue;

    periodRows.push({
      entryId: entry.id,
      date,
      journalNumber: entry.journal_number ?? "",
      reference: entry.reference_number ?? "",
      description: line.description || entry.description || "",
      debit,
      credit,
      balance: 0,
    });
  }

  periodRows.sort((a, b) => (a.date === b.date ? a.journalNumber.localeCompare(b.journalNumber) : a.date.localeCompare(b.date)));

  const openingBalance = signedBalance(account.type, openingDebit, openingCredit);
  let running = openingBalance;
  for (const row of periodRows) {
    running = round3(running + signedBalance(account.type, row.debit, row.credit));
    row.balance = running;
  }

  return {
    accountId: account.id,
    openingBalance,
    rows: periodRows,
    totalDebit: round3(periodRows.reduce((s, r) => s + r.debit, 0)),
    totalCredit: round3(periodRows.reduce((s, r) => s + r.credit, 0)),
    closingBalance: running,
  };
}

/**
 * The net movement of every account in a period, keyed by account id. Reports
 * that need a section total (revenue, expense, asset, …) sum this rather than
 * re-deriving it from raw lines.
 */
export function netByAccount(entries: LedgerEntry[], lines: LedgerLine[]): Map<string, { debit: number; credit: number }> {
  const entryById = new Map<string, LedgerEntry>();
  for (const entry of entries) if (isCountableEntry(entry)) entryById.set(entry.id, entry);
  const out = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    if (line.journal_entry_id && !entryById.has(line.journal_entry_id)) continue;
    const accountId = String(line.account_id ?? "");
    if (!accountId) continue;
    const current = out.get(accountId) ?? { debit: 0, credit: 0 };
    current.debit = round3(current.debit + num(line.debit));
    current.credit = round3(current.credit + num(line.credit));
    out.set(accountId, current);
  }
  return out;
}

export interface SectionTotal {
  debit: number;
  credit: number;
  /** Balance on the normal side for the section's accounts. */
  balance: number;
}

/** Sum a set of account types into one section (used by P&L / balance sheet). */
export function sectionTotal(
  accounts: LedgerAccount[],
  movements: Map<string, { debit: number; credit: number }>,
  types: LedgerAccountType[],
): SectionTotal {
  let debit = 0;
  let credit = 0;
  let balance = 0;
  for (const account of accounts) {
    if (!types.includes(account.type ?? "")) continue;
    const move = movements.get(account.id);
    if (!move) continue;
    debit = round3(debit + move.debit);
    credit = round3(credit + move.credit);
    balance = round3(balance + signedBalance(account.type, move.debit, move.credit));
  }
  return { debit, credit, balance };
}

export interface BalanceSheetSection {
  assets: SectionTotal;
  liabilities: SectionTotal;
  equity: SectionTotal;
  /**
   * Profit and loss for the period, not yet closed to equity. A balance sheet
   * that omits this cannot balance mid-year, because the ledger holds revenue
   * and expense in their own accounts until a closing entry is posted.
   */
  currentEarnings: number;
  totalAssets: number;
  totalLiabilitiesAndEquity: number;
  /** assets − (liabilities + equity + current earnings); zero when balanced. */
  difference: number;
  balanced: boolean;
}

/**
 * Build a balance sheet section summary from the ledger.
 *
 * `currentEarnings` is revenue − expenses for the period, and it is added to the
 * liabilities-and-equity side. Without it the statement only balances after the
 * year is closed, so an in-progress year always looked wrong.
 */
export function buildBalanceSheet(
  accounts: LedgerAccount[],
  entries: LedgerEntry[],
  lines: LedgerLine[],
  period: { from?: string | null; to?: string | null } = {},
): BalanceSheetSection {
  const tb = buildTrialBalance(accounts, entries, lines, period);
  const closingFor = (type: LedgerAccountType) =>
    round3(
      tb.rows
        .filter((r) => r.type === type)
        .reduce((s, r) => s + r.closingBalance, 0),
    );

  const assets: SectionTotal = { debit: 0, credit: 0, balance: closingFor("asset") };
  const liabilities: SectionTotal = { debit: 0, credit: 0, balance: closingFor("liability") };
  const equity: SectionTotal = { debit: 0, credit: 0, balance: closingFor("equity") };
  const revenue = closingFor("revenue");
  const expense = closingFor("expense");
  const currentEarnings = round3(revenue - expense);

  const totalAssets = assets.balance;
  const totalLiabilitiesAndEquity = round3(liabilities.balance + equity.balance + currentEarnings);
  const difference = round3(totalAssets - totalLiabilitiesAndEquity);

  return {
    assets,
    liabilities,
    equity,
    currentEarnings,
    totalAssets,
    totalLiabilitiesAndEquity,
    difference,
    balanced: Math.abs(difference) < EPS,
  };
}
