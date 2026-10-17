/**
 * AI repair client (Execution 22, Phase R1 UI integration).
 *
 * Pure TypeScript with no React import, so the whole UI↔API flow is unit
 * testable. The AI Control panel drives this controller; the controller only
 * ever calls `/api/ai/repairs` and never decides a result on its own — success
 * is shown only from a trusted execution response whose verification passed.
 */

export interface RepairError {
  code: string;
  ar: string;
  en: string;
}

export interface RepairActionInfo {
  id: string;
  titleAr: string;
  titleEn: string;
  modules: string[];
  effect: "read" | "settings";
  risk: string;
  requiresApproval: boolean;
  inputSchema?: { ar: string; en: string };
  descriptionAr?: string;
  descriptionEn?: string;
}

export interface RepairPreview {
  action: string;
  kind: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  diff: string[];
  dataSource: string;
  rowCount: number;
  issues?: unknown[];
}

export interface RepairProposal {
  proposalId: string;
  action: string;
  kind: string | null;
  params: { prompt?: string; name?: string; from?: string | null; to?: string | null };
  effect: "read" | "settings";
  requiresApproval: boolean;
  status: "ready" | "needs_approval" | "requires_verification" | "forbidden" | "unknown_action" | "invalid_input";
  titleAr: string;
  titleEn: string;
  preview: RepairPreview | null;
  fingerprint: string;
  contentFingerprint: string;
  expiresAt: string;
  error?: RepairError;
}

export interface RepairVerification {
  ok: boolean;
  detailAr: string;
  detailEn: string;
  dataSource?: string;
}

export interface RepairExecutionResult {
  ok: boolean;
  status: "verified" | "rejected" | "conflict" | "expired" | "forbidden" | "duplicate" | "failed";
  proposalId: string;
  action: string;
  changed: Record<string, unknown> | null;
  verification: RepairVerification;
  idempotencyKey: string;
  reference: string;
  error?: RepairError;
}

export interface RepairCandidate {
  action: string;
  kind: string;
  reasonAr: string;
  reasonEn: string;
}

