import type { ColumnType } from "./types";
import type { PermissionModule } from "@/lib/auth/permissions";

/**
 * Dynamic field catalog.
 *
 * Every reportable field is declared once here, tied to the real table/column
 * it comes from. Reports and the natural-language builder reference catalog
 * keys only, so a request can never invent a column or read a table the field
 * catalogue does not expose. Adding a field = adding a catalog entry (plus a
 * column that actually exists), never editing the route or UI.
 *
 * Fields are marked `computed` when they are derived rather than stored; a
 * computed field carries its calculation rule so the UI can explain it.
 */

export type FieldSource =
  | "invoices"
  | "purchase_invoices"
  | "expenses"
  | "payments"
  | "customers"
  | "suppliers"
  | "accounts";

export type Dataset = "sales" | "purchases" | "expenses" | "payments" | "accounts";

export interface CatalogField {
  key: string;
  labelAr: string;
  labelEn: string;
  type: ColumnType;
  source: FieldSource;
  /** Stored column name, or the base field for a computed field. */
  column?: string;
  /** Related-table column to pull in (e.g. customers.full_name). */
  via?: { table: FieldSource; column: string; localKey: string };
  /** Derived at report time (not stored). */
  computed?: boolean;
  /** Human rule for a computed field, bilingual (shown in "explain"). */
  ruleAr?: string;
  ruleEn?: string;
  /** Permission module required to view the underlying data. */
  module: PermissionModule;
  /** Filterable via a small whitelist of operators. */
  filterable?: boolean;
  total?: boolean;
  /** Extra natural-language names/plurals that also resolve to this field. */
  aliases?: string[];
}

export const CATALOG: CatalogField[] = [
  // --- Sales (invoices) -------------------------------------------------------
  { key: "invoice_number", labelAr: "رقم الفاتورة", labelEn: "Invoice No.", type: "text", source: "invoices", column: "invoice_number", module: "invoices", filterable: true, aliases: ["invoice number", "invoice no", "invoice no.", "invoice"] },
  { key: "invoice_date", labelAr: "تاريخ الفاتورة", labelEn: "Invoice Date", type: "date", source: "invoices", column: "invoice_date", module: "invoices", filterable: true, aliases: ["date", "invoice date"] },
  { key: "customer_name", labelAr: "العميل", labelEn: "Customer", type: "text", source: "invoices", via: { table: "customers", column: "full_name", localKey: "customer_id" }, module: "customers", filterable: true, aliases: ["customer name", "client", "customer"] },
  { key: "status", labelAr: "الحالة", labelEn: "Status", type: "text", source: "invoices", column: "status", module: "invoices", filterable: true, aliases: ["state"] },
  { key: "payment_status", labelAr: "حالة السداد", labelEn: "Payment Status", type: "text", source: "invoices", computed: true, module: "invoices", aliases: ["payment status", "paid status"], ruleAr: "مدفوعة إذا كان المدفوع ≥ الإجمالي، جزئية إذا كان > 0، وإلا غير مدفوعة.", ruleEn: "Paid if paid ≥ total, partial if > 0, else unpaid." },
  { key: "subtotal", labelAr: "قبل الضريبة", labelEn: "Subtotal", type: "currency", source: "invoices", computed: true, module: "invoices", ruleAr: "الإجمالي ناقص ضريبة القيمة المضافة.", ruleEn: "Total minus VAT.", total: true },
  { key: "vat_amount", labelAr: "الضريبة", labelEn: "VAT", type: "currency", source: "invoices", column: "vat_amount", module: "invoices", total: true },
  { key: "total", labelAr: "الإجمالي", labelEn: "Total", type: "currency", source: "invoices", column: "total_amount", module: "invoices", total: true, aliases: ["amount", "grand total", "total amount"] },
  { key: "paid_amount", labelAr: "المدفوع", labelEn: "Paid", type: "currency", source: "invoices", column: "paid_amount", module: "invoices", total: true, aliases: ["paid amount", "paid"] },
  { key: "remaining", labelAr: "المتبقي", labelEn: "Remaining", type: "currency", source: "invoices", computed: true, module: "invoices", ruleAr: "الإجمالي ناقص المدفوع.", ruleEn: "Total minus paid.", total: true, aliases: ["remaining amount", "balance"] },
  { key: "due_date", labelAr: "تاريخ الاستحقاق", labelEn: "Due Date", type: "date", source: "invoices", column: "due_date", module: "invoices", filterable: true },
  { key: "currency", labelAr: "العملة", labelEn: "Currency", type: "text", source: "invoices", column: "currency", module: "invoices" },

  // --- Purchases (purchase_invoices) -----------------------------------------
  { key: "bill_number", labelAr: "رقم فاتورة المشتريات", labelEn: "Bill No.", type: "text", source: "purchase_invoices", column: "invoice_number", module: "purchases", filterable: true },
  { key: "bill_date", labelAr: "تاريخ المشتريات", labelEn: "Bill Date", type: "date", source: "purchase_invoices", column: "bill_date", module: "purchases", filterable: true },
  { key: "supplier_name", labelAr: "المورد", labelEn: "Supplier", type: "text", source: "purchase_invoices", via: { table: "suppliers", column: "name", localKey: "supplier_id" }, module: "suppliers", filterable: true },
  { key: "purchase_vat", labelAr: "ضريبة المشتريات", labelEn: "Purchase VAT", type: "currency", source: "purchase_invoices", column: "vat_amount", module: "purchases", total: true },
  { key: "purchase_total", labelAr: "إجمالي المشتريات", labelEn: "Purchase Total", type: "currency", source: "purchase_invoices", column: "total_amount", module: "purchases", total: true },

  // --- Expenses ---------------------------------------------------------------
  { key: "expense_date", labelAr: "تاريخ المصروف", labelEn: "Expense Date", type: "date", source: "expenses", column: "expense_date", module: "expenses", filterable: true },
  { key: "expense_category", labelAr: "التصنيف", labelEn: "Category", type: "text", source: "expenses", column: "category", module: "expenses", filterable: true },
  { key: "expense_description", labelAr: "الوصف", labelEn: "Description", type: "text", source: "expenses", column: "description", module: "expenses" },
  { key: "expense_amount", labelAr: "المبلغ", labelEn: "Amount", type: "currency", source: "expenses", column: "amount", module: "expenses", total: true },
  { key: "expense_vat", labelAr: "ضريبة المصروف", labelEn: "Expense VAT", type: "currency", source: "expenses", column: "vat_amount", module: "expenses", total: true },
  { key: "expense_branch", labelAr: "الفرع", labelEn: "Branch", type: "text", source: "expenses", column: "branch", module: "expenses", filterable: true },

  // --- Payments ---------------------------------------------------------------
  { key: "payment_date", labelAr: "تاريخ الدفع", labelEn: "Payment Date", type: "date", source: "payments", column: "payment_date", module: "payments", filterable: true },
  { key: "payment_amount", labelAr: "مبلغ الدفع", labelEn: "Payment Amount", type: "currency", source: "payments", column: "amount", module: "payments", total: true },
  { key: "payment_method", labelAr: "طريقة الدفع", labelEn: "Payment Method", type: "text", source: "payments", column: "payment_method", module: "payments", filterable: true },

  // --- Accounts ---------------------------------------------------------------
  { key: "account_code", labelAr: "رمز الحساب", labelEn: "Account Code", type: "text", source: "accounts", column: "code", module: "accounting", filterable: true },
  { key: "account_name", labelAr: "اسم الحساب", labelEn: "Account Name", type: "text", source: "accounts", column: "name", module: "accounting" },
  { key: "account_type", labelAr: "نوع الحساب", labelEn: "Account Type", type: "text", source: "accounts", column: "type", module: "accounting", filterable: true },
];

