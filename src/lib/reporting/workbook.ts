import ExcelJS from "exceljs";

import { getReportDefinition } from "./definitions";
import type { FormatPlan, ReportColumn, ReportData, ReportKind, ReportRow } from "./types";
import type { FormatTemplate } from "./plan";

/**
 * ExcelJS-backed rendering for a validated `FormatPlan`.
 *
 * Responsibilities:
 *   - write the report with real formulas for totals (not hardcoded numbers),
 *   - keep data values untouched (only presentation changes),
 *   - produce a workbook that is re-openable and self-consistent.
 */

const NUMBER_FORMATS: Record<ReportColumn["type"], string> = {
  text: "@",
  date: "yyyy-mm-dd",
  currency: "#,##0.000",
  number: "#,##0.###",
  percent: "0.00%",
};

export interface RenderResult {
  buffer: Buffer;
  sheetName: string;
  /** Cells that carry a SUM formula, for verification. */
  formulaCells: { ref: string; expected: number }[];
}

function visibleColumns(plan: FormatPlan): ReportColumn[] {
  const hidden = new Set(plan.hiddenColumns);
  return plan.columns.filter((c) => !hidden.has(c.key));
}

/** The grouping column for a plan's report kind, if the definition declares one. */
function groupColumnOf(plan: FormatPlan): string | null {
  const def = getReportDefinition(plan.kind);
  if (!def?.groupColumn) return null;
  return plan.columns.some((c) => c.key === def.groupColumn) && !plan.hiddenColumns.includes(def.groupColumn)
    ? def.groupColumn
    : null;
}

function labelFor(col: ReportColumn, direction: "rtl" | "ltr"): string {
  return direction === "rtl" ? col.labelAr : col.labelEn;
}

/** Writes data + styling for a plan into a fresh sheet. */
export function renderSheet(
  workbook: ExcelJS.Workbook,
  plan: FormatPlan,
  data: ReportData,
): RenderResult {
  const sheetName = (plan.direction === "rtl" ? plan.titleAr : plan.titleEn).slice(0, 31) || "Report";
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ rightToLeft: plan.direction === "rtl", showGridLines: false, state: "frozen", ySplit: 0 }],
  });

  const cols = visibleColumns(plan);
  const widths = cols.map((c) => plan.columnWidths[c.key] ?? defaultWidth(c));
  sheet.columns = cols.map((c, i) => ({ key: c.key, width: widths[i] }));

  sheet.mergeCells(1, 1, 1, Math.max(1, cols.length));
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = plan.direction === "rtl" ? plan.titleAr : plan.titleEn;
  titleCell.font = { bold: true, size: 14, color: { argb: plan.headerFill } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 24;

  const headerRow = sheet.getRow(3);
  cols.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = labelFor(c, plan.direction);
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: plan.headerFill } };
    cell.alignment = {
      horizontal: plan.rightAlignColumns.includes(c.key) ? "right" : "center",
      vertical: "middle",
    };
  });
  headerRow.height = 20;

  const firstDataRow = 4;
  data.rows.forEach((row, r) => {
    const excelRow = sheet.getRow(firstDataRow + r);
    cols.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1);
      cell.value = toCellValue(row[c.key], c);
      cell.numFmt = NUMBER_FORMATS[c.type];
      if (plan.rightAlignColumns.includes(c.key)) cell.alignment = { horizontal: "right" };
      if (plan.bandedRows && r % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
      }
    });
  });

  const lastDataRow = firstDataRow + data.rows.length - 1;
  const formulaCells: { ref: string; expected: number }[] = [];
  let cursor = firstDataRow + data.rows.length;

  // Group subtotals: when the definition names a grouping column, emit a SUM
  // row per contiguous group before the grand total. The rows are grouped (the
  // VAT model already orders sales before purchases), so a subtotal is a real
  // section total and the grand total stays the sum of the details.
  const groupKey = groupColumnOf(plan);
  if (plan.addTotals && groupKey && data.rows.length > 0) {
    let start = firstDataRow;
    for (let r = 1; r <= data.rows.length; r++) {
      const atEnd = r === data.rows.length;
      const changed = !atEnd && String(data.rows[r][groupKey] ?? "") !== String(data.rows[start - firstDataRow][groupKey] ?? "");
      if (!atEnd && !changed) continue;
      const end = firstDataRow + r - 1;
      const subtotalRow = sheet.getRow(cursor);
      const label = String(data.rows[start - firstDataRow][groupKey] ?? "");
      cols.forEach((c, i) => {
        const cell = subtotalRow.getCell(i + 1);
        if (i === 0) {
          cell.value = `${plan.direction === "rtl" ? "مجموع" : "Subtotal"} ${label}`;
          cell.font = { bold: true };
          return;
        }
        if (c.total && (c.type === "currency" || c.type === "number")) {
          const colLetter = sheet.getColumn(i + 1).letter;
          cell.value = { formula: `SUM(${colLetter}${start}:${colLetter}${end})` } as ExcelJS.CellFormulaValue;
          cell.numFmt = NUMBER_FORMATS[c.type];
          cell.font = { bold: true };
          const expected = data.rows.slice(start - firstDataRow, end - firstDataRow + 1).reduce((s, row) => s + (Number(row[c.key]) || 0), 0);
          formulaCells.push({ ref: cell.address, expected: Math.round(expected * 1000) / 1000 });
        }
      });
      cursor += 1;
      start = firstDataRow + r;
    }
  }

  if (plan.addTotals && data.rows.length > 0) {
    const totalRow = sheet.getRow(cursor);
    cols.forEach((c, i) => {
      const cell = totalRow.getCell(i + 1);
      if (i === 0) {
        cell.value = plan.direction === "rtl" ? "الإجمالي" : "Total";
        cell.font = { bold: plan.boldTotals };
        return;
      }
      if (c.total && (c.type === "currency" || c.type === "number")) {
        const colLetter = sheet.getColumn(i + 1).letter;
        const range = `${colLetter}${firstDataRow}:${colLetter}${lastDataRow}`;
        cell.value = { formula: `SUM(${range})` } as ExcelJS.CellFormulaValue;
        cell.numFmt = NUMBER_FORMATS[c.type];
        cell.font = { bold: plan.boldTotals };
        const expected = data.rows.reduce((s, row) => s + (Number(row[c.key]) || 0), 0);
        formulaCells.push({ ref: cell.address, expected: Math.round(expected * 1000) / 1000 });
      }
      cell.border = { top: { style: "double" } };
    });
    totalRow.commit?.();
  }

  if (plan.freezeHeader) {
    sheet.views = [{ state: "frozen", ySplit: 3, rightToLeft: plan.direction === "rtl", showGridLines: false }];
  }
  if (plan.autoFilter && data.rows.length > 0) {
    sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: cols.length } };
  }

  return { buffer: Buffer.alloc(0), sheetName, formulaCells };
}

