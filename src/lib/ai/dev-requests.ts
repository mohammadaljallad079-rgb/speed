import { classifyDevRequest, isForbiddenPath, type DevClassification, type DevRisk } from "./policy";

/**
 * Development-request workflow.
 *
 * A controlled, reviewable pipeline: receive → analyse → plan → impact assess →
 * approval → (human) apply. Crucially, the AI **never executes** code, shell or
 * git, and never applies its own change. The pipeline produces a structured
 * plan and a reviewable patch artifact; a human applies it on a branch. This is
 * the safe foundation the mission asks for when the runtime cannot execute code
 * on the assistant's behalf.
 *
 * State is stored in the existing `settings` table (key `ai_dev_requests`),
 * scoped by tenant. Nothing here writes source files or touches the database
 * schema.
 */

export const DEV_REQUESTS_KEY = "ai_dev_requests";
const MAX_REQUESTS = 100;
const MAX_PROMPT = 4000;

export type DevRequestStatus = "pending_approval" | "approved" | "rejected" | "applied" | "rolled_back";

export interface DevPlanStep {
  order: number;
  title: string;
  detail: string;
}

export interface DevImpact {
  permissions: string;
  accounting: string;
  database: string;
  tests: string;
}

export interface DevRequest {
  id: string;
  prompt: string;
  title: string;
  risk: DevRisk;
  classification: DevClassification;
  /** Modules/files the plan expects to touch (advisory, for review). */
  affectedPaths: string[];
  steps: DevPlanStep[];
  impact: DevImpact;
  status: DevRequestStatus;
  createdBy: string;
  createdAt: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  /** Base commit recorded for rollback traceability. */
  baseCommit?: string | null;
  decisionNote?: string | null;
}

interface SettingsQuery extends PromiseLike<{ data: { value?: unknown } | null; error: unknown }> {
  eq(column: string, value: string): SettingsQuery;
  maybeSingle(): Promise<{ data: { value?: unknown } | null; error: unknown }>;
}

export interface DevRequestDb {
  from(table: string): {
    select(columns: string): SettingsQuery;
    upsert(row: Record<string, unknown>, options?: { onConflict?: string }): Promise<{ error: unknown }>;
  };
}

/** Derives a short title from the request text. */
export function deriveTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((l) => l.trim()) ?? prompt;
  return firstLine.trim().slice(0, 80);
}

/** Heuristically lists the modules the request appears to concern. */
export function inferAffectedPaths(prompt: string): string[] {
  const paths = new Set<string>();
  const map: Array<{ re: RegExp; path: string }> = [
    { re: /report|تقرير/i, path: "src/lib/reporting/" },
    { re: /sales|مبيعات|invoice|فاتورة/i, path: "src/app/sales/" },
    { re: /purchase|مشتريات/i, path: "src/app/purchases/" },
    { re: /expense|مصروف/i, path: "src/app/expenses/" },
    { re: /excel|import|export|استيراد|تصدير/i, path: "src/lib/reporting/workbook.ts" },
    { re: /dashboard|لوحة/i, path: "src/app/dashboard/" },
    { re: /settings|إعدادات/i, path: "src/app/settings/" },
    { re: /ai|مساعد|ذكاء/i, path: "src/lib/ai/" },
  ];
  for (const { re, path } of map) if (re.test(prompt)) paths.add(path);
  if (paths.size === 0) paths.add("(to be determined during review)");
  return [...paths];
}

/** Builds the ordered plan and the impact assessment for a request. */
export function planDevRequest(prompt: string, classification: DevClassification): { steps: DevPlanStep[]; impact: DevImpact; affectedPaths: string[] } {
  const affectedPaths = inferAffectedPaths(prompt);
  const steps: DevPlanStep[] = [
    { order: 1, title: "Analyse the request", detail: "Identify the exact module, screen and data involved; confirm it does not duplicate an existing feature." },
    { order: 2, title: "Scope the change", detail: `Candidate paths: ${affectedPaths.join(", ")}. Confirm the smallest change that satisfies the request.` },
    { order: 3, title: "Impact assessment", detail: "Check permissions, accounting posting path, database schema and tenant isolation before writing code." },
    { order: 4, title: "Implement on an isolated branch", detail: "Prepare the change as a patch on a dedicated branch. The AI does not run git or shell; a human applies the patch." },
    { order: 5, title: "Run the gates", detail: "test:core, typecheck, lint, build — record real results, no claims without evidence." },
    { order: 6, title: "Review the diff", detail: "Show changed files, the diff and test output to the approver." },
    { order: 7, title: "Approve", detail: classification.risk === "high" ? "High-risk change: requires an explicit global super-admin approval." : "Requires an explicit administrator approval." },
    { order: 8, title: "Apply and verify", detail: "A human commits on the isolated branch; deployment is a separate, explicitly approved step." },
  ];
  const impact: DevImpact = {
    permissions: classification.risk === "high" ? "Touches a sensitive area (auth/RLS/tenant). Any permission change must be reviewed by a super admin." : "No permission change expected; verify no new module is exposed.",
    accounting: "Must not add a second posting path. All financial writes stay on the existing guarded service.",
    database: "No schema change unless explicitly approved; migrations are human-applied and never by the AI.",
    tests: "Add or extend a real-path test for the change; the request is not done until the gates pass.",
  };
  return { steps, impact, affectedPaths };
}

