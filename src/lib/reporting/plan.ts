import { getReportDefinition } from "./definitions";
import type { FormatPlan, PlanDiff, ReportColumn, ReportIntent, ReportKind } from "./types";

/**
 * Turns a whitelisted intent (plus an optional saved template) into a concrete,
 * validated `FormatPlan`. No financial value is ever read or written here.
 */

export interface FormatTemplate {
  name: string;
  kind: ReportKind;
  plan: Omit<FormatPlan, "kind" | "warnings" | "structural" | "dataChangeRequested">;
}

const DEFAULT_HEADER_FILL = "FF0F172A";
const HEX = /^[0-9A-Fa-f]{6}$/;
const MAX_WIDTH = 80;
const MIN_WIDTH = 6;

function cleanFill(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const hex = value.replace(/^#/, "").toUpperCase();
  return HEX.test(hex) ? `FF${hex}` : undefined;
}

function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return MIN_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

/**
 * Builds the plan. `warnings` collects anything the user should see but which
 * must not silently change data (e.g. an unknown column name was ignored).
 */
export function buildFormatPlan(
  kind: ReportKind,
  intent: ReportIntent,
  template?: FormatTemplate | null,
): FormatPlan {
  const def = getReportDefinition(kind);
  if (!def) throw new Error(`Unknown report kind: ${kind}`);

  const warnings: string[] = [];
  let columns: ReportColumn[] = def.columns.map((c) => ({ ...c }));
  let hidden: string[] = [];
  const rightAlign: string[] = [];
  let headerFill = DEFAULT_HEADER_FILL;
  let bandedRows = true;
  let boldTotals = true;
  let addTotals = true;
  let freezeHeader = true;
  let autoFilter = false;
  let widths: Record<string, number> = {};
  let direction: "rtl" | "ltr" = intent.direction ?? "rtl";
  let titleEn = def.titleEn;
  let titleAr = def.titleAr;

  // A saved template is a baseline; the explicit request then overrides it so a
  // deliberate instruction always wins over the stored default.
  if (template && template.kind === kind) {
    const t = template.plan;
    direction = intent.direction ?? t.direction;
    columns = t.columns.map((c) => ({ ...c }));
    hidden = [...t.hiddenColumns];
    rightAlign.push(...t.rightAlignColumns);
    headerFill = t.headerFill;
    bandedRows = t.bandedRows;
    boldTotals = t.boldTotals;
    addTotals = t.addTotals;
    freezeHeader = t.freezeHeader;
    autoFilter = t.autoFilter;
    widths = { ...t.columnWidths };
    titleEn = t.titleEn;
    titleAr = t.titleAr;
  } else if (template) {
    warnings.push(`القالب "${template.name}" لا يطابق نوع التقرير المطلوب.`);
  }

  const byKey = new Map(columns.map((c) => [c.key, c]));

  // Reorder: only known keys, in the requested order, remaining columns kept.
  if (intent.columnOrder?.length) {
    const ordered: ReportColumn[] = [];
    for (const key of intent.columnOrder) {
      const col = byKey.get(key);
      if (col && !ordered.includes(col)) ordered.push(col);
      else if (!col) warnings.push(`عمود غير معروف تم تجاهله: ${key}`);
    }
    for (const col of columns) if (!ordered.includes(col)) ordered.push(col);
    columns = ordered;
  }

  // Renames.
  if (intent.renameColumns) {
    columns = columns.map((c) =>
      intent.renameColumns?.[c.key] ? { ...c, labelEn: intent.renameColumns[c.key], labelAr: intent.renameColumns[c.key] } : c,
    );
  }

  // Hiding: never allow hiding every column.
  if (intent.hideColumns?.length) {
    const requested = intent.hideColumns.filter((k) => byKey.has(k));
    for (const k of intent.hideColumns) if (!byKey.has(k)) warnings.push(`عمود غير معروف تم تجاهله: ${k}`);
    if (requested.length >= columns.length) {
      warnings.push("لا يمكن إخفاء كل الأعمدة.");
    } else {
      hidden = [...new Set([...hidden, ...requested])];
    }
  }
  if (hidden.length >= columns.length) {
    hidden = [];
    warnings.push("تم تجاهل الإخفاء لأنه يخفي كل الأعمدة.");
  }

  // Alignment.
  for (const key of intent.rightAlignColumns ?? []) {
    if (byKey.has(key) && !rightAlign.includes(key)) rightAlign.push(key);
  }
  if (intent.direction === "rtl" && !rightAlign.length) {
    // Excel's RTL view already right-aligns; mirror numeric text columns too.
    for (const c of columns) if (c.type === "text") rightAlign.push(c.key);
  }

  // Styling.
  const fill = cleanFill(intent.headerFill);
  if (fill) headerFill = fill;
  else if (intent.headerFill) warnings.push("لون العنوان غير صالح؛ تم استخدام اللون الافتراضي.");
  if (intent.bandedRows !== undefined) bandedRows = intent.bandedRows;
  if (intent.boldTotals !== undefined) boldTotals = intent.boldTotals;
  if (intent.addTotals !== undefined) addTotals = intent.addTotals;
  if (intent.freezeHeader !== undefined) freezeHeader = intent.freezeHeader;
  if (intent.autoFilter !== undefined) autoFilter = intent.autoFilter;

  // Widths: clamp to a sane range; keep only known keys.
  if (intent.columnWidths) {
    for (const [key, w] of Object.entries(intent.columnWidths)) {
      if (!byKey.has(key)) {
        warnings.push(`عمود غير معروف تم تجاهله: ${key}`);
        continue;
      }
      widths[key] = clampWidth(w);
    }
  }

  const structural =
    Boolean(intent.columnOrder?.length) || Boolean(intent.renameColumns) || hidden.length > 0;

  if (intent.dataChangeRequested) {
    warnings.push("لم يُنفَّذ أي تعديل على البيانات المحاسبية؛ هذا الطلب يخصّ التنسيق فقط.");
  }

  return {
    kind,
    direction,
    columns,
    hiddenColumns: hidden,
    rightAlignColumns: [...new Set(rightAlign)],
    headerFill,
    bandedRows,
    boldTotals,
    addTotals,
    freezeHeader,
    autoFilter,
    columnWidths: widths,
    titleEn,
    titleAr,
    structural,
    warnings,
    dataChangeRequested: intent.dataChangeRequested,
  };
}

/** Human-readable diff between the definition's default order and the plan. */
export function describePlanDiff(plan: FormatPlan, base: ReportColumn[]): PlanDiff {
  const changes: string[] = [];
  const reordered: string[] = [];
  const hidden: string[] = [...plan.hiddenColumns];
  const widthChanged: string[] = [];

  const baseKeys = base.map((c) => c.key);
  const planKeys = plan.columns.map((c) => c.key);
  if (baseKeys.join(",") !== planKeys.join(",")) reordered.push(...planKeys);

  for (const col of plan.columns) {
    const original = base.find((c) => c.key === col.key);
    if (original && (original.labelEn !== col.labelEn || original.labelAr !== col.labelAr)) {
      changes.push(`${col.key}: "${original.labelEn}" → "${col.labelEn}"`);
    }
  }
  if (plan.direction) changes.push(`direction: ${plan.direction}`);
  if (plan.autoFilter) changes.push("auto-filter: on");
  if (plan.freezeHeader) changes.push("freeze-header: on");

  for (const key of Object.keys(plan.columnWidths)) widthChanged.push(key);

  return { changes, reordered, hidden, widthChanged, structural: plan.structural };
}
