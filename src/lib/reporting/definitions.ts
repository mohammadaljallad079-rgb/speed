import type { ReportDefinition, ReportKind } from "./types";

/**
 * Report definitions (schema only).
 *
 * These describe columns and labels; they contain no financial values. The VAT
 * definition follows the Bahrain VAT return structure: sales and purchases split
 * by taxable treatment (standard-rated 10%, zero-rated, exempt, out-of-scope /
 * unregistered parties), with taxable amounts and output/input VAT totalled.
 */

export const REPORT_DEFINITIONS: Record<ReportKind, ReportDefinition> = {
  vat_report: {
    kind: "vat_report",
    titleEn: "VAT Report (Bahrain)",
    titleAr: "تقرير ضريبة القيمة المضافة (البحرين)",
    columns: [
      { key: "section", labelEn: "Section", labelAr: "القسم", type: "text" },
      { key: "treatment", labelEn: "Tax Treatment", labelAr: "المعاملة الضريبية", type: "text" },
      { key: "taxable_amount", labelEn: "Taxable Amount (BHD)", labelAr: "المبلغ الخاضع للضريبة (د.ب)", type: "currency", total: true },
      { key: "rate", labelEn: "Rate %", labelAr: "النسبة %", type: "percent" },
      { key: "vat_amount", labelEn: "VAT Amount (BHD)", labelAr: "قيمة الضريبة (د.ب)", type: "currency", total: true },
    ],
  },
  sales_report: {
    kind: "sales_report",
    titleEn: "Sales Report",
    titleAr: "تقرير المبيعات",
    columns: [
      { key: "invoice_date", labelEn: "Date", labelAr: "التاريخ", type: "date" },
      { key: "invoice_number", labelEn: "Invoice No.", labelAr: "رقم الفاتورة", type: "text" },
      { key: "customer_name", labelEn: "Customer", labelAr: "العميل", type: "text" },
      { key: "subtotal", labelEn: "Subtotal (BHD)", labelAr: "المجموع (د.ب)", type: "currency", total: true },
      { key: "vat_amount", labelEn: "VAT (BHD)", labelAr: "الضريبة (د.ب)", type: "currency", total: true },
      { key: "total", labelEn: "Total (BHD)", labelAr: "الإجمالي (د.ب)", type: "currency", total: true },
    ],
  },
  purchases_report: {
    kind: "purchases_report",
    titleEn: "Purchases Report",
    titleAr: "تقرير المشتريات",
    columns: [
      { key: "bill_date", labelEn: "Date", labelAr: "التاريخ", type: "date" },
      { key: "bill_number", labelEn: "Bill No.", labelAr: "رقم الفاتورة", type: "text" },
      { key: "supplier_name", labelEn: "Supplier", labelAr: "المورد", type: "text" },
      { key: "subtotal", labelEn: "Subtotal (BHD)", labelAr: "المجموع (د.ب)", type: "currency", total: true },
      { key: "vat_amount", labelEn: "VAT (BHD)", labelAr: "الضريبة (د.ب)", type: "currency", total: true },
      { key: "total", labelEn: "Total (BHD)", labelAr: "الإجمالي (د.ب)", type: "currency", total: true },
    ],
  },
  expenses_report: {
    kind: "expenses_report",
    titleEn: "Expenses Report",
    titleAr: "تقرير المصروفات",
    columns: [
      { key: "expense_date", labelEn: "Date", labelAr: "التاريخ", type: "date" },
      { key: "category", labelEn: "Category", labelAr: "الفئة", type: "text" },
      { key: "description", labelEn: "Description", labelAr: "الوصف", type: "text" },
      { key: "amount", labelEn: "Amount (BHD)", labelAr: "المبلغ (د.ب)", type: "currency", total: true },
      { key: "vat_amount", labelEn: "VAT (BHD)", labelAr: "الضريبة (د.ب)", type: "currency", total: true },
    ],
  },
  trial_balance: {
    kind: "trial_balance",
    titleEn: "Trial Balance",
    titleAr: "ميزان المراجعة",
    columns: [
      { key: "account_code", labelEn: "Account Code", labelAr: "رمز الحساب", type: "text" },
      { key: "account_name", labelEn: "Account Name", labelAr: "اسم الحساب", type: "text" },
      { key: "debit", labelEn: "Debit (BHD)", labelAr: "مدين (د.ب)", type: "currency", total: true },
      { key: "credit", labelEn: "Credit (BHD)", labelAr: "دائن (د.ب)", type: "currency", total: true },
    ],
  },
};

export function getReportDefinition(kind: string): ReportDefinition | null {
  return (REPORT_DEFINITIONS as Record<string, ReportDefinition>)[kind] ?? null;
}

export function isReportKind(value: string): value is ReportKind {
  return value in REPORT_DEFINITIONS;
}