/** Creates a pending request. Pure: the caller persists the result. */
export function createDevRequest(prompt: string, createdBy: string, now = new Date(), baseCommit: string | null = null): DevRequest {
  const clean = prompt.trim().slice(0, MAX_PROMPT);
  const classification = classifyDevRequest(clean);
  const { steps, impact, affectedPaths } = planDevRequest(clean, classification);
  return {
    id: `dev_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    prompt: clean,
    title: deriveTitle(clean),
    risk: classification.risk,
    classification,
    affectedPaths,
    steps,
    impact,
    status: "pending_approval",
    createdBy,
    createdAt: now.toISOString(),
    approvedBy: null,
    approvedAt: null,
    baseCommit,
    decisionNote: null,
  };
}

/**
 * Whether the given role may approve a request of this risk. High risk requires
 * a global super admin; everything else an administrator.
 */
export function canApprove(risk: DevRisk, approverIsSuperAdmin: boolean, approverIsAdmin: boolean): boolean {
  if (risk === "high") return approverIsSuperAdmin;
  return approverIsAdmin;
}

/** Applies an approval decision. Pure: the caller persists the result. */
export function decideDevRequest(
  request: DevRequest,
  decision: "approve" | "reject",
  approver: { email: string; isSuperAdmin: boolean; isAdmin: boolean },
  note: string | null = null,
  now = new Date(),
): DevRequest {
  if (request.status !== "pending_approval") {
    throw Object.assign(new Error(`Request already ${request.status}`), { status: 409 });
  }
  if (decision === "approve" && !canApprove(request.risk, approver.isSuperAdmin, approver.isAdmin)) {
    throw Object.assign(new Error("Not authorized to approve this request"), { status: 403 });
  }
  return {
    ...request,
    status: decision === "approve" ? "approved" : "rejected",
    approvedBy: approver.email,
    approvedAt: now.toISOString(),
    decisionNote: note,
  };
}

/**
 * Renders a reviewable patch artifact. This is a proposal for a human to apply,
 * never something the assistant writes or executes. It also refuses to include
 * any human-only path, so an approved request can never smuggle in an auth or
 * migration change.
 */
export function buildPatchArtifact(request: DevRequest): string {
  const offending = request.affectedPaths.filter((p) => isForbiddenPath(p));
  if (offending.length > 0) {
    throw Object.assign(new Error(`Change targets a human-only path: ${offending.join(", ")}`), { status: 403 });
  }
  return [
    `# SPEED ERP — development request ${request.id}`,
    `# title: ${request.title}`,
    `# risk: ${request.risk}`,
    `# status: ${request.status}`,
    `# base-commit: ${request.baseCommit ?? "(unknown)"}`,
    `# NOTE: review-only artifact. A human applies this on a branch; the AI never does.`,
    "",
    ...request.steps.map((s) => `# step ${s.order}: ${s.title} — ${s.detail}`),
    "",
    "# suggested commit message:",
    `#   ${request.title}`,
    "",
    "# rollback: do not apply, or revert the human commit on the branch.",
  ].join("\n");
}

/** Normalises a stored value into a list of requests. */
export function sanitizeRequests(raw: unknown): DevRequest[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw && Array.isArray((raw as { requests?: unknown }).requests)
      ? (raw as { requests: unknown[] }).requests
      : [];
  return (list as DevRequest[]).filter((r) => r && typeof r.id === "string").slice(0, MAX_REQUESTS);
}

export async function loadDevRequests(db: DevRequestDb, tenantId: string | null): Promise<DevRequest[]> {
  let query = db.from("settings").select("value").eq("key", DEV_REQUESTS_KEY);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { data, error } = await query.maybeSingle();
  if (error || !data?.value) return [];
  return sanitizeRequests(data.value);
}

export async function saveDevRequests(db: DevRequestDb, tenantId: string | null, requests: DevRequest[]): Promise<void> {
  const row: Record<string, unknown> = {
    key: DEV_REQUESTS_KEY,
    value: requests.slice(0, MAX_REQUESTS),
    updated_at: new Date().toISOString(),
  };
  if (tenantId) row.tenant_id = tenantId;
  // Match the canonical settings conflict target so tenants do not overwrite
  // each other's request lists.
  const { error } = await db.from("settings").upsert(row, { onConflict: "tenant_id,key" });
  if (error) throw error;
}

/** Appends or replaces a request and persists the list. */
export async function persistDevRequest(db: DevRequestDb, tenantId: string | null, request: DevRequest): Promise<DevRequest[]> {
  const existing = await loadDevRequests(db, tenantId);
  const next = [request, ...existing.filter((r) => r.id !== request.id)].slice(0, MAX_REQUESTS);
  await saveDevRequests(db, tenantId, next);
  return next;
}
