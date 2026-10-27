/**
 * Shared record-creation schemas (pure, infrastructure-free).
 *
 * The invariant this file protects: an inline quick-create modal and the
 * server-side create endpoint validate the SAME fields with the SAME rules.
 * Before this file existed the modal carried its own hand-written form and
 * wrote to Supabase from the browser, so the two could drift — and they had:
 * the customer kind had no modal at all (the (+) button silently did nothing),
 * and the account modal computed a child account's `level` as a constant 2
 * instead of parent.level + 1.
 *
 * One schema per record kind drives all three surfaces:
 *   - the modal's fields,
 *   - the client-side required-field check (for immediate feedback),
 *   - the authoritative server-side validation in `/api/records/create`.
 *
 * `tenant_id` is deliberately NOT a field. It is taken from the session by the
 * server route; a caller must never be able to plant a record inside another
 * tenant by posting a body field.
 */

import type { RecordKind } from "./sources";

export type FieldType =
  | "text"
  | "email"
  | "tel"
  | "number"
  | "date"
  | "select"
  | "textarea"
  | "checkbox";

export type FieldOption = { value: string; ar: string; en: string };

export type RecordField = {
  /** The column name on the owning table. */
  name: string;
  type: FieldType;
  ar: string;
  en: string;
  required?: boolean;
  options?: FieldOption[];
  /**
   * Restrict the field to one customer type. The canonical customer form is a
   * two-tab form (individual / company) and only the matching tab's fields are
   * sent, so the modal must do the same or it would write a company column onto
   * an individual row.
   */
  onlyFor?: "individual" | "company";
  /** Numeric bounds, enforced by `validateRecord`. */
  min?: number;
  /** Placeholder hint shown in the input. */
  hint?: { ar: string; en: string };
};

export type RecordSchema = {
  kind: RecordKind;
  table: string;
  /** Permission module guarding creation of this record. */
  module: string;
  fields: RecordField[];
  /** Columns whose combination must be unique per tenant. */
  uniqueBy?: string[];
  /** Fields the modal shows on the first, always-visible section. */
  primaryFields: string[];
};

const CUSTOMER_STATUS: FieldOption[] = [
  { value: "active", ar: "نشط", en: "Active" },
  { value: "vip", ar: "VIP", en: "VIP" },
  { value: "defaulted", ar: "متعثر", en: "Defaulted" },
  { value: "blocked", ar: "محظور", en: "Blocked" },
];

const ACCOUNT_TYPES: FieldOption[] = [
  { value: "asset", ar: "أصول", en: "Asset" },
  { value: "liability", ar: "خصوم", en: "Liability" },
  { value: "equity", ar: "حقوق ملكية", en: "Equity" },
  { value: "revenue", ar: "إيرادات", en: "Revenue" },
  { value: "expense", ar: "مصروفات", en: "Expense" },
];

const CAR_CATEGORY: FieldOption[] = [
  { value: "rental", ar: "تأجير", en: "Rental" },
  { value: "sale", ar: "بيع", en: "Sale" },
  { value: "both", ar: "تأجير وبيع", en: "Both" },
];

const CAR_STATUS: FieldOption[] = [
  { value: "available", ar: "متاحة", en: "Available" },
  { value: "rented", ar: "مؤجرة", en: "Rented" },
  { value: "maintenance", ar: "صيانة", en: "Maintenance" },
  { value: "sold", ar: "مباعة", en: "Sold" },
];

const CAR_FUEL: FieldOption[] = [
  { value: "petrol", ar: "بنزين", en: "Petrol" },
  { value: "diesel", ar: "ديزل", en: "Diesel" },
  { value: "hybrid", ar: "هجين", en: "Hybrid" },
  { value: "electric", ar: "كهربائي", en: "Electric" },
];

const CAR_TRANSMISSION: FieldOption[] = [
  { value: "automatic", ar: "أوتوماتيك", en: "Automatic" },
  { value: "manual", ar: "عادي", en: "Manual" },
];

