"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Coins,
  Eye,
  EyeOff,
  Gauge,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react"

/**
 * The AI Control Center (Super Admin).
 *
 * This is the operator's single screen for making AI work across the platform:
 * pick a provider, paste a key, press Save — the change is live on the next
 * request, with no restart and no source edit.
 *
 * Security rules the UI obeys (the server enforces them independently):
 *   - the API key is write-only: it is never fetched back, only a mask is shown;
 *   - "Test Connection" performs a REAL provider call and reports its result;
 *   - a key is never rendered into the DOM, a URL or local storage.
 *
 * The component talks only to `/api/super-admin/ai/settings`; it sends no
 * `tenant_id`, `role` or key back to the server except when the operator is
 * deliberately saving or testing one.
 */

type AiTaskKind = "analysis" | "assistant" | "report" | "repair" | "development"

interface PublicSettings {
  enabled: boolean
  preset: string
  providerDisplayName: string
  adapter: string
  baseUrl: string | null
  effectiveBaseUrl: string | null
  defaultModel: string
  models: Partial<Record<AiTaskKind, string>>
  hasApiKey: boolean
  apiKeyMask: string | null
  configuredPresets: string[]
  allowFinancialWrites: boolean
  allowedOperations: string[]
  limits: {
    perCompanyDailyTokens: number | null
    dailyTokens: number | null
    monthlyTokens: number | null
    dailyCostUsd: number | null
    monthlyCostUsd: number | null
  }
  lastTest: {
    at: string
    ok: boolean
    preset: string
    model: string | null
    latencyMs: number | null
    errorSanitized: string | null
    replyChars: number | null
  } | null
  updatedAt: string | null
  updatedBy: string | null
  encryptionConfigured: boolean
  encryptionSetupMessage: string | null
}

interface PresetInfo {
  id: string
  displayName: string
  adapter: string
  baseUrl: string | null
  defaultModel: string
  models: string[]
  keyHintEn: string
  keyHintAr: string
  openAiCompatible: boolean
}

interface UsageTotals {
  requests: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUsd: number
  degraded: number
  failed: number
}

interface UsageSummary {
  today: UsageTotals
  month: UsageTotals
  allTime: UsageTotals
  perCompany: Array<UsageTotals & { tenantId: string | null }>
  lastRequestAt: string | null
}

interface Payload {
  settings: PublicSettings
  presets: PresetInfo[]
  operations: string[]
  tasks: AiTaskKind[]
  usage: UsageSummary
  financialWritesAvailable: boolean
  financialWritesReason: string
}

type Tab = "provider" | "models" | "limits" | "usage"

const OPERATION_LABELS: Record<string, { ar: string; en: string }> = {
  assistant_chat: { ar: "المحادثة المساعدة", en: "Assistant chat" },
  business_analysis: { ar: "تحليل الأعمال", en: "Business analysis" },
  fleet_analysis: { ar: "تحليل الأسطول", en: "Fleet analysis" },
  booking_questions: { ar: "أسئلة الحجوزات", en: "Booking questions" },
  financial_summary: { ar: "الملخص المالي", en: "Financial summary" },
  operational_recommendations: { ar: "توصيات تشغيلية", en: "Operational recommendations" },
  report_builder: { ar: "بناء التقارير", en: "Report builder" },
  data_diagnostics: { ar: "تشخيص البيانات", en: "Data diagnostics" },
}

const TASK_LABELS: Record<AiTaskKind, { ar: string; en: string }> = {
  analysis: { ar: "التحليل", en: "Analysis" },
  assistant: { ar: "المساعد", en: "Assistant" },
  report: { ar: "التقارير", en: "Reports" },
  repair: { ar: "الإصلاح", en: "Repair" },
  development: { ar: "التطوير", en: "Development" },
}

