import { CATALOG_BY_KEY, DATASET_SOURCES, type CatalogField, type Dataset } from "./catalog";
import {
  buildDynamicDefinition,
  definitionColumns,
  parseReportRequest,
  type DynamicReportDefinition,
  type ReportFilter,
  type ReportRequest,
} from "./report-def";
import {
  loadDynamicRows,
  type ReportingDb,
  type ReportQuery,
} from "./data";
import { renderReportWorkbook, verifyWorkbookBuffer, type VerifyResult } from "./workbook";
import { validateReport, summarizeIssues, type ReportIssue, type ValidationColumn } from "./validation";
import type { ReportRow } from "./types";

/**
 * Dynamic report builder + validator orchestration.
 *
 * Pure rules (parse, group, validate) live here with no React/DOM imports so
 * they can be unit-tested directly. Nothing mutates source data; the only side
 * effect is producing a verified Excel buffer on request.
 */

export interface DynamicContext {
  db: ReportingDb;
  tenantId: string | null;
  companyName?: string | null;
  /** Permission gate for fields (from the session's module map). */
  allowField?: (field: CatalogField) => boolean;
}

export interface DynamicInput {
  prompt: string;
  dataset?: Dataset;
  from?: string | null;
  to?: string | null;
  /** Server clock for "this month" (deterministic in tests). */
  now?: Date;
  maxRows?: number;
  previewRows?: number;
}

export interface DynamicPreview {
  definition: DynamicReportDefinition;
  columns: ValidationColumn[];
  rows: ReportRow[];
  totalRow: ReportRow | null;
  totals: Record<string, number>;
  rowCount: number;
  sourceCount: number;
  truncated: boolean;
  issues: ReportIssue[];
  summary: { error: number; warning: number; info: number };
  request: ReportRequest;
  dataChangeRequested: boolean;
  notes: string[];
  warnings: string[];
}

const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_PREVIEW_ROWS = 25;

/** Applies the whitelisted filters produced by the parser, purely. */
export function applyFilters(rows: ReportRow[], filters: ReportFilter[], now: Date): ReportRow[] {
  const today = now.toISOString().slice(0, 10);
  return rows.filter((row) =>
    filters.every((f) => {
      const v = row[f.field];
      switch (f.op) {
        case "eq":
          return v !== null && v !== undefined && String(v) === String(f.value);
        case "gte":
          if (f.field === "remaining" && f.value === 0) return true; // display flag, no narrowing
          return v !== null && v !== undefined && String(v) >= String(f.value);
        case "lte":
          return v !== null && v !== undefined && String(v) <= String(f.value);
        case "contains":
          return String(v ?? "").toLowerCase().includes(String(f.value).toLowerCase());
        case "overdue": {
          const due = row["due_date"];
          const remaining = Number(row["remaining"]);
          return Boolean(due) && String(due).slice(0, 10) < today && (Number.isNaN(remaining) || remaining > 0.001);
        }
        default:
          return true;
      }
    }),
  );
}

