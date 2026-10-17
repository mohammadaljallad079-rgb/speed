import type { ReportRow } from "./types";

/**
 * Bahrain VAT return model (pure).
 *
 * Structure follows the Bahrain VAT return: sales and purchases split by taxable
 * treatment — standard-rated (10%), zero-rated, exempt, and out-of-scope /
 * unregistered parties — with taxable amounts and output/input VAT totalled.
 *
 * Classification uses the transaction's real registration status and tax
 * treatment. When treatment cannot be determined it is reported as
 * `unclassified` for review rather than being invented. Tax rates are never
 * changed here.
 */

export const STANDARD_VAT_RATE = 0.1;

export type VatTreatment = "standard" | "zero" | "exempt" | "out_of_scope" | "unclassified";

export interface VatTransaction {
  section: "sales" | "purchases";
  /** Value before VAT. */
  amount: number;
  /** VAT actually recorded on the transaction, if known. */
  vatAmount?: number | null;
  /** Explicit treatment, if the source declares one. */
  treatment?: VatTreatment | null;
  /** Whether the counterparty is VAT-registered, if known. */
  partyRegistered?: boolean | null;
}

export interface VatTreatmentLine {
  section: "sales" | "purchases";
  treatment: VatTreatment;
  rate: number;
  taxableAmount: number;
  vatAmount: number;
  count: number;
}

export interface VatIssue {
  section: "sales" | "purchases";
  treatment: VatTreatment;
  messageAr: string;
  messageEn: string;
  amount: number;
}

export interface VatResult {
  lines: VatTreatmentLine[];
  totalOutputVat: number;
  totalInputVat: number;
  netVat: number;
  totalTaxableSales: number;
  totalTaxablePurchases: number;
  /** Rows needing human review (unclassified treatment or VAT mismatch). */
  issues: VatIssue[];
}

const EPSILON = 0.001;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Classifies one transaction without inventing a treatment it cannot know. */
export function classifyVatTransaction(t: VatTransaction): VatTreatmentLine["treatment"] {
  if (t.treatment) return t.treatment;
  const vat = t.vatAmount ?? null;
  if (t.partyRegistered === false) return "out_of_scope";
  if (vat !== null && vat > EPSILON) return "standard";
  // Zero VAT with a registered party could be zero-rated or exempt — we cannot
  // tell from the record alone, so it is left for review rather than guessed.
  return "unclassified";
}

function rateFor(treatment: VatTreatment): number {
  return treatment === "standard" ? STANDARD_VAT_RATE : 0;
}

export function buildVatResult(transactions: VatTransaction[]): VatResult {
  const buckets = new Map<string, VatTreatmentLine>();
  const issues: VatIssue[] = [];

  const keyOf = (s: string, t: string) => `${s}::${t}`;

  for (const t of transactions) {
    const treatment = classifyVatTransaction(t);
    const section = t.section;
    const k = keyOf(section, treatment);
    if (!buckets.has(k)) {
      buckets.set(k, { section, treatment, rate: rateFor(treatment), taxableAmount: 0, vatAmount: 0, count: 0 });
    }
    const line = buckets.get(k)!;
    line.taxableAmount = round3(line.taxableAmount + (Number(t.amount) || 0));
    line.vatAmount = round3(line.vatAmount + (Number(t.vatAmount) || 0));
    line.count += 1;

    if (treatment === "standard") {
      const expected = round3((Number(t.amount) || 0) * STANDARD_VAT_RATE);
      const recorded = round3(Number(t.vatAmount) || 0);
      if (Math.abs(expected - recorded) > EPSILON) {
        issues.push({
          section,
          treatment,
          amount: recorded,
          messageAr: `ضريبة غير مطابقة: المتوقع ${expected} والسجل ${recorded}.`,
          messageEn: `VAT mismatch: expected ${expected}, recorded ${recorded}.`,
        });
      }
    }
    if (treatment === "unclassified") {
      issues.push({
        section,
        treatment,
        amount: Number(t.amount) || 0,
        messageAr: "معاملة غير مصنّفة ضريبيًا — تحتاج مراجعة.",
        messageEn: "Unclassified tax treatment — requires review.",
      });
    }
  }

  // Stable display order: sales then purchases, each by treatment.
  const order: VatTreatment[] = ["standard", "zero", "exempt", "out_of_scope", "unclassified"];
  const lines: VatTreatmentLine[] = [];
  for (const section of ["sales", "purchases"] as const) {
    for (const treatment of order) {
      const found = buckets.get(keyOf(section, treatment));
      if (found) lines.push(found);
    }
  }

  let totalOutputVat = 0;
  let totalInputVat = 0;
  let totalTaxableSales = 0;
  let totalTaxablePurchases = 0;
  for (const line of lines) {
    if (line.section === "sales") {
      totalOutputVat = round3(totalOutputVat + line.vatAmount);
      totalTaxableSales = round3(totalTaxableSales + line.taxableAmount);
    } else {
      totalInputVat = round3(totalInputVat + line.vatAmount);
      totalTaxablePurchases = round3(totalTaxablePurchases + line.taxableAmount);
    }
  }

  return {
    lines,
    totalOutputVat,
    totalInputVat,
    netVat: round3(totalOutputVat - totalInputVat),
    totalTaxableSales,
    totalTaxablePurchases,
    issues,
  };
}

const SECTION_LABEL: Record<"sales" | "purchases", { ar: string; en: string }> = {
  sales: { ar: "المبيعات", en: "Sales" },
  purchases: { ar: "المشتريات", en: "Purchases" },
};

