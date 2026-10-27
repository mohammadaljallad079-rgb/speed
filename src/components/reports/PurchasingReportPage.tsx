"use client"

import { Suspense, useEffect, useState } from 'react'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FileSearch, Download } from 'lucide-react'
import { buildReportWorkbook, downloadWorkbook, exportFilename } from '@/lib/reporting/excel-export'
import type { PurchasingReportKind } from '@/lib/reporting/purchasing-reports'

/**
 * Generic renderer for the purchasing/expense reports.
 *
 * One component serves all nine reports so the purchasing module gains reporting
 * without nine near-identical pages. The figures are computed server-side
 * (`/api/reports/purchasing`), which is also where the tenant scope and the
 * `reports.view` permission are enforced; this component only renders the
 * columns and rows the server returns.
 */

type ReportColumn = { key: string; labelEn: string; labelAr: string; type: 'text' | 'currency' | 'number' }
type ReportData = {
  columns: ReportColumn[]
  rows: Record<string, string | number | null>[]
  totals: Record<string, number>
}

const dayMs = 24 * 60 * 60 * 1000
const dateInput = (d: Date) => d.toISOString().split('T')[0]

const HAS_DATES: PurchasingReportKind[] = [
  'purchase_register',
  'expenses_by_vehicle',
  'expenses_by_branch',
  'expenses_by_category',
  'vat_purchases',
  'monthly_expenses',
  'vehicle_profitability',
]

function ReportContent({ kind, titleAr, titleEn, showSupplierFilter }: { kind: PurchasingReportKind; titleAr: string; titleEn: string; showSupplierFilter?: boolean }) {
  const { isRTL } = useLanguage()
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [from, setFrom] = useState(dateInput(new Date(Date.now() - 365 * dayMs)))
  const [to, setTo] = useState(dateInput(new Date()))
  const [draftFrom, setDraftFrom] = useState(from)
  const [draftTo, setDraftTo] = useState(to)
  const [supplierId, setSupplierId] = useState('')

  const hasDates = HAS_DATES.includes(kind)

  async function load(f = from, t = to, supplier = supplierId) {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ kind })
      if (hasDates) {
        if (f) params.set('from', f)
        if (t) params.set('to', t)
      }
      if (showSupplierFilter && supplier) params.set('supplier_id', supplier)
      const res = await fetch(`/api/reports/purchasing?${params.toString()}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      setData(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  const columns = data?.columns ?? []
  const rows = data?.rows ?? []

  /**
   * Branded export through the shared engine (Exec 60, Section 6). The columns
   * and totals come from the server response, so the file is exactly what the
   * table shows - including the totals row, which is emitted as a real SUM.
   */
  async function exportExcel() {
    if (!data) return
    const spec = {
      titleAr,
      titleEn,
      periodLabel: hasDates ? `${from} — ${to}` : null,
      rtl: isRTL,
      columns: columns.map((c) => ({
        key: c.key,
        labelAr: c.labelAr,
        labelEn: c.labelEn,
        type: (c.type === 'currency' ? 'currency' : c.type === 'number' ? 'number' : 'text') as 'currency' | 'number' | 'text',
      })),
      rows: rows as unknown as Record<string, unknown>[],
      totals: columns
        .filter((c) => data.totals?.[c.key] !== undefined)
        .map((c) => ({ labelAr: c.labelAr, labelEn: c.labelEn, columnKey: c.key, value: Number(data.totals[c.key]) })),
    }
    const buffer = await buildReportWorkbook(spec)
    downloadWorkbook(buffer, exportFilename(kind, hasDates ? `${from}_${to}` : null))
  }

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-black text-slate-900 dark:text-white">{isRTL ? titleAr : titleEn}</h1>
          <div className="flex flex-wrap items-center gap-2">
            {hasDates && (
              <>
                <Input type="date" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} className="w-40" />
                <Input type="date" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} className="w-40" />
              </>
            )}
            {showSupplierFilter && (
              <Input
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                placeholder={isRTL ? 'معرّف المورد (اختياري)' : 'Supplier id (optional)'}
                className="w-56"
              />
            )}
            <Button onClick={() => { setFrom(draftFrom); setTo(draftTo); load(draftFrom, draftTo) }}>
              {isRTL ? 'تطبيق' : 'Apply'}
            </Button>
            <Button variant="outline" onClick={() => void exportExcel()} disabled={!data || rows.length === 0} className="gap-2">
              <Download className="w-4 h-4" />
              {isRTL ? 'تصدير Excel' : 'Export Excel'}
            </Button>
          </div>
        </header>

        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">{error}</div>
        ) : loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full" />
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-700">
                    {columns.map((c) => (
                      <th key={c.key} className={`px-6 py-4 font-bold ${c.type === 'text' ? (isRTL ? 'text-right' : 'text-left') : 'text-end'}`}>
                        {isRTL ? c.labelAr : c.labelEn}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={Math.max(1, columns.length)} className="px-6 py-12 text-center text-slate-500">
                        <FileSearch className="w-12 h-12 mx-auto mb-3 opacity-20" />
                        {isRTL ? 'لا توجد بيانات لهذه الفترة.' : 'No records for this period.'}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row, i) => (
                      <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                        {columns.map((c) => (
                          <td key={c.key} className={`px-6 py-4 text-sm ${c.type === 'text' ? 'text-slate-700 dark:text-slate-200' : 'text-end font-medium text-slate-800 dark:text-slate-100'}`}>
                            {c.type === 'currency' ? formatCurrency(Number(row[c.key] ?? 0)) : (row[c.key] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
                {rows.length > 0 && columns.some((c) => data?.totals?.[c.key] !== undefined) && (
                  <tfoot>
                    <tr className="bg-slate-50 dark:bg-slate-900/50 font-bold text-slate-800 dark:text-slate-100">
                      {columns.map((c, idx) => (
                        <td key={c.key} className={`px-6 py-4 text-sm ${c.type === 'text' ? '' : 'text-end'}`}>
                          {idx === 0 ? (isRTL ? 'الإجمالي' : 'Total') : data?.totals?.[c.key] !== undefined
                            ? (c.type === 'currency' ? formatCurrency(Number(data.totals[c.key])) : data.totals[c.key])
                            : ''}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function PurchasingReportPage(props: { kind: PurchasingReportKind; titleAr: string; titleEn: string; showSupplierFilter?: boolean }) {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <ReportContent {...props} />
    </Suspense>
  )
}
