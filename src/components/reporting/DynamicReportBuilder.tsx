"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/lib/LanguageContext";
import { Loader2, Sparkles, Download, Save, Wand2, ShieldAlert, History, RotateCcw } from "lucide-react";

/**
 * Natural-language report builder + validator UI.
 *
 * Flow: describe a report -> "build" (preview + deterministic validation) ->
 * review the issues table and the sample rows -> download a verified Excel file
 * or save the definition. Sensitive (class-3) issues are shown but never
 * auto-applied; only safe format issues are offered as fixes.
 */

type Issue = {
  id: string;
  severity: "error" | "warning" | "info";
  category: "calculation" | "data" | "logic" | "format";
  titleAr: string;
  titleEn: string;
  current?: string | number | null;
  expected?: string | number | null;
  evidence: string;
  fixAr: string;
  fixEn: string;
  fixClass: 1 | 2 | 3;
  rows?: number[];
};

type DynamicPreview = {
  definition: { dataset: string; table: string; titleAr: string; titleEn: string; deniedFields: string[] };
  columns: { key: string; labelAr: string; labelEn: string; type: string }[];
  rows: Record<string, string | number | null>[];
  totalRow: Record<string, number> | null;
  totals: Record<string, number>;
  rowCount: number;
  sourceCount: number;
  truncated: boolean;
  issues: Issue[];
  summary: { error: number; warning: number; info: number };
  notes: string[];
  warnings: string[];
  dataChangeRequested: boolean;
};

const DATASETS = [
  { value: "", ar: "تلقائي", en: "Auto-detect" },
  { value: "sales", ar: "المبيعات", en: "Sales" },
  { value: "purchases", ar: "المشتريات", en: "Purchases" },
  { value: "expenses", ar: "المصروفات", en: "Expenses" },
  { value: "payments", ar: "المدفوعات", en: "Payments" },
  { value: "accounts", ar: "الحسابات", en: "Accounts" },
];

const SEV_STYLE: Record<string, string> = {
  error: "bg-red-50 text-red-700 border-red-200",
  warning: "bg-amber-50 text-amber-800 border-amber-200",
  info: "bg-sky-50 text-sky-700 border-sky-200",
};