const TREATMENT_LABEL: Record<VatTreatment, { ar: string; en: string }> = {
  standard: { ar: "خاضع للنسبة القياسية 10%", en: "Standard-rated 10%" },
  zero: { ar: "نسبة صفرية", en: "Zero-rated" },
  exempt: { ar: "معفى", en: "Exempt" },
  out_of_scope: { ar: "غير مسجل / خارج النطاق", en: "Unregistered / out of scope" },
  unclassified: { ar: "غير محدد (للمراجعة)", en: "Unclassified (review)" },
};

/** Projects the VAT result into the `vat_report` rows (never mutating inputs). */
export function vatReportRows(result: VatResult): ReportRow[] {
  return result.lines.map((line) => ({
    section: SECTION_LABEL[line.section].ar,
    treatment: TREATMENT_LABEL[line.treatment].ar,
    taxable_amount: line.taxableAmount,
    rate: line.rate,
    vat_amount: line.vatAmount,
  }));
}

// ---------------------------------------------------------------------------
// Source-level aggregation for the VAT report screen.
//
// The screen reads three real tables and must show, per source, the taxable
// base and the VAT separately (never conflate the invoice total with the VAT).
// The stored amounts are NOT uniform, so the taxable base is derived from the
// real columns rather than assumed:
//
//   invoices.total_amount / purchase_invoices.total_amount  -> VAT-inclusive
//       taxable = total_amount - vat_amount
//   expenses.amount                                         -> VAT-exclusive
//       taxable = amount
//
// Cancelled documents are excluded. No tax treatment is invented: the recorded
// `vat_amount` is reported as-is (the schema stores no recoverability flag).
// ---------------------------------------------------------------------------

export interface VatSourceRow {
  vat_amount?: number | string | null;
  total_amount?: number | string | null;
  amount?: number | string | null;
  status?: string | null;
  invoice_date?: string | null;
  bill_date?: string | null;
  expense_date?: string | null;
}

export interface VatSourceBreakdown {
  sales: { taxable: number; vat: number };
  purchases: { taxable: number; vat: number };
  expenses: { taxable: number; vat: number };
}

export interface VatMonthRow {
  month: string;
  outputVat: number;
  inputVat: number;
  net: number;
}

export interface VatSummary {
  outputVat: number;
  inputVat: number;
  netVat: number;
  totalTaxableSales: number;
  totalTaxablePurchases: number;
  breakdown: VatSourceBreakdown;
  months: VatMonthRow[];
}

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? x : 0;
};
const monthKey = (d?: string | null): string => (d && d.length >= 7 ? d.slice(0, 7) : "unknown");

/** Aggregates the three VAT sources into totals, a source breakdown and months. */
export function summarizeVatSources(input: {
  invoices: VatSourceRow[];
  purchases: VatSourceRow[];
  expenses: VatSourceRow[];
}): VatSummary {
  const breakdown: VatSourceBreakdown = {
    sales: { taxable: 0, vat: 0 },
    purchases: { taxable: 0, vat: 0 },
    expenses: { taxable: 0, vat: 0 },
  };
  const months = new Map<string, { output: number; input: number }>();
  const bucket = (key: string) => {
    if (!months.has(key)) months.set(key, { output: 0, input: 0 });
    return months.get(key)!;
  };

  for (const r of input.invoices) {
    if (r.status === "cancelled") continue;
    const vat = n(r.vat_amount);
    const taxable = round3(n(r.total_amount) - vat);
    breakdown.sales.taxable = round3(breakdown.sales.taxable + taxable);
    breakdown.sales.vat = round3(breakdown.sales.vat + vat);
    bucket(monthKey(r.invoice_date)).output = round3(bucket(monthKey(r.invoice_date)).output + vat);
  }
  for (const r of input.purchases) {
    if (r.status === "cancelled") continue;
    const vat = n(r.vat_amount);
    const taxable = round3(n(r.total_amount) - vat);
    breakdown.purchases.taxable = round3(breakdown.purchases.taxable + taxable);
    breakdown.purchases.vat = round3(breakdown.purchases.vat + vat);
    bucket(monthKey(r.bill_date)).input = round3(bucket(monthKey(r.bill_date)).input + vat);
  }
  for (const r of input.expenses) {
    const vat = n(r.vat_amount);
    const taxable = round3(n(r.amount)); // expenses.amount is stored pre-VAT
    breakdown.expenses.taxable = round3(breakdown.expenses.taxable + taxable);
    breakdown.expenses.vat = round3(breakdown.expenses.vat + vat);
    bucket(monthKey(r.expense_date)).input = round3(bucket(monthKey(r.expense_date)).input + vat);
  }

  const outputVat = breakdown.sales.vat;
  const inputVat = round3(breakdown.purchases.vat + breakdown.expenses.vat);
  const totalTaxableSales = breakdown.sales.taxable;
  const totalTaxablePurchases = round3(breakdown.purchases.taxable + breakdown.expenses.taxable);

  const monthRows: VatMonthRow[] = Array.from(months.keys())
    .filter((k) => k !== "unknown")
    .sort()
    .map((k) => {
      const m = months.get(k)!;
      return { month: k, outputVat: m.output, inputVat: m.input, net: round3(m.output - m.input) };
    });

  return {
    outputVat,
    inputVat,
    netVat: round3(outputVat - inputVat),
    totalTaxableSales,
    totalTaxablePurchases,
    breakdown,
    months: monthRows,
  };
}