export const CATALOG_BY_KEY: Record<string, CatalogField> = Object.fromEntries(
  CATALOG.map((f) => [f.key, f]),
);

/**
 * Dataset → underlying table + the columns that must be fetched to compute any
 * catalog field for that dataset. `relationColumns` are local FK columns needed
 * to join related tables.
 */
export interface DatasetSource {
  dataset: Dataset;
  table: string;
  module: PermissionModule;
  /** Stored columns to select (superset of the catalog's stored columns). */
  columns: string[];
  /** Local FK columns used for joins. */
  relationColumns: string[];
  /** Default date column for period filtering. */
  dateColumn: string;
  /** Default display columns if the user names none. */
  defaultFields: string[];
  /** Identifying field always kept in the report when one exists. */
  keyField?: string;
}

export const DATASET_SOURCES: Record<Dataset, DatasetSource> = {
  sales: {
    dataset: "sales",
    table: "invoices",
    module: "invoices",
    columns: ["id", "invoice_number", "invoice_date", "status", "vat_amount", "total_amount", "paid_amount", "due_date", "currency"],
    relationColumns: ["customer_id"],
    dateColumn: "invoice_date",
    defaultFields: ["invoice_number", "invoice_date", "customer_name", "total", "paid_amount", "remaining", "payment_status"],
    keyField: "invoice_number",
  },
  purchases: {
    dataset: "purchases",
    table: "purchase_invoices",
    module: "purchases",
    columns: ["id", "invoice_number", "bill_date", "status", "vat_amount", "total_amount"],
    relationColumns: ["supplier_id"],
    dateColumn: "bill_date",
    defaultFields: ["bill_number", "bill_date", "supplier_name", "purchase_total", "purchase_vat"],
    keyField: "bill_number",
  },
  expenses: {
    dataset: "expenses",
    table: "expenses",
    module: "expenses",
    columns: ["id", "expense_date", "category", "description", "amount", "vat_amount", "branch"],
    relationColumns: [],
    dateColumn: "expense_date",
    defaultFields: ["expense_date", "expense_category", "expense_description", "expense_amount", "expense_vat"],
  },
  payments: {
    dataset: "payments",
    table: "payments",
    module: "payments",
    columns: ["id", "payment_date", "amount", "payment_method", "invoice_id"],
    relationColumns: ["invoice_id"],
    dateColumn: "payment_date",
    defaultFields: ["payment_date", "payment_amount", "payment_method"],
  },
  accounts: {
    dataset: "accounts",
    table: "accounts",
    module: "accounting",
    columns: ["id", "code", "name", "type"],
    relationColumns: [],
    dateColumn: "code",
    defaultFields: ["account_code", "account_name", "account_type"],
    keyField: "account_code",
  },
};

export function fieldsForDataset(dataset: Dataset): CatalogField[] {
  const table = DATASET_SOURCES[dataset].table;
  return CATALOG.filter((f) => f.source === table || DATASET_SOURCES[dataset].relationColumns.includes(f.via?.localKey ?? ""));
}

export function isDataset(value: string): value is Dataset {
  return value in DATASET_SOURCES;
}
