"use client"

import { useMemo, useState } from "react"

import { supabase } from "@/lib/supabase"
import { useLanguage } from "@/lib/LanguageContext"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, X } from "lucide-react"

import {
  RECORD_SCHEMAS,
  initialRecordValues,
  fieldApplies,
  validateRecord,
  type RecordField,
} from "@/lib/records/schemas"
import type { RecordKind } from "@/lib/records/sources"

/**
 * Inline quick-create modal, driven by the shared schema.
 *
 * The fields are generated from `RECORD_SCHEMAS[kind]`, so the modal shows the
 * same fields, in the same order, with the same required/optional rules as the
 * module's own create form - it is not a cut-down copy. Validation is the same
 * pure function the server route uses, and the write goes through
 * `/api/records/create`, which is permission-checked and tenant-scoped from the
 * session (the browser never sets `tenant_id`).
 *
 * On success the created row is handed back so the caller can refresh its list
 * and select the new record without leaving the transaction form.
 */

type Props = {
  kind: RecordKind
  onClose: () => void
  onCreated: (record: Record<string, unknown>) => void
}

const TITLES: Record<RecordKind, { ar: string; en: string }> = {
  customer: { ar: "عميل", en: "Customer" },
  supplier: { ar: "مورد", en: "Supplier" },
  account: { ar: "حساب محاسبي", en: "Account" },
  car: { ar: "مركبة", en: "Vehicle" },
}

export default function QuickCreateModal({ kind, onClose, onCreated }: Props) {
  const { isRTL } = useLanguage()
  const schema = RECORD_SCHEMAS[kind]

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>(() => initialRecordValues(schema))

  const [parents, setParents] = useState<Array<{ id: string; code: string; name_ar: string }>>([])
  const [loadedParents, setLoadedParents] = useState(false)

  const set = (name: string, value: unknown) => setValues((prev) => ({ ...prev, [name]: value }))

  const loadParents = async () => {
    if (loadedParents || kind !== "account") return
    setLoadedParents(true)
    const { data } = await supabase.from("accounts").select("id, code, name_ar").order("code")
    setParents((data as Array<{ id: string; code: string; name_ar: string }>) ?? [])
  }

  const visibleFields = useMemo(() => schema.fields.filter((f) => fieldApplies(f, values)), [schema.fields, values])

  const save = async () => {
    const validation = validateRecord(schema, values)
    if (!validation.ok) {
      const first = validation.errors[0]
      setError(isRTL ? first.ar : first.en)
      return
    }

    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/records/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, values }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // A validation response carries per-field messages; show the first so the
        // user is told which field the server rejected, not just "failed".
        const detail =
          Array.isArray(data?.errors) && data.errors.length > 0
            ? isRTL
              ? data.errors[0].ar
              : data.errors[0].en
            : data?.error
        throw new Error(detail || (isRTL ? "فشل الحفظ" : "Save failed"))
      }
      onCreated(data as Record<string, unknown>)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const title = isRTL ? `إضافة ${TITLES[kind].ar} جديد` : `New ${TITLES[kind].en}`

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      dir={isRTL ? "rtl" : "ltr"}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-black text-slate-900">{title}</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label={isRTL ? "إغلاق" : "Close"}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
            {error}
          </p>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2" onFocus={loadParents}>
          {visibleFields.map((field) => (
            <Field
              key={field.name}
              field={field}
              isRTL={isRTL}
              value={values[field.name]}
              onChange={(v) => set(field.name, v)}
              parents={kind === "account" ? parents : undefined}
              className={field.type === "textarea" ? "sm:col-span-2" : undefined}
            />
          ))}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving} type="button">
            {isRTL ? "إلغاء" : "Cancel"}
          </Button>
          <Button onClick={() => void save()} disabled={saving} className="bg-cyan-600 hover:bg-cyan-700" type="button">
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isRTL ? "حفظ" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({
  field,
  isRTL,
  value,
  onChange,
  parents,
  className,
}: {
  field: RecordField
  isRTL: boolean
  value: unknown
  onChange: (v: unknown) => void
  parents?: Array<{ id: string; code: string; name_ar: string }>
  className?: string
}) {
  const label = `${isRTL ? field.ar : field.en}${field.required ? " *" : ""}`
  const inputClass = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"

  return (
    <div className={className}>
      <Label className="mb-1 block text-xs font-semibold text-slate-600">{label}</Label>

      {field.type === "select" ? (
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {isRTL ? o.ar : o.en}
            </option>
          ))}
        </select>
      ) : field.type === "textarea" ? (
        <textarea
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className={inputClass}
        />
      ) : field.type === "checkbox" ? (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300"
        />
      ) : field.name === "parent_id" && parents ? (
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputClass}>
          <option value="">{isRTL ? "بدون (مستوى أول)" : "None (level 1)"}</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} — {p.name_ar}
            </option>
          ))}
        </select>
      ) : (
        <Input
          type={field.type === "number" ? "number" : field.type}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          required={field.required}
        />
      )}
    </div>
  )
}