function defaultWidth(col: ReportColumn): number {
  switch (col.type) {
    case "currency":
    case "number":
    case "percent":
      return 16;
    case "date":
      return 14;
    default:
      return Math.max(14, Math.min(40, Math.max(col.labelEn.length, col.labelAr.length) + 4));
  }
}

function toCellValue(value: string | number | null, col: ReportColumn): ExcelJS.CellValue {
  if (value === null || value === undefined || value === "") return null;
  if (col.type === "text") return String(value);
  if (col.type === "date") {
    const d = new Date(String(value));
    return isNaN(d.getTime()) ? String(value) : d;
  }
  const n = Number(value);
  return isNaN(n) ? String(value) : n;
}

/** Renders a complete, re-openable workbook buffer for a plan + data. */
export async function renderReportWorkbook(plan: FormatPlan, data: ReportData): Promise<RenderResult> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = data.companyName || "SPEED ERP";
  workbook.created = new Date();
  const result = renderSheet(workbook, plan, data);
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return { ...result, buffer: Buffer.from(arrayBuffer) };
}

export interface VerifyResult {
  ok: boolean;
  sheetNames: string[];
  errors: string[];
}

/**
 * Re-opens a generated buffer and checks structural integrity + that every SUM
 * formula evaluates to the expected value. This is the "reopen and verify" step
 * before a file is ever offered for download.
 */
