import ExcelJS from "exceljs";

/**
 * One branded Excel exporter for every report screen.
 *
 * Execution 60, Section 6. Before this, each report page that exported built its
 * own workbook by hand, and most report pages had no export at all. The result
 * was a different look per page and no way to guarantee the four things the
 * assignment requires of every file: the current filters, the company branding,
 * correct totals, and the right text direction.
 *
 * A page supplies a `ReportExportSpec` (title, columns, rows, totals) and this
 * module owns the presentation. It never fetches data and never decides what to
 * include: the caller passes the rows it is already showing, so the export can
 * only ever contain what the user sees (tenant scoping happened upstream in the
 * page's query).
 */

export type ExportCellType = "text" | "date" | "currency" | "number" | "percent";

export interface ExportColumn {
  key: string;
  labelAr: string;
  labelEn: string;
  type?: ExportCellType;
  width?: number;
}

export interface ExportTotal {
  labelAr: string;
  labelEn: string;
  /** Key of the column the total sits under. */
  columnKey: string;
  value: number;
}

export interface CompanyBranding {
  nameAr?: string | null;
  nameEn?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  crNumber?: string | null;
  /** A data URL or remote URL. Only http(s)/data is embedded (see sanitizeLogoUrl). */
  logoUrl?: string | null;
}

export interface ReportExportSpec {
  titleAr: string;
  titleEn: string;
  /** e.g. "2026-01-01 — 2026-12-31". Shown under the title. */
  periodLabel?: string | null;
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
  totals?: ExportTotal[];
  branding?: CompanyBranding | null;
  rtl?: boolean;
}

const NUMBER_FORMATS: Record<ExportCellType, string> = {
  text: "@",
  date: "yyyy-mm-dd",
  currency: "#,##0.000",
  number: "#,##0.###",
  percent: "0.00%",
};

const NAVY = "FF0F172A";
const SLATE = "FF334155";
const MUTED = "FF64748B";
const LIGHT = "FFF1F5F9";
const WHITE = "FFFFFFFF";

/**
 * Only an http(s) or data-URL logo is embedded. A `file:`/`javascript:` URL in a
 * settings row must never end up inside a generated document, and ExcelJS would
 * happily fetch it.
 */
export function sanitizeBrandingLogo(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\//i.test(trimmed)) return trimmed;
  return null;
}

function brandName(branding: CompanyBranding | null | undefined, rtl: boolean): string {
  if (!branding) return rtl ? "SPEED ERP" : "SPEED ERP";
  const ar = (branding.nameAr ?? "").trim();
  const en = (branding.nameEn ?? "").trim();
  return (rtl ? ar || en : en || ar) || "SPEED ERP";
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** A cell value coerced to the column's declared type, so Excel sorts/filters. */
export function coerceCell(value: unknown, type: ExportCellType = "text"): string | number | Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (type === "currency" || type === "number" || type === "percent") return toNumber(value);
  if (type === "date") {
    const d = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(d.getTime()) ? String(value) : d;
  }
  return String(value);
}

/**
 * Builds the workbook. Pure w.r.t. the data it is given: no fetching, no
 * re-querying. The returned buffer is a real `.xlsx` (verified by the caller
 * through `verifyWorkbookBuffer` in `workbook.ts` when a preview is needed).
 */
