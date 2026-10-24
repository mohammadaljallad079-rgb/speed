import type { AuthContext } from "@/lib/auth/types";
import type { PermissionAction } from "@/lib/auth/permissions";
import { can } from "@/lib/auth/policy";
import { classifyRepairRequest, type RepairClassification } from "./policy";
import { isReportKind } from "@/lib/reporting/definitions";
import { isDocumentKind, DOCUMENT_KINDS, type DocumentKind } from "@/lib/templates/document-templates";
import type { ReportKind } from "@/lib/reporting/types";

/**
 * Safe repair action catalogue (pure).
 *
 * Execution 21, Phase R1. This is the **only** set of actions the AI repair
 * flow may run. The model can never invent an action id or call an arbitrary
 * function: an unknown id is rejected here. Every action reuses an existing
 * service (the reporting engine / the tenant-scoped template store) — no new
 * engine, no SQL, no shell, no source-file editing.
 *
 * A spec declares: the module/page it targets, its input schema, the permission
 * required, whether it reads or writes settings/data, its risk, and whether it
 * always needs an explicit approval. The permission is checked here (propose)
 * **and** again at execution time; the catalogue never trusts the UI.
 */

export type RepairRisk = "low" | "medium" | "high";

/** Read-only (no persisted change) vs. settings-changing (needs approval). */
export type RepairEffect = "read" | "settings";

export type RepairActionId =
  | "report_format_preview"
  | "report_validation"
  | "dashboard_revenue_reconciliation"
  | "date_filter_diagnostic"
  | "save_report_format_template"
  | "document_template_preview"
  | "save_document_template"
  | "restore_document_template";

export interface RepairActionSpec {
  id: RepairActionId;
  titleAr: string;
  titleEn: string;
  /** Modules/pages this action targets (for the diagnosis and the UI). */
  modules: string[];
  effect: RepairEffect;
  /** Permission the caller must hold to run it. */
  permission: { module: string; action: PermissionAction };
  risk: RepairRisk;
  /** Writes always require an explicit approval; reads do not. */
  requiresApproval: boolean;
  /** Human description of the accepted input. */
  inputSchema: { ar: string; en: string };
  descriptionAr: string;
  descriptionEn: string;
}