/** Groups rows by a key and folds the requested aggregates. */
export function aggregateRows(
  rows: ReportRow[],
  groupKey: string | null,
  aggregates: { field: string; fn: "sum" | "count" | "avg" | "min" | "max" }[],
): ReportRow[] {
  if (!groupKey) return rows;
  const groups = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const k = row[groupKey] === null || row[groupKey] === undefined ? "—" : String(row[groupKey]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(row);
  }
  const out: ReportRow[] = [];
  for (const [k, members] of groups) {
    const record: ReportRow = { [groupKey]: k };
    aggregates.forEach((agg, i) => {
      if (agg.field === "*") {
        record[`agg_${i}`] = members.length;
        return;
      }
      const nums = members.map((m) => Number(m[agg.field])).filter((n) => !Number.isNaN(n));
      const sum = nums.reduce((s, n) => s + n, 0);
      record[`agg_${i}`] =
        agg.fn === "count" ? nums.length
          : agg.fn === "avg" ? (nums.length ? round3(sum / nums.length) : 0)
            : agg.fn === "min" ? (nums.length ? Math.min(...nums) : 0)
              : agg.fn === "max" ? (nums.length ? Math.max(...nums) : 0)
                : round3(sum);
    });
    out.push(record);
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function computeTotals(columns: ValidationColumn[], rows: ReportRow[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const c of columns) {
    if (!c.total) continue;
    totals[c.key] = round3(rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0));
  }
  return totals;
}

function toValidationColumns(def: DynamicReportDefinition): ValidationColumn[] {
  return definitionColumns(def).map((c) => ({ key: c.key, labelAr: c.labelAr, labelEn: c.labelEn, type: c.type, total: c.total }));
}

async function loadAndShape(
  ctx: DynamicContext,
  input: DynamicInput,
): Promise<{
  definition: DynamicReportDefinition;
  request: ReportRequest;
  rows: ReportRow[];
  sourceCount: number;
  truncated: boolean;
  now: Date;
}> {
  const now = input.now ?? new Date();
  const request = parseReportRequest(input.prompt, {
    now,
    defaultDataset: input.dataset,
    allow: ctx.allowField,
  });
  const definition = buildDynamicDefinition(request, ctx.allowField);
  // A report always keeps its identifying key so rows stay recognisable, even
  // if the request did not name it. It is prepended so it reads first.
  const keyKey = DATASET_SOURCES[definition.dataset].keyField;
  const keyField = keyKey ? CATALOG_BY_KEY[keyKey] : undefined;
  if (keyField && ctx.allowField?.(keyField) !== false && !definition.fields.some((f) => f.key === keyField.key)) {
    definition.fields = [keyField, ...definition.fields];
  }
  // Fields needed to evaluate filters and aggregates must be loaded even when
  // they are not displayed; they are never added to the visible columns.
  const loadFields = [...definition.fields];
  const need = (key: string) => {
    const field = CATALOG_BY_KEY[key];
    if (field && ctx.allowField?.(field) !== false && !loadFields.some((x) => x.key === field.key)) loadFields.push(field);
  };
  for (const f of definition.filters) need(f.field);
  for (const a of definition.aggregates) if (a.field !== "*") need(a.field);
  const query: ReportQuery = { tenantId: ctx.tenantId, from: input.from ?? null, to: input.to ?? null };
  const { rows: raw, sourceCount } = await loadDynamicRows(ctx.db, definition.dataset, query, loadFields);
  const filtered = applyFilters(raw, definition.filters, now);
  const max = input.maxRows ?? DEFAULT_MAX_ROWS;
  const truncated = filtered.length > max;
  const rows = aggregateRows(filtered.slice(0, max), definition.groupBy?.key ?? null, definition.aggregates);
  return { definition, request, rows, sourceCount, truncated, now };
}

/** Parse + load + validate, without producing a file. */
export async function buildDynamicPreview(ctx: DynamicContext, input: DynamicInput): Promise<DynamicPreview> {
  const { definition, request, rows, sourceCount, truncated } = await loadAndShape(ctx, input);
  const columns = toValidationColumns(definition);
  const totals = computeTotals(columns, rows);
  const issues = validateReport({
    columns,
    rows,
    totals,
    sourceCount: definition.groupBy ? undefined : sourceCount,
    period: { from: input.from ?? null, to: input.to ?? null },
    direction: "rtl",
    required: definition.fields.some((f) => f.key === "invoice_number") ? ["invoice_number"] : [],
  });

  const previewRows = rows.slice(0, input.previewRows ?? DEFAULT_PREVIEW_ROWS).map((row) =>
    Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? null])),
  );

  return {
    definition,
    columns,
    rows: previewRows,
    totalRow: Object.keys(totals).length ? totals : null,
    totals,
    rowCount: rows.length,
    sourceCount,
    truncated,
    issues,
    summary: summarizeIssues(issues),
    request,
    dataChangeRequested: /(عدّل|غيّ?ر|احذف|update|delete|edit|change)/i.test(input.prompt) &&
      /(مبلغ|رصيد|فاتورة|قيد|amount|balance|invoice|vat|journal)/i.test(input.prompt),
    notes: [...request.notes, ...definition.deniedFields.length ? [`حقول محجوبة بلا صلاحية: ${definition.deniedFields.join(", ")}`] : []],
    warnings: request.warnings,
  };
}

/** Builds a verified Excel buffer for a dynamic definition + dataset. */
export async function buildDynamicFile(
  ctx: DynamicContext,
  input: DynamicInput,
): Promise<{ buffer: Buffer; filename: string; verification: VerifyResult; issues: ReportIssue[] }> {
  const { definition, rows } = await loadAndShape(ctx, input);
  const columns = toValidationColumns(definition);
  const totals = computeTotals(columns, rows);

  const plan = {
    kind: "custom" as unknown as DynamicReportDefinition["dataset"],
    direction: "rtl" as const,
    columns: columns.map((c) => ({ key: c.key, labelAr: c.labelAr, labelEn: c.labelEn, type: c.type, total: c.total })),
    hiddenColumns: [],
    rightAlignColumns: columns.filter((c) => c.type === "text").map((c) => c.key),
    headerFill: "FF0F172A",
    bandedRows: true,
    boldTotals: true,
    addTotals: Object.keys(totals).length > 0,
    freezeHeader: true,
    autoFilter: false,
    columnWidths: {},
    titleEn: definition.titleEn,
    titleAr: definition.titleAr,
    structural: true as const,
    warnings: [],
    dataChangeRequested: false,
  };

  const rendered = await renderReportWorkbook(plan as never, {
    kind: "sales_report",
    rows,
    periodFrom: input.from ?? null,
    periodTo: input.to ?? null,
    companyName: ctx.companyName ?? null,
  });
  const verification = await verifyWorkbookBuffer(rendered.buffer, {
    sheetName: rendered.sheetName,
    formulas: rendered.formulaCells,
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const issues = validateReport({ columns, rows, totals, sourceCount: definition.groupBy ? undefined : rows.length });
  return { buffer: rendered.buffer, filename: `SPEED_${definition.dataset}_${stamp}.xlsx`, verification, issues };
}

void CATALOG_BY_KEY;
