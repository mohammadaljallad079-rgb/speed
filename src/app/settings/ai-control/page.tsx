"use client";
export const dynamic = "force-dynamic";

import { Suspense, useEffect, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { useLanguage } from "@/lib/LanguageContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Bot,
  Brain,
  CheckCircle2,
  Cpu,
  GitBranch,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";

/**
 * AI Control dashboard (administrators only).
 *
 * Manages the assistant's on/off switch, the model provider per task and the
 * fallback chain; lists the configured agents and their tools; and drives the
 * development-request workflow (create → plan → approve/reject → review
 * artifact). The API key is never displayed — the UI only learns whether one is
 * configured. The server enforces admin + settings.edit on every write.
 */

interface PublicSettings {
  provider: string;
  enabled: boolean;
  baseUrl: string | null;
  models: Record<string, string>;
  defaultModel: string | null;
  fallback: Array<{ provider: string; model?: string }>;
  hasApiKey: boolean;
  availableProviders: string[];
}

interface AgentInfo {
  id: string;
  nameEn: string;
  nameAr: string;
  task: string;
  requiresHumanReview: boolean;
  descriptionEn: string;
  descriptionAr: string;
  allowedTools: string[];
}

interface DevRequest {
  id: string;
  title: string;
  risk: string;
  status: string;
  createdBy: string;
  createdAt: string;
  affectedPaths: string[];
}

const RISK_STYLE: Record<string, string> = {
  low: "bg-emerald-100 text-emerald-700",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-rose-100 text-rose-700",
};

function AiControlContent() {
  const { isRTL } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [requests, setRequests] = useState<DevRequest[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [devPrompt, setDevPrompt] = useState("");
  const [artifact, setArtifact] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [s, d] = await Promise.all([
        fetch("/api/ai/settings"),
        fetch("/api/ai/dev-requests"),
      ]);
      const sj = await s.json();
      if (!s.ok) throw new Error(sj.error || "Failed to load AI settings");
      setSettings(sj.settings);
      setAgents(sj.agents ?? []);
      if (d.ok) {
        const dj = await d.json();
        setRequests(dj.requests ?? []);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = async (body: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSettings(json.settings);
      setApiKey("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const createRequest = async () => {
    if (!devPrompt.trim()) return;
    const res = await fetch("/api/ai/dev-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", prompt: devPrompt }),
    });
    const json = await res.json();
    if (res.ok) {
      setDevPrompt("");
      load();
    } else setError(json.error);
  };

  const decide = async (id: string, action: "approve" | "reject" | "artifact") => {
    const res = await fetch("/api/ai/dev-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id }),
    });
    const json = await res.json();
    if (!res.ok) return setError(json.error);
    if (action === "artifact") setArtifact(json.artifact);
    else load();
  };

  return (
    <DashboardLayout>
      <div className="min-h-screen bg-[#f0f2f5]" dir={isRTL ? "rtl" : "ltr"}>
        <div className="mx-auto max-w-5xl space-y-6 p-6">
          <div className="flex items-center gap-3">
            <Brain className="h-7 w-7 text-cyan-600" />
            <div>
              <h1 className="text-2xl font-black text-slate-900">
                {isRTL ? "التحكم بالذكاء الاصطناعي" : "AI Control"}
              </h1>
              <p className="text-sm text-slate-500">
                {isRTL ? "إدارة المساعد والوكلاء وطلبات التطوير" : "Manage the assistant, agents and development requests"}
              </p>
            </div>
          </div>

          {error && (
            <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</p>
          )}

          {loading ? (
            <div className="flex justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-cyan-500" />
            </div>
          ) : (
            settings && (
              <>
                <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
                  <h2 className="mb-4 flex items-center gap-2 text-sm font-black text-slate-800">
                    <Cpu className="h-4 w-4 text-cyan-600" />
                    {isRTL ? "مزوّد النموذج" : "Model provider"}
                  </h2>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="space-y-1.5 text-sm">
                      <span className="font-semibold text-slate-600">{isRTL ? "المزوّد" : "Provider"}</span>
                      <select
                        value={settings.provider}
                        onChange={(e) => patch({ provider: e.target.value })}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      >
                        {settings.availableProviders.map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1.5 text-sm">
                      <span className="font-semibold text-slate-600">
                        {isRTL ? "مفتاح API (لا يُعرض)" : "API key (never shown)"}
                      </span>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={settings.hasApiKey ? (isRTL ? "مُهيأ — اتركه فارغًا للإبقاء" : "Configured — leave blank to keep") : ""}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                      />
                    </label>
                    {settings.provider === "openai_compatible" && (
                      <label className="space-y-1.5 text-sm sm:col-span-2">
                        <span className="font-semibold text-slate-600">{isRTL ? "عنوان الخدمة الذاتية" : "Self-hosted base URL"}</span>
                        <input
                          value={settings.baseUrl ?? ""}
                          onChange={(e) => patch({ baseUrl: e.target.value })}
                          placeholder="http://localhost:11434/v1"
                          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                        />
                      </label>
                    )}
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button
                      onClick={() => patch({ apiKey })}
                      disabled={saving || !apiKey.trim()}
                      className="bg-cyan-600 text-white"
                    >
                      {isRTL ? "حفظ المفتاح" : "Save key"}
                    </Button>
                    <Button
                      onClick={() => patch({ enabled: !settings.enabled })}
                      disabled={saving}
                      variant={settings.enabled ? "outline" : "default"}
                      className={settings.enabled ? "" : "bg-emerald-600 text-white"}
                    >
                      {settings.enabled ? (isRTL ? "إيقاف المساعد" : "Disable assistant") : (isRTL ? "تفعيل المساعد" : "Enable assistant")}
                    </Button>
                    <Badge className={settings.enabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}>
                      {settings.enabled ? (isRTL ? "مُفعّل" : "Enabled") : (isRTL ? "معطّل" : "Disabled")}
                    </Badge>
                    <Badge className={settings.hasApiKey ? "bg-cyan-100 text-cyan-700" : "bg-amber-100 text-amber-700"}>
                      {settings.hasApiKey ? (isRTL ? "المفتاح مُهيأ" : "Key configured") : (isRTL ? "لا يوجد مفتاح" : "No key")}
                    </Badge>
                  </div>
                  <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {isRTL
                      ? "المفاتيح محفوظة على الخادم فقط ولا تُعاد إلى المتصفح. المزوّد المتوافق ذاتيًا لا يُفترض أنه مجاني."
                      : "Keys are stored server-side only and never returned. A self-hosted provider is not assumed free."}
                  </p>
                </section>

                <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
                  <h2 className="mb-4 flex items-center gap-2 text-sm font-black text-slate-800">
                    <Bot className="h-4 w-4 text-cyan-600" />
                    {isRTL ? "الوكلاء" : "Agents"}
                  </h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {agents.map((a) => (
                      <div key={a.id} className="rounded-xl border border-slate-100 p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold text-slate-800">{isRTL ? a.nameAr : a.nameEn}</span>
                          {a.requiresHumanReview && (
                            <Badge className="bg-amber-100 text-amber-700">
                              {isRTL ? "مراجعة بشرية" : "Human review"}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">{isRTL ? a.descriptionAr : a.descriptionEn}</p>
                        <p className="mt-2 font-mono text-[10px] text-slate-400">
                          {a.allowedTools.length ? a.allowedTools.join(", ") : (isRTL ? "لا أدوات" : "no tools")}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
                  <h2 className="mb-4 flex items-center gap-2 text-sm font-black text-slate-800">
                    <GitBranch className="h-4 w-4 text-cyan-600" />
                    {isRTL ? "طلبات التطوير" : "Development requests"}
                  </h2>
                  <div className="mb-4 flex gap-2">
                    <input
                      value={devPrompt}
                      onChange={(e) => setDevPrompt(e.target.value)}
                      placeholder={isRTL ? "صف التطوير المطلوب..." : "Describe the development you need..."}
                      className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    />
                    <Button onClick={createRequest} className="bg-cyan-600 text-white">
                      {isRTL ? "إرسال" : "Submit"}
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {requests.length === 0 && (
                      <p className="text-xs text-slate-400">{isRTL ? "لا توجد طلبات" : "No requests yet"}</p>
                    )}
                    {requests.map((r) => (
                      <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-100 p-3">
                        <Badge className={RISK_STYLE[r.risk] ?? "bg-slate-100"}>{r.risk}</Badge>
                        <span className="flex-1 text-sm font-semibold text-slate-800">{r.title}</span>
                        <Badge className="bg-slate-100 text-slate-600">{r.status}</Badge>
                        {r.status === "pending_approval" && (
                          <>
                            <button onClick={() => decide(r.id, "approve")} className="text-emerald-600" title="approve">
                              <CheckCircle2 className="h-4 w-4" />
                            </button>
                            <button onClick={() => decide(r.id, "reject")} className="text-rose-600" title="reject">
                              <XCircle className="h-4 w-4" />
                            </button>
                          </>
                        )}
                        <button onClick={() => decide(r.id, "artifact")} className="text-slate-500" title="review artifact">
                          <ShieldAlert className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {artifact && (
                    <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-slate-900 p-3 text-[11px] text-slate-100">
                      {artifact}
                    </pre>
                  )}
                  <p className="mt-3 text-[11px] text-slate-500">
                    {isRTL
                      ? "المساعد لا يطبّق التغييرات بنفسه؛ يُنتج خطة ومقترحًا فقط، ويطبّقه إنسان على فرع مستقل."
                      : "The assistant never applies changes itself; it produces a plan and a proposal, and a human applies it on a branch."}
                  </p>
                </section>
              </>
            )
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}

export default function AiControlPage() {
  // The fallback must not render DashboardLayout: it calls useSearchParams(),
  // which is not allowed outside the boundary during prerender.
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-500" />
        </div>
      }
    >
      <AiControlContent />
    </Suspense>
  );
}