const EMPLOYEE_STATUS: FieldOption[] = [
  { value: "active", ar: "نشط", en: "Active" },
  { value: "inactive", ar: "غير نشط", en: "Inactive" },
  { value: "on_leave", ar: "في إجازة", en: "On leave" },
  { value: "terminated", ar: "منتهي الخدمة", en: "Terminated" },
];

/**
 * The canonical schemas. Each mirrors the fields its module's own create form
 * uses, so the modal is the same form, not a cut-down copy.
 */
export const RECORD_SCHEMAS: Record<RecordKind, RecordSchema> = {
  customer: {
    kind: "customer",
    table: "customers",
    module: "customers",
    primaryFields: ["customer_type", "full_name", "phone", "email"],
    uniqueBy: ["phone"],
    fields: [
      {
        name: "customer_type",
        type: "select",
        ar: "نوع العميل",
        en: "Customer type",
        required: true,
        options: [
          { value: "individual", ar: "فرد", en: "Individual" },
          { value: "company", ar: "شركة", en: "Company" },
        ],
      },
      { name: "full_name", type: "text", ar: "الاسم الكامل", en: "Full name", required: true },
      { name: "phone", type: "tel", ar: "الهاتف", en: "Phone", required: true },
      { name: "phone_2", type: "tel", ar: "هاتف بديل", en: "Phone 2" },
      { name: "email", type: "email", ar: "البريد الإلكتروني", en: "Email" },
      { name: "status", type: "select", ar: "الحالة", en: "Status", options: CUSTOMER_STATUS },
      { name: "city", type: "text", ar: "المدينة", en: "City" },
      { name: "country", type: "text", ar: "الدولة", en: "Country" },
      { name: "address", type: "text", ar: "العنوان", en: "Address" },
      { name: "national_id", type: "text", ar: "الرقم الشخصي", en: "National ID", onlyFor: "individual" },
      { name: "license_number", type: "text", ar: "رقم الرخصة", en: "License number", onlyFor: "individual" },
      { name: "nationality", type: "text", ar: "الجنسية", en: "Nationality", onlyFor: "individual" },
      { name: "company_name", type: "text", ar: "اسم الشركة", en: "Company name", onlyFor: "company" },
      { name: "commercial_reg", type: "text", ar: "السجل التجاري", en: "Commercial registration", onlyFor: "company" },
      { name: "tax_number", type: "text", ar: "الرقم الضريبي", en: "Tax number", onlyFor: "company" },
      { name: "credit_limit", type: "number", ar: "حد الائتمان", en: "Credit limit", min: 0 },
      { name: "notes", type: "textarea", ar: "ملاحظات", en: "Notes" },
    ],
  },

  supplier: {
    kind: "supplier",
    table: "suppliers",
    module: "suppliers",
    primaryFields: ["name", "phone", "email"],
    uniqueBy: ["name"],
    fields: [
      { name: "name", type: "text", ar: "اسم المورد", en: "Supplier name", required: true },
      { name: "phone", type: "tel", ar: "الهاتف", en: "Phone" },
      { name: "email", type: "email", ar: "البريد الإلكتروني", en: "Email" },
      { name: "contact_person", type: "text", ar: "الشخص المسؤول", en: "Contact person" },
      { name: "trn_number", type: "text", ar: "الرقم الضريبي", en: "TRN" },
      { name: "payment_terms", type: "text", ar: "شروط الدفع", en: "Payment terms" },
      { name: "opening_balance", type: "number", ar: "الرصيد الافتتاحي", en: "Opening balance", min: 0 },
      { name: "address", type: "text", ar: "العنوان", en: "Address" },
      { name: "notes", type: "textarea", ar: "ملاحظات", en: "Notes" },
    ],
  },

  account: {
    kind: "account",
    table: "accounts",
    module: "accounting",
    primaryFields: ["code", "name_ar", "type", "parent_id"],
    uniqueBy: ["code"],
    fields: [
      { name: "code", type: "text", ar: "رمز الحساب", en: "Account code", required: true },
      { name: "name_ar", type: "text", ar: "الاسم بالعربية", en: "Name (Arabic)", required: true },
      { name: "name_en", type: "text", ar: "الاسم بالإنجليزية", en: "Name (English)" },
      { name: "type", type: "select", ar: "نوع الحساب", en: "Account type", required: true, options: ACCOUNT_TYPES },
      { name: "parent_id", type: "text", ar: "الحساب الأب", en: "Parent account" },
      { name: "is_active", type: "checkbox", ar: "نشط", en: "Active" },
    ],
  },

  car: {
    kind: "car",
    table: "cars",
    module: "cars",
    primaryFields: ["plate_number", "make", "model", "year"],
    uniqueBy: ["plate_number"],
    fields: [
      { name: "plate_number", type: "text", ar: "رقم اللوحة", en: "Plate number", required: true },
      { name: "make", type: "text", ar: "الماركة", en: "Make", required: true },
      { name: "model", type: "text", ar: "الموديل", en: "Model", required: true },
      { name: "year", type: "number", ar: "سنة الصنع", en: "Year", min: 1900 },
      { name: "color", type: "text", ar: "اللون", en: "Color" },
      { name: "vin", type: "text", ar: "رقم الهيكل (VIN)", en: "VIN" },
      { name: "category", type: "select", ar: "الفئة", en: "Category", options: CAR_CATEGORY },
      { name: "status", type: "select", ar: "الحالة", en: "Status", options: CAR_STATUS },
      { name: "fuel_type", type: "select", ar: "نوع الوقود", en: "Fuel type", options: CAR_FUEL },
      { name: "transmission", type: "select", ar: "ناقل الحركة", en: "Transmission", options: CAR_TRANSMISSION },
      { name: "seats", type: "number", ar: "عدد المقاعد", en: "Seats", min: 1 },
      { name: "location", type: "text", ar: "الموقع", en: "Location" },
      { name: "daily_rate", type: "number", ar: "السعر اليومي", en: "Daily rate", min: 0 },
      { name: "monthly_rate", type: "number", ar: "السعر الشهري", en: "Monthly rate", min: 0 },
    ],
  },
  employee: {
    kind: "employee",
    table: "employees",
    module: "hr",
    primaryFields: ["full_name", "job_title", "phone"],
    fields: [
      { name: "full_name", type: "text", ar: "الاسم الكامل", en: "Full name", required: true },
      { name: "job_title", type: "text", ar: "المسمى الوظيفي", en: "Job title" },
      { name: "position", type: "text", ar: "الوظيفة", en: "Position" },
      { name: "phone", type: "tel", ar: "الهاتف", en: "Phone" },
      { name: "salary", type: "number", ar: "الراتب", en: "Salary", min: 0 },
      { name: "basic_salary", type: "number", ar: "الراتب الأساسي", en: "Basic salary", min: 0 },
      { name: "status", type: "select", ar: "الحالة", en: "Status", options: EMPLOYEE_STATUS },
    ],
  },
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: Array<{ field: string; ar: string; en: string }> };

