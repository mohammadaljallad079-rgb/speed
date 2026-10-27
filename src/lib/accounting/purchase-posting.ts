/**
 * Purchase (supplier bill) posting.
 *
 * SPEED ERP has NO inventory: a purchase is an expense or an asset acquisition,
 * never a stock movement. This module owns the one journal a purchase posts:
 *
 *   Dr expense/asset account          grandTotal
 *   Cr cash / bank                    advancePayment   (only when paid at once)
 *   Cr accounts payable (21001)       remainingAmount  (only when on credit)
 *
 * It never touches revenue. The pure builder is separated from the DB write so
 * the debit/credit shape is testable without a database.
 */

export const PURCHASE_ACCOUNT_CODES = {
  cash: "11001",
  bank: "11002",
  payable: "21001",
  /** Input (recoverable) VAT. Seeded by migration 010; may be absent live. */
  inputVat: "24001",
} as const;

/** Expense-category -> account code, matching the purchases screen. */
export const PURCHASE_EXPENSE_CODES: Record<string, string> = {
  fuel: "51001",
  maintenance: "51002",
  insurance: "51003",
  registration: "51004",
  tyres: "51005",
  accident_repair: "51006",
  other: "51099",
};

export function expenseCodeFor(category: string | null | undefined): string {
  return PURCHASE_EXPENSE_CODES[category ?? ""] || PURCHASE_EXPENSE_CODES.other;
}

export function cashBankCodeForMethod(paymentType: string): string {
  return paymentType === "cash" ? PURCHASE_ACCOUNT_CODES.cash : PURCHASE_ACCOUNT_CODES.bank;
}

export type PurchaseJournalLine = {
  account_id: string;
  debit: number;
  credit: number;
  description: string;
  line_order: number;
};

export type PurchaseJournal = {
  header: {
    journal_number: string;
    entry_date: string;
    reference_number: string;
    description: string;
    total_debit: number;
    total_credit: number;
    is_balanced: true;
    status: "posted";
    entry_type: "purchase_invoice";
  };
  lines: PurchaseJournalLine[];
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Build the balanced purchase journal. Returns null when the total is not
 * positive or a required account id is missing, so a caller can never post a
 * zero-value or unbalanced entry.
 */
export function buildPurchaseJournal(params: {
  journalNumber: string;
  invoiceNumber: string;
  date: string;
  description: string;
  grandTotal: number;
  advancePayment: number;
  remainingAmount: number;
  expenseAccountId: string;
  cashAccountId: string;
  payableAccountId: string;
  /**
   * The recoverable VAT included in `grandTotal`. When an input-VAT account was
   * resolved this is split out to that account instead of being capitalised into
   * the expense - otherwise the expense account carries tax that belongs on the
   * VAT return, and the input-VAT claim is lost.
   */
  vatAmount?: number;
  vatAccountId?: string | null;
}): PurchaseJournal | null {
  const { grandTotal, advancePayment, remainingAmount } = params;
  if (!(grandTotal > 0)) return null;
  if (!params.expenseAccountId) return null;
  if (advancePayment > 0 && !params.cashAccountId) return null;
  if (remainingAmount > 0 && !params.payableAccountId) return null;
  if (!params.journalNumber) return null;

  // Split out input VAT only when an account exists for it AND the remainder
  // stays positive. A bill with no input-VAT account still posts (the whole
  // amount goes to the expense), matching how the rest of the chart degrades.
  const requestedVat = round3(Math.max(params.vatAmount ?? 0, 0));
  const vat = params.vatAccountId && requestedVat > 0 && requestedVat < grandTotal ? requestedVat : 0;
  const taxable = round3(grandTotal - vat);

  const lines: PurchaseJournalLine[] = [
    { account_id: params.expenseAccountId, debit: taxable, credit: 0, description: "Expense", line_order: 1 },
  ];
  let order = 2;
  if (vat > 0) {
    lines.push({ account_id: params.vatAccountId as string, debit: vat, credit: 0, description: "Input VAT", line_order: order++ });
  }
  if (advancePayment > 0) {
    lines.push({ account_id: params.cashAccountId, debit: 0, credit: round3(advancePayment), description: "Payment made", line_order: order++ });
  }
  if (remainingAmount > 0) {
    lines.push({ account_id: params.payableAccountId, debit: 0, credit: round3(remainingAmount), description: "Amount due to supplier", line_order: order++ });
  }

  const debit = round3(lines.reduce((s, l) => s + l.debit, 0));
  const credit = round3(lines.reduce((s, l) => s + l.credit, 0));
  if (debit !== credit) return null;

  return {
    header: {
      journal_number: params.journalNumber,
      entry_date: params.date,
      reference_number: params.invoiceNumber,
      description: params.description,
      total_debit: debit,
      total_credit: credit,
      is_balanced: true,
      status: "posted",
      entry_type: "purchase_invoice",
    },
    lines,
  };
}
