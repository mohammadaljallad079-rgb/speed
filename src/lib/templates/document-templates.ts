/**
 * Document templates (pure).
 *
 * The printable documents (invoice, rental contract, quotation, receipt, ...)
 * were hard-coded into their print pages, so a company could not brand them and
 * the AI Agent had nothing to modify. This module is the single,
 * infrastructure-free definition of what a document template *is*: branding,
 * layout, visible fields, columns and page setup - plus a deterministic request
 * parser so a natural-language command ("add the company logo", "add the plate
 * number to the rental contract", "make the accent colour blue") becomes a
 * concrete, reviewable change.
 *
 * Nothing here reads a database, a file or a model. The store
 * (`document-template-store.ts`) persists these objects in the existing
 * `settings` table and the print pages render them. Keeping the shape and the
 * parsing pure is what makes the AI path testable without a model.
 */

export type DocumentKind =
  | "sales_invoice"
  | "rental_contract"
  | "quotation"
  | "purchase_invoice"
  | "payment_receipt"
  | "payment_voucher"
  | "debit_note"
  | "purchase_order"
  | "requisition"
  | "statement"
  | "vehicle_document";

export const DOCUMENT_KINDS: DocumentKind[] = [
  "sales_invoice",
  "rental_contract",
  "quotation",
  "purchase_invoice",
  "payment_receipt",
  "payment_voucher",
  "debit_note",
  "purchase_order",
  "requisition",
  "statement",
  "vehicle_document",
];

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === "string" && (DOCUMENT_KINDS as string[]).includes(value);
}

export const DOCUMENT_LABELS: Record<DocumentKind, { ar: string; en: string }> = {
  sales_invoice: { ar: "فاتورة مبيعات", en: "Sales invoice" },
  rental_contract: { ar: "عقد إيجار", en: "Rental contract" },
  quotation: { ar: "عرض سعر", en: "Quotation" },
  purchase_invoice: { ar: "فاتورة مشتريات", en: "Purchase invoice" },
  payment_receipt: { ar: "سند قبض", en: "Payment receipt" },
  payment_voucher: { ar: "سند صرف", en: "Payment voucher" },
  debit_note: { ar: "إشعار مدين", en: "Debit note" },
  purchase_order: { ar: "أمر شراء", en: "Purchase order" },
  requisition: { ar: "طلب شراء", en: "Purchase requisition" },
  statement: { ar: "كشف حساب", en: "Statement" },
  vehicle_document: { ar: "مستند مركبة", en: "Vehicle document" },
};

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

export type Direction = "rtl" | "ltr";
export type PageSize = "A4" | "A5" | "Letter";

export interface DocumentBranding {
  /** A data URI or an absolute URL. A bare path is refused (see sanitize). */
  logoUrl: string | null;
  companyNameAr: string;
  companyNameEn: string;
  tagline: string;
  addressLine: string;
  phone: string;
  email: string;
  /** VAT / CR number shown in the header when present. */
  taxId: string;
  footerText: string;
  /** Hex, `#rgb` or `#rrggbb`. */
  accentColor: string;
}

export interface DocumentLayout {
  /** Document heading, e.g. "TAX INVOICE". */
  title: string;
  /** Optional sub-heading under the title. */
  subtitle: string;
  direction: Direction;
  fontFamily: string;
  pageSize: PageSize;
  marginMm: number;
  /** Columns rendered in the items table, in order. */
  columns: string[];
  /** Field keys rendered on the document. Toggling one hides/shows it. */
  visibleFields: string[];
  showLogo: boolean;
  showSignatureBlock: boolean;
  showStamp: boolean;
}

