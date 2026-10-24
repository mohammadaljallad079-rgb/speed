"use client"

import { useEffect, useRef, useState } from "react"

import { useLanguage } from "@/lib/LanguageContext"
import {
  createRepairController,
  isVerifiedSuccess,
  type RepairController,
  type RepairState,
} from "@/lib/ai/repair-client"
import {
  Bot,
  Brain,
  CheckCircle2,
  Loader2,
  Send,
  ShieldAlert,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react"

/**
 * Company-facing AI Assistant.
 *
 * Two capabilities, both backed by the existing, already-built AI endpoints —
 * nothing here re-implements the AI:
 *   1. Ask (read/analysis only)  → POST /api/ai/assistant
 *   2. Safe repair workflow      → POST /api/ai/repairs (catalog/propose/execute/history)
 *
 * The repair flow is "propose → preview → approve → execute → verify", driven by
 * the shared `repair-client` controller so the company console and the existing
 * AI Control page use one implementation. Approval, permission and the plan
 * fingerprint are re-checked server-side; the client can never execute an action
 * its role does not permit, and the AI never applies a change on its own.
 */
export default function AiAssistantPanel({ screen }: { screen?: string }) {
  const { isRTL } = useLanguage()

  const t = (ar: string, en: string) => (isRTL ? ar : en)

  // ---- Ask (read-only) ------------------------------------------------------
  const [question, setQuestion] = useState("")
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState<string | null>(null)
  const [sources, setSources] = useState<Array<{ label: string; value: string | number | null }>>([])
  const [askError, setAskError] = useState<string | null>(null)

  // ---- Repair workflow ------------------------------------------------------
  const [repair, setRepair] = useState<RepairState | null>(null)
  const [prompt, setPrompt] = useState("")
  const controllerRef = useRef<RepairController | null>(null)

  const getController = (): RepairController => {
    if (!controllerRef.current) {
      controllerRef.current = createRepairController(async (input, init) => fetch(input, init))
      controllerRef.current.subscribe((s) => setRepair(s))
      setRepair(controllerRef.current.getState())
    }
    return controllerRef.current
  }

  useEffect(() => {
    const c = getController()
    void c.loadActions()
    void c.loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ask = async () => {
    if (!question.trim() || asking) return
    setAsking(true)
    setAskError(null)
    setAnswer(null)
    try {
      const res = await fetch("/api/ai/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: question, screen: screen ?? "dashboard" }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || t("تعذر الحصول على رد.", "Could not get an answer."))
      setAnswer(json.answer)
      setSources(json.sources ?? [])
    } catch (e) {
      setAskError((e as Error).message)
    } finally {
      setAsking(false)
    }
  }

  const proposal = repair?.proposal ?? null
  const result = repair?.result ?? null

  return (
    <section id="ai-assistant" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-cyan-50">
          <Bot className="h-5 w-5 text-cyan-600" />
        </span>
        <div>
          <h2 className="text-lg font-black text-slate-900">{t("المساعد الذكي", "AI Assistant")}</h2>
          <p className="text-sm text-slate-500">
            {t(
              "اسأل عن أرقامك، أو اطلب إصلاحًا آمنًا مع معاينة وموافقة قبل التنفيذ.",
              "Ask about your figures, or request a safe repair with preview and approval before it runs.",
            )}
          </p>
        </div>
      </div>

      {/* Ask */}
      <div className="mt-5 rounded-xl border border-slate-100 bg-slate-50 p-4">
        <label className="text-sm font-bold text-slate-700">{t("اسأل بالعربية", "Ask in Arabic")}</label>
        <div className="mt-2 flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void ask()
            }}
            placeholder={t("مثال: ما إجمالي إيرادات هذا الشهر؟", "e.g. What is this month's total revenue?")}
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-cyan-500"
          />
          <button
            onClick={() => void ask()}
            disabled={asking}
            className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-bold text-white hover:bg-cyan-700 disabled:opacity-60"
          >
            {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {t("اسأل", "Ask")}
          </button>
        </div>
        {askError && <p className="mt-3 text-sm text-rose-600">{askError}</p>}
        {answer && (
          <div className="mt-3 rounded-lg border border-cyan-100 bg-white p-3">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-cyan-600">
              <Sparkles className="h-3.5 w-3.5" />
              {t("التحليل", "Analysis")}
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{answer}</p>
            {sources.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3">
                {sources.map((s, i) => (
                  <li key={i} className="flex items-center justify-between text-xs text-slate-500">
                    <span>{s.label}</span>
                    <span className="font-semibold text-slate-700">{String(s.value ?? "—")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Repair workflow */}
      <div className="mt-5 rounded-xl border border-slate-100 p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-slate-700">
          <Wrench className="h-4 w-4 text-slate-500" />
          {t("إصلاح آمن (معاينة ثم موافقة)", "Safe repair (preview, then approve)")}
        </p>

        <div className="mt-2 flex gap-2">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("صف المشكلة أو الطلب...", "Describe the problem or request...")}
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-cyan-500"
          />
          <button
            onClick={() => {
              getController().setPrompt(prompt)
              void getController().propose(prompt)
            }}
            disabled={!prompt.trim() || Boolean(repair?.busy)}
            className="flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {repair?.busy && repair.phase === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Brain className="h-4 w-4" />
            )}
            {t("تحليل", "Analyze")}
          </button>
        </div>

        {repair?.error && (
          <p className="mt-3 flex items-center gap-2 text-sm text-rose-600">
            <XCircle className="h-4 w-4" />
            {isRTL ? repair.error.ar : repair.error.en}
          </p>
        )}

        {proposal && (
          <div className="mt-3 rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-slate-800">{isRTL ? proposal.titleAr : proposal.titleEn}</p>
              {proposal.requiresApproval && (
                <span className="flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700">
                  <ShieldAlert className="h-3 w-3" />
                  {t("يتطلب موافقة", "needs approval")}
                </span>
              )}
            </div>

            {proposal.preview && (
              <div className="mt-3">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                  {t("معاينة التغييرات", "Preview of changes")}
                </p>
                <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-200" dir="ltr">
                  {proposal.preview.diff.length ? proposal.preview.diff.join("\n") : JSON.stringify(proposal.preview.after, null, 2)}
                </pre>
              </div>
            )}

            <div className="mt-3 flex gap-2">
              {proposal.requiresApproval && !repair?.approved && (
                <button
                  onClick={() => getController().approve()}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700"
                >
                  {t("موافقة", "Approve")}
                </button>
              )}
              <button
                onClick={() => void getController().execute()}
                disabled={Boolean(repair?.busy) || (proposal.requiresApproval && !repair?.approved)}
                className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-bold text-white hover:bg-cyan-700 disabled:opacity-60"
              >
                {repair?.busy && repair.phase === "executing" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                {t("تنفيذ", "Execute")}
              </button>
              <button
                onClick={() => getController().reset()}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"
              >
                {t("إلغاء", "Cancel")}
              </button>
            </div>
          </div>
        )}

        {result && (
          <div
            className={`mt-3 rounded-lg border p-3 ${
              isVerifiedSuccess(result) ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"
            }`}
          >
            <p className="flex items-center gap-2 text-sm font-bold">
              {isVerifiedSuccess(result) ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <XCircle className="h-4 w-4 text-rose-600" />
              )}
              {isVerifiedSuccess(result)
                ? t("تم التنفيذ والتحقق", "Executed and verified")
                : t("لم يكتمل التنفيذ", "Execution did not complete")}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {isRTL ? result.verification.detailAr : result.verification.detailEn}
            </p>
          </div>
        )}

        {repair && repair.history.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
              {t("سجل طلبات شركتك", "Your company's request history")}
            </p>
            <ul className="mt-2 divide-y divide-slate-100">
              {repair.history.slice(0, 8).map((h) => (
                <li key={h.proposalId} className="flex items-center justify-between py-2 text-xs">
                  <span className="text-slate-600">{h.action}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-slate-400">{h.status}</span>
                    {h.verificationOk ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-slate-400" />
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
