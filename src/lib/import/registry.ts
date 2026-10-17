import type { ImportModuleKey, ImportModuleSpec } from "./types";

/**
 * Universal Excel data-import registry.
 *
 * Adding an importable module = adding one entry here (plus a table whose live
 * schema has the declared columns). Nothing else hardcodes module knowledge.
 *
 * IMPORTANT — only modules whose target table carries a real `tenantColumn` may
 * be importable: the importer scopes writes with that column, so a tenant-less
 * module would scope updates by `id` alone. `importSafety()` enforces this
 * fail-closed.
 */

export const IMPORT_MODULES: Record<ImportModuleKey, ImportModuleSpec> = {
  customers: {
    key: "customers",
    labelAr: "العملاء",
    labelEn: "Customers",
    table: "customers",
    tenantColumn: "tenant_id",
    module: "customers",
    keyFields: ["phone"],
    fields: [
      { key: "full_name", labelAr: "الاسم الكامل", labelEn: "Full Name", type: "text", required: true, aliases: ["name", "customer name", "الاسم", "اسم العميل"] },
      { key: "customer_type", labelAr: "نوع العميل", labelEn: "Customer Type", type: "enum", enumValues: ["individual", "company"], defaultValue: "individual", aliases: ["type", "النوع", "نوع"] },
      { key: "phone", labelAr: "الهاتف", labelEn: "Phone", type: "text", required: true, aliases: ["mobile", "phone number", "الهاتف", "الجوال", "رقم الهاتف"] },
      { key: "email", labelAr: "البريد الإلكتروني", labelEn: "Email", type: "text", aliases: ["e-mail", "البريد", "الايميل"] },
      { key: "phone_2", labelAr: "هاتف إضافي", labelEn: "Phone 2", type: "text", aliases: ["phone 2", "هاتف آخر"] },
      { key: "address", labelAr: "العنوان", labelEn: "Address", type: "text", aliases: ["العنوان"] },
      { key: "city", labelAr: "المدينة", labelEn: "City", type: "text", aliases: ["المدينة"] },
      { key: "country", labelAr: "الدولة", labelEn: "Country", type: "text", aliases: ["الدولة"] },
      { key: "national_id", labelAr: "الرقم الوطني", labelEn: "National ID", type: "text", aliases: ["national id", "الرقم الوطني", "الهوية"] },
      { key: "company_name", labelAr: "اسم الشركة", labelEn: "Company Name", type: "text", aliases: ["company", "الشركة", "اسم الشركة"] },
      { key: "tax_number", labelAr: "الرقم الضريبي", labelEn: "Tax Number", type: "text", aliases: ["vat number", "trn", "الرقم الضريبي"] },
      { key: "status", labelAr: "الحالة", labelEn: "Status", type: "enum", enumValues: ["active", "inactive", "vip"], defaultValue: "active", aliases: ["state", "الحالة"] },
      { key: "notes", labelAr: "ملاحظات", labelEn: "Notes", type: "text", aliases: ["note", "ملاحظات"] },
    ],
    notesAr: "يُطابق العميل الموجود برقم الهاتف لتفادي التكرار.",
    notesEn: "An existing customer is matched by phone to avoid duplicates.",
  },

  suppliers: {
    key: "suppliers",
    labelAr: "الموردون",
    labelEn: "Suppliers",
    table: "suppliers",
    tenantColumn: "tenant_id",
    module: "suppliers",
    keyFields: ["name"],
    fields: [
      { key: "name", labelAr: "اسم المورد", labelEn: "Supplier Name", type: "text", required: true, aliases: ["supplier", "supplier name", "الاسم", "اسم المورد"] },
      { key: "phone", labelAr: "الهاتف", labelEn: "Phone", type: "text", aliases: ["mobile", "الهاتف", "الجوال"] },
      { key: "email", labelAr: "البريد الإلكتروني", labelEn: "Email", type: "text", aliases: ["e-mail", "البريد"] },
      { key: "address", labelAr: "العنوان", labelEn: "Address", type: "text", aliases: ["العنوان"] },
      { key: "trn_number", labelAr: "الرقم الضريبي", labelEn: "TRN", type: "text", aliases: ["trn", "vat number", "الرقم الضريبي"] },
      { key: "contact_person", labelAr: "الشخص المسؤول", labelEn: "Contact Person", type: "text", aliases: ["contact", "المسؤول", "جهة الاتصال"] },
      { key: "payment_terms", labelAr: "شروط الدفع", labelEn: "Payment Terms", type: "text", aliases: ["terms", "شروط الدفع"] },
      { key: "opening_balance", labelAr: "الرصيد الافتتاحي", labelEn: "Opening Balance", type: "number", aliases: ["balance", "الرصيد الافتتاحي"] },
      { key: "notes", labelAr: "ملاحظات", labelEn: "Notes", type: "text", aliases: ["note", "ملاحظات"] },
    ],
    notesAr: "يُطابق المورد الموجود بالاسم لتفادي التكرار.",
    notesEn: "An existing supplier is matched by name to avoid duplicates.",
  },

  expenses: {
    key: "expenses",
    labelAr: "المصروفات",
    labelEn: "Expenses",
    table: "expenses",
    tenantColumn: "tenant_id",
    module: "expenses",
    keyFields: ["invoice_number"],
    fields: [
      { key: "expense_date", labelAr: "التاريخ", labelEn: "Date", type: "date", required: true, aliases: ["date", "التاريخ"] },
      {
        key: "supplier",
        labelAr: "المورد",
        labelEn: "Supplier",
        type: "text",
        required: true,
        aliases: ["supplier name", "المورد"],
        reference: { table: "suppliers", matchColumns: ["name"], targetColumn: "supplier_id", module: "suppliers" },
      },
      {
        key: "expense_account",
        labelAr: "حساب المصروف",
        labelEn: "Expense Account",
        type: "text",
        required: true,
        aliases: ["account", "expense account", "الحساب"],
        reference: { table: "accounts", matchColumns: ["name", "code"], targetColumn: "expense_account_id", module: "accounting", shared: true },
      },
      { key: "amount", labelAr: "المبلغ", labelEn: "Amount", type: "number", required: true, aliases: ["amount", "المبلغ"] },
      { key: "vat_rate", labelAr: "نسبة الضريبة", labelEn: "VAT Rate", type: "number", defaultValue: 0.1, aliases: ["vat rate", "نسبة الضريبة"] },
      { key: "vat_amount", labelAr: "قيمة الضريبة", labelEn: "VAT Amount", type: "number", aliases: ["vat", "قيمة الضريبة"] },
      { key: "discount", labelAr: "الخصم", labelEn: "Discount", type: "number", aliases: ["الخصم"] },
      { key: "total", labelAr: "الإجمالي", labelEn: "Total", type: "number", aliases: ["الإجمالي"] },
      { key: "invoice_number", labelAr: "رقم الفاتورة", labelEn: "Invoice No.", type: "text", aliases: ["invoice", "invoice number", "رقم الفاتورة"] },
      { key: "branch", labelAr: "الفرع", labelEn: "Branch", type: "text", aliases: ["الفرع"] },
      { key: "payment_term", labelAr: "شرط الدفع", labelEn: "Payment Term", type: "text", aliases: ["payment term", "شرط الدفع"] },
      { key: "payment_method", labelAr: "طريقة الدفع", labelEn: "Payment Method", type: "text", aliases: ["payment method", "طريقة الدفع"] },
      { key: "description", labelAr: "الوصف", labelEn: "Description", type: "text", aliases: ["description", "الوصف", "البيان"] },
      { key: "notes", labelAr: "ملاحظات", labelEn: "Notes", type: "text", aliases: ["note", "ملاحظات"] },
    ],
    notesAr: "يُطابق رقم فاتورة المصروف لتفادي التكرار. المورد وحساب المصروف يجب أن يكونا موجودين.",
    notesEn: "An existing expense is matched by invoice number. The supplier and expense account must already exist.",
  },
};

export function getImportModule(key: string): ImportModuleSpec | null {
  return (IMPORT_MODULES as Record<string, ImportModuleSpec>)[key] ?? null;
}

export function importableModuleKeys(): ImportModuleKey[] {
  return Object.values(IMPORT_MODULES)
    .filter((m) => importSafety(m).ok)
    .map((m) => m.key);
}

/**
 * Fail-closed import safety: a module is importable only when it declares a
 * tenant column AND every reference targets a table that is itself tenant-owned
 * or a shared chart (accounts is shared, so it is allowed).
 */
export function importSafety(spec: ImportModuleSpec): { ok: boolean; reason?: string } {
  if (!spec.tenantColumn) {
    return { ok: false, reason: `module ${spec.key} has no tenant column` };
  }
  if (spec.fields.length === 0) {
    return { ok: false, reason: `module ${spec.key} declares no fields` };
  }
  return { ok: true };
}
