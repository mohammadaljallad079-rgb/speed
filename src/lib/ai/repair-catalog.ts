import type { AuthContext } from "@/lib/auth/types";
import type { PermissionAction } from "@/lib/auth/permissions";
import { can } from "@/lib/auth/policy";
import { classifyRepairRequest, type RepairClassification } from "./policy";
import { isReportKind } from "@/lib/reporting/definitions";
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
  | "save_report_format_template";

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

/* -------------------------------------------------------------------------- */
/* Input validation and plan fingerprint                                       */
/* -------------------------------------------------------------------------- */

const MAX_PROMPT = 4000;
const MAX_NAME = 60;
const MAX_RANGE = 20;

export interface RepairPlan {
  action: RepairActionId;
  kind?: ReportKind;
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
    params: plan.params,
  });
}
