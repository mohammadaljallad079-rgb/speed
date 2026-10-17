/**
 * Pure journal builders for the four manual posting screens:
 * bank transfer, petty cash, payroll and rental deposit refund.
 *
 * WHY
 * ---
 * Each of these screens used to inline its own journal header and line array.
 * Inlining made the debit/credit shape untestable and let the four screens drift
 * from each other and from the canonical `journal_lines` table (Execution 16
 * found them writing to the orphaned `journal_entry_lines`). Extracting the
 * shape into pure builders, as `payment-posting.ts` already does for supplier
 * payments, lets the balance invariants be asserted without a database and
 * guarantees the screens cannot silently diverge.
 *
 * Each builder returns `null` for a non-positive amount or a missing account, so
 * a caller can never post a zero-value or unbalanced entry. Lines are returned
 * WITHOUT `journal_entry_id`; the caller adds it once the header has an id.
 */

export type ManualJournalLine = {
  account_id: string;
  debit: number;
  credit: number;
  description: string;
};

export type ManualJournal = {
  header: {
    journal_number: string;
    entry_date: string;
    description: string;
    entry_type: string;
    status: "posted";
    total_debit: number;
    total_credit: number;
    is_balanced: true;
    reference_number?: string | null;
  };
  lines: ManualJournalLine[];
};

type PairInput = {
  journalNumber: string;
  date: string;
  description: string;
  amount: number;
  entryType: string;
  debitAccountId: string;
  creditAccountId: string;
  debitDescription?: string;
  creditDescription?: string;
  reference?: string | null;
};

/** Build a balanced two-line journal (Dr one account, Cr another). */
function buildPair(input: PairInput): ManualJournal | null {
  const {
    journalNumber,
    date,
    description,
    amount,
    entryType,
    debitAccountId,
    creditAccountId,
    debitDescription,
    creditDescription,
    reference,
  } = input;
  if (!(amount > 0) || !debitAccountId || !creditAccountId) return null;
  if (!journalNumber) return null;

  const header: ManualJournal["header"] = {
    journal_number: journalNumber,
    entry_date: date,
    description,
    entry_type: entryType,
    status: "posted",
    total_debit: amount,
    total_credit: amount,
    is_balanced: true,
  };
  if (reference !== undefined) header.reference_number = reference ?? null;

  return {
    header,
    lines: [
      { account_id: debitAccountId, debit: amount, credit: 0, description: debitDescription ?? description },
      { account_id: creditAccountId, debit: 0, credit: amount, description: creditDescription ?? description },
    ],
  };
}

/** Bank transfer: Dr destination (to) / Cr source (from). */
export function buildBankTransferJournal(params: {
  journalNumber: string;
  date: string;
  description: string;
  amount: number;
  fromAccountId: string;
  toAccountId: string;
  reference?: string | null;
}): ManualJournal | null {
  return buildPair({
    journalNumber: params.journalNumber,
    date: params.date,
    description: params.description,
    amount: params.amount,
    entryType: "bank_transfer",
    debitAccountId: params.toAccountId,
    creditAccountId: params.fromAccountId,
    reference: params.reference,
  });
}

/** Payroll: Dr salaries expense / Cr cash. */
export function buildPayrollJournal(params: {
  journalNumber: string;
  date: string;
  description: string;
  amount: number;
  salaryAccountId: string;
  cashAccountId: string;
}): ManualJournal | null {
  return buildPair({
    journalNumber: params.journalNumber,
    date: params.date,
    description: params.description,
    amount: params.amount,
    entryType: "payroll",
    debitAccountId: params.salaryAccountId,
    creditAccountId: params.cashAccountId,
  });
}

/**
 * Petty cash:
 *   fund    -> Dr petty cash (11003) / Cr main cash (11001)
 *   expense -> Dr expense / Cr petty cash
 * The expense account passed by the screen is its `cashAccount` value; the shape
 * is preserved exactly as the screen posted it.
 */
export function buildPettyCashJournal(params: {
  journalNumber: string;
  date: string;
  description: string;
  amount: number;
  kind: "fund" | "expense";
  pettyAccountId: string;
  expenseAccountId: string;
  fundDescription: string;
  expenseDescription: string;
}): ManualJournal | null {
  const { kind } = params;
  return buildPair({
    journalNumber: params.journalNumber,
    date: params.date,
    description: params.description,
    amount: params.amount,
    entryType: kind === "fund" ? "petty_cash_fund" : "petty_cash_expense",
    debitAccountId: kind === "fund" ? params.pettyAccountId : params.expenseAccountId,
    creditAccountId: kind === "fund" ? params.expenseAccountId : params.pettyAccountId,
    debitDescription: params.fundDescription,
    creditDescription: params.expenseDescription,
  });
}

/** Rental deposit refund: Dr deposit liability / Cr cash. */
export function buildDepositRefundJournal(params: {
  journalNumber: string;
  date: string;
  description: string;
  amount: number;
  depositAccountId: string;
  cashAccountId: string;
  reference?: string | null;
}): ManualJournal | null {
  return buildPair({
    journalNumber: params.journalNumber,
    date: params.date,
    description: params.description,
    amount: params.amount,
    entryType: "deposit_refund",
    debitAccountId: params.depositAccountId,
    creditAccountId: params.cashAccountId,
    reference: params.reference,
  });
}

/** A journal is internally balanced when its lines' debits equal credits. */
export function isJournalBalanced(journal: ManualJournal): boolean {
  const debit = journal.lines.reduce((s, l) => s + l.debit, 0);
  const credit = journal.lines.reduce((s, l) => s + l.credit, 0);
  return (
    Math.abs(debit - credit) < 0.001 &&
    Math.abs(journal.header.total_debit - debit) < 0.001 &&
    Math.abs(journal.header.total_credit - credit) < 0.001
  );
}
