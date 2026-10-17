"use client";

import { useState } from "react";
import { useLanguage } from "@/lib/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, FileSpreadsheet, Loader2, Upload, CheckCircle2, AlertTriangle } from "lucide-react";

/**
 * Universal Excel data-import control.
 *
 * The browser only chooses a module and uploads a file; the server decides
 * permissions, tenant and validity. The preview is produced server-side and a
 * commit re-validates the same file, so a tampered client cannot skip a check.
 */

type ModuleKey = "customers" | "suppliers" | "expenses";

const MODULES: { key: ModuleKey; ar: string; en: string }[] = [
  { key: "customers", ar: "العملاء", en: "Customers" },
  { key: "suppliers", ar: "الموردون", en: "Suppliers" },
  { key: "expenses", ar: "المصروفات", en: "Expenses" },
];

type RowError = { field: string | null; code: string; messageAr: string; messageEn: string };
type PreviewRow = { rowNumber: number; values: Record<string, unknown>; errors: RowError[]; duplicate: { level: number; key: string } | null };
type Preview = {
  module: string;
  labelAr: string;
  labelEn: string;
  mapping: { header: string; field: string | null; labelEn: string | null }[];
  rows: PreviewRow[];
  summary: { total: number; valid: number; invalid: number; duplicates: number };
  canCommit: boolean;
  notesAr: string[];
  notesEn: string[];
};

export default function ExcelImportPanel() {
  const { isRTL } = useLanguage();
  const [moduleKey, setModuleKey] = useState<ModuleKey>("customers");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function upload(mode: "preview" | "commit") {
    if (!file) {
      setError(isRTL ? "اختر ملفًا أولًا." : "Choose a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/import?module=${moduleKey}&mode=${mode}`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || (isRTL ? "تعذّر الاستيراد" : "Import failed"));
        return;
      }
      setPreview(data.preview);
      if (mode === "commit") {
        setMessage(isRTL ? `تم استيراد ${data.inserted} سجل.` : `Imported ${data.inserted} record(s).`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    window.location.href = `/api/import?module=${moduleKey}`;
  }

  function downloadErrorReport() {
    if (!preview) return;
    const lines = ["Row,Field,Code,Message EN,Message AR,Resolution"];
    const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
    for (const row of preview.rows) {
      for (const err of row.errors) {
        lines.push([row.rowNumber, err.field ?? "", err.code, esc(err.messageEn), esc(err.messageAr), ""].join(","));
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-errors-${moduleKey}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
          {isRTL ? "استيراد بيانات Excel" : "Excel Data Import"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48">
            <label className="text-xs text-slate-500 mb-1 block">{isRTL ? "الوحدة" : "Module"}</label>
            <Select value={moduleKey} onValueChange={(v) => { setModuleKey(v as ModuleKey); setPreview(null); setMessage(null); setError(null); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MODULES.map((m) => (
                  <SelectItem key={m.key} value={m.key}>{isRTL ? m.ar : m.en}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={downloadTemplate} className="gap-1.5">
            <Download className="w-4 h-4" /> {isRTL ? "تنزيل القالب" : "Template"}
          </Button>
        </div>

        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setMessage(null); setError(null); }}
          className="block w-full text-sm text-slate-600 file:me-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-4 file:py-2 file:text-sm file:font-medium hover:file:bg-slate-200"
        />

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => upload("preview")} disabled={busy || !file} variant="outline" className="gap-1.5">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {isRTL ? "معاينة" : "Preview"}
          </Button>
          <Button onClick={() => upload("commit")} disabled={busy || !preview || !preview.canCommit} className="gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white">
            <CheckCircle2 className="w-4 h-4" /> {isRTL ? "تأكيد الاستيراد" : "Confirm Import"}
          </Button>
          {preview && preview.summary.invalid > 0 && (
            <Button onClick={downloadErrorReport} variant="outline" className="gap-1.5">
              <AlertTriangle className="w-4 h-4 text-amber-500" /> {isRTL ? "تقرير الأخطاء" : "Error report"}
            </Button>
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {message && <p className="text-sm text-emerald-600">{message}</p>}

        {preview && (
          <div className="space-y-3 border-t pt-3">
            <div className="text-sm text-slate-600">
              {isRTL
                ? `الإجمالي: ${preview.summary.total} · صالح: ${preview.summary.valid} · غير صالح: ${preview.summary.invalid} · مكرر: ${preview.summary.duplicates}`
                : `Total: ${preview.summary.total} · Valid: ${preview.summary.valid} · Invalid: ${preview.summary.invalid} · Duplicate: ${preview.summary.duplicates}`}
            </div>
            {(preview.notesAr.length > 0 || preview.notesEn.length > 0) && (
              <ul className="text-xs text-amber-700 list-disc ps-5">
                {(isRTL ? preview.notesAr : preview.notesEn).map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-100 text-slate-600">
                    <th className="py-1.5 px-2 text-start">#</th>
                    <th className="py-1.5 px-2 text-start">{isRTL ? "الحالة" : "Status"}</th>
                    <th className="py-1.5 px-2 text-start">{isRTL ? "الأخطاء" : "Errors"}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {preview.rows.slice(0, 100).map((r) => (
                    <tr key={r.rowNumber} className={r.errors.length ? "bg-red-50" : ""}>
                      <td className="py-1 px-2 font-mono">{r.rowNumber}</td>
                      <td className="py-1 px-2">
                        {r.errors.length === 0 ? (isRTL ? "صالح" : "OK") : r.duplicate ? (isRTL ? "مكرر" : "Duplicate") : (isRTL ? "خطأ" : "Error")}
                      </td>
                      <td className="py-1 px-2">
                        {r.errors.map((e, i) => <div key={i}>{isRTL ? e.messageAr : e.messageEn}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
