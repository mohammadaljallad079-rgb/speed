/**
 * Shared types for the AI report-formatting intelligence.
 *
 * This module formats and structures EXISTING report data. It never invents
 * financial figures and never performs accounting writes: any change to
 * invoices, journals, balances or tax values must go through the normal
 * guarded service layer (see `AGENTS.md`).
 */

export type ReportKind =
  | "vat_report"
  | "sales_report"
  | "purchases_report"
  | "expenses_report"
  | "trial_balance";

/** Value kinds a column can carry; drives Excel number formats and formulas. */
export type ColumnType = "text" | "date" | "currency" | "number" | "percent";

export interface ReportColumn {
  /** Stable key referenced by plans and data rows. */
  key: string;
  labelEn: string;
  labelAr: string;
  type: ColumnType;
  /** Totalable columns are summed by the totals formula. */
  total?: boolean;
}

export interface ReportDefinition {
  kind: ReportKind;
  titleEn: string;
  titleAr: string;
  columns: ReportColumn[];
}

/** A single report data row, keyed by column key. Values are never mutated. */
export type ReportRow = Record<string, string | number | null>;

export interface ReportData {
  kind: ReportKind;
  /** ISO date bounds, informational only (used in the header). */
  periodFrom?: string | null;
  periodTo?: string | null;
  rows: ReportRow[];
  /** Company/tenant display name, from the authenticated context only. */
  companyName?: string | null;
}

/**
 * Normalized, whitelisted intent. The natural-language parser maps user text
 * onto exactly these fields; nothing else is ever executed.
 */
export type IntentClass = "format" | "structure" | "data";

export interface ReportIntent {
  /** What the user is asking for, so a data change can be refused as off-scope. */
  intent: IntentClass;
  /** Explicit data-change request detected in the text (never auto-executed). */
  dataChangeRequested: boolean;
  direction?: "rtl" | "ltr";
  /** Column keys in the desired display order, if the user asked to reorder. */
  columnOrder?: string[];
  /** Column keys the user wants renamed → new label. */
  renameColumns?: Record<string, string>;
  /** Column keys the user wants hidden. */
  hideColumns?: string[];
  rightAlignColumns?: string[];
  headerFill?: string;
  bandedRows?: boolean;
  boldTotals?: boolean;
  /** Per-column width in characters. */
  columnWidths?: Record<string, number>;
  freezeHeader?: boolean;
  autoFilter?: boolean;
  addTotals?: boolean;
  /** Saved template name to apply, if the user named one. */
  applyTemplate?: string;
  saveAsTemplate?: string;
  /** Human-readable summary lines (bilingual) for the preview. */
  notes: string[];
}

export interface FormatPlan {
  kind: ReportKind;
  direction: "rtl" | "ltr";
  columns: ReportColumn[];
  hiddenColumns: string[];
  rightAlignColumns: string[];
  headerFill: string;
  bandedRows: boolean;
  boldTotals: boolean;
  addTotals: boolean;
  freezeHeader: boolean;
  autoFilter: boolean;
  columnWidths: Record<string, number>;
  titleEn: string;
  titleAr: string;
  /** True when the plan would change displayed structure (not just styling). */
  structural: boolean;
  /** Safe, actionable issues (e.g. unknown column) surfaced to the user. */
  warnings: string[];
  dataChangeRequested: boolean;
}

export interface PlanDiff {
  /** `renamed: <key>: "old" → "new"` style entries. */
  changes: string[];
  /** Columns whose display order changed. */
  reordered: string[];
  /** Columns newly hidden. */
  hidden: string[];
  /** Columns whose width changed. */
  widthChanged: string[];
  structural: boolean;
}