/** True when a field applies to the given customer type. */
export function fieldApplies(field: RecordField, values: Record<string, unknown>): boolean {
  if (!field.onlyFor) return true;
  const type = String(values.customer_type ?? "individual");
  return field.onlyFor === type;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "boolean") return false;
  return false;
}

/**
 * The single validation rule set, used by both the modal (immediate feedback)
 * and the server route (authoritative). A field that does not apply to the
 * selected customer type is skipped rather than failed, so switching tabs never
 * produces a phantom "required" error.
 */
export function validateRecord(schema: RecordSchema, values: Record<string, unknown>): ValidationResult {
  const errors: Array<{ field: string; ar: string; en: string }> = [];

  for (const field of schema.fields) {
    if (!fieldApplies(field, values)) continue;
    const raw = values[field.name];

    if (field.required && isEmpty(raw)) {
      errors.push({ field: field.name, ar: `${field.ar} مطلوب`, en: `${field.en} is required` });
      continue;
    }
    if (isEmpty(raw)) continue;

    if (field.type === "email" && typeof raw === "string" && !EMAIL_RE.test(raw.trim())) {
      errors.push({ field: field.name, ar: `${field.ar} غير صالح`, en: `${field.en} is not a valid email` });
    }
    if (field.type === "number") {
      const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
      if (!Number.isFinite(n)) {
        errors.push({ field: field.name, ar: `${field.ar} يجب أن يكون رقماً`, en: `${field.en} must be a number` });
      } else if (field.min !== undefined && n < field.min) {
        errors.push({ field: field.name, ar: `${field.ar} لا يمكن أن يكون أقل من ${field.min}`, en: `${field.en} cannot be less than ${field.min}` });
      }
    }
    if (field.type === "select" && field.options && !field.options.some((o) => o.value === raw)) {
      errors.push({ field: field.name, ar: `${field.ar} غير صالح`, en: `${field.en} is not a valid choice` });
    }
  }

  // A company customer must carry its company name; the canonical form enforces
  // the same rule and the modal must not be a softer door.
  if (schema.kind === "customer" && String(values.customer_type ?? "individual") === "company") {
    if (isEmpty(values.company_name) && !errors.some((e) => e.field === "company_name")) {
      errors.push({ field: "company_name", ar: "اسم الشركة مطلوب", en: "Company name is required" });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Build the row to insert from raw form values.
 *
 * - trims text, converts numbers, nulls blanks,
 * - drops fields that do not apply to the selected customer type,
 * - never emits `tenant_id` (the server adds it from the session),
 * - never emits an unknown column (only schema fields are copied).
 */
export function buildRecordPayload(schema: RecordSchema, values: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const field of schema.fields) {
    if (!fieldApplies(field, values)) continue;
    const raw = values[field.name];

    if (field.type === "checkbox") {
      payload[field.name] = raw === true || raw === "true";
      continue;
    }
    if (isEmpty(raw)) {
      // Required fields are already refused by `validateRecord`; an optional
      // blank becomes an explicit null so an update clears it rather than
      // silently keeping the old value.
      payload[field.name] = null;
      continue;
    }
    if (field.type === "number") {
      const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
      payload[field.name] = Number.isFinite(n) ? n : null;
      continue;
    }
    payload[field.name] = typeof raw === "string" ? raw.trim() : raw;
  }

  // A supplier's opening balance is also its running balance, exactly as the
  // suppliers page writes it - otherwise a new supplier shows a zero balance
  // until its first bill.
  if (schema.kind === "supplier") {
    const opening = payload.opening_balance;
    payload.balance = typeof opening === "number" ? opening : 0;
  }

  return payload;
}

/** The default value for a field, used to initialise the modal's state. */
export function defaultFieldValue(field: RecordField): unknown {
  if (field.type === "checkbox") return true;
  if (field.type === "select") return field.options?.[0]?.value ?? "";
  if (field.name === "year") return String(new Date().getFullYear());
  if (field.name === "customer_type") return "individual";
  return "";
}

/** Initial form state for a schema. */
export function initialRecordValues(schema: RecordSchema): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of schema.fields) values[field.name] = defaultFieldValue(field);
  return values;
}

/**
 * The columns a reference field may show, derived from the schema so the picker
 * and the create form can never disagree about what a record contains.
 */
export function referenceColumns(kind: RecordKind): string[] {
  const schema = RECORD_SCHEMAS[kind];
  return schema.fields.filter((f) => schema.primaryFields.includes(f.name)).map((f) => f.name);
}
