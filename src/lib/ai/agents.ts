import type { AuthContext } from "@/lib/auth/types";
import { allowedTools, classifyDevRequest, type AiToolSpec } from "./policy";
import type { AiTaskKind } from "./types";

/**
 * Agent registry.
 *
 * There is **one** execution service; an "agent" is a configuration entry, not
 * a separate module. Each agent declares the task class it runs, the tools it
 * may use and a run/consumption budget. The effective tool set for a given
 * caller is the agent's tools ∩ the caller's permissions, so an agent can never
 * grant access the user does not already have.
 */

export interface AgentSpec {
  id: string;
  nameEn: string;
  nameAr: string;
  task: AiTaskKind;
  /** Tools this agent is designed to use (still intersected with permissions). */
  tools: string[];
  /** Per-run caps. */
  limits: { maxTools: number; maxTokens: number };
  /** True when the agent's output always needs a human before it takes effect. */
  requiresHumanReview: boolean;
  descriptionEn: string;
  descriptionAr: string;
}

export const AGENTS: AgentSpec[] = [
  {
    id: "financial_analyst",
    nameEn: "Financial Analyst",
    nameAr: "المحلل المالي",
    task: "analysis",
    tools: ["sales_summary", "expense_summary", "profit_summary", "receivables_summary", "vat_summary", "report_totals"],
    limits: { maxTools: 6, maxTokens: 2500 },
    requiresHumanReview: false,
    descriptionEn: "Explains financial performance from real, permitted figures.",
    descriptionAr: "يشرح الأداء المالي من أرقام حقيقية ومسموح بها.",
  },
  {
    id: "excel_quality",
    nameEn: "Excel & Data Quality",
    nameAr: "جودة بيانات Excel",
    task: "repair",
    tools: ["report_totals", "invoice_lookup", "customer_lookup"],
    limits: { maxTools: 4, maxTokens: 2000 },
    requiresHumanReview: true,
    descriptionEn: "Flags data-quality issues in imported files; never rewrites source rows.",
    descriptionAr: "يرصد مشاكل جودة البيانات في الملفات المستوردة دون تعديل البيانات الأصلية.",
  },
  {
    id: "accounting_helper",
    nameEn: "Accounting Helper",
    nameAr: "المساعد المحاسبي",
    task: "assistant",
    tools: ["report_totals", "invoice_lookup", "payments_summary", "vat_summary"],
    limits: { maxTools: 4, maxTokens: 2000 },
    requiresHumanReview: true,
    descriptionEn: "Answers accounting questions from the ledger; cannot post entries.",
    descriptionAr: "يجيب عن الأسئلة المحاسبية من الدفاتر دون تسجيل قيود.",
  },
  {
    id: "code_qa",
    nameEn: "Code & Test Reviewer",
    nameAr: "مراجع الكود والاختبارات",
    task: "development",
    tools: [],
    limits: { maxTools: 0, maxTokens: 3000 },
    requiresHumanReview: true,
    descriptionEn: "Plans code/test improvements as proposals for human review.",
    descriptionAr: "يخطط تحسينات الكود والاختبارات كمقترحات لمراجعة بشرية.",
  },
  {
    id: "dev_planner",
    nameEn: "Development Planner",
    nameAr: "مخطط التطوير",
    task: "development",
    tools: [],
    limits: { maxTools: 0, maxTokens: 3000 },
    requiresHumanReview: true,
    descriptionEn: "Turns an admin request into a scoped plan; never self-applies.",
    descriptionAr: "يحوّل طلب المسؤول إلى خطة محددة دون تطبيق ذاتي.",
  },
  {
    id: "reporting",
    nameEn: "Management Reporting",
    nameAr: "التقارير الإدارية",
    task: "report",
    tools: ["report_totals", "sales_summary", "expense_summary", "profit_summary", "purchase_summary"],
    limits: { maxTools: 6, maxTokens: 2500 },
    requiresHumanReview: false,
    descriptionEn: "Builds management summaries from permitted datasets.",
    descriptionAr: "ينشئ ملخصات إدارية من البيانات المسموح بها.",
  },
];

export function getAgent(id: string): AgentSpec | null {
  return AGENTS.find((a) => a.id === id) ?? null;
}

export interface EffectiveAgent {
  agent: AgentSpec;
  tools: AiToolSpec[];
  /** Development requests always carry a risk classification. */
  classification?: ReturnType<typeof classifyDevRequest>;
}

/**
 * Resolves an agent for a caller: its tools are narrowed to the caller's own
 * permissions. Development agents additionally classify the request.
 */
export function resolveAgent(context: AuthContext, id: string, prompt = ""): EffectiveAgent | null {
  const agent = getAgent(id);
  if (!agent) return null;
  const permitted = new Set(allowedTools(context).map((t) => t.name));
  const tools = allowedTools(context).filter(
    (t) => agent.tools.includes(t.name) && permitted.has(t.name),
  );
  const classification = agent.task === "development" ? classifyDevRequest(prompt) : undefined;
  return { agent, tools, classification };
}