export const REPAIR_ACTIONS: RepairActionSpec[] = [
  {
    id: "report_validation",
    titleAr: "تحقق قراءة-فقط من التقرير",
    titleEn: "Read-only report validation",
    modules: ["reports", "reports/vat", "reports/sales", "reports/trial-balance"],
    effect: "read",
    permission: { module: "reports", action: "view" },
    risk: "low",
    requiresApproval: false,
    inputSchema: { ar: "نوع التقرير وفترة اختيارية", en: "report kind + optional period" },
    descriptionAr: "يشغّل المدقق الحتمي على بيانات التقرير ويعرض الفروقات ومصدر البيانات. لا يغيّر شيئًا.",
    descriptionEn: "Runs the deterministic validator over the report data and shows discrepancies and the data source. Changes nothing.",
  },
  {
    id: "report_format_preview",
    titleAr: "معاينة تنسيق/ترتيب أعمدة التقرير",
    titleEn: "Report format / column preview",
    modules: ["reports", "reports/vat", "reports/sales", "reports/purchases", "reports/expenses"],
    effect: "read",
    permission: { module: "reports", action: "view" },
    risk: "low",
    requiresApproval: false,
    inputSchema: { ar: "نوع التقرير، الطلب النصي، فترة اختيارية", en: "report kind, text request, optional period" },
    descriptionAr: "يبني خطة تنسيق/ترتيب/إخفاء الأعمدة من الطلب ويعرض القبل/بعد دون حفظ.",
    descriptionEn: "Builds a format/order/hide-columns plan from the request and shows before/after without saving.",
  },
  {
    id: "dashboard_revenue_reconciliation",
    titleAr: "مطابقة إيراد Dashboard مع الفواتير",
    titleEn: "Dashboard revenue reconciliation",
    modules: ["dashboard", "reports", "reports/sales"],
    effect: "read",
    permission: { module: "reports", action: "view" },
    risk: "low",
    requiresApproval: false,
    inputSchema: { ar: "فترة اختيارية", en: "optional period" },
    descriptionAr: "يوازن إيراد لوحة المعلومات مع مستندات المبيعات (إجمالي/ضريبة/صافي) عبر revenue.ts. لا يغيّر شيئًا.",
    descriptionEn: "Reconciles dashboard revenue against the sales documents (gross/VAT/net) via revenue.ts. Changes nothing.",
  },
  {
    id: "date_filter_diagnostic",
    titleAr: "تشخيص فلتر التاريخ/الفترة",
    titleEn: "Date filter diagnostic",
    modules: ["reports", "reports/vat", "reports/sales", "reports/purchases", "reports/expenses"],
    effect: "read",
    permission: { module: "reports", action: "view" },
    risk: "low",
    requiresApproval: false,
    inputSchema: { ar: "نوع التقرير، من/إلى (YYYY-MM-DD)", en: "report kind, from/to (YYYY-MM-DD)" },
    descriptionAr: "يعيد تشغيل نافذة الفترة على بيانات المصدر ويظهر الصفوف داخل/خارج النافذة وأي صفوف بلا تاريخ. لا يغيّر شيئًا.",
    descriptionEn: "Replays the period window over source data and shows rows inside/outside the window and any undated rows. Changes nothing.",
  },
  {
    id: "save_report_format_template",
    titleAr: "حفظ قالب تنسيق تقرير",
    titleEn: "Save report format template",
    modules: ["reports", "settings"],
    effect: "settings",
    permission: { module: "settings", action: "edit" },
    risk: "low",
    requiresApproval: true,
    inputSchema: { ar: "اسم القالب، نوع التقرير، الطلب النصي، فترة اختيارية", en: "template name, report kind, text request, optional period" },
    descriptionAr: "يحفظ قالب تنسيق قابلًا لإعادة الاستخدام في مخزن الإعدادات (tenant-scoped). لا يغيّر أي بيانات محاسبية.",
    descriptionEn: "Saves a reusable format template in the tenant-scoped settings store. Changes no accounting data.",
  },
  {
    id: "document_template_preview",
    titleAr: "معاينة تعديل قالب مستند",
    titleEn: "Document template preview",
    modules: ["settings", "documents", "templates"],
    effect: "read",
    permission: { module: "settings", action: "view" },
    risk: "low",
    requiresApproval: false,
    inputSchema: { ar: "نوع المستند، الطلب النصي", en: "document kind + text request" },
    descriptionAr: "يبني تعديل قالب المستند (شعار، حقول، ألوان، اتجاه) من الطلب ويعرض القبل/بعد دون حفظ.",
    descriptionEn: "Builds a document-template change (logo, fields, colours, direction) from the request and shows before/after without saving.",
  },
  {
    id: "save_document_template",
    titleAr: "حفظ قالب مستند",
    titleEn: "Save document template",
    modules: ["settings", "documents", "templates"],
    effect: "settings",
    permission: { module: "settings", action: "edit" },
    risk: "medium",
    requiresApproval: true,
    inputSchema: { ar: "نوع المستند، الطلب النصي، اسم اختياري", en: "document kind, text request, optional name" },
    descriptionAr: "يحفظ قالب المستند المخصص للشركة (tenant-scoped) بعد الموافقة، ويحتفظ بنسخة سابقة للاستعادة.",
    descriptionEn: "Persists the company-specific document template (tenant-scoped) after approval, keeping a prior version for restore.",
  },
  {
    id: "restore_document_template",
    titleAr: "استعادة إصدار سابق من قالب المستند",
    titleEn: "Restore a previous document template",
    modules: ["settings", "documents", "templates"],
    effect: "settings",
    permission: { module: "settings", action: "edit" },
    risk: "medium",
    requiresApproval: true,
    inputSchema: { ar: "نوع المستند", en: "document kind" },
    descriptionAr: "يعيد الإصدار السابق من قالب المستند كإصدار جديد (سجل الإصدارات).",
    descriptionEn: "Restores the previous version of a document template as a new version (version history).",
  },
];