export default function AiControlCenter({ isRTL, t }: { isRTL: boolean; t: (ar: string, en: string) => string }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [payload, setPayload] = useState<Payload | null>(null)
  const [tab, setTab] = useState<Tab>("provider")

  // Draft state (only sent when the operator presses Save/Test).
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [preset, setPreset] = useState("openrouter")
  const [baseUrl, setBaseUrl] = useState("")
  const [defaultModel, setDefaultModel] = useState("")
  const [enabled, setEnabled] = useState(false)
  const [models, setModels] = useState<Partial<Record<AiTaskKind, string>>>({})
  const [operations, setOperations] = useState<string[]>([])
  const [limits, setLimits] = useState<PublicSettings["limits"]>({
    perCompanyDailyTokens: null,
    dailyTokens: null,
    monthlyTokens: null,
    dailyCostUsd: null,
    monthlyCostUsd: null,
  })
  const [testResult, setTestResult] = useState<{
    ok: boolean
    latencyMs?: number
    model?: string
    provider?: string
    replyPreview?: string
    replyChars?: number
    error?: string | null
    rateLimited?: boolean
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/super-admin/ai/settings", { cache: "no-store" })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        setError(json?.error ?? t("تعذر تحميل إعدادات الذكاء الاصطناعي.", "Could not load the AI configuration."))
        return
      }
      const data = json as Payload
      setPayload(data)
      const s = data.settings
      setPreset(s.preset)
      setBaseUrl(s.baseUrl ?? "")
      setDefaultModel(s.defaultModel ?? "")
      setEnabled(s.enabled)
      setModels(s.models ?? {})
      setOperations(s.allowedOperations ?? [])
      setLimits(s.limits)
      setApiKey("")
    } catch {
      setError(t("تعذر الاتصال بالخادم.", "Could not reach the server."))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const activePreset = useMemo(
    () => payload?.presets.find((p) => p.id === preset) ?? null,
    [payload, preset],
  )

  const save = useCallback(
    async (extra: Record<string, unknown> = {}) => {
      setSaving(true)
      setError(null)
      setNotice(null)
      try {
        const body: Record<string, unknown> = {
          preset,
          enabled,
          baseUrl: baseUrl.trim() || null,
          defaultModel: defaultModel.trim(),
          models,
          allowedOperations: operations,
          limits,
          ...extra,
        }
        if (apiKey.trim()) body.apiKey = apiKey.trim()

        const res = await fetch("/api/super-admin/ai/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok) {
          setError(json?.error ?? t("تعذر الحفظ.", "Could not save."))
          return
        }
        setApiKey("")
        setNotice(
          extra.revokeKey === true
            ? t("تم حذف المفتاح.", "The key was removed.")
            : t("تم الحفظ. الإعدادات فعّالة فورًا.", "Saved. The configuration is live immediately."),
        )
        await load()
      } catch {
        setError(t("تعذر الاتصال بالخادم.", "Could not reach the server."))
      } finally {
        setSaving(false)
      }
    },
    [preset, enabled, baseUrl, defaultModel, models, operations, limits, apiKey, load, t],
  )

  const testConnection = useCallback(async () => {
    setTesting(true)
    setError(null)
    setNotice(null)
    setTestResult(null)
    try {
      const body: Record<string, unknown> = { op: "test", preset, model: defaultModel.trim() || undefined }
      // A key typed but not yet saved is tested WITHOUT persisting it.
      if (apiKey.trim()) body.apiKey = apiKey.trim()
      if (baseUrl.trim()) body.baseUrl = baseUrl.trim()

      const res = await fetch("/api/super-admin/ai/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok && !json?.ok) {
        setTestResult({ ok: false, error: json?.error ?? t("فشل الاختبار.", "The test failed.") })
      } else {
        setTestResult({
          ok: json?.ok === true,
          latencyMs: json?.latencyMs,
          model: json?.model,
          provider: json?.provider,
          replyPreview: json?.replyPreview,
          replyChars: json?.replyChars,
          error: json?.error ?? null,
          rateLimited: json?.rateLimited === true,
        })
      }
    } catch {
      setTestResult({ ok: false, error: t("تعذر الاتصال بالخادم.", "Could not reach the server.") })
    } finally {
      setTesting(false)
    }
  }, [preset, defaultModel, apiKey, baseUrl, t])

  if (loading && !payload) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-red-500" />
      </div>
    )
  }

  if (!payload) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-6 text-center text-sm text-red-300">
        {error ?? t("لا تتوفر بيانات.", "No data available.")}
      </div>
    )
  }

  const s = payload.settings
  const tabs: Array<{ id: Tab; ar: string; en: string; icon: typeof Bot }> = [
    { id: "provider", ar: "المزوّد والمفتاح", en: "Provider & key", icon: KeyRound },
    { id: "models", ar: "النماذج والقدرات", en: "Models & capabilities", icon: Bot },
    { id: "limits", ar: "الحدود والتحكم", en: "Limits & control", icon: Gauge },
    { id: "usage", ar: "الاستخدام والتكلفة", en: "Usage & cost", icon: Coins },
  ]

  return (
    <div className="space-y-6">
      {/* Status strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatusTile
          label={t("حالة الذكاء الاصطناعي", "AI status")}
          value={s.enabled ? t("مفعّل", "Enabled") : t("معطّل", "Disabled")}
          ok={s.enabled}
          icon={s.enabled ? CheckCircle2 : XCircle}
        />
        <StatusTile
          label={t("المفتاح", "API key")}
          value={s.hasApiKey ? (s.apiKeyMask ?? t("مُهيأ", "Configured")) : t("غير مُهيأ", "Not configured")}
          ok={s.hasApiKey}
          icon={KeyRound}
        />
        <StatusTile
          label={t("آخر اختبار اتصال", "Last connection test")}
          value={s.lastTest ? (s.lastTest.ok ? t("ناجح", "Passed") : t("فشل", "Failed")) : t("لم يُختبر", "Not tested")}
          ok={s.lastTest?.ok === true}
          icon={Plug}
        />
        <StatusTile
          label={t("استهلاك اليوم", "Today's usage")}
          value={formatTokens(payload.usage.today.totalTokens)}
          ok
          icon={Gauge}
        />
      </div>

      {!s.encryptionConfigured && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400" />
          <div className="text-sm text-amber-200">
            <p className="font-bold">{t("تشفير المفاتيح غير مُهيأ", "Secret encryption is not configured")}</p>
            <p className="mt-1 text-amber-300/90">{s.encryptionSetupMessage}</p>
          </div>
        </div>
      )}

      {error && (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>
      )}
      {notice && (
        <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</p>
      )}

      {/* Sub-tabs */}
      <nav className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`flex flex-shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition ${
              tab === item.id ? "bg-white/10 text-white" : "border border-white/10 text-slate-300 hover:bg-white/5"
            }`}
          >
            <item.icon className="h-4 w-4" />
            {t(item.ar, item.en)}
          </button>
        ))}
      </nav>

      {tab === "provider" && (
        <div className="space-y-5">
          <Section title={t("المزوّد", "Provider")} icon={Bot}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("المزوّد", "Provider")}>
                <select
                  value={preset}
                  onChange={(e) => {
                    const next = e.target.value
                    setPreset(next)
                    const info = payload.presets.find((p) => p.id === next)
                    if (info) {
                      setDefaultModel(info.defaultModel)
                      setBaseUrl(info.baseUrl ?? "")
                    }
                    setTestResult(null)
                  }}
                  className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                >
                  {payload.presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label={t("النموذج الافتراضي", "Default model")}>
                <input
                  list="ai-model-suggestions"
                  value={defaultModel}
                  onChange={(e) => setDefaultModel(e.target.value)}
                  placeholder={activePreset?.defaultModel || "model-id"}
                  className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                />
                <datalist id="ai-model-suggestions">
                  {(activePreset?.models ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </Field>

              {activePreset?.openAiCompatible && (
                <Field label={t("عنوان الخدمة (Base URL)", "Base URL")} span>
                  <input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={activePreset.baseUrl ?? "https://…/v1"}
                    className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                  />
                </Field>
              )}
            </div>
          </Section>

          <Section title={t("مفتاح API", "API key")} icon={KeyRound}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Field label={t("المفتاح (لا يُعرض بعد الحفظ)", "Key (never shown after saving)")}>
                  <div className="relative">
                    <input
                      type={showKey ? "text" : "password"}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder={s.hasApiKey ? t("مُهيأ — اتركه فارغًا للإبقاء", "Configured — leave blank to keep") : ""}
                      className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 pe-10 text-sm text-white"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      aria-label={t("إظهار/إخفاء", "Show/hide")}
                      className="absolute end-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </Field>
                {activePreset && (
                  <p className="mt-1.5 text-[11px] text-slate-500">
                    {isRTL ? activePreset.keyHintAr : activePreset.keyHintEn}
                  </p>
                )}
              </div>
              <button
                onClick={() => void save()}
                disabled={saving || (!apiKey.trim() && !s.hasApiKey)}
                className="flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {t("حفظ المفتاح", "Save key")}
              </button>
              {s.hasApiKey && (
                <button
                  onClick={() => void save({ revokeKey: true })}
                  disabled={saving}
                  className="flex items-center justify-center gap-2 rounded-lg border border-red-500/40 px-4 py-2 text-sm font-bold text-red-300 transition hover:bg-red-500/10 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  {t("حذف المفتاح", "Remove key")}
                </button>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={() => void testConnection()}
                disabled={testing || (!apiKey.trim() && !s.hasApiKey)}
                className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm font-bold text-slate-200 transition hover:bg-white/5 disabled:opacity-50"
              >
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                {t("اختبار الاتصال", "Test connection")}
              </button>
              <button
                onClick={() => void save({ enabled: !enabled })}
                disabled={saving}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white transition disabled:opacity-50 ${
                  enabled ? "bg-slate-700 hover:bg-slate-600" : "bg-emerald-600 hover:bg-emerald-700"
                }`}
              >
                {enabled ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                {enabled ? t("إيقاف الذكاء الاصطناعي", "Disable AI") : t("تفعيل الذكاء الاصطناعي", "Enable AI")}
              </button>
            </div>

            {testResult && (
              <div
                className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
                  testResult.ok
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                    : "border-red-500/30 bg-red-500/10 text-red-200"
                }`}
              >
                {testResult.ok ? (
                  <div className="space-y-1">
                    <p className="flex items-center gap-2 font-bold">
                      <CheckCircle2 className="h-4 w-4" />
                      {t("نجح الاتصال", "Connection succeeded")}
                    </p>
                    <p className="text-emerald-300/90">
                      {testResult.provider} · {testResult.model} · {testResult.latencyMs}
                      {t("ملّي ثانية", "ms")} · {t("رد", "reply")}: {testResult.replyChars} {t("حرف", "chars")}
                      {testResult.replyPreview ? ` ("${testResult.replyPreview}")` : ""}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p className="flex items-center gap-2 font-bold">
                      <AlertTriangle className="h-4 w-4" />
                      {t("فشل الاتصال", "Connection failed")}
                    </p>
                    <p className="text-red-300/90">{testResult.error}</p>
                    {testResult.rateLimited && (
                      <p className="text-amber-300/90">
                        {t(
                          "المزود المجاني مشغول حاليًا. أعد المحاولة بعد قليل أو اختر نموذجًا آخر.",
                          "The free provider is busy right now. Retry shortly or choose another model.",
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
              <ShieldCheck className="h-3.5 w-3.5" />
              {t(
                "المفتاح يُخزَّن مشفّرًا على الخادم ولا يُعاد إلى المتصفح. الاختبار يُجري نداءً حقيقيًا للمزوّد.",
                "The key is stored encrypted server-side and never returned to the browser. The test performs a real provider call.",
              )}
            </p>
          </Section>
        </div>
      )}

      {tab === "models" && (
        <div className="space-y-5">
          <Section title={t("نموذج لكل مهمة", "Model per task")} icon={Bot}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {payload.tasks.map((task) => (
                <Field key={task} label={isRTL ? TASK_LABELS[task].ar : TASK_LABELS[task].en}>
                  <input
                    value={models[task] ?? ""}
                    onChange={(e) => setModels((prev) => ({ ...prev, [task]: e.target.value }))}
                    placeholder={defaultModel}
                    className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
                  />
                </Field>
              ))}
            </div>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="mt-4 flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t("حفظ النماذج", "Save models")}
            </button>
          </Section>

          <Section title={t("العمليات المسموح بها", "Allowed operations")} icon={ShieldCheck}>
            <div className="grid gap-2 sm:grid-cols-2">
              {payload.operations.map((op) => {
                const on = operations.includes(op)
                const label = OPERATION_LABELS[op] ?? { ar: op, en: op }
                return (
                  <button
                    key={op}
                    onClick={() =>
                      setOperations((prev) => (prev.includes(op) ? prev.filter((o) => o !== op) : [...prev, op]))
                    }
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                      on
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                        : "border-white/10 text-slate-400 hover:bg-white/5"
                    }`}
                  >
                    {isRTL ? label.ar : label.en}
                    {on ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                  </button>
                )
              })}
            </div>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="mt-4 flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t("حفظ القدرات", "Save capabilities")}
            </button>
          </Section>

          <Section title={t("الكتابة المالية", "Financial writes")} icon={ShieldAlert}>
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400" />
              <div className="text-sm text-amber-200">
                <p className="font-bold">
                  {payload.financialWritesAvailable
                    ? t("متاحة", "Available")
                    : t("معطّلة (مقصود)", "Disabled (deliberate)")}
                </p>
                <p className="mt-1 text-amber-300/90">{payload.financialWritesReason}</p>
              </div>
            </div>
          </Section>
        </div>
      )}

      {tab === "limits" && (
        <Section title={t("الحدود", "Limits")} icon={Gauge}>
          <p className="mb-4 text-xs text-slate-400">
            {t(
              "اترك الحقل فارغًا لعدم وجود حد. تُطبَّق الحدود قبل إرسال الطلب للمزوّد.",
              "Leave a field empty for no limit. Limits are enforced before the request reaches the provider.",
            )}
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <LimitField
              label={t("حد التوكنات اليومي للمنصة", "Platform daily token limit")}
              value={limits.dailyTokens}
              onChange={(v) => setLimits((p) => ({ ...p, dailyTokens: v }))}
            />
            <LimitField
              label={t("حد التوكنات الشهري للمنصة", "Platform monthly token limit")}
              value={limits.monthlyTokens}
              onChange={(v) => setLimits((p) => ({ ...p, monthlyTokens: v }))}
            />
            <LimitField
              label={t("حد التوكنات اليومي لكل شركة", "Per-company daily token limit")}
              value={limits.perCompanyDailyTokens}
              onChange={(v) => setLimits((p) => ({ ...p, perCompanyDailyTokens: v }))}
            />
            <LimitField
              label={t("حد التكلفة اليومي (دولار)", "Daily cost limit (USD)")}
              value={limits.dailyCostUsd}
              onChange={(v) => setLimits((p) => ({ ...p, dailyCostUsd: v }))}
              step="0.01"
            />
            <LimitField
              label={t("حد التكلفة الشهري (دولار)", "Monthly cost limit (USD)")}
              value={limits.monthlyCostUsd}
              onChange={(v) => setLimits((p) => ({ ...p, monthlyCostUsd: v }))}
              step="0.01"
            />
          </div>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="mt-4 flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t("حفظ الحدود", "Save limits")}
          </button>
        </Section>
      )}

      {tab === "usage" && (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">
              {t("الاستخدام والتكلفة", "Usage & cost")}
            </h3>
            <button
              onClick={() => void load()}
              className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              {t("تحديث", "Refresh")}
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <UsageCard label={t("اليوم", "Today")} totals={payload.usage.today} t={t} />
            <UsageCard label={t("هذا الشهر", "This month")} totals={payload.usage.month} t={t} />
            <UsageCard label={t("الإجمالي", "All time")} totals={payload.usage.allTime} t={t} />
          </div>

          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-slate-400">
                <tr>
                  <th className="px-4 py-3 text-start">{t("الشركة", "Company")}</th>
                  <th className="px-4 py-3 text-start">{t("طلبات", "Requests")}</th>
                  <th className="px-4 py-3 text-start">{t("توكنات", "Tokens")}</th>
                  <th className="px-4 py-3 text-start">{t("التكلفة (USD)", "Cost (USD)")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {payload.usage.perCompany.map((c) => (
                  <tr key={c.tenantId ?? "null"}>
                    <td className="px-4 py-3 text-slate-300">
                      {c.tenantId ? `${c.tenantId.slice(0, 8)}…` : t("بدون شركة", "No company")}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-300">{c.requests}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-300">{formatTokens(c.totalTokens)}</td>
                    <td className="px-4 py-3 tabular-nums text-slate-300">{formatCost(c.estimatedCostUsd)}</td>
                  </tr>
                ))}
                {payload.usage.perCompany.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-sm text-slate-500">
                      {t("لا يوجد استخدام بعد.", "No usage yet.")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-slate-500">
            {t(
              "تُحتسب الأرقام من سجل التدقيق نفسه الذي يكتبه كل طلب ذكاء اصطناعي؛ لا يوجد مخزن منفصل.",
              "Figures are aggregated from the same audit trail every AI request writes; there is no separate store.",
            )}
          </p>
        </div>
      )}
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.0000"
  if (usd < 0.01) return `$${usd.toFixed(6)}`
  return `$${usd.toFixed(4)}`
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: typeof Bot
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-slate-900 p-5">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-slate-400">
        <Icon className="h-4 w-4 text-red-400" />
        {title}
      </h3>
      {children}
    </section>
  )
}

function Field({ label, children, span }: { label: string; children: React.ReactNode; span?: boolean }) {
  return (
    <label className={`block space-y-1.5 text-sm ${span ? "sm:col-span-2" : ""}`}>
      <span className="font-semibold text-slate-300">{label}</span>
      {children}
    </label>
  )
}

function LimitField({
  label,
  value,
  onChange,
  step,
}: {
  label: string
  value: number | null
  onChange: (v: number | null) => void
  step?: string
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        min={0}
        step={step ?? "1"}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        placeholder="∞"
        className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white"
      />
    </Field>
  )
}

function StatusTile({
  label,
  value,
  ok,
  icon: Icon,
}: {
  label: string
  value: string
  ok: boolean
  icon: typeof Bot
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-gradient-to-br from-slate-900 to-slate-900/40 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 sm:text-xs">{label}</span>
        <Icon className={`h-4 w-4 flex-shrink-0 ${ok ? "text-emerald-400" : "text-slate-500"}`} />
      </div>
      <p className="mt-2 truncate text-base font-black text-white sm:text-lg">{value}</p>
    </div>
  )
}

function UsageCard({ label, totals, t }: { label: string; totals: UsageTotals; t: (a: string, e: string) => string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900 p-4">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-black tabular-nums text-white">{formatTokens(totals.totalTokens)}</p>
      <p className="mt-1 text-xs text-slate-400">
        {totals.requests} {t("طلب", "requests")} · {formatCost(totals.estimatedCostUsd)}
      </p>
      {totals.failed > 0 && (
        <p className="mt-1 text-[11px] text-amber-400">
          {totals.failed} {t("فاشل", "failed")}
        </p>
      )}
    </div>
  )
}
