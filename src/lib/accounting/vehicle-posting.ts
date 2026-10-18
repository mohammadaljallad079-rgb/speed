/**
 * Vehicle-acquisition posting.
 *
 * Buying a car capitalises an asset - it is NOT a sale and must never touch a
 * revenue account. The single journal is:
 *
 *   Dr Vehicle fleet (13001)     purchasePrice
 *   Cr Bank (11002)              downPayment      (only when paid up front)
 *   Cr Bank loan (22001)         loanAmount       (only when financed)
 *
 * The loan amount is the financed part of the price (price - down payment); the
 * purchase is recognised at the price, not at the total of the instalments
 * (interest is a separate future cost). The pure builder is separated from the
 * DB write so the shape is testable without a database.
 */

export const VEHICLE_ACCOUNT_CODES = {
  fleet: "13001",
  bank: "11002",
  bankLoan: "22001",
} as const;

export type VehicleJournalLine = {
  account_id: string;
  debit: number;
  credit: number;
  description: string;
  line_order: number;
};

export type VehicleJournal = {
  header: {
    journal_number: string;
    entry_date: string;
    reference_number: string;
    description: string;
    total_debit: number;
    total_credit: number;
    is_balanced: true;
    status: "posted";
    entry_type: "vehicle_purchase";
  };
  lines: VehicleJournalLine[];
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Build the balanced vehicle-acquisition journal. Returns null when the price is
 * not positive or a required account is missing, so a caller cannot post a
 * zero-value or unbalanced entry.
 */
export function buildVehiclePurchaseJournal(params: {
  journalNumber: string;
  reference: string;
  date: string;
  description: string;
  purchasePrice: number;
  downPayment: number;
  loanAmount: number;
  fleetAccountId: string;
  bankAccountId: string;
  loanAccountId: string;
}): VehicleJournal | null {
  const { purchasePrice, downPayment, loanAmount } = params;
  if (!(purchasePrice > 0)) return null;
  if (!params.fleetAccountId) return null;
  if (downPayment > 0 && !params.bankAccountId) return null;
  if (loanAmount > 0 && !params.loanAccountId) return null;
  if (!params.journalNumber) return null;
  if (round3(downPayment + loanAmount) !== round3(purchasePrice)) return null;

  const lines: VehicleJournalLine[] = [
    { account_id: params.fleetAccountId, debit: round3(purchasePrice), credit: 0, description: "Vehicle Fleet", line_order: 1 },
  ];
  let order = 2;
  if (downPayment > 0) {
    lines.push({ account_id: params.bankAccountId, debit: 0, credit: round3(downPayment), description: "Down payment", line_order: order++ });
  }
  if (loanAmount > 0) {
    lines.push({ account_id: params.loanAccountId, debit: 0, credit: round3(loanAmount), description: "Bank loan", line_order: order++ });
  }

  const debit = round3(lines.reduce((s, l) => s + l.debit, 0));
  const credit = round3(lines.reduce((s, l) => s + l.credit, 0));
  if (debit !== credit) return null;

  return {
    header: {
      journal_number: params.journalNumber,
      entry_date: params.date,
      reference_number: params.reference,
      description: params.description,
      total_debit: debit,
      total_credit: credit,
      is_balanced: true,
      status: "posted",
      entry_type: "vehicle_purchase",
    },
    lines,
  };
}
