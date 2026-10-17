import ExcelJS from "exceljs";
import type { ImportModuleSpec } from "./types";

/**
 * Builds a downloadable import template for a module: a header row (English +
 * Arabic in the header text) plus one example row so the user sees the expected
 * shape. RTL is applied so the Arabic headers read naturally. Only the existing
 * ExcelJS dependency is used — no second spreadsheet library.
 */
export async function buildTemplateWorkbook(spec: ImportModuleSpec): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "SPEED ERP";
  wb.created = new Date();
  const sheet = wb.addWorksheet(spec.labelEn, { views: [{ rightToLeft: true, showGridLines: false }] });

  sheet.columns = spec.fields.map((f) => ({
    header: `${f.labelEn} / ${f.labelAr}${f.required ? " *" : ""}`,
    key: f.key,
    width: Math.max(16, f.labelEn.length + 6),
  }));

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.height = 28;

  // One example row so the required columns are obvious.
  const example: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (f.type === "number") example[f.key] = f.defaultValue ?? 0;
    else if (f.type === "date") example[f.key] = new Date().toISOString().slice(0, 10);
    else if (f.type === "enum") example[f.key] = (f.enumValues ?? [""])[0];
    else if (f.reference) example[f.key] = `${f.labelEn} (existing)`;
    else example[f.key] = "";
  }
  const exampleRow = sheet.addRow(example);
  exampleRow.font = { italic: true, color: { argb: "FF94A3B8" } };

  const notesSheet = wb.addWorksheet("Notes");
  notesSheet.getColumn(1).width = 100;
  const notes = [
    `${spec.labelEn} / ${spec.labelAr}`,
    "",
    "Required columns are marked with *.",
    spec.notesEn ?? "",
    spec.notesAr ?? "",
    "",
    "Do not rename the header cells; the importer matches them by name.",
    "The tenant is taken from your session — never add a tenant column.",
  ].filter(Boolean);
  notes.forEach((n, i) => {
    notesSheet.getCell(i + 1, 1).value = n;
    if (i === 0) notesSheet.getCell(i + 1, 1).font = { bold: true, size: 13 };
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
