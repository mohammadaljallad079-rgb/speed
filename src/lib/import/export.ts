import ExcelJS from "exceljs";
import type { ImportErrorCode, ImportPreview } from "./types";

/**
 * Bilingual resolution hints for each import error code, mirroring the reporting
 * error-report convention. Add a code here when a new one is introduced.
 */
const RESOLUTIONS: Record<ImportErrorCode, { ar: string; en: string }> = {
  required: { ar: "أكمل الحقل المطلوب في الملف ثم أعد الاستيراد.", en: "Fill the required field in the file, then import again." },
  type: { ar: "صحّح نوع القيمة (رقم/تاريخ) في الخلية.", en: "Correct the cell value type (number/date)." },
  enum: { ar: "استخدم إحدى القيم المسموحة.", en: "Use one of the allowed values." },
  reference: { ar: "أضف السجل المرجعي في النظام أولًا أو صحّح الاسم.", en: "Create the referenced record first, or correct the name." },
  duplicate_file: { ar: "احذف الصف المكرر داخل الملف.", en: "Remove the duplicate row inside the file." },
  duplicate_db: { ar: "السجل موجود مسبقًا؛ استخدم التعديل بدل الاستيراد.", en: "The record already exists; edit it instead of importing." },
  unknown_header: { ar: "أعد تسمية العمود ليطابق قالب الوحدة.", en: "Rename the column to match the module template." },
  no_mapping: { ar: "لا يوجد عمود مطابق؛ نزّل القالب المعتمد.", en: "No matching column; download the approved template." },
};

/** Builds a downloadable, colour-coded error report for a preview. */
export async function buildErrorReportWorkbook(preview: ImportPreview): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "SPEED ERP";
  const sheet = wb.addWorksheet("Import errors", { views: [{ rightToLeft: true, showGridLines: false }] });
  sheet.columns = [
    { header: "Row", key: "row", width: 8 },
    { header: "Field / الحقل", key: "field", width: 24 },
    { header: "Code", key: "code", width: 18 },
    { header: "Message (EN)", key: "en", width: 46 },
    { header: "الرسالة (AR)", key: "ar", width: 46 },
    { header: "الحل المقترح / Resolution", key: "resolution", width: 52 },
  ];
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  header.height = 26;

  for (const row of preview.rows) {
    if (row.errors.length === 0) continue;
    for (const err of row.errors) {
      const r = sheet.addRow({
        row: row.rowNumber,
        field: err.field ?? "—",
        code: err.code,
        en: err.messageEn,
        ar: err.messageAr,
        resolution: `${RESOLUTIONS[err.code]?.ar ?? ""} / ${RESOLUTIONS[err.code]?.en ?? ""}`,
      });
      r.alignment = { vertical: "top", wrapText: true };
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