export async function buildReportWorkbook(spec: ReportExportSpec): Promise<Buffer> {
  const rtl = spec.rtl === true;
  const wb = new ExcelJS.Workbook();
  wb.creator = brandName(spec.branding, false);
  wb.created = new Date();

  const sheetName = (rtl ? spec.titleAr : spec.titleEn).slice(0, 31) || "Report";
  const sheet = wb.addWorksheet(sheetName, {
    views: [{ rightToLeft: rtl, showGridLines: false }],
    pageSetup: { orientation: spec.columns.length > 6 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });

  const colCount = Math.max(1, spec.columns.length);
  sheet.columns = spec.columns.map((c) => ({
    key: c.key,
    width: c.width ?? (c.type === "currency" ? 18 : c.type === "text" ? 30 : 14),
  }));

  const lastCol = String.fromCharCode(64 + Math.min(colCount, 26));

  // --- Title block ---
  sheet.mergeCells(`A1:${lastCol}1`);
  const title = sheet.getCell("A1");
  title.value = brandName(spec.branding, rtl);
  title.font = { bold: true, size: 16, color: { argb: NAVY } };
  title.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 24;

  sheet.mergeCells(`A2:${lastCol}2`);
  const sub = sheet.getCell("A2");
  sub.value = rtl ? spec.titleAr : spec.titleEn;
  sub.font = { bold: true, size: 13, color: { argb: SLATE } };
  sub.alignment = { horizontal: "center", vertical: "middle" };

  const meta: string[] = [];
  if (spec.periodLabel) meta.push((rtl ? "الفترة: " : "Period: ") + spec.periodLabel);
  const b = spec.branding;
  if (b) {
    if (b.crNumber) meta.push((rtl ? "س.ت: " : "CR: ") + b.crNumber);
    if (b.phone) meta.push((rtl ? "هاتف: " : "Tel: ") + b.phone);
    if (b.address) meta.push(b.address);
  }
  sheet.mergeCells(`A3:${lastCol}3`);
  const metaCell = sheet.getCell("A3");
  metaCell.value = meta.join("  |  ");
  metaCell.font = { italic: true, size: 10, color: { argb: MUTED } };
  metaCell.alignment = { horizontal: "center" };

  // --- Logo ---
  const logo = sanitizeBrandingLogo(b?.logoUrl);
  if (logo) {
    try {
      const id = wb.addImage({ buffer: await fetchLogoBuffer(logo), extension: "png" });
      sheet.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 96, height: 48 } });
    } catch {
      // A logo that cannot be embedded must never fail the whole export.
    }
  }

  sheet.addRow([]);

  // --- Header row ---
  const headerRow = sheet.addRow(spec.columns.map((c) => (rtl ? c.labelAr : c.labelEn)));
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin" }, bottom: { style: "thin" },
      left: { style: "thin" }, right: { style: "thin" },
    };
  });
  headerRow.height = 24;
  const headerRowNumber = headerRow.number;

  // --- Data rows ---
  spec.rows.forEach((row, i) => {
    const values = spec.columns.map((c) => coerceCell(row[c.key], c.type));
    const r = sheet.addRow(values);
    spec.columns.forEach((c, ci) => {
      const cell = r.getCell(ci + 1);
      cell.numFmt = NUMBER_FORMATS[c.type ?? "text"];
      cell.alignment = { horizontal: c.type === "text" ? (rtl ? "right" : "left") : "center", vertical: "middle" };
      cell.font = { size: 10, color: { argb: "FF1E293B" } };
      if (i % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
      cell.border = { bottom: { style: "hair", color: { argb: "FFE2E8F0" } } };
    });
  });

  const firstDataRow = headerRowNumber + 1;
  const lastDataRow = headerRowNumber + spec.rows.length;

  // --- Totals as REAL formulas over the data range, so a user can audit them ---
  if (spec.totals && spec.totals.length > 0 && spec.rows.length > 0) {
    sheet.addRow([]);
    for (const total of spec.totals) {
      const ci = spec.columns.findIndex((c) => c.key === total.columnKey);
      if (ci < 0) continue;
      const colLetter = String.fromCharCode(65 + ci);
      const r = sheet.addRow(spec.columns.map((_, idx) => (idx === ci ? null : "")));
      r.getCell(ci + 1).value = { formula: `SUM(${colLetter}${firstDataRow}:${colLetter}${lastDataRow})` } as ExcelJS.CellFormulaValue;
      // The label goes in the first column, the value under its own column.
      if (ci !== 0) r.getCell(1).value = rtl ? total.labelAr : total.labelEn;
      r.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: NAVY }, size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
        cell.border = { top: { style: "double" }, bottom: { style: "thin" } };
      });
      r.getCell(ci + 1).numFmt = NUMBER_FORMATS[spec.columns[ci].type ?? "currency"];
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/** Fetches a remote logo, or decodes a data URL, into bytes ExcelJS can embed. */
async function fetchLogoBuffer(url: string): Promise<ArrayBuffer> {
  const dataMatch = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(url);
  if (dataMatch) {
    return Buffer.from(dataMatch[1], "base64").buffer as ArrayBuffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`logo fetch failed: ${res.status}`);
  return res.arrayBuffer();
}

/** Triggers a browser download of a buffer. Client-only. */
export function downloadWorkbook(buffer: Buffer | ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** A filesystem-safe filename from a title + period. */
export function exportFilename(title: string, period?: string | null): string {
  const safe = (s: string) => s.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "");
  return [safe(title), period ? safe(period) : null].filter(Boolean).join("_") || "report";
}