const BY_ID = new Map<string, RepairActionSpec>(REPAIR_ACTIONS.map((a) => [a.id, a]));

export function getRepairAction(id: string): RepairActionSpec | null {
  return BY_ID.get(id) ?? null;
}

/** The actions the caller is actually allowed to run, given its permissions. */
export function allowedRepairActions(context: AuthContext): RepairActionSpec[] {
  return REPAIR_ACTIONS.filter((a) => can(context, a.permission.module, a.permission.action));
}

export function canRunRepairAction(context: AuthContext, id: string): boolean {
  const spec = getRepairAction(id);
  if (!spec) return false;
  return can(context, spec.permission.module, spec.permission.action);
}

/* -------------------------------------------------------------------------- */
/* Report-kind inference (deterministic, never a guess about a value)          */
/* -------------------------------------------------------------------------- */

const KIND_HINTS: Array<{ re: RegExp; kind: ReportKind }> = [
  { re: /vat|ضريبة|ضريبه|قيمة\s*مضافة/i, kind: "vat_report" },
  { re: /trial|ميزان\s*المراجعة|ميزان/i, kind: "trial_balance" },
  { re: /purchase|مشتريات|مورد/i, kind: "purchases_report" },
  { re: /expense|مصروف|مصاريف|تكلفة/i, kind: "expenses_report" },
  { re: /sales|مبيعات|إيراد|ايراد|revenue|dashboard|لوحة|فاتورة/i, kind: "sales_report" },
];

export function inferReportKind(prompt: string): ReportKind | null {
  for (const { re, kind } of KIND_HINTS) if (re.test(prompt)) return kind;
  return null;
}

/** A default kind for a diagnosis area, used when the prompt names none. */
function defaultKindFor(area: RepairClassification["module"]): ReportKind {
  if (area === "vat") return "vat_report";
  if (area === "ledger_balance" || area === "trial_balance") return "trial_balance";
  if (area === "receivables" || area === "revenue" || area === "dashboard" || area === "sales_numbering") {
    return "sales_report";
  }
  return "sales_report";
}

export interface RepairCandidate {
  action: RepairActionId;
  kind: ReportKind;
  reasonAr: string;
  reasonEn: string;
}

/**
 * Picks candidate actions for a complaint. Deterministic: the diagnosis area
 * chooses the report kind, and only actions the caller may run are returned.
 * A save is only offered when the request actually asks to save/name a template.
 */
export function selectRepairActions(context: AuthContext, prompt: string): RepairCandidate[] {
  const diagnosis = classifyRepairRequest(prompt);
  const kind = inferReportKind(prompt) ?? defaultKindFor(diagnosis.module);
  const candidates: RepairCandidate[] = [];

  // A revenue/dashboard complaint routes first to the revenue reconciliation.
  const revenueish = diagnosis.module === "revenue" || diagnosis.module === "dashboard" || /dashboard|لوحة|إيراد|ايراد|revenue/i.test(prompt);
  if (revenueish && canRunRepairAction(context, "dashboard_revenue_reconciliation")) {
    candidates.push({
      action: "dashboard_revenue_reconciliation",
      kind,
      reasonAr: "مطابقة الإيراد تثبت الفرق مقابل مستندات المبيعات.",
      reasonEn: "Revenue reconciliation proves the gap against the sales documents.",
    });
  }

  // A date/period complaint routes first to the date filter diagnostic.
  const dateish = diagnosis.errorType === "query" || /فلتر|filter|فترة|period|تاريخ|date|لا\s*يطابق/i.test(prompt);
  if (dateish && canRunRepairAction(context, "date_filter_diagnostic")) {
    candidates.push({
      action: "date_filter_diagnostic",
      kind,
      reasonAr: "تشخيص الفترة يعيد تشغيل النافذة على المصدر.",
      reasonEn: "The period diagnostic replays the window over the source.",
    });
  }

  if (canRunRepairAction(context, "report_validation")) {
    candidates.push({
      action: "report_validation",
      kind,
      reasonAr: "التحقق الحتمي يثبت الفرق ومصدر البيانات قبل أي إصلاح.",
      reasonEn: "Deterministic validation proves the discrepancy and its source before any fix.",
    });
  }
  if (canRunRepairAction(context, "report_format_preview")) {
    candidates.push({
      action: "report_format_preview",
      kind,
      reasonAr: "معاينة التنسيق تعرض القبل/بعد دون حفظ.",
      reasonEn: "A format preview shows before/after without saving.",
    });
  }
  const wantsSave = /(احفظ|حفظ|قالب|template|save\s*as|store\s*format)/i.test(prompt);
  if (wantsSave && canRunRepairAction(context, "save_report_format_template")) {
    candidates.push({
      action: "save_report_format_template",
      kind,
      reasonAr: "حفظ القالب يتطلب موافقة صريحة.",
      reasonEn: "Saving a template requires an explicit approval.",
    });
  }
  return candidates;
}