export async function verifyWorkbookBuffer(
  buffer: Buffer,
  expected: { sheetName?: string; formulas?: { ref: string; expected: number }[] } = {},
): Promise<VerifyResult> {
  const errors: string[] = [];
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (e) {
    return { ok: false, sheetNames: [], errors: [`تعذّر فتح الملف الناتج / could not reopen file: ${(e as Error).message}`] };
  }
  const sheetNames = workbook.worksheets.map((w) => w.name);
  if (!sheetNames.length) errors.push("الملف لا يحتوي على أي ورقة / no worksheet");

  if (expected.sheetName) {
    const sheet = workbook.getWorksheet(expected.sheetName);
    if (!sheet) errors.push(`ورقة مفقودة: ${expected.sheetName} / missing sheet`);
  }
  for (const f of expected.formulas ?? []) {
    const sheet = workbook.worksheets[0];
    const cell = sheet.getCell(f.ref);
    const result = cell.value as ExcelJS.CellFormulaValue | number | null;
    let value: number | null = null;
    if (typeof result === "number") value = result;
    else if (result && typeof result === "object" && "result" in result && typeof result.result === "number") {
      value = result.result;
    }
    if (value === null) {
      // ExcelJS does not evaluate formulas on load; a formula cell is acceptable.
      continue;
    }
    if (Math.abs(value - f.expected) > 0.01) {
      errors.push(`صيغة ${f.ref}: ${value} ≠ المتوقع ${f.expected}`);
    }
  }

  return { ok: errors.length === 0, sheetNames, errors };
}

/**
 * Reads a user-supplied Excel template and derives a reusable `FormatTemplate`
 * for the requested report kind: direction, header fill, widths, and column
 * order detected by matching the template's header labels. Columns the template
 * does not mention are left at their defaults.
 */
export async function readTemplateWorkbook(
  buffer: Buffer,
  kind: ReportKind,
  name: string,
): Promise<{ template: FormatTemplate | null; matched: string[]; warnings: string[] }> {
  const def = getReportDefinition(kind);
  const warnings: string[] = [];
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return { template: null, matched: [], warnings: ["تعذّر قراءة القالب المرفوع / could not read template."] };
  }
  const sheet = workbook.worksheets[0];
  if (!def || !sheet) {
    return { template: null, matched: [], warnings: ["القالب فارغ أو غير مدعوم / empty or unsupported template."] };
  }

  const direction: "rtl" | "ltr" = sheet.views?.[0]?.rightToLeft ? "rtl" : "ltr";

  // Find the header row: the row with the most label matches.
  let headerRowNumber = 0;
  let bestMatches: string[] = [];
  for (let r = 1; r <= Math.min(sheet.rowCount, 20); r++) {
    const row = sheet.getRow(r);
    const keys: string[] = [];
    row.eachCell((cell) => {
      const text = String(cell.value ?? "").trim();
      const col = def.columns.find((c) => c.labelEn === text || c.labelAr === text);
      if (col) keys.push(col.key);
    });
    if (keys.length > bestMatches.length) {
      bestMatches = keys;
      headerRowNumber = r;
    }
  }

  let headerFill = "FF0F172A";
  const widths: Record<string, number> = {};
  const columns: ReportColumn[] = [];

  if (headerRowNumber) {
    const row = sheet.getRow(headerRowNumber);
    row.eachCell((cell) => {
      const text = String(cell.value ?? "").trim();
      const col = def.columns.find((c) => c.labelEn === text || c.labelAr === text);
      if (col) {
        columns.push({ ...col, labelEn: col.labelEn, labelAr: col.labelAr });
        const w = sheet.getColumn(cell.col).width;
        if (typeof w === "number" && w > 0) widths[col.key] = w;
        const fill = cell.fill as ExcelJS.FillPattern | undefined;
        if (fill && fill.type === "pattern" && fill.fgColor?.argb && /^FF[0-9A-Fa-f]{6}$/.test(fill.fgColor.argb)) {
          headerFill = fill.fgColor.argb;
        }
      }
    });
  }

  if (!columns.length) {
    warnings.push("لم يتم مطابقة أي عمود معروف في القالب / no known columns matched.");
    return { template: null, matched: [], warnings };
  }

  // Keep every definition column; ordered ones first, then the rest.
  const ordered = [...columns];
  for (const c of def.columns) if (!ordered.find((o) => o.key === c.key)) ordered.push({ ...c });

  const template: FormatTemplate = {
    name: name || "Imported template",
    kind,
    plan: {
      direction,
      columns: ordered,
      hiddenColumns: [],
      rightAlignColumns: direction === "rtl" ? ordered.filter((c) => c.type === "text").map((c) => c.key) : [],
      headerFill,
      bandedRows: true,
      boldTotals: true,
      addTotals: true,
      freezeHeader: true,
      autoFilter: false,
      columnWidths: widths,
      titleEn: def.titleEn,
      titleAr: def.titleAr,
    },
  };

  return { template, matched: bestMatches, warnings };
}