export interface RepairHistoryEntry {
  proposalId: string;
  action: string;
  status: string;
  verificationOk: boolean | null;
  reference: string | null;
  changedKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export type RepairPhase = "idle" | "loading" | "proposed" | "executing" | "done" | "error";

export interface RepairState {
  phase: RepairPhase;
  actions: RepairActionInfo[];
  prompt: string;
  proposal: RepairProposal | null;
  candidates: RepairCandidate[];
  result: RepairExecutionResult | null;
  error: RepairError | null;
  history: RepairHistoryEntry[];
  /** True while a request is in flight; the UI disables its buttons on it. */
  busy: boolean;
  /** Whether the user pressed approve for this proposal. */
  approved: boolean;
}

export interface RepairResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type RepairFetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<RepairResponse>;

export function initialState(): RepairState {
  return { phase: "idle", actions: [], prompt: "", proposal: null, candidates: [], result: null, error: null, history: [], busy: false, approved: false };
}

/** Maps an HTTP status/body to a safe, bilingual error. Never leaks raw output. */
export function mapRepairError(status: number, body: unknown): RepairError {
  const b = (body ?? {}) as { code?: string; error?: string };
  const code = typeof b.code === "string" ? b.code : "";
  const known: Record<string, RepairError> = {
    forbidden: { code: "forbidden", ar: "لا تملك صلاحية هذا الإجراء.", en: "You are not permitted to run this action." },
    plan_changed: { code: "plan_changed", ar: "تغيّرت خطة الإصلاح بعد الموافقة؛ أعد المعاينة.", en: "The repair plan changed after approval; preview again." },
    data_changed: { code: "data_changed", ar: "تغيّرت البيانات بعد المعاينة؛ أعد المعاينة.", en: "Data changed since the preview; preview again." },
    duplicate: { code: "duplicate", ar: "تم تنفيذ هذا الإجراء مسبقًا.", en: "This action was already executed." },
    expired: { code: "expired", ar: "انتهت صلاحية المعاينة؛ أعد المعاينة.", en: "The preview expired; preview again." },
    approval_required: { code: "approval_required", ar: "يتطلب هذا الإجراء موافقة صريحة.", en: "This action requires an explicit approval." },
    unknown_action: { code: "unknown_action", ar: "الإجراء غير موجود في الكتالوج.", en: "The action is not in the catalogue." },
    bad_request: { code: "bad_request", ar: "مدخلات غير صالحة.", en: "Invalid input." },
    no_action: { code: "no_action", ar: "لا يوجد إجراء مسموح لهذا الطلب.", en: "No permitted action applies to this request." },
    verification_failed: { code: "verification_failed", ar: "فشل التحقق بعد التنفيذ.", en: "Post-execution verification failed." },
    in_progress: { code: "in_progress", ar: "هذا الإجراء قيد التنفيذ بالفعل.", en: "This action is already in progress." },
    unresolved: { code: "unresolved", ar: "نتيجة التنفيذ السابق غير محسومة؛ يتطلب مراجعة بشرية.", en: "A previous execution is unresolved; human review is required." },
    key_reused: { code: "key_reused", ar: "أُعيد استخدام مفتاح منع التكرار لخطة مختلفة.", en: "The idempotency key was reused for a different plan." },
    requires_verification: { code: "requires_verification", ar: "الأدلة غير كافية لتحديد المصدر؛ حدّد الوحدة/التقرير أو الفترة.", en: "Not enough evidence to pick a source; name the module/report or period." },
  };
  if (known[code]) return known[code];
  if (status === 401) return { code: "unauthorized", ar: "يجب تسجيل الدخول.", en: "You must sign in." };
  if (status === 403) return known.forbidden;
  if (status === 409) return { code: "conflict", ar: "تعارض: أعد المعاينة والموافقة.", en: "Conflict: preview and approve again." };
  if (status >= 500) return { code: "server_error", ar: "خطأ في الخادم؛ حاول لاحقًا.", en: "Server error; try again later." };
  return { code: code || "error", ar: "فشل الطلب.", en: "The request failed." };
}

/**
 * A result is only shown as success when the execution response is ok AND its
 * verification passed. A press of "approve" alone is never success.
 */
export function isVerifiedSuccess(result: RepairExecutionResult | null): boolean {
  return Boolean(result && result.ok && result.status === "verified" && result.verification.ok);
}

/** Generates a stable idempotency key for one proposal. */
export function newIdempotencyKey(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `k_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export interface RepairController {
  getState(): RepairState;
  subscribe(listener: (s: RepairState) => void): () => void;
  setPrompt(prompt: string): void;
  loadActions(): Promise<void>;
  loadHistory(): Promise<void>;
  propose(prompt: string, action?: string): Promise<void>;
  approve(): void;
  execute(): Promise<void>;
  reset(): void;
}

/**
 * Creates the controller. `fetchImpl` is injected so tests can drive it against
 * a fake server. Concurrent calls are ignored while `busy`, so a double click
 * cannot fire two requests.
 */
export function createRepairController(fetchImpl: RepairFetch): RepairController {
  let state = initialState();
  let idempotencyKey = "";
  const listeners = new Set<(s: RepairState) => void>();

  const emit = () => {
    for (const l of listeners) l(state);
  };
  const set = (patch: Partial<RepairState>) => {
    state = { ...state, ...patch };
    emit();
  };

  const post = async (op: string, body: Record<string, unknown>) => {
    return fetchImpl(`/api/ai/repairs?op=${op}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  const controller: RepairController = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPrompt(prompt) {
      set({ prompt });
    },
    async loadActions() {
      if (state.busy) return;
      set({ busy: true, error: null });
      try {
        const res = await fetchImpl("/api/ai/repairs?op=catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const json = (await res.json()) as { actions?: RepairActionInfo[] };
        if (!res.ok) {
          set({ busy: false, phase: "error", error: mapRepairError(res.status, json) });
          return;
        }
        set({ busy: false, actions: json.actions ?? [] });
      } catch {
        set({ busy: false, phase: "error", error: mapRepairError(0, null) });
      }
    },
    async loadHistory() {
      try {
        const res = await post("history", {});
        const json = (await res.json()) as { records?: RepairHistoryEntry[] };
        if (res.ok) set({ history: json.records ?? [] });
      } catch {
        // A history read failure must never surface as an execution result.
      }
    },
    async propose(prompt, action) {
      if (state.busy) return;
      set({ busy: true, phase: "loading", error: null, proposal: null, result: null, approved: false, prompt });
      idempotencyKey = "";
      try {
        const res = await post("propose", { prompt, ...(action ? { action } : {}) });
        const json = (await res.json()) as { proposal?: RepairProposal; candidates?: RepairCandidate[] };
        if (!res.ok || !json.proposal) {
          set({ busy: false, phase: "error", error: mapRepairError(res.status, json) });
          return;
        }
        const proposal = json.proposal;
        if (proposal.status === "forbidden" || proposal.status === "unknown_action" || proposal.status === "invalid_input" || proposal.status === "requires_verification") {
          set({ busy: false, phase: "error", proposal, candidates: json.candidates ?? [], error: proposal.error ?? mapRepairError(res.status, json) });
          return;
        }
        idempotencyKey = newIdempotencyKey();
        set({ busy: false, phase: "proposed", proposal, candidates: json.candidates ?? [], result: null, error: null, approved: !proposal.requiresApproval });
      } catch {
        set({ busy: false, phase: "error", error: mapRepairError(0, null) });
      }
    },
    approve() {
      if (!state.proposal) return;
      set({ approved: true });
    },
    async execute() {
      if (state.busy || !state.proposal) return;
      if (state.proposal.requiresApproval && !state.approved) {
        set({ error: mapRepairError(0, { code: "approval_required" }) });
        return;
      }
      set({ busy: true, phase: "executing", error: null });
      try {
        const res = await post("execute", {
          proposal: state.proposal,
          approval: { approved: true, fingerprint: state.proposal.fingerprint, idempotencyKey: idempotencyKey || state.proposal.proposalId },
        });
        const json = (await res.json()) as { result?: RepairExecutionResult };
        if (!json.result) {
          set({ busy: false, phase: "error", error: mapRepairError(res.status, json) });
          return;
        }
        const result = json.result;
        set({ busy: false, phase: result.ok ? "done" : "error", result, error: result.ok ? null : result.error ?? mapRepairError(res.status, json) });
        // Refresh the audit history after any resolved execution attempt.
        await controller.loadHistory();
      } catch {
        set({ busy: false, phase: "error", error: mapRepairError(0, null) });
      }
    },
    reset() {
      idempotencyKey = "";
      set({ ...initialState() });
    },
  };

  return controller;
}
