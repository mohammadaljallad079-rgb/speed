import * as XLSX from "xlsx";

/**
 * Parses an uploaded .xlsx/.xls/.csv buffer into a header row plus data rows.
 *
 * Cells are read as raw values (dates stay dates) so the normalizer can apply
 * the field type. The first non-empty row is the header; blank rows are dropped.
 * Nothing is written here — parsing is pure and side-effect free.
 */

export interface ParsedSheet {
  headers: string[];
  /** Each row is keyed by the header text of its column. */
  rows: Record<string, unknown>[];
  sheetName: string;
}

const MAX_ROWS = 5000;

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

export function parseSheet(buffer: ArrayBuffer | Buffer, sheetName?: string): ParsedSheet {
  const data = buffer instanceof Buffer ? buffer : Buffer.from(buffer as ArrayBuffer);
  const workbook = XLSX.read(data, { type: "buffer", cellDates: true });
  const name = sheetName && workbook.SheetNames.includes(sheetName) ? sheetName : workbook.SheetNames[0];
  if (!name) return { headers: [], rows: [], sheetName: "" };

  const sheet = workbook.Sheets[name];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: false });
  if (matrix.length === 0) return { headers: [], rows: [], sheetName: name };

  const headerRow = (matrix[0] ?? []).map(toText);
  const headers = headerRow.map((h, i) => h || `Column ${i + 1}`);

  const rows: Record<string, unknown>[] = [];
  for (let r = 1; r < matrix.length && rows.length < MAX_ROWS; r++) {
    const cells = matrix[r] ?? [];
    const row: Record<string, unknown> = {};
    let hasValue = false;
    headers.forEach((h, i) => {
      const value = cells[i] ?? null;
      if (value !== null && value !== "") hasValue = true;
      row[h] = value;
    });
    if (hasValue) rows.push(row);
  }

  return { headers, rows, sheetName: name };
}
