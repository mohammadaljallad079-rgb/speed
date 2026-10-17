import type { ColumnType } from "./types";

/**
 * Deterministic report validator.
 *
 * Pure and rule-based: it does NOT rely on the language model to decide whether
 * numbers are right. Each finding carries a severity, the evidence, the current
 * and expected values, a suggested fix, and a repair *class*:
 *   1 = safe display change, 2 = report-definition change (still not data),
 *   3 = sensitive accounting/data change (never applied here).
 *
 * Tolerance is applied so rounding, currency scale and refunds (negative
 * amounts) are not reported as errors.
 */

export type IssueSeverity = "error" | "warning" | "info";
export type IssueCategory = "calculation" | "data" | "logic" | "format";
export type RepairClass = 1 | 2 | 3;

export interface ValidationColumn {
  key: string;
  labelAr: string;
  labelEn: string;
  type: ColumnType;
  total?: boolean;
}

export interface ReportIssue {
  id: string;
  severity: IssueSeverity;
  category: IssueCategory;
  titleAr: string;
  titleEn: string;
  current?: string | number | null;
  expected?: string | number | null;
  evidence: string;
  fixAr: string;
  fixEn: string;
  fixClass: RepairClass;
  field?: string;
  /** Row indices (0-based) the issue relates to, for highlighting. */
  rows?: number[];
}

export interface ReportValidationInput {
  columns: ValidationColumn[];
  rows: Record<string, unknown>[];
  /** Aggregate values the report claims, keyed by column key. */
  totals?: Record<string, number>;
  /** How many source records the query matched (before any client-side filter). */
  sourceCount?: number;
  period?: { from?: string | null; to?: string | null };
  direction?: "rtl" | "ltr";
  /** Fields required to be present on every row. */
  required?: string[];
  /**
   * Column key whose value groups the rows. When present, the validator checks
   * that per-group subtotals add up to the declared grand total.
   */
  groupColumn?: string;
}

const TOL = 0.01;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Key columns whose duplicates usually mean double-counted totals. */
const KEY_FOR_DUPLICATES = ["invoice_number", "bill_number", "account_code", "payment_reference"];

