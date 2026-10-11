"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Bot, Loader2, Send, ShieldAlert, Sparkles } from "lucide-react";

import { useLanguage } from "@/lib/LanguageContext";

/**
 * Read-only assistant panel.
 *
 * Grounds every answer in the server's permission-gated tools and shows the
 * exact sources used, so a user can verify the figures. It never sends tenant
 * or role information — the server derives those from the session. The current
 * screen path is passed as context so the assistant can scope its answer.
 */

interface Source {
  label: string;
  value: string | number | null;
  dataset: string;
  ref: string;
}

export default function AssistantPanel({ screen }: { screen?: string }) {
  const { isRTL } = useLanguage();
  const pathname = usePathname();
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!prompt.trim() || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await fetch("/api/ai/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, screen: screen ?? pathname }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setAnswer(json.answer);
      setSources(json.sources ?? []);
      setDegraded(Boolean(json.degraded));
      setNeedsApproval(Boolean(json.requiresApproval));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-cyan-100 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-cyan-50 px-4 py-3">
        <Bot className="h-5 w-5 text-cyan-600" />
        <h2 className="text-sm font-black text-slate-800">
          {isRTL ? "المساعد الذكي" : "AI Assistant"}
        </h2>
        <span className="rounded-full bg-cyan-50 px-2 py-0.5 text-[10px] font-bold text-cyan-700">
          {isRTL ? "قراءة وتحليل فقط" : "Read & analysis only"}
        </span>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex gap-2">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={isRTL ? "اسأل عن المبيعات أو المصروفات أو الأرباح..." : "Ask about sales, expenses or profit..."}
            className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          <button
            onClick={submit}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-bold text-white hover:bg-cyan-700 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {isRTL ? "إرسال" : "Ask"}
          </button>
        </div>

        {error && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{error}</p>
        )}

        {answer && (
          <div className="space-y-2">
            <div className="whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-800">
              {answer}
            </div>
            {degraded && (
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-700">
                <ShieldAlert className="h-3.5 w-3.5" />
                {isRTL ? "تم عرض الأرقام الفعلية دون صياغة النموذج" : "Real figures shown without model phrasing"}
              </p>
            )}
            {needsApproval && (
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-rose-700">
                <ShieldAlert className="h-3.5 w-3.5" />
                {isRTL ? "يتطلب هذا الإجراء موافقة معتمدة" : "This action requires an approved workflow"}
              </p>
            )}
            {sources.length > 0 && (
              <div className="rounded-xl border border-slate-100 p-3">
                <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                  <Sparkles className="h-3.5 w-3.5" />
                  {isRTL ? "المصادر" : "Sources"}
                </p>
                <ul className="space-y-1">
                  {sources.map((s, i) => (
                    <li key={i} className="flex items-center justify-between text-xs">
                      <span className="text-slate-600">{s.label}</span>
                      <span className="font-mono font-bold text-slate-800">{s.value ?? "-"}</span>
                      <span className="text-[10px] text-slate-400">{s.ref}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
