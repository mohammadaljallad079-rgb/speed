import { getReportDefinition } from "./definitions";
import type { ReportIntent, ReportKind } from "./types";

/**
 * Deterministic, whitelisted natural-language intent parser (Arabic + English).
 *
 * The output is a closed set of formatting operations. The LLM/provider is never
 * asked to emit code or SQL; this parser is the only thing that turns text into
 * an action, and every action it can emit is a known formatting primitive.
 */

const ARABIC_INDIC = /[\u0600-\u06FF]/;

interface ColumnHint {
  key: string;
  patterns: RegExp[];
}

/**
 * Column hints are matched against the *requested* definition only, so a term
 * like "العميل" maps to `customer_name` for a sales report but never leaks a
 * column that report does not have.
 */
function hintsFor(kind: ReportKind): ColumnHint[] {
  const def = getReportDefinition(kind);
  const generic: ColumnHint[] = [
    { key: "date", patterns: [/\bdate\b/i, /تاريخ/i] },
    { key: "number", patterns: [/invoice\s*(no|number)/i, /bill\s*(no|number)/i, /رقم\s*الفاتورة/i] },
  ];
  if (!def) return generic;
  const map: Record<string, RegExp[]> = {
    section: [/section/i, /القسم/i, /بند/i],
    treatment: [/treatment/i, /المعاملة/i, /التصنيف/i],
    taxable_amount: [/taxable/i, /الخاضع/i, /الوعاء/i],
    rate: [/\brate\b/i, /النسبة/i, /نسبة\s*الضريبة/i],
    vat_amount: [/vat\b/i, /ضريبة/i],
    invoice_date: [/\bdate\b/i, /تاريخ/i],
    expense_date: [/\bdate\b/i, /تاريخ/i],
    bill_date: [/\bdate\b/i, /تاريخ/i],
    invoice_number: [/invoice\s*(no|number)/i, /رقم\s*الفاتورة/i],
    bill_number: [/bill\s*(no|number)/i, /رقم\s*الفاتورة/i],
    customer_name: [/customer/i, /العميل/i, /الزبون/i],
    supplier_name: [/supplier/i, /المورد/i],
    subtotal: [/subtotal/i, /المجموع\s*الفرعي/i],
    total: [/total/i, /الإجمالي/i],
    amount: [/amount/i, /المبلغ/i],
    category: [/category/i, /الفئة/i, /التصنيف/i],
    description: [/description/i, /الوصف/i],
    account_code: [/code/i, /الرمز/i],
    account_name: [/\bname\b/i, /الاسم/i],
    debit: [/debit/i, /مدين/i],
    credit: [/credit/i, /دائن/i],
  };
  return def.columns.map((c) => ({
    key: c.key,
    patterns: map[c.key] ?? [new RegExp(c.key, "i"), new RegExp(c.labelEn, "i")],
  }));
}

/** True for phrases that clearly ask to change accounting data, not formatting. */
function detectDataChange(text: string): boolean {
  const patterns = [
    /غيّ?ر\s*(المبلغ|الرصيد|الضريبة|الفاتورة|القيد|التاريخ|السعر)/i,
    /(عدّل|تعديل|حدّ?ث)\s*(المبلغ|الرصيد|الضريبة|الفاتورة|القيد|السعر)/i,
    /احذف\s*(الفاتورة|القيد|السجل|الحركة)/i,
    /\b(change|edit|update|delete|adjust)\b.{0,20}\b(amount|balance|vat|invoice|journal|entry|price)\b/i,
  ];
  return patterns.some((p) => p.test(text));
}