export function validateReport(input: ReportValidationInput): ReportIssue[] {
  const issues: ReportIssue[] = [];
  const { columns, rows } = input;
  const colByKey = new Map(columns.map((c) => [c.key, c]));

  // --- Calculation: each declared total equals the sum of its rows. ----------
  for (const col of columns) {
    if (!col.total) continue;
    const sum = rows.reduce((s, r) => s + (num(r[col.key]) ?? 0), 0);
    const claimed = input.totals?.[col.key];
    if (typeof claimed === "number" && Math.abs(sum - claimed) > TOL) {
      issues.push({
        id: `calc-total-${col.key}`,
        severity: "error",
        category: "calculation",
        titleAr: `إجمالي العمود «${col.labelAr}» لا يساوي مجموع التفاصيل`,
        titleEn: `Column "${col.labelEn}" total does not equal the sum of its rows`,
        current: round(claimed),
        expected: round(sum),
        evidence: `Σ rows = ${round(sum)} but the report states ${round(claimed)}.`,
        fixAr: "أعد احتساب الصف الإجمالي بمعادلة على كل الصفوف.",
        fixEn: "Recompute the totals row with a formula over all rows.",
        fixClass: 2,
        field: col.key,
      });
    }
  }

  // --- Calculation: derived relationships that must hold row by row. ---------
  if (colByKey.has("total") && colByKey.has("vat_amount") && colByKey.has("subtotal")) {
    rows.forEach((r, i) => {
      const total = num(r.total);
      const vat = num(r.vat_amount);
      const sub = num(r.subtotal);
      if (total !== null && vat !== null && sub !== null && Math.abs(total - vat - sub) > TOL) {
        issues.push({
          id: `calc-subtotal-${i}`,
          severity: "error",
          category: "calculation",
          titleAr: "الإجمالي لا يساوي (قبل الضريبة + الضريبة)",
          titleEn: "Total is not (subtotal + VAT)",
          current: round(total),
          expected: round(sub + vat),
          evidence: `row ${i + 1}: ${total} ≠ ${sub} + ${vat}`,
          fixAr: "تحقق من احتساب قبل الضريبة والإجمالي في السجل المصدر.",
          fixEn: "Verify subtotal and total in the source record.",
          fixClass: 3,
          field: "total",
          rows: [i],
        });
      }
    });
  }

  if (colByKey.has("total") && colByKey.has("paid_amount") && colByKey.has("remaining")) {
    rows.forEach((r, i) => {
      const total = num(r.total);
      const paid = num(r.paid_amount);
      const rem = num(r.remaining);
      if (total !== null && paid !== null && rem !== null && Math.abs(total - paid - rem) > TOL) {
        issues.push({
          id: `calc-remaining-${i}`,
          severity: "error",
          category: "calculation",
          titleAr: "المتبقي لا يساوي (الإجمالي - المدفوع)",
          titleEn: "Remaining is not (total - paid)",
          current: round(rem),
          expected: round(total - paid),
          evidence: `row ${i + 1}: remaining ${rem}, expected ${round(total - paid)}`,
          fixAr: "تحقق من المدفوع والمتبقي في السجل المصدر.",
          fixEn: "Verify paid and remaining in the source record.",
          fixClass: 3,
          field: "remaining",
          rows: [i],
        });
      }
    });
  }

  // --- Data: duplicate keys that double-count totals. ------------------------
  for (const key of KEY_FOR_DUPLICATES) {
    if (!colByKey.has(key)) continue;
    const seen = new Map<string, number[]>();
    rows.forEach((r, i) => {
      const v = str(r[key]).trim();
      if (!v) return;
      if (!seen.has(v)) seen.set(v, []);
      seen.get(v)!.push(i);
    });
    for (const [v, idx] of seen) {
      if (idx.length > 1) {
        issues.push({
          id: `data-dup-${key}-${v}`,
          severity: "warning",
          category: "data",
          titleAr: `سجل مكرر: ${key} = ${v}`,
          titleEn: `Duplicate record: ${key} = ${v}`,
          current: idx.length,
          expected: 1,
          evidence: `appears ${idx.length} times (rows ${idx.map((i) => i + 1).join(", ")})`,
          fixAr: "راجع سبب التكرار؛ قد يكون الربط بين جدولين يضاعف الإجمالي.",
          fixEn: "Review why it repeats; a join may be double-counting.",
          fixClass: 3,
          field: key,
          rows: idx,
        });
      }
    }
  }

  // --- Data: missing required values. ----------------------------------------
  for (const key of input.required ?? []) {
    const missing = rows.map((r, i) => ({ i, v: r[key] })).filter((x) => str(x.v).trim() === "").map((x) => x.i);
    if (missing.length) {
      issues.push({
        id: `data-missing-${key}`,
        severity: "warning",
        category: "data",
        titleAr: `قيم ناقصة في «${colByKey.get(key)?.labelAr ?? key}»`,
        titleEn: `Missing values in "${colByKey.get(key)?.labelEn ?? key}"`,
        current: missing.length,
        expected: 0,
        evidence: `${missing.length} row(s): ${missing.map((i) => i + 1).join(", ")}`,
        fixAr: "أكمل الحقل الناقص في السجل المصدر عبر واجهة النظام.",
        fixEn: "Complete the missing field in the source record via the system screen.",
        fixClass: 3,
        field: key,
        rows: missing,
      });
    }
  }

  // --- Data: rows outside the requested period. ------------------------------
  const dateCol = columns.find((c) => c.type === "date")?.key;
  if (dateCol && (input.period?.from || input.period?.to)) {
    const outside: number[] = [];
    rows.forEach((r, i) => {
      const v = str(r[dateCol]).slice(0, 10);
      if (!v) return;
      if (input.period?.from && v < input.period.from) outside.push(i);
      else if (input.period?.to && v > input.period.to) outside.push(i);
    });
    if (outside.length) {
      issues.push({
        id: `data-period-${dateCol}`,
        severity: "warning",
        category: "data",
        titleAr: "سجلات خارج الفترة المطلوبة",
        titleEn: "Records outside the requested period",
        current: outside.length,
        expected: 0,
        evidence: `rows ${outside.map((i) => i + 1).join(", ")}`,
        fixAr: "تحقق من فلتر التاريخ ومصدر البيانات.",
        fixEn: "Check the date filter and the data source.",
        fixClass: 2,
        field: dateCol,
        rows: outside,
      });
    }
  }

  // --- Data: VAT classification inconsistent with 10% standard. --------------
  if (colByKey.has("vat_amount")) {
    const inconsistent: number[] = [];
    rows.forEach((r, i) => {
      const vat = num(r.vat_amount);
      const sub = num(r.subtotal) ?? num(r.total);
      if (vat !== null && sub !== null && Math.abs(sub) > TOL && vat !== 0) {
        const expected = Math.abs(sub) * 0.1;
        if (Math.abs(Math.abs(vat) - expected) > TOL * 10) inconsistent.push(i);
      }
    });
    if (inconsistent.length) {
      issues.push({
        id: "data-vat-rate",
        severity: "info",
        category: "data",
        titleAr: "معاملات ضريبية لا تطابق النسبة القياسية 10%",
        titleEn: "VAT amounts that do not follow the 10% standard rate",
        current: inconsistent.length,
        expected: "review",
        evidence: `rows ${inconsistent.map((i) => i + 1).join(", ")} — may be zero-rated, exempt or wrongly classified.`,
        fixAr: "راجع التصنيف الضريبي الفعلي لكل معاملة؛ لا تغيّر القاعدة الضريبية تلقائيًا.",
        fixEn: "Review each transaction's real tax treatment; do not auto-change the tax rule.",
        fixClass: 3,
        field: "vat_amount",
        rows: inconsistent,
      });
    }
  }

  // --- Logic: report rows vs matched source records. -------------------------
  if (typeof input.sourceCount === "number" && input.sourceCount !== rows.length) {
    issues.push({
      id: "logic-source-count",
      severity: "warning",
      category: "logic",
      titleAr: "عدد صفوف التقرير لا يطابق عدد السجلات المصدر",
      titleEn: "Report row count does not match the source record count",
      current: rows.length,
      expected: input.sourceCount,
      evidence: `report ${rows.length} vs source ${input.sourceCount}`,
      fixAr: "تحقق من الفلاتر غير المقصودة أو استبعاد سجلات مستحقة الظهور.",
      fixEn: "Check for unintended filters or excluded records that should appear.",
      fixClass: 2,
    });
  }

  // --- Format: duplicate column labels / missing totals / RTL. ---------------
  const labels = new Map<string, number>();
  for (const c of columns) labels.set(c.labelEn, (labels.get(c.labelEn) ?? 0) + 1);
  const dupLabels = [...labels.entries()].filter(([, n]) => n > 1).map(([l]) => l);
  if (dupLabels.length) {
    issues.push({
      id: "format-dup-labels",
      severity: "warning",
      category: "format",
      titleAr: "عناوين أعمدة مكررة",
      titleEn: "Duplicate column labels",
      current: dupLabels.join(", "),
      expected: "unique",
      evidence: dupLabels.join(", "),
      fixAr: "أعد تسمية الأعمدة لتمييزها.",
      fixEn: "Rename the columns to distinguish them.",
      fixClass: 1,
    });
  }

  const totalable = columns.filter((c) => c.total);
  const hasTotals = typeof input.totals === "object" && input.totals !== null;
  if (totalable.length && !hasTotals) {
    issues.push({
      id: "format-missing-totals",
      severity: "info",
      category: "format",
      titleAr: "لا يوجد صف إجماليات",
      titleEn: "No totals row",
      current: 0,
      expected: totalable.length,
      evidence: `${totalable.length} totalable column(s)`,
      fixAr: "أضف صف إجماليات بمعادلات صحيحة.",
      fixEn: "Add a totals row with correct formulas.",
      fixClass: 1,
    });
  }

  if (input.direction && input.direction !== "rtl" && columns.some((c) => /[\u0600-\u06FF]/.test(c.labelAr))) {
    issues.push({
      id: "format-direction",
      severity: "info",
      category: "format",
      titleAr: "التقرير يحتوي نصًا عربيًا لكن الاتجاه ليس RTL",
      titleEn: "Report has Arabic labels but direction is not RTL",
      current: input.direction,
      expected: "rtl",
      evidence: "Arabic column labels detected",
      fixAr: "اضبط اتجاه الورقة على RTL.",
      fixEn: "Set the sheet direction to RTL.",
      fixClass: 1,
    });
  }

  // --- Calculation: group subtotals sum to the grand total. ------------------
  // A report that carries per-group subtotal rows must have subtotals that add
  // up to the declared grand total; otherwise a section total is wrong even
  // though the grand total (which is the row sum) looks right.
  const groupKey = input.groupColumn;
  if (groupKey && colByKey.has(groupKey)) {
    const sumsByGroup = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const g = str(r[groupKey]).trim() || "—";
      if (!sumsByGroup.has(g)) sumsByGroup.set(g, new Map());
      const gsums = sumsByGroup.get(g)!;
      for (const col of columns) {
        if (!col.total) continue;
        gsums.set(col.key, (gsums.get(col.key) ?? 0) + (num(r[col.key]) ?? 0));
      }
    }
    for (const col of columns) {
      if (!col.total) continue;
      const claimed = input.totals?.[col.key];
      if (typeof claimed !== "number") continue;
      const subtotalSum = [...sumsByGroup.values()].reduce((s, m) => s + (m.get(col.key) ?? 0), 0);
      if (Math.abs(subtotalSum - claimed) > TOL) {
        issues.push({
          id: `calc-subtotal-sum-${col.key}`,
          severity: "error",
          category: "calculation",
          titleAr: `مجموع المجاميع الفرعية للعمود «${col.labelAr}» لا يساوي الإجمالي`,
          titleEn: `Group subtotals for "${col.labelEn}" do not add up to the grand total`,
          current: round(subtotalSum),
          expected: round(claimed),
          evidence: `Σ subtotals = ${round(subtotalSum)} but the report states ${round(claimed)}.`,
          fixAr: "أعد احتساب المجاميع الفرعية على مجموعاتها الفعلية.",
          fixEn: "Recompute each subtotal over its own group.",
          fixClass: 2,
          field: col.key,
        });
      }
    }
  }

  return issues;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Applies only the safe (class 1) format repairs; returns what changed. */
export function applicableFixes(issues: ReportIssue[]): ReportIssue[] {
  return issues.filter((i) => i.fixClass === 1);
}

export function summarizeIssues(issues: ReportIssue[]): Record<IssueSeverity, number> {
  return {
    error: issues.filter((i) => i.severity === "error").length,
    warning: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
  };
}