export interface DocumentTemplate {
  id: string;
  name: string;
  kind: DocumentKind;
  branding: DocumentBranding;
  layout: DocumentLayout;
  /** Monotonic version, bumped on every save; the history keeps the last N. */
  version: number;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Supported fields and columns per document kind                              */
/* -------------------------------------------------------------------------- */

/**
 * The dynamic fields a document of this kind may show. This is the closed set
 * the AI may toggle - it can never invent a field, because only these keys are
 * read when rendering.
 */
export const SUPPORTED_FIELDS: Record<DocumentKind, Array<{ key: string; ar: string; en: string }>> = {
  sales_invoice: [
    { key: "invoice_number", ar: "رقم الفاتورة", en: "Invoice number" },
    { key: "invoice_date", ar: "تاريخ الفاتورة", en: "Invoice date" },
    { key: "due_date", ar: "تاريخ الاستحقاق", en: "Due date" },
    { key: "customer", ar: "العميل", en: "Customer" },
    { key: "customer_tax_id", ar: "الرقم الضريبي للعميل", en: "Customer VAT number" },
    { key: "items_table", ar: "جدول الأصناف", en: "Items table" },
    { key: "subtotal", ar: "المجموع الفرعي", en: "Subtotal" },
    { key: "discount", ar: "الخصم", en: "Discount" },
    { key: "vat", ar: "ضريبة القيمة المضافة", en: "VAT" },
    { key: "total", ar: "الإجمالي", en: "Total" },
    { key: "amount_in_words", ar: "المبلغ بالحروف", en: "Amount in words" },
    { key: "notes", ar: "ملاحظات", en: "Notes" },
    { key: "signature", ar: "التوقيع", en: "Signature" },
    { key: "stamp", ar: "الختم", en: "Stamp" },
  ],
  rental_contract: [
    { key: "contract_number", ar: "رقم العقد", en: "Contract number" },
    { key: "contract_date", ar: "تاريخ العقد", en: "Contract date" },
    { key: "customer", ar: "العميل", en: "Customer" },
    { key: "customer_id_number", ar: "رقم هوية العميل", en: "Customer ID number" },
    { key: "vehicle", ar: "المركبة", en: "Vehicle" },
    { key: "plate_number", ar: "رقم اللوحة", en: "Plate number" },
    { key: "chassis_number", ar: "رقم الهيكل", en: "Chassis number" },
    { key: "mileage_out", ar: "العداد عند التسليم", en: "Mileage out" },
    { key: "mileage_in", ar: "العداد عند الاستلام", en: "Mileage in" },
    { key: "fuel_level", ar: "مستوى الوقود", en: "Fuel level" },
    { key: "start_date", ar: "تاريخ البداية", en: "Start date" },
    { key: "end_date", ar: "تاريخ النهاية", en: "End date" },
    { key: "daily_rate", ar: "السعر اليومي", en: "Daily rate" },
    { key: "total", ar: "الإجمالي", en: "Total" },
    { key: "deposit", ar: "التأمين", en: "Deposit" },
    { key: "terms", ar: "الشروط والأحكام", en: "Terms and conditions" },
    { key: "signature", ar: "التوقيع", en: "Signature" },
    { key: "stamp", ar: "الختم", en: "Stamp" },
  ],
  quotation: [
    { key: "quotation_number", ar: "رقم العرض", en: "Quotation number" },
    { key: "quotation_date", ar: "تاريخ العرض", en: "Quotation date" },
    { key: "valid_until", ar: "صالح حتى", en: "Valid until" },
    { key: "customer", ar: "العميل", en: "Customer" },
    { key: "items_table", ar: "جدول الأصناف", en: "Items table" },
    { key: "subtotal", ar: "المجموع الفرعي", en: "Subtotal" },
    { key: "vat", ar: "ضريبة القيمة المضافة", en: "VAT" },
    { key: "total", ar: "الإجمالي", en: "Total" },
    { key: "terms", ar: "الشروط والأحكام", en: "Terms and conditions" },
    { key: "signature", ar: "التوقيع", en: "Signature" },
  ],
  purchase_invoice: [
    { key: "bill_number", ar: "رقم الفاتورة", en: "Bill number" },
    { key: "bill_date", ar: "تاريخ الفاتورة", en: "Bill date" },
    { key: "supplier", ar: "المورد", en: "Supplier" },
    { key: "supplier_tax_id", ar: "الرقم الضريبي للمورد", en: "Supplier VAT number" },
    { key: "items_table", ar: "جدول الأصناف", en: "Items table" },
    { key: "subtotal", ar: "المجموع الفرعي", en: "Subtotal" },
    { key: "vat", ar: "ضريبة القيمة المضافة", en: "VAT" },
    { key: "total", ar: "الإجمالي", en: "Total" },
    { key: "notes", ar: "ملاحظات", en: "Notes" },
    { key: "signature", ar: "التوقيع", en: "Signature" },
  ],
  payment_receipt: [
    { key: "receipt_number", ar: "رقم السند", en: "Receipt number" },
    { key: "receipt_date", ar: "التاريخ", en: "Date" },
    { key: "customer", ar: "العميل", en: "Customer" },
    { key: "invoice_number", ar: "رقم الفاتورة", en: "Invoice number" },
    { key: "amount", ar: "المبلغ", en: "Amount" },
    { key: "amount_in_words", ar: "المبلغ بالحروف", en: "Amount in words" },
    { key: "payment_method", ar: "طريقة الدفع", en: "Payment method" },
    { key: "notes", ar: "ملاحظات", en: "Notes" },
    { key: "signature", ar: "التوقيع", en: "Signature" },
  ],
  payment_voucher: [
    { key: "voucher_number", ar: "رقم السند", en: "Voucher number" },
    { key: "voucher_date", ar: "التاريخ", en: "Date" },
    { key: "supplier", ar: "المورد", en: "Supplier" },
    { key: "amount", ar: "المبلغ", en: "Amount" },
    { key: "amount_in_words", ar: "المبلغ بالحروف", en: "Amount in words" },
    { key: "payment_method", ar: "طريقة الدفع", en: "Payment method" },
    { key: "notes", ar: "ملاحظات", en: "Notes" },
    { key: "signature", ar: "التوقيع", en: "Signature" },
  ],
  debit_note: [
    { key: "note_number", ar: "رقم الإشعار", en: "Note number" },
    { key: "note_date", ar: "التاريخ", en: "Date" },
    { key: "supplier", ar: "المورد", en: "Supplier" },
    { key: "bill_number", ar: "رقم فاتورة المورد", en: "Supplier bill number" },
    { key: "amount", ar: "المبلغ", en: "Amount" },
    { key: "vat", ar: "ضريبة القيمة المضافة", en: "VAT" },
    { key: "reason", ar: "السبب", en: "Reason" },
    { key: "signature", ar: "التوقيع", en: "Signature" },
  ],
  purchase_order: [
    { key: "order_number", ar: "رقم الأمر", en: "Order number" },
    { key: "order_date", ar: "التاريخ", en: "Date" },
    { key: "supplier", ar: "المورد", en: "Supplier" },
    { key: "expected_date", ar: "التاريخ المتوقع", en: "Expected date" },
    { key: "items_table", ar: "جدول الأصناف", en: "Items table" },
    { key: "subtotal", ar: "المجموع الفرعي", en: "Subtotal" },
    { key: "vat", ar: "ضريبة القيمة المضافة", en: "VAT" },
    { key: "total", ar: "الإجمالي", en: "Total" },
    { key: "terms", ar: "الشروط والأحكام", en: "Terms and conditions" },
    { key: "signature", ar: "التوقيع", en: "Signature" },
  ],
  requisition: [
    { key: "requisition_number", ar: "رقم الطلب", en: "Requisition number" },
    { key: "requisition_date", ar: "التاريخ", en: "Date" },
    { key: "requested_by", ar: "مقدم الطلب", en: "Requested by" },
    { key: "department", ar: "القسم", en: "Department" },
    { key: "items_table", ar: "جدول الأصناف", en: "Items table" },
    { key: "total", ar: "الإجمالي", en: "Total" },
    { key: "notes", ar: "ملاحظات", en: "Notes" },
    { key: "signature", ar: "التوقيع", en: "Signature" },
  ],
  statement: [
    { key: "party", ar: "الطرف", en: "Party" },
    { key: "period_from", ar: "من تاريخ", en: "Period from" },
    { key: "period_to", ar: "إلى تاريخ", en: "Period to" },
    { key: "opening_balance", ar: "الرصيد الافتتاحي", en: "Opening balance" },
    { key: "movements_table", ar: "جدول الحركات", en: "Movements table" },
    { key: "closing_balance", ar: "الرصيد الختامي", en: "Closing balance" },
    { key: "aging_summary", ar: "ملخص الأعمار", en: "Aging summary" },
    { key: "notes", ar: "ملاحظات", en: "Notes" },
  ],
  vehicle_document: [
    { key: "vehicle", ar: "المركبة", en: "Vehicle" },
    { key: "plate_number", ar: "رقم اللوحة", en: "Plate number" },
    { key: "registration_expiry", ar: "انتهاء التسجيل", en: "Registration expiry" },
    { key: "insurance_expiry", ar: "انتهاء التأمين", en: "Insurance expiry" },
    { key: "chassis_number", ar: "رقم الهيكل", en: "Chassis number" },
    { key: "notes", ar: "ملاحظات", en: "Notes" },
    { key: "signature", ar: "التوقيع", en: "Signature" },
  ],
};

export const SUPPORTED_COLUMNS = ["#", "description", "quantity", "unit_price", "amount", "vat", "total"] as const;

export function supportedFieldKeys(kind: DocumentKind): string[] {
  return (SUPPORTED_FIELDS[kind] ?? []).map((f) => f.key);
}

/** Finds a supported field by an Arabic/English label or by its key. */
export function findSupportedField(kind: DocumentKind, term: string): { key: string; ar: string; en: string } | null {
  const t = term.trim().toLowerCase();
  if (!t) return null;
  const fields = SUPPORTED_FIELDS[kind] ?? [];
  return (
    fields.find((f) => f.key === t) ??
    fields.find((f) => f.en.toLowerCase() === t || f.ar === term.trim()) ??
    fields.find((f) => f.en.toLowerCase().includes(t) || f.ar.includes(term.trim())) ??
    null
  );
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

export const DEFAULT_BRANDING: DocumentBranding = {
  logoUrl: null,
  companyNameAr: "سبيد لتأجير السيارات",
  companyNameEn: "SPEED Car Rental Services",
  tagline: "Car Rental Services",
  addressLine: "Kingdom of Bahrain",
  phone: "",
  email: "",
  taxId: "",
  footerText: "Thank you for your business",
  accentColor: "#dc2626",
};

const BASE_LAYOUT: Omit<DocumentLayout, "title"> = {
  subtitle: "",
  direction: "rtl",
  fontFamily: "system",
  pageSize: "A4",
  marginMm: 12,
  columns: ["#", "description", "quantity", "unit_price", "amount"],
  visibleFields: [],
  showLogo: true,
  showSignatureBlock: false,
  showStamp: false,
};

export function defaultTemplate(kind: DocumentKind): DocumentTemplate {
  const label = DOCUMENT_LABELS[kind];
  const visible = supportedFieldKeys(kind).filter((k) => !["signature", "stamp"].includes(k));
  return {
    id: `default-${kind}`,
    name: `${label.en} - default`,
    kind,
    branding: { ...DEFAULT_BRANDING },
    layout: { ...BASE_LAYOUT, title: label.en.toUpperCase(), visibleFields: visible },
    version: 1,
    updatedAt: new Date(0).toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Sanitisation (a template from the client or the model is untrusted)         */
/* -------------------------------------------------------------------------- */

const MAX_NAME = 80;
const MAX_TEXT = 240;
const MAX_LOGO = 200_000; // ~200 KB data URI
const MAX_COLUMNS = 8;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const SAFE_FONTS = ["system", "serif", "sans-serif", "monospace"];

/** Accepts an https URL, a data:image URI, or a root-relative path. Anything else is dropped. */
export function sanitizeLogoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > MAX_LOGO) return null;
  if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(v)) return v;
  if (/^https:\/\/[^\s"'<>]+$/i.test(v)) return v;
  if (/^\/[^\s"'<>]*$/.test(v)) return v;
  return null;
}

const text = (value: unknown, max = MAX_TEXT): string =>
  typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max) : "";

export function sanitizeTemplate(input: unknown): DocumentTemplate | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (!isDocumentKind(raw.kind)) return null;
  const kind = raw.kind;
  const base = defaultTemplate(kind);

  const b = (raw.branding ?? {}) as Record<string, unknown>;
  const branding: DocumentBranding = {
    logoUrl: sanitizeLogoUrl(b.logoUrl),
    companyNameAr: text(b.companyNameAr) || base.branding.companyNameAr,
    companyNameEn: text(b.companyNameEn) || base.branding.companyNameEn,
    tagline: text(b.tagline),
    addressLine: text(b.addressLine),
    phone: text(b.phone, 40),
    email: text(b.email, 120),
    taxId: text(b.taxId, 40),
    footerText: text(b.footerText),
    accentColor: typeof b.accentColor === "string" && HEX.test(b.accentColor.trim()) ? b.accentColor.trim().toLowerCase() : base.branding.accentColor,
  };

  const l = (raw.layout ?? {}) as Record<string, unknown>;
  const allowedFields = new Set(supportedFieldKeys(kind));
  const visibleFields = Array.isArray(l.visibleFields)
    ? [...new Set(l.visibleFields.filter((f): f is string => typeof f === "string" && allowedFields.has(f)))]
    : base.layout.visibleFields;
  const columns = Array.isArray(l.columns)
    ? l.columns.filter((c): c is string => typeof c === "string" && (SUPPORTED_COLUMNS as readonly string[]).includes(c)).slice(0, MAX_COLUMNS)
    : base.layout.columns;

  const layout: DocumentLayout = {
    title: text(l.title, 60) || base.layout.title,
    subtitle: text(l.subtitle, 120),
    direction: l.direction === "ltr" ? "ltr" : "rtl",
    fontFamily: typeof l.fontFamily === "string" && SAFE_FONTS.includes(l.fontFamily) ? l.fontFamily : base.layout.fontFamily,
    pageSize: l.pageSize === "A5" || l.pageSize === "Letter" ? l.pageSize : "A4",
    marginMm: typeof l.marginMm === "number" && Number.isFinite(l.marginMm) ? Math.min(30, Math.max(5, Math.round(l.marginMm))) : base.layout.marginMm,
    columns: columns.length ? columns : base.layout.columns,
    visibleFields,
    showLogo: l.showLogo !== false,
    showSignatureBlock: l.showSignatureBlock === true,
    showStamp: l.showStamp === true,
  };

  return {
    id: text(raw.id, 80) || `tpl-${kind}`,
    name: text(raw.name, MAX_NAME) || base.name,
    kind,
    branding,
    layout,
    version: typeof raw.version === "number" && Number.isFinite(raw.version) && raw.version > 0 ? Math.floor(raw.version) : 1,
    updatedAt: typeof raw.updatedAt === "string" ? text(raw.updatedAt, 40) : new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic request -> change parser                                      */
/* -------------------------------------------------------------------------- */

export interface TemplateChange {
  /** Machine-readable change kind, for the UI and the audit log. */
  kind: "logo" | "field" | "field_hidden" | "color" | "title" | "subtitle" | "footer" | "font" | "direction" | "page" | "margin" | "signature" | "stamp" | "branding";
  field?: string;
  from?: string;
  to?: string;
  ar: string;
  en: string;
}

export interface TemplateChangeResult {
  template: DocumentTemplate;
  changes: TemplateChange[];
  /** Terms the parser recognised as a request but could not apply. */
  unapplied: string[];
}

const COLOR_WORDS: Array<{ re: RegExp; hex: string; ar: string; en: string }> = [
  { re: /أحمر|احمر|red/i, hex: "#dc2626", ar: "أحمر", en: "red" },
  { re: /أزرق|ازرق|blue/i, hex: "#2563eb", ar: "أزرق", en: "blue" },
  { re: /أخضر|اخضر|green/i, hex: "#16a34a", ar: "أخضر", en: "green" },
  { re: /أسود|اسود|black/i, hex: "#0f172a", ar: "أسود", en: "black" },
  { re: /ذهبي|gold/i, hex: "#b45309", ar: "ذهبي", en: "gold" },
  { re: /رمادي|gray|grey/i, hex: "#475569", ar: "رمادي", en: "gray" },
];

const ADD_WORDS = /(add|include|insert|show|display|أضف|اضف|أدرج|ادرج|اعرض|أظهر|اظهر)/i;
const REMOVE_WORDS = /(remove|hide|drop|delete|احذف|أخف|اخف|أزل|ازل|إزالة|ازالة)/i;
const LOGO_WORDS = /(logo|شعار|الشعار)/i;
const SIGNATURE_WORDS = /(signature|توقيع|التوقيع)/i;
const STAMP_WORDS = /(stamp|seal|ختم|الختم)/i;
const FOOTER_WORDS = /(footer|تذييل|الأسفل|الاسفل)/i;
const TITLE_WORDS = /(title|heading|عنوان|العنوان)/i;

/** A quoted string, used for free-text values (title, footer). */
function quotedValue(prompt: string): string | null {
  const m = prompt.match(/["“”'«»]([^"“”'«»]{1,120})["“”'«»]/) ?? prompt.match(/["“”'«»]([^"“”'«»]{1,120})$/);
  return m ? m[1].trim() : null;
}

/**
 * Applies a natural-language request to a template. Deterministic: the same
 * request always produces the same change, and the model is never consulted, so
 * a hallucinated instruction cannot reach the template. Unknown requests are
 * reported in `unapplied` rather than guessed at.
 */
export function applyTemplateRequest(base: DocumentTemplate, prompt: string): TemplateChangeResult {
  const template: DocumentTemplate = {
    ...base,
    branding: { ...base.branding },
    layout: { ...base.layout, columns: [...base.layout.columns], visibleFields: [...base.layout.visibleFields] },
  };
  const changes: TemplateChange[] = [];
  const unapplied: string[] = [];
  const p = String(prompt ?? "");

  // Logo
  if (LOGO_WORDS.test(p)) {
    if (REMOVE_WORDS.test(p)) {
      if (template.branding.logoUrl || template.layout.showLogo) {
        template.branding.logoUrl = null;
        template.layout.showLogo = false;
        changes.push({ kind: "logo", from: "shown", to: "hidden", ar: "إخفاء الشعار", en: "Hide the logo" });
      }
    } else {
      const url = sanitizeLogoUrl(quotedValue(p));
      if (url) {
        template.branding.logoUrl = url;
        template.layout.showLogo = true;
        changes.push({ kind: "logo", from: "hidden", to: "shown", ar: "إظهار شعار الشركة", en: "Show the company logo" });
      } else if (template.layout.showLogo) {
        // No replacement file was supplied (a logo already exists, or the logo is
        // already shown): report it rather than pushing a phantom change.
        unapplied.push("logo");
      } else {
        template.layout.showLogo = true;
        changes.push({ kind: "logo", from: "hidden", to: "shown", ar: "إظهار الشعار (يرجى رفع ملف الشعار)", en: "Show the logo (upload the logo file)" });
      }
    }
  }

  // Accent colour
  for (const c of COLOR_WORDS) {
    if (c.re.test(p)) {
      if (template.branding.accentColor !== c.hex) {
        changes.push({ kind: "color", from: template.branding.accentColor, to: c.hex, ar: `تغيير اللون إلى ${c.ar}`, en: `Set the accent colour to ${c.en}` });
        template.branding.accentColor = c.hex;
      }
      break;
    }
  }

  // A supported field add/remove
  for (const f of SUPPORTED_FIELDS[template.kind] ?? []) {
    const mentioned = p.toLowerCase().includes(f.en.toLowerCase()) || (f.ar && p.includes(f.ar));
    if (!mentioned) continue;
    const isShown = template.layout.visibleFields.includes(f.key);
    if (REMOVE_WORDS.test(p) && isShown) {
      template.layout.visibleFields = template.layout.visibleFields.filter((k) => k !== f.key);
      changes.push({ kind: "field_hidden", field: f.key, from: "shown", to: "hidden", ar: `إخفاء حقل: ${f.ar}`, en: `Hide field: ${f.en}` });
    } else if (ADD_WORDS.test(p) && !isShown) {
      template.layout.visibleFields = [...template.layout.visibleFields, f.key];
      changes.push({ kind: "field", field: f.key, from: "hidden", to: "shown", ar: `إضافة حقل: ${f.ar}`, en: `Add field: ${f.en}` });
    } else if (!isShown && !REMOVE_WORDS.test(p)) {
      // A bare mention ("the plate number on the contract") means "show it".
      template.layout.visibleFields = [...template.layout.visibleFields, f.key];
      changes.push({ kind: "field", field: f.key, from: "hidden", to: "shown", ar: `إضافة حقل: ${f.ar}`, en: `Add field: ${f.en}` });
    }
  }

  // Signature / stamp blocks
  if (SIGNATURE_WORDS.test(p) && !template.layout.showSignatureBlock) {
    template.layout.showSignatureBlock = true;
    changes.push({ kind: "signature", from: "hidden", to: "shown", ar: "إضافة مربع التوقيع", en: "Add the signature block" });
  }
  if (STAMP_WORDS.test(p) && !template.layout.showStamp) {
    template.layout.showStamp = true;
    changes.push({ kind: "stamp", from: "hidden", to: "shown", ar: "إضافة الختم", en: "Add the stamp area" });
  }

  // Title / footer free text
  if (TITLE_WORDS.test(p)) {
    const v = quotedValue(p);
    if (v && v !== template.layout.title) {
      changes.push({ kind: "title", from: template.layout.title, to: v, ar: `تغيير العنوان إلى "${v}"`, en: `Set the title to "${v}"` });
      template.layout.title = v;
    }
  }
  if (FOOTER_WORDS.test(p)) {
    const v = quotedValue(p);
    if (v && v !== template.branding.footerText) {
      changes.push({ kind: "footer", from: template.branding.footerText, to: v, ar: `تغيير التذييل إلى "${v}"`, en: `Set the footer to "${v}"` });
      template.branding.footerText = v;
    }
  }

  // Direction
  if (/\b(english|ltr|left to right)\b|إنجليزي|انجليزي/i.test(p) && template.layout.direction !== "ltr") {
    changes.push({ kind: "direction", from: "rtl", to: "ltr", ar: "تحويل المستند إلى الإنجليزية (LTR)", en: "Switch the document to English (LTR)" });
    template.layout.direction = "ltr";
  } else if (/\b(arabic|rtl|right to left)\b|عربي|العربية/i.test(p) && template.layout.direction !== "rtl") {
    changes.push({ kind: "direction", from: "ltr", to: "rtl", ar: "تحويل المستند إلى العربية (RTL)", en: "Switch the document to Arabic (RTL)" });
    template.layout.direction = "rtl";
  }

  // Font
  if (/\bserif\b/i.test(p) && template.layout.fontFamily !== "serif") {
    changes.push({ kind: "font", from: template.layout.fontFamily, to: "serif", ar: "تغيير الخط", en: "Change the font" });
    template.layout.fontFamily = "serif";
  } else if (/\bsans[- ]?serif\b/i.test(p) && template.layout.fontFamily !== "sans-serif") {
    changes.push({ kind: "font", from: template.layout.fontFamily, to: "sans-serif", ar: "تغيير الخط", en: "Change the font" });
    template.layout.fontFamily = "sans-serif";
  }

  // Page size
  if (/\bA5\b/i.test(p) && template.layout.pageSize !== "A5") {
    changes.push({ kind: "page", from: template.layout.pageSize, to: "A5", ar: "تغيير حجم الصفحة إلى A5", en: "Set the page size to A5" });
    template.layout.pageSize = "A5";
  } else if (/\bLetter\b/i.test(p) && template.layout.pageSize !== "Letter") {
    changes.push({ kind: "page", from: template.layout.pageSize, to: "Letter", ar: "تغيير حجم الصفحة إلى Letter", en: "Set the page size to Letter" });
    template.layout.pageSize = "Letter";
  }

  // Columns (add/remove a column by name)
  for (const col of SUPPORTED_COLUMNS) {
    if (col === "#") continue;
    const label = col.replace("_", " ");
    if (!new RegExp(`\\b${label}\\b`, "i").test(p) && !p.includes(col)) continue;
    const present = template.layout.columns.includes(col);
    if (REMOVE_WORDS.test(p) && present) {
      template.layout.columns = template.layout.columns.filter((c) => c !== col);
      changes.push({ kind: "field_hidden", field: col, from: "shown", to: "hidden", ar: `إخفاء عمود: ${col}`, en: `Hide column: ${col}` });
    } else if (ADD_WORDS.test(p) && !present) {
      template.layout.columns = [...template.layout.columns, col].slice(0, MAX_COLUMNS);
      changes.push({ kind: "field", field: col, from: "hidden", to: "shown", ar: `إضافة عمود: ${col}`, en: `Add column: ${col}` });
    }
  }

  return { template, changes, unapplied };
}

/* -------------------------------------------------------------------------- */
/* Diff (for a before/after preview)                                           */
/* -------------------------------------------------------------------------- */

export interface TemplateDiffEntry {
  label: string;
  labelAr: string;
  before: string;
  after: string;
}

/** A human-readable before/after of the two templates, for the approval preview. */
export function diffTemplates(before: DocumentTemplate, after: DocumentTemplate): TemplateDiffEntry[] {
  const out: TemplateDiffEntry[] = [];
  const add = (label: string, labelAr: string, b: unknown, a: unknown) => {
    const bs = formatValue(b);
    const as = formatValue(a);
    if (bs !== as) out.push({ label, labelAr, before: bs, after: as });
  };
  add("Title", "العنوان", before.layout.title, after.layout.title);
  add("Subtitle", "العنوان الفرعي", before.layout.subtitle, after.layout.subtitle);
  add("Direction", "الاتجاه", before.layout.direction, after.layout.direction);
  add("Font", "الخط", before.layout.fontFamily, after.layout.fontFamily);
  add("Page size", "حجم الصفحة", before.layout.pageSize, after.layout.pageSize);
  add("Margin (mm)", "الهامش (مم)", before.layout.marginMm, after.layout.marginMm);
  add("Accent colour", "اللون", before.branding.accentColor, after.branding.accentColor);
  add("Company name (EN)", "اسم الشركة (EN)", before.branding.companyNameEn, after.branding.companyNameEn);
  add("Company name (AR)", "اسم الشركة (AR)", before.branding.companyNameAr, after.branding.companyNameAr);
  add("Tagline", "الوصف", before.branding.tagline, after.branding.tagline);
  add("Address", "العنوان", before.branding.addressLine, after.branding.addressLine);
  add("Phone", "الهاتف", before.branding.phone, after.branding.phone);
  add("Email", "البريد", before.branding.email, after.branding.email);
  add("Tax id", "الرقم الضريبي", before.branding.taxId, after.branding.taxId);
  add("Footer", "التذييل", before.branding.footerText, after.branding.footerText);
  add("Logo", "الشعار", before.layout.showLogo && before.branding.logoUrl ? "shown" : "hidden", after.layout.showLogo && after.branding.logoUrl ? "shown" : "hidden");
  add("Signature block", "مربع التوقيع", before.layout.showSignatureBlock, after.layout.showSignatureBlock);
  add("Stamp", "الختم", before.layout.showStamp, after.layout.showStamp);
  add("Columns", "الأعمدة", before.layout.columns.join(", "), after.layout.columns.join(", "));
  add("Visible fields", "الحقول الظاهرة", before.layout.visibleFields.join(", "), after.layout.visibleFields.join(", "));
  return out;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}
