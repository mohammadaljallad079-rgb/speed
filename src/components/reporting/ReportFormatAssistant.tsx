"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/lib/LanguageContext";
import { Loader2, Sparkles, Download, Save, FileSpreadsheet, Eye } from "lucide-react";

/**
 * AI report formatting panel.
 *
 * Flow: describe what you want -> preview (plan + diff + sample rows) -> download
 * the formatted Excel, or save the format as a reusable template. It shows the
 * download affordance only after the server confirms the generated file passed
 * verification; a formatting request never modifies accounting data.
 */

type PreviewIssue = {
  id: string;
  severity: "error" | "warning" | "info";
  titleAr: string;
  titleEn: string;
  current?: string | number | null;
  expected?: string | number | null;
  evidence: string;
};

type Preview = {
  kind: string;
  notes: string[];
  warnings: string[];
  rowCount: number;
  truncated: boolean;
  dataChangeRequested: boolean;
  diff: { changes: string[]; reordered: string[]; hidden: string[]; widthChanged: string[]; structural: boolean };
  columns: { key: string; labelEn: string; labelAr: string; type: string }[];
  previewRows: Record<string, string | number | null>[];
  issues?: PreviewIssue[];
  summary?: { error: number; warning: number; info: number };
};

const REPORT_TYPES = [
  { value: "vat_report", ar: "تقرير ضريبة القيمة المضافة (البحرين)", en: "VAT Report (Bahrain)" },
  { value: "sales_report", ar: "تقرير المبيعات", en: "Sales Report" },
  { value: "purchases_report", ar: "تقرير المشتريات", en: "Purchases Report" },
  { value: "expenses_report", ar: "تقرير المصروفات", en: "Expenses Report" },
  { value: "trial_balance", ar: "ميزان المراجعة", en: "Trial Balance" },
];

