"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { supabase } from "@/lib/supabase"
import { useLanguage } from "@/lib/LanguageContext"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Check, ChevronDown, Loader2, Plus, Search } from "lucide-react"

import {
  RECORD_SOURCES,
  recordLabel,
  recordMatches,
  recordSublabel,
  type RecordKind,
} from "@/lib/records/sources"
import QuickCreateModal from "./QuickCreateModal"

/**
 * Searchable record picker with inline (+) creation.
 *
 * One reusable control for every "select an existing record" field. It loads its
 * options from the record's OWN module (see `RECORD_SOURCES`), lets the user
 * search, and opens the module's create form in a modal via the (+) button. After
 * a successful create the list refreshes and the new record is selected
 * automatically — the surrounding form keeps all of its other values because
 * only `value` changes here.
 *
 * `createMode`:
 *   - `"inline"`  → show the (+) button and the in-page quick-create modal. This is
 *                   the default for every record kind: customer, supplier,
 *                   account and vehicle all create inline through the shared
 *                   schema, so the user never leaves the transaction.
 *   - `"link"`    → show a link to the module's full create page (escape hatch)
 *   - `"none"`    → no create affordance (a read-only reference field)
 */

export type RecordRow = Record<string, unknown>

type Props = {
  kind: RecordKind
  value: string
  onChange: (id: string, row: RecordRow | null) => void
  /** Restrict which rows appear (e.g. only active accounts). */
  filter?: (row: RecordRow) => boolean
  /** Extra query constraints applied to the module read. */
  eq?: Array<[string, unknown]>
  createMode?: "inline" | "link" | "none"
  placeholder?: string
  disabled?: boolean
  className?: string
  id?: string
}

export default function RecordSelect({
  kind,
  value,
  onChange,
  filter,
  eq,
  createMode = "inline",
  placeholder,
  disabled,
  className,
  id,
}: Props) {
  const { isRTL } = useLanguage()
  const source = RECORD_SOURCES[kind]

  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<RecordRow[]>([])
  const [loading, setLoading] = useState(true)
  const [term, setTerm] = useState("")
  const [showCreate, setShowCreate] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    setLoading(true)
    let query = supabase.from(source.table).select(source.listColumns)
    for (const [column, val] of eq ?? []) query = query.eq(column, val)
    const { data } = await query
    setRows(((data as unknown as RecordRow[]) ?? []).filter((r) => (filter ? filter(r) : true)))
    setLoading(false)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.table])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [])

  const selected = useMemo(() => rows.find((r) => String(r.id) === value) ?? null, [rows, value])

  const filtered = useMemo(
    () => rows.filter((r) => recordMatches(source, r, term)).slice(0, 100),
    [rows, term, source],
  )

  const handleCreated = async (record: RecordRow) => {
    setShowCreate(false)
    await load()
    const createdId = String(record.id ?? "")
    if (createdId) onChange(createdId, record)
  }

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-start text-sm disabled:opacity-60"
      >
        <span className={selected ? "text-slate-800" : "text-slate-400"}>
          {selected ? recordLabel(source, selected) : placeholder ?? (isRTL ? `اختر ${source.ar}` : `Select ${source.en}`)}
        </span>
        <ChevronDown className="h-4 w-4 flex-shrink-0 text-slate-400" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
          <div className="relative">
            <Search className="absolute top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 ltr:left-3 rtl:right-3" />
            <Input
              autoFocus
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={isRTL ? "بحث..." : "Search..."}
              className="ltr:pl-9 rtl:pr-9"
            />
          </div>

          <div className="mt-2 max-h-56 overflow-y-auto">
            {loading ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-sm text-slate-400">
                {isRTL ? "لا نتائج." : "No results."}
              </p>
            ) : (
              filtered.map((r) => {
                const rid = String(r.id)
                const sub = recordSublabel(r)
                return (
                  <button
                    key={rid}
                    type="button"
                    onClick={() => {
                      onChange(rid, r)
                      setOpen(false)
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-start text-sm hover:bg-slate-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-slate-800">{recordLabel(source, r)}</span>
                      {sub && <span className="block truncate text-xs text-slate-400">{sub}</span>}
                    </span>
                    {rid === value && <Check className="h-4 w-4 text-cyan-600" />}
                  </button>
                )
              })
            )}
          </div>

          {createMode === "inline" && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowCreate(true)}
              className="mt-2 w-full justify-center gap-2 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              {isRTL ? `إضافة ${source.ar} جديد` : `New ${source.en}`}
            </Button>
          )}

          {createMode === "link" && (
            <a
              href={source.createRoute}
              target="_blank"
              rel="noreferrer"
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {isRTL ? `إضافة ${source.ar} (يفتح نموذج الوحدة)` : `New ${source.en} (opens module form)`}
            </a>
          )}
        </div>
      )}

      {showCreate && (
        <QuickCreateModal kind={kind} onClose={() => setShowCreate(false)} onCreated={(r) => void handleCreated(r)} />
      )}
    </div>
  )
}