/**
 * Candidate actions for a *document template* request (invoice/contract/...).
 * Deterministic: a prompt that names a document and a design change routes here,
 * and only the actions the caller may run are returned. A save is offered only
 * when the request actually asks to save/apply.
 */
export function selectDocumentTemplateActions(context: AuthContext, prompt: string): RepairCandidate[] {
  const out: RepairCandidate[] = [];
  if (canRunRepairAction(context, "document_template_preview")) {
    out.push({
      action: "document_template_preview",
      kind: "sales_report",
      reasonAr: "معاينة قالب المستند تعرض القبل/بعد دون حفظ.",
      reasonEn: "A document-template preview shows before/after without saving.",
    });
  }
  const wantsSave = /(احفظ|حفظ|طبّق|طبق|اعتمد|apply|save|persist)/i.test(prompt);
  if (wantsSave && canRunRepairAction(context, "save_document_template")) {
    out.push({
      action: "save_document_template",
      kind: "sales_report",
      reasonAr: "حفظ قالب المستند يتطلب موافقة صريحة.",
      reasonEn: "Saving a document template requires an explicit approval.",
    });
  }
  if (canRunRepairAction(context, "restore_document_template")) {
    out.push({
      action: "restore_document_template",
      kind: "sales_report",
      reasonAr: "استعادة الإصدار السابق من قالب المستند.",
      reasonEn: "Restore the previous version of the document template.",
    });
  }
  return out;
}

/**
 * True when a prompt is about a printable document template rather than a
 * report. Used by the route to choose between the report and document candidate
 * sets. Deterministic keyword matching only.
 */
export function isDocumentTemplateRequest(prompt: string): boolean {
  const docWord = /(invoice|contract|receipt|quotation|voucher|statement|bill|debit\s*note|purchase\s*order|requisition)/i.test(prompt) ||
    /فاتورة|عقد|سند|عرض\s*سعر|كشف|إشعار|اشعار|أمر\s*شراء|طلب\s*شراء|مستند/.test(prompt);
  const designWord = /(logo|design|template|layout|header|footer|branding|colour|color|font|signature|stamp)/i.test(prompt) ||
    /شعار|تصميم|قالب|تنسيق|ترويسة|تذييل|لون|خط|توقيع|ختم/.test(prompt);
  return docWord && designWord;
}

/* -------------------------------------------------------------------------- */
/* Input validation and plan fingerprint                                       */
/* -------------------------------------------------------------------------- */

const MAX_PROMPT = 4000;
const MAX_NAME = 60;
const MAX_RANGE = 20;

export interface RepairPlan {
  action: RepairActionId;
  kind?: ReportKind;
  /** Set only for the document-template actions. */
  documentKind?: DocumentKind;
  /** Whitelisted, canonical parameters only. */
  params: {
    prompt?: string;
    name?: string;
    from?: string | null;
    to?: string | null;
  };
  effect: RepairEffect;
  requiresApproval: boolean;
}