export function parseReportIntent(
  text: string,
  kind: ReportKind,
  options: { defaultDirection?: "rtl" | "ltr" } = {},
): ReportIntent {
  const raw = (text ?? "").trim();
  const notes: string[] = [];
  const intent: ReportIntent = {
    intent: "format",
    dataChangeRequested: false,
    notes,
  };

  // Direction: RTL / Arabic / right-to-left, or LTR / English / left-to-right.
  if (/(رتل|من\s*اليمين|عربي|العربية|rtl|right\s*to\s*left)/i.test(raw)) intent.direction = "rtl";
  else if (/(ltr|english|left\s*to\s*right|إنجليزي|انجليزي|من\s*اليسار)/i.test(raw)) intent.direction = "ltr";
  else if (options.defaultDirection) intent.direction = options.defaultDirection;

  const hints = hintsFor(kind);

  // Column order: "... حسب التاريخ ورقم الفاتورة والعميل" / "order by date, invoice no, customer"
  const orderMatch =
    /(?:حسب|ترتيب|رتّب|رتب|order\s*by|sort\s*by|by)\s*([^\n.]+)/i.exec(raw) ||
    /(?:رتّب|رتب|order|arrange)\s*(?:الأعمدة|columns)?\s*([^\n.]+)/i.exec(raw);
  if (orderMatch) {
    const segment = orderMatch[1];
    // Order by the position the user mentioned each column, not by the
    // definition's order, so "order by total, date" puts total first.
    const found: { key: string; index: number }[] = [];
    for (const hint of hints) {
      let best = -1;
      for (const p of hint.patterns) {
        const m = new RegExp(p.source, p.flags.replace("g", "")).exec(segment);
        if (m && (best === -1 || m.index < best)) best = m.index;
      }
      if (best >= 0) found.push({ key: hint.key, index: best });
    }
    found.sort((a, b) => a.index - b.index);
    const ordered = found.map((f) => f.key);
    if (ordered.length >= 2) {
      intent.columnOrder = ordered;
      notes.push(`عمود مُرتّب: ${ordered.join(", ")}`);
    }
  }

  // Hide columns: "أخفِ العميل" / "hide customer"
  const hideMatch = /(?:أخف|اخفي|إخفاء|hide|remove)\s*([^\n.]+)/i.exec(raw);
  if (hideMatch) {
    const hidden: string[] = [];
    for (const hint of hints) {
      if (hint.patterns.some((p) => p.test(hideMatch[1]))) hidden.push(hint.key);
    }
    if (hidden.length) {
      intent.hideColumns = hidden;
      notes.push(`إخفاء أعمدة: ${hidden.join(", ")}`);
    }
  }

  // Totals
  if (/(إجمالي|مجموع|جمع|الإجماليات|total|totals|sum)/i.test(raw)) {
    intent.addTotals = true;
    intent.boldTotals = true;
    notes.push("إضافة صف الإجماليات");
  }

  // Bold / professional header
  if (/(عناوين|رأس|header|title)/i.test(raw) && /(واضح|عريض|bold|احترافي|professional|clear)/i.test(raw)) {
    intent.boldTotals = true;
    notes.push("عناوين واضحة وعريضة");
  }

  // Freeze header / autofilter are safe conveniences when structure is edited.
  if (/(تثبيت|تجميد|freeze)/i.test(raw)) intent.freezeHeader = true;
  if (/(فلتر|تصفية|filter)/i.test(raw)) {
    intent.autoFilter = true;
    intent.freezeHeader = true;
  }

  // Saved template references.
  const applyMatch = /(?:طبّ?ق|apply)\s*(?:قالب|template)?\s*["«]?([^"»\n]+)["»]?/i.exec(raw);
  const saveMatch = /(?:احفظ|حفظ|save)\s*(?:هذا|as)?\s*(?:التنسيق|كقالب|as\s*a?\s*template)?\s*["«]?([^"»\n]+)["»]?/i.exec(raw);
  if (/قالب|template/i.test(raw) && applyMatch && !/احفظ|save/i.test(raw)) {
    intent.applyTemplate = applyMatch[1].trim();
    notes.push(`تطبيق القالب: ${intent.applyTemplate}`);
  }
  if (/احفظ|save/i.test(raw) && /قالب|template/i.test(raw) && saveMatch) {
    intent.saveAsTemplate = saveMatch[1].trim();
    notes.push(`حفظ القالب: ${intent.saveAsTemplate}`);
  }

  // Data-change detection — classified separately and never auto-applied.
  if (detectDataChange(raw)) {
    intent.dataChangeRequested = true;
    intent.intent = "data";
    notes.push(
      "طلب تعديل بيانات محاسبية — لا يُنفّذ عبر التنسيق؛ يجب المرور عبر واجهات النظام المعتمدة.",
    );
  } else if (intent.columnOrder || intent.hideColumns || intent.renameColumns) {
    intent.intent = "structure";
  }

  if (!notes.length) notes.push("لم يُحدَّد أي تغيير؛ سيُطبَّق التنسيق الاحترافي الافتراضي.");

  // Arabic-only text with no explicit direction defaults to RTL for readability.
  if (!intent.direction && ARABIC_INDIC.test(raw)) intent.direction = "rtl";

  return intent;
}