export default function DynamicReportBuilder() {
  const { isRTL } = useLanguage();
  const [prompt, setPrompt] = useState("");
  const [dataset, setDataset] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<DynamicPreview | null>(null);
  const [history, setHistory] = useState<{ action: string; entity: string; created_at: string }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState<"" | "build" | "download" | "save">("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  function form() {
    const f = new FormData();
    f.append("prompt", prompt);
    if (dataset) f.append("kind", dataset);
    if (from) f.append("from", from);
    if (to) f.append("to", to);
    return f;
  }

  async function build() {
    setBusy("build");
    setError("");
    setMessage("");
    setPreview(null);
    try {
      const res = await fetch("/api/financial/report-format?mode=build-preview", { method: "POST", body: form() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || (isRTL ? "تعذّر إنشاء التقرير" : "Could not build the report"));
        return;
      }
      setPreview(data.dynamic);
    } catch {
      setError(isRTL ? "تعذّر الاتصال بالخادم" : "Could not reach the server");
    } finally {
      setBusy("");
    }
  }

  async function download() {
    setBusy("download");
    setError("");
    try {
      const res = await fetch("/api/financial/report-format?mode=build-file", { method: "POST", body: form() });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || (isRTL ? "فشل إنشاء الملف" : "Could not generate the file"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `SPEED_${preview?.definition.dataset ?? "report"}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMessage(isRTL ? "تم إنشاء الملف بنجاح." : "File generated successfully.");
    } catch {
      setError(isRTL ? "تعذّر تنزيل الملف" : "Could not download the file");
    } finally {
      setBusy("");
    }
  }

  async function saveDefinition() {
    if (!name.trim()) return;
    setBusy("save");
    setError("");
    try {
      const f = form();
      f.append("name", name);
      const res = await fetch("/api/financial/report-format?mode=save-definition", { method: "POST", body: f });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || (isRTL ? "تعذّر حفظ التعريف" : "Could not save the definition"));
        return;
      }
      setMessage(isRTL ? `تم حفظ التعريف: ${data.saved}` : `Definition saved: ${data.saved}`);
      setName("");
    } catch {
      setError(isRTL ? "تعذّر حفظ التعريف" : "Could not save the definition");
    } finally {
      setBusy("");
    }
  }

  async function loadHistory() {
    setShowHistory(true);
    try {
      const res = await fetch("/api/financial/report-format?what=history");
      const data = await res.json().catch(() => ({}));
      setHistory(data.history ?? []);
    } catch {
      setHistory([]);
    }
  }

  const label = (c: { labelAr: string; labelEn: string }) => (isRTL ? c.labelAr : c.labelEn);

  return (
    <Card className="border-0 shadow-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Wand2 className="w-5 h-5 text-violet-600" />
          {isRTL ? "منشئ التقارير بالذكاء الاصطناعي" : "AI Report Builder"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-500">
          {isRTL
            ? "اكتب طلبك بالعربية أو الإنجليزية لإنشاء تقرير من بيانات النظام، مع فحص تلقائي للأخطاء قبل التصدير. لا يتم تعديل أي بيانات محاسبية."
            : "Describe the report in Arabic or English to build it from real system data, with automatic error checking before export. No accounting data is changed."}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? "مصدر البيانات" : "Dataset"}</Label>
            <select value={dataset} onChange={(e) => setDataset(e.target.value)} className="h-9 w-full rounded-lg border border-slate-300 px-2 text-sm">
              {DATASETS.map((d) => <option key={d.value} value={d.value}>{isRTL ? d.ar : d.en}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? "من تاريخ" : "From"}</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-lg" />
          </div>
          <div>
            <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? "إلى تاريخ" : "To"}</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-lg" />
          </div>
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder={isRTL
            ? "مثال: أنشئ تقرير مبيعات حسب العميل خلال هذا الشهر مع رقم الفاتورة وحالة السداد والمتبقي وأضف الإجماليات"
            : "e.g. Sales report by customer this month with invoice number, payment status and remaining, plus totals"}
          className="w-full rounded-lg border border-slate-300 p-3 text-sm"
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={build} disabled={busy !== "" || !prompt.trim()} className="bg-violet-600 hover:bg-violet-500 text-white rounded-xl font-bold gap-2">
            {busy === "build" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {isRTL ? "إنشاء ومعاينة" : "Build & preview"}
          </Button>
          <Button onClick={loadHistory} variant="outline" className="h-9 rounded-lg gap-2">
            <History className="w-4 h-4" />{isRTL ? "سجل التعديلات" : "History"}
          </Button>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {message && <p className="text-sm text-emerald-600">{message}</p>}

        {preview && (
          <div className="space-y-4 border-t pt-4">
            {preview.dataChangeRequested && (
              <p className="text-sm rounded-lg bg-amber-50 border border-amber-200 text-amber-800 p-3">
                {isRTL
                  ? "طلبك يتضمن تعديل بيانات محاسبية. لا يتم تنفيذ ذلك هنا؛ استخدم المسار المعتمد في النظام."
                  : "Your request includes an accounting-data change. It is not applied here; use the approved system path."}
              </p>
            )}
            {preview.definition.deniedFields.length > 0 && (
              <p className="text-sm rounded-lg bg-slate-100 border border-slate-200 text-slate-700 p-3 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4" />
                {isRTL
                  ? `حقول محجوبة بلا صلاحية: ${preview.definition.deniedFields.join(", ")}`
                  : `Fields hidden (no permission): ${preview.definition.deniedFields.join(", ")}`}
              </p>
            )}

            {preview.notes.length > 0 && (
              <div className="text-sm text-slate-600">
                <p className="font-semibold">{isRTL ? "ملخص الفهم:" : "Understanding:"}</p>
                <ul className="list-disc ps-5">{preview.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </div>
            )}

            <div className="flex flex-wrap gap-2 text-xs">
              <span className="px-2 py-1 rounded-full bg-red-100 text-red-700">{isRTL ? "أخطاء" : "Errors"}: {preview.summary.error}</span>
              <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-800">{isRTL ? "تحذيرات" : "Warnings"}: {preview.summary.warning}</span>
              <span className="px-2 py-1 rounded-full bg-sky-100 text-sky-700">{isRTL ? "معلومات" : "Info"}: {preview.summary.info}</span>
              <span className="px-2 py-1 rounded-full bg-slate-100 text-slate-700">
                {isRTL ? `الصفوف: ${preview.rowCount}/${preview.sourceCount}` : `Rows: ${preview.rowCount}/${preview.sourceCount}`}
              </span>
            </div>

            {preview.issues.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border rounded-lg">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600">
                      <th className="py-2 px-2 text-start">{isRTL ? "المشكلة" : "Issue"}</th>
                      <th className="py-2 px-2">{isRTL ? "الخطورة" : "Severity"}</th>
                      <th className="py-2 px-2">{isRTL ? "الحالي" : "Current"}</th>
                      <th className="py-2 px-2">{isRTL ? "المتوقع" : "Expected"}</th>
                      <th className="py-2 px-2 text-start">{isRTL ? "الدليل" : "Evidence"}</th>
                      <th className="py-2 px-2 text-start">{isRTL ? "الإصلاح المقترح" : "Suggested fix"}</th>
                      <th className="py-2 px-2">{isRTL ? "الفئة" : "Class"}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.issues.map((it) => (
                      <tr key={it.id}>
                        <td className="py-2 px-2 font-medium">{isRTL ? it.titleAr : it.titleEn}</td>
                        <td className="py-2 px-2 text-center">
                          <span className={`px-2 py-0.5 rounded-full border ${SEV_STYLE[it.severity]}`}>{it.severity}</span>
                        </td>
                        <td className="py-2 px-2 text-center font-mono">{it.current ?? "—"}</td>
                        <td className="py-2 px-2 text-center font-mono">{it.expected ?? "—"}</td>
                        <td className="py-2 px-2 font-mono text-[10px]">{it.evidence}</td>
                        <td className="py-2 px-2">{isRTL ? it.fixAr : it.fixEn}</td>
                        <td className="py-2 px-2 text-center">
                          {it.fixClass === 1 ? (isRTL ? "عرض آمن" : "Safe display")
                            : it.fixClass === 2 ? (isRTL ? "تعريف التقرير" : "Report def")
                              : (isRTL ? "حساس — يتطلب المسار المعتمد" : "Sensitive — approved path")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-100 text-slate-600">
                    {preview.columns.map((c) => <th key={c.key} className="py-2 px-3 text-start font-semibold">{label(c)}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {preview.rows.map((row, i) => (
                    <tr key={i}>
                      {preview.columns.map((c) => <td key={c.key} className="py-1.5 px-3 font-mono">{row[c.key] ?? ""}</td>)}
                    </tr>
                  ))}
                  {preview.totalRow && (
                    <tr className="bg-slate-50 font-bold">
                      {preview.columns.map((c) => (
                        <td key={c.key} className="py-2 px-3 font-mono">{preview.totals[c.key] ?? ""}</td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={download} disabled={busy !== ""} className="bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold gap-2">
                {busy === "download" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {isRTL ? "تصدير Excel" : "Export Excel"}
              </Button>
              <div className="flex items-center gap-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={isRTL ? "اسم التعريف" : "Definition name"} className="h-9 rounded-lg w-44" />
                <Button onClick={saveDefinition} disabled={busy !== "" || !name.trim()} variant="outline" className="h-9 rounded-lg gap-2">
                  {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {isRTL ? "حفظ التعريف" : "Save definition"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {showHistory && (
          <div className="border-t pt-4">
            <p className="font-semibold text-sm text-slate-600 mb-2 flex items-center gap-2">
              <RotateCcw className="w-4 h-4" />{isRTL ? "سجل عمليات التقارير" : "Report operations history"}
            </p>
            {history.length === 0 ? (
              <p className="text-xs text-slate-400">{isRTL ? "لا يوجد سجل بعد." : "No history yet."}</p>
            ) : (
              <ul className="text-xs text-slate-600 space-y-1">
                {history.map((h, i) => (
                  <li key={i} className="font-mono">{h.created_at} · {h.action} · {h.entity}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