export interface RepairInput {
  prompt?: unknown;
  name?: unknown;
  from?: unknown;
  to?: unknown;
  /** Document kind for the document-template actions. */
  documentKind?: unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanRange(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const s = v.slice(0, MAX_RANGE);
  return DATE_RE.test(s) ? s : null;
}

export interface ValidationResult {
  ok: boolean;
  plan?: RepairPlan;
  error?: { code: string; ar: string; en: string };
}

/**
 * Validates the action + raw input into a canonical plan, or returns a safe
 * error. Never trusts the body: only whitelisted fields survive.
 */
export function validateRepairInput(action: string, input: RepairInput): ValidationResult {
  const spec = getRepairAction(action);
  if (!spec) {
    return { ok: false, error: { code: "unknown_action", ar: "إجراء غير معروف.", en: "Unknown repair action." } };
  }

  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, MAX_PROMPT) : "";
  const from = cleanRange(input.from);
  const to = cleanRange(input.to);

  // Document-template actions: the kind is a DocumentKind, never a ReportKind.
  const isDocAction =
    spec.id === "document_template_preview" ||
    spec.id === "save_document_template" ||
    spec.id === "restore_document_template";

  if (isDocAction) {
    const rawDocKind = typeof input.documentKind === "string" ? input.documentKind.trim() : "";
    if (!isDocumentKind(rawDocKind)) {
      return {
        ok: false,
        error: {
          code: "bad_request",
          ar: `نوع المستند مطلوب (${DOCUMENT_KINDS.join(", ")}).`,
          en: `A supported document kind is required (${DOCUMENT_KINDS.join(", ")}).`,
        },
      };
    }
    const docParams: RepairPlan["params"] = { from: null, to: null };
    if (prompt) docParams.prompt = prompt;
    if (spec.id === "save_document_template") {
      const name = typeof input.name === "string" ? input.name.trim().slice(0, MAX_NAME) : "";
      if (name) docParams.name = name;
      if (!prompt) {
        return { ok: false, error: { code: "bad_request", ar: "الطلب النصي مطلوب للحفظ.", en: "A text request is required to save." } };
      }
    }
    return {
      ok: true,
      plan: {
        action: spec.id,
        documentKind: rawDocKind,
        params: docParams,
        effect: spec.effect,
        requiresApproval: spec.requiresApproval,
      },
    };
  }

  const needsPrompt = spec.id === "report_format_preview" || spec.id === "save_report_format_template";

  if (needsPrompt && !prompt) {
    return { ok: false, error: { code: "bad_request", ar: "الطلب النصي مطلوب.", en: "A text request is required." } };
  }

  // Report kind: for validation/format it may be inferred; for a save it must
  // resolve to a real kind (never invented).
  let kind: ReportKind | undefined;
  const kindFromPrompt = prompt ? inferReportKind(prompt) : null;
  if (kindFromPrompt) kind = kindFromPrompt;
  if (!kind && spec.id !== "save_report_format_template") {
    // Validation/format default to sales only when nothing else is named.
    kind = "sales_report";
  }

  const params: RepairPlan["params"] = { from, to };
  if (prompt) params.prompt = prompt;

  if (spec.id === "save_report_format_template") {
    const name = typeof input.name === "string" ? input.name.trim().slice(0, MAX_NAME) : "";
    if (!name) {
      return { ok: false, error: { code: "bad_request", ar: "اسم القالب مطلوب.", en: "A template name is required." } };
    }
    if (!kind || !isReportKind(kind)) {
      return { ok: false, error: { code: "bad_request", ar: "نوع التقرير مطلوب للقالب.", en: "A report kind is required for a template." } };
    }
    params.name = name;
  }

  if (kind && !isReportKind(kind)) {
    return { ok: false, error: { code: "bad_request", ar: "نوع تقرير غير مدعوم.", en: "Unsupported report kind." } };
  }

  return {
    ok: true,
    plan: {
      action: spec.id,
      kind,
      params,
      effect: spec.effect,
      requiresApproval: spec.requiresApproval,
    },
  };
}

/** A 64-bit (two 32-bit FNV-1a) fingerprint of a canonical plan. */
export function stableFingerprint(value: unknown): string {
  const s = JSON.stringify(value ?? null);
  const fnv = (offset: number): string => {
    let h = offset >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x01000193);
}

/** Binds an approval to the exact plan content. */
export function planFingerprint(plan: RepairPlan): string {
  return stableFingerprint({
    action: plan.action,
    kind: plan.kind ?? null,
    documentKind: plan.documentKind ?? null,
    params: plan.params,
  });
}
