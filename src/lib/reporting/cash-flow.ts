/**
 * Cash-flow statement engine (pure, infrastructure-free).
 *
 * A cash-flow statement explains the MOVEMENT OF CASH, not profit. The report
 * this replaces classified every revenue and expense account into "operating"
 * and summed them, so it was an accrual P&L restatement wearing a cash-flow
 * heading: a credit sale (Dr AR / Cr Revenue) showed as cash even though no money
 * arrived, and a vehicle bought on credit showed as an investing outflow even
 * though no money left.
 *
 * This engine decomposes the ledger by the DIRECT method. Because every journal
 * entry balances, the net change in the cash accounts equals the negative of the
 * net change in every other line of the same entry. Attributing
 * `-(debit - credit)` of each non-cash line to that line's account therefore
 * splits the actual cash movement exactly across the accounts it came from — no
 * proportional allocation and no residual. Each counter account is then
 * classified into operating, investing or financing.
 *
 * Nothing here reads a database or writes a row; the caller passes the rows it
 * already loaded, so the engine is unit-testable.
 */

import { isDebitNature, round3, type LedgerAccount, type LedgerEntry, type LedgerLine } from "./ledger";

const num = (v: unknown): number => {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? x : 0;
};

/**
 * Cash and cash equivalents: the accounts whose movement the statement explains.
 * The chart uses 11001 cash, 11002 bank and 11003 petty cash; a code beginning
 * `11` is treated as cash so a new bank account is picked up without a code
 * change, while receivables (`12…`) stay out.
 */
export function isCashAccount(account: Pick<LedgerAccount, "code" | "type">): boolean {
  const code = String(account.code ?? "").trim();
  if (code.startsWith("11")) return true;
  return false;
}

export type CashFlowSection = "operating" | "investing" | "financing";

/**
 * Classify a NON-cash counter account. The chart is code-driven:
 *   13… fixed assets, 14… accumulated depreciation → investing
 *   22… loans, 3… equity/capital                → financing
 *   everything else (12… AR, 21… AP, 24… VAT, 41… revenue, 5…/6… expense) → operating
 * An unknown code is operating, which is the conservative default: it stays in the
 * section that the total of the statement is checked against.
 */
export function classifyCashFlowSection(code: string | null | undefined): CashFlowSection {
  const c = String(code ?? "").trim();
  if (c.startsWith("13") || c.startsWith("14")) return "investing";
  if (c.startsWith("22") || c.startsWith("3")) return "financing";
  return "operating";
}

export interface CashFlowRow {
  accountId: string;
  code: string;
  name: string;
  nameAr: string;
  section: CashFlowSection;
  amount: number;
}

export interface CashFlowStatement {
  /** Cash held before the period started. */
  openingCash: number;
  /** Cash held at the end of the period (opening + net change). */
  closingCash: number;
  /** Net movement of the cash accounts inside the period. */
  netChange: number;
  operating: CashFlowRow[];
  investing: CashFlowRow[];
  financing: CashFlowRow[];
  totalOperating: number;
  totalInvesting: number;
  totalFinancing: number;
  /**
   * `true` when the section totals add up to the cash accounts' own movement.
   * A `false` here means the data is not a balanced ledger and the statement must
   * not be presented as reconciled.
   */
  reconciled: boolean;
}

/** Net movement of the cash accounts across a set of entries and their lines. */
function cashMovement(
  entries: LedgerEntry[],
  lines: LedgerLine[],
  cashIds: Set<string>,
): number {
  const countable = new Set(entries.filter((e) => e.status !== "cancelled").map((e) => e.id));
  let movement = 0;
  for (const line of lines) {
    const entryId = String(line.journal_entry_id ?? "");
    if (!countable.has(entryId)) continue;
    if (!cashIds.has(String(line.account_id ?? ""))) continue;
    // Cash is debit-nature: a debit increases it.
    movement += num(line.debit) - num(line.credit);
  }
  return round3(movement);
}

export function buildCashFlowStatement(params: {
  accounts: LedgerAccount[];
  entries: LedgerEntry[];
  lines: LedgerLine[];
  fromDate: string;
  toDate: string;
}): CashFlowStatement {
  const { accounts, entries, lines, fromDate, toDate } = params;

  const accountById = new Map<string, LedgerAccount>();
  const cashIds = new Set<string>();
  for (const a of accounts) {
    accountById.set(a.id, a);
    if (isCashAccount(a)) cashIds.add(a.id);
  }

  // Split the entries by date: before the period (opening cash) and inside it.
  const inPeriod: LedgerEntry[] = [];
  const beforePeriod: LedgerEntry[] = [];
  for (const e of entries) {
    if (e.status === "cancelled") continue;
    const d = String(e.entry_date ?? "");
    if (d && d < fromDate) beforePeriod.push(e);
    else if ((!d || d >= fromDate) && (!d || d <= toDate)) inPeriod.push(e);
  }

  const openingCash = cashMovement(beforePeriod, lines, cashIds);

  // Direct-method attribution: for each entry inside the period that touches
  // cash, every non-cash line contributes -(debit - credit) to the cash movement.
  const inPeriodIds = new Set(inPeriod.map((e) => e.id));
  const cashEntries = new Set<string>();
  for (const line of lines) {
    const entryId = String(line.journal_entry_id ?? "");
    if (inPeriodIds.has(entryId) && cashIds.has(String(line.account_id ?? ""))) cashEntries.add(entryId);
  }

  const byAccount = new Map<string, number>();
  for (const line of lines) {
    const entryId = String(line.journal_entry_id ?? "");
    if (!cashEntries.has(entryId)) continue;
    const accountId = String(line.account_id ?? "");
    if (cashIds.has(accountId)) continue; // cash-to-cash (e.g. bank transfer) is not a flow
    const contribution = -(num(line.debit) - num(line.credit));
    byAccount.set(accountId, round3((byAccount.get(accountId) ?? 0) + contribution));
  }

  const rows: CashFlowRow[] = [];
  for (const [accountId, amount] of byAccount) {
    if (Math.abs(amount) < 0.001) continue;
    const acc = accountById.get(accountId);
    const code = String(acc?.code ?? "");
    rows.push({
      accountId,
      code,
      name: String(acc?.name_en ?? acc?.name ?? code),
      nameAr: String(acc?.name_ar ?? acc?.name ?? code),
      section: classifyCashFlowSection(code),
      amount,
    });
  }

  const operating = rows.filter((r) => r.section === "operating").sort((a, b) => a.code.localeCompare(b.code));
  const investing = rows.filter((r) => r.section === "investing").sort((a, b) => a.code.localeCompare(b.code));
  const financing = rows.filter((r) => r.section === "financing").sort((a, b) => a.code.localeCompare(b.code));

  const totalOperating = round3(operating.reduce((s, r) => s + r.amount, 0));
  const totalInvesting = round3(investing.reduce((s, r) => s + r.amount, 0));
  const totalFinancing = round3(financing.reduce((s, r) => s + r.amount, 0));
  const netChange = round3(totalOperating + totalInvesting + totalFinancing);
  const cashAccountsMovement = cashMovement(inPeriod, lines, cashIds);

  return {
    openingCash,
    closingCash: round3(openingCash + cashAccountsMovement),
    netChange,
    operating,
    investing,
    financing,
    totalOperating,
    totalInvesting,
    totalFinancing,
    reconciled: Math.abs(netChange - cashAccountsMovement) < 0.001,
  };
}

/** Re-exported so a page can show a sign without re-deriving the convention. */
export { isDebitNature };