export default function ReportFormatAssistant() {
  const { isRTL } = useLanguage();
  const [kind, setKind] = useState("vat_report");
  const [prompt, setPrompt] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [savedTemplates, setSavedTemplates] = useState<{ name: string; kind: string }[]>([]);
  const [appliedTemplate, setAppliedTemplate] = useState("");
  const [saveName, setSaveName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/financial/report-format")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d) => setSavedTemplates(d.templates ?? []))
      .catch(() => setSavedTemplates([]));
  }, []);

  function buildForm() {
    const form = new FormData();
    form.append("kind", kind);
    form.append("prompt", prompt);
    if (from) form.append("from", from);
    if (to) form.append("to", to);
    if (templateName) form.append("templateName", templateName);
    if (templateFile) form.append("file", templateFile);
    return form;
  }

  async function runPreview() {
    setLoading(true);
    setError("");
    setMessage("");
    setPreview(null);
    try {
      const res = await fetch("/api/financial/report-format?mode=preview", { method: "POST", body: buildForm() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || (isRTL ? "تعذّر إنشاء المعاينة" : "Could not build preview"));
        return;
      }
      setPreview(data.preview);
    } catch {
      setError(isRTL ? "تعذّر الاتصال بالخادم" : "Could not reach the server");
    } finally {
      setLoading(false);
    }
  }

  async function download() {
    setDownloading(true);
    setError("");
    try {
      const res = await fetch("/api/financial/report-format?mode=file", { method: "POST", body: buildForm() });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || (isRTL ? "فشل إنشاء الملف" : "Could not generate the file"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `SPEED_${kind}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMessage(isRTL ? "تم إنشاء الملف بنجاح." : "File generated successfully.");
    } catch {
      setError(isRTL ? "تعذّر تنزيل الملف" : "Could not download the file");
    } finally {
      setDownloading(false);
    }
  }

  async function saveTemplate() {
    if (!saveName.trim()) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const form = new FormData();
      form.append("kind", kind);
      form.append("prompt", prompt);
      form.append("name", saveName);
      if (templateFile) form.append("file", templateFile);
      const res = await fetch("/api/financial/report-format?mode=save-template", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || (isRTL ? "تعذّر حفظ القالب" : "Could not save the template"));
        return;
      }
      setSavedTemplates((data.templates ?? []).map((n: string) => ({ name: n, kind })));
      setMessage(isRTL ? `تم حفظ القالب: ${data.saved}` : `Template saved: ${data.saved}`);
      setSaveName("");
    } catch {
      setError(isRTL ? "تعذّر حفظ القالب" : "Could not save the template");
    } finally {
      setSaving(false);
    }
  }

  const label = (c: { labelEn: string; labelAr: string }) => (isRTL ? c.labelAr : c.labelEn);

  return (
    <Card className="border-0 shadow-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sparkles className="w-5 h-5 text-cyan-600" />
          {isRTL ? "مساعد تنسيق التقارير بالذكاء الاصطناعي" : "AI Report Formatting Assistant"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-500">
          {isRTL
            ? "اطلب تنسيق تقرير مالي أو إعادة ترتيب أعمدته. لن يتم تعديل أي بيانات محاسبية — التنسيق فقط، مع معاينة قبل التنزيل."
            : "Ask to format a financial report or reorder its columns. No accounting data is changed — formatting only, with a preview before download."}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? "نوع التقرير" : "Report type"}</Label>
            <select
              value={kind}
              onChange={(e) => { setKind(e.target.value); setPreview(null); }}
              className="h-9 w-full rounded-lg border border-slate-300 px-2 text-sm"
            >
              {REPORT_TYPES.map((r) => (
                <option key={r.value} value={r.value}>{isRTL ? r.ar : r.en}</option>
              ))}
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
          <div>
            <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? "قالب محفوظ" : "Saved template"}</Label>
            <select
              value={appliedTemplate}
              onChange={(e) => { setAppliedTemplate(e.target.value); setTemplateName(e.target.value); }}
              className="h-9 w-full rounded-lg border border-slate-300 px-2 text-sm"
            >
              <option value="">{isRTL ? "بدون" : "None"}</option>
              {savedTemplates.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </div>
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder={isRTL
            ? "مثال: نسّق التقرير بشكل احترافي، رتّب الأعمدة حسب التاريخ ورقم الفاتورة، وخلّيه عربي من اليمين لليسار"
            : "e.g. Format professionally, order columns by date and invoice number, and make it RTL"}
          className="w-full rounded-lg border border-slate-300 p-3 text-sm"
        />

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 px-3 py-2 border-2 border-dashed border-slate-300 rounded-xl cursor-pointer hover:border-cyan-400 transition-colors">
            <FileSpreadsheet className="w-4 h-4 text-slate-500" />
            <span className="text-sm text-slate-600">
              {templateFile ? templateFile.name : (isRTL ? "قالب إكسل مرجعي (اختياري)" : "Reference Excel template (optional)")}
            </span>
            <input type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => setTemplateFile(e.target.files?.[0] || null)} />
          </label>
          <Button onClick={runPreview} disabled={loading} className="bg-cyan-500 hover:bg-cyan-400 text-white rounded-xl font-bold gap-2">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
            {isRTL ? "معاينة" : "Preview"}
          </Button>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {message && <p className="text-sm text-emerald-600">{message}</p>}

        {preview && (
          <div className="space-y-4 border-t pt-4">
            {preview.dataChangeRequested && (
              <p className="text-sm rounded-lg bg-amber-50 border border-amber-200 text-amber-800 p-3">
                {isRTL
                  ? "طلبك يتضمن تعديل بيانات محاسبية. لا يتم تنفيذ ذلك عبر التنسيق؛ يُرجى استخدام واجهات النظام المعتمدة."
                  : "Your request includes an accounting-data change. That is not performed via formatting; use the approved system screens."}
              </p>
            )}

            <div className="text-sm text-slate-600 space-y-1">
              <p className="font-semibold">{isRTL ? "ملخص الفهم:" : "Understanding:"}</p>
              <ul className="list-disc ps-5">
                {preview.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>

            {preview.diff.changes.length > 0 && (
              <div className="text-sm text-slate-600">
                <p className="font-semibold">{isRTL ? "الفروقات:" : "Differences:"}</p>
                <ul className="list-disc ps-5">
                  {preview.diff.changes.map((c, i) => <li key={i}>{c}</li>)}
                  {preview.diff.reordered.length > 0 && <li>{isRTL ? "إعادة ترتيب الأعمدة" : "Columns reordered"}</li>}
                  {preview.diff.hidden.length > 0 && <li>{isRTL ? `إخفاء: ${preview.diff.hidden.join(", ")}` : `Hidden: ${preview.diff.hidden.join(", ")}`}</li>}
                </ul>
              </div>
            )}

            {preview.warnings.length > 0 && (
              <div className="text-sm text-amber-700">
                <p className="font-semibold">{isRTL ? "تنبيهات:" : "Warnings:"}</p>
                <ul className="list-disc ps-5">
                  {preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {preview.issues && preview.issues.length > 0 && (
              <div className="text-sm space-y-2">
                <p className="font-semibold">
                  {isRTL
                    ? `نتائج الفحص: ${preview.summary?.error ?? 0} خطأ، ${preview.summary?.warning ?? 0} تحذير، ${preview.summary?.info ?? 0} ملاحظة`
                    : `Validation: ${preview.summary?.error ?? 0} error(s), ${preview.summary?.warning ?? 0} warning(s), ${preview.summary?.info ?? 0} info`}
                </p>
                <ul className="space-y-1">
                  {preview.issues.map((iss) => (
                    <li
                      key={iss.id}
                      className={`rounded-lg border p-2 ${
                        iss.severity === "error"
                          ? "border-red-200 bg-red-50 text-red-800"
                          : iss.severity === "warning"
                            ? "border-amber-200 bg-amber-50 text-amber-800"
                            : "border-slate-200 bg-slate-50 text-slate-700"
                      }`}
                    >
                      <span className="font-semibold">{isRTL ? iss.titleAr : iss.titleEn}</span>
                      <span className="block text-xs opacity-80">{iss.evidence}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-xs text-slate-500">
              {isRTL
                ? `عدد الصفوف: ${preview.rowCount}${preview.truncated ? " (تم تحديد الحد الأقصى)" : ""}`
                : `Rows: ${preview.rowCount}${preview.truncated ? " (capped)" : ""}`}
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-100 text-slate-600">
                    {preview.columns.map((c) => (
                      <th key={c.key} className="py-2 px-3 text-start font-semibold">{label(c)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {preview.previewRows.map((row, i) => (
                    <tr key={i}>
                      {preview.columns.map((c) => (
                        <td key={c.key} className="py-1.5 px-3 font-mono">{row[c.key] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={download} disabled={downloading} className="bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold gap-2">
                {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {isRTL ? "تنزيل الملف النهائي" : "Download final file"}
              </Button>
              <div className="flex items-center gap-2">
                <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={isRTL ? "اسم القالب" : "Template name"} className="h-9 rounded-lg w-40" />
                <Button onClick={saveTemplate} disabled={saving || !saveName.trim()} variant="outline" className="h-9 rounded-lg gap-2">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {isRTL ? "حفظ كقالب" : "Save as template"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
