"use client"
export const dynamic = "force-dynamic"

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  ArrowLeft, Link2, Unlink, ShoppingBag, FileText, RefreshCw, Info
} from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/utils'
import { notifyDataChanged, useReportRefresh } from '@/lib/hooks/use-report-refresh'

/**
 * Purchase ↔ credit-sale analytical links (Exec 30, Item 6).
 *
 * REPORTING/ANALYSIS ONLY. This page reads the link table and shows which
 * purchases and sales are linked and which are not. It never adds purchase value
 * to revenue, never creates a journal entry, and never changes a document. The
 * linked totals count each record once, so a many-to-many relationship cannot
 * inflate a figure.
 */

type PurchaseRow = {
  id: string
  invoice_number: string | null
  bill_date: string | null
  total_amount: number | null
  status: string | null
}
type SaleRow = {
  id: string
  invoice_number: string | null
  invoice_date: string | null
  total_amount: number | null
  status: string | null
}
type LinkRow = {
  id: string
  purchase_invoice_id: string
  invoice_id: string
  relation_type: string | null
  source: string | null
  note: string | null
  created_at: string | null
}
type Summary = {
  linkedPurchases: number
  unlinkedPurchases: number
  linkedSales: number
  unlinkedSales: number
  linkCount: number
  linkedPurchaseTotal: number
  linkedSaleTotal: number
}

function Content() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [purchases, setPurchases] = useState<PurchaseRow[]>([])
  const [sales, setSales] = useState<SaleRow[]>([])
  const [links, setLinks] = useState<LinkRow[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [busy, setBusy] = useState(false)
  const [formPurchase, setFormPurchase] = useState('')
  const [formSale, setFormSale] = useState('')
  const [formRelation, setFormRelation] = useState('')
  const [formMessage, setFormMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/purchase-sale-links', { cache: 'no-store' })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error || 'Failed to load links')
      setPurchases(payload.purchases || [])
      setSales(payload.sales || [])
      setLinks(payload.links || [])
      setSummary(payload.summary || null)
    } catch (e: any) {
      setError(e.message || 'Failed to load links')
    }
    setLoading(false)
  }

  useReportRefresh(loadData)

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const purchaseById = useMemo(() => new Map(purchases.map((p) => [p.id, p])), [purchases])
  const saleById = useMemo(() => new Map(sales.map((s) => [s.id, s])), [sales])
  const unlinkedPurchases = useMemo(
    () => purchases.filter((p) => !links.some((l) => l.purchase_invoice_id === p.id)),
    [purchases, links],
  )
  const unlinkedSales = useMemo(
    () => sales.filter((s) => !links.some((l) => l.invoice_id === s.id)),
    [sales, links],
  )

  async function removeLink(id: string) {
    if (!confirm(isRTL ? 'إزالة الربط؟ لن تُحذف الفاتورة الأصلية.' : 'Remove this link? The original document is not deleted.')) return
    setBusy(true)
    try {
      const res = await fetch(`/api/purchase-sale-links?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error || 'Failed to remove link')
      notifyDataChanged()
      await loadData()
    } catch (e: any) {
      alert(e.message || 'Failed to remove link')
    }
    setBusy(false)
  }

  async function createLink() {
    setFormMessage(null)
    if (!formPurchase || !formSale) {
      setFormMessage({ kind: 'err', text: isRTL ? 'اختر فاتورة مشتريات وفاتورة بيع.' : 'Select a purchase bill and a sale invoice.' })
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/purchase-sale-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          purchase_invoice_id: formPurchase,
          invoice_id: formSale,
          relation_type: formRelation || undefined,
        }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error || 'Failed to create link')
      setFormPurchase('')
      setFormSale('')
      setFormRelation('')
      setFormMessage({ kind: 'ok', text: isRTL ? 'تم إنشاء الربط.' : 'Link created.' })
      notifyDataChanged()
      await loadData()
    } catch (e: any) {
      setFormMessage({ kind: 'err', text: e.message || 'Failed to create link' })
    }
    setBusy(false)
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => router.push('/reports')} className="rounded-lg gap-1">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
                {isRTL ? 'ربط المشتريات بالمبيعات الآجلة' : 'Purchase ↔ Credit-Sale Links'}
              </h1>
              <p className="text-sm text-slate-500">
                {isRTL ? 'تحليلي فقط — بدون مخزون أو قيود محاسبية' : 'Analytical only — no inventory, no journal entries'}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={loadData} disabled={loading} className="rounded-lg gap-1">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {isRTL ? 'تحديث' : 'Refresh'}
          </Button>
        </div>

        <div className="flex items-start gap-2 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-3 text-sm text-amber-800 dark:text-amber-200">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            {isRTL
              ? 'هذا الربط للتقارير والتحليل فقط: لا يضيف قيمة المشتريات إلى الإيرادات، ولا ينشئ قيودًا يومية أو حركات مخزون، ولا يعدّل الفواتير الأصلية.'
              : 'This link is for reporting and analysis only: it does not add purchase value to revenue, does not create journal entries or stock movements, and never edits the original documents.'}
          </span>
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-3 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat title={isRTL ? 'مشتريات مرتبطة' : 'Linked purchases'} value={String(summary.linkedPurchases)} tone="emerald" />
            <Stat title={isRTL ? 'مشتريات غير مرتبطة' : 'Unlinked purchases'} value={String(summary.unlinkedPurchases)} tone="slate" />
            <Stat title={isRTL ? 'مبيعات مرتبطة' : 'Linked sales'} value={String(summary.linkedSales)} tone="indigo" />
            <Stat title={isRTL ? 'مبيعات غير مرتبطة' : 'Unlinked sales'} value={String(summary.unlinkedSales)} tone="slate" />
            <Stat title={isRTL ? 'عدد الروابط' : 'Link count'} value={String(summary.linkCount)} tone="slate" />
            <Stat title={isRTL ? 'إجمالي المشتريات المرتبطة' : 'Linked purchase total'} value={formatCurrency(summary.linkedPurchaseTotal)} tone="amber" />
            <Stat title={isRTL ? 'إجمالي المبيعات المرتبطة' : 'Linked sale total'} value={formatCurrency(summary.linkedSaleTotal)} tone="amber" />
            <Stat title={isRTL ? 'مؤشر الربط' : 'Link indicator'} value={
              summary.linkedPurchases + summary.unlinkedPurchases === 0
                ? '—'
                : `${Math.round((summary.linkedPurchases / (summary.linkedPurchases + summary.unlinkedPurchases)) * 100)}%`
            } tone="slate" />
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="w-4 h-4 text-emerald-600" />
              {isRTL ? 'إنشاء ربط' : 'Create a link'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid md:grid-cols-3 gap-3">
              <label className="text-sm space-y-1">
                <span className="text-slate-500">{isRTL ? 'فاتورة المشتريات' : 'Purchase bill'}</span>
                <select
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                  value={formPurchase}
                  onChange={(e) => setFormPurchase(e.target.value)}
                >
                  <option value="">{isRTL ? '— اختر —' : '— select —'}</option>
                  {unlinkedPurchases.map((p) => (
                    <option key={p.id} value={p.id}>{p.invoice_number || p.id.slice(0, 8)}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm space-y-1">
                <span className="text-slate-500">{isRTL ? 'فاتورة البيع الآجل' : 'Credit-sale invoice'}</span>
                <select
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                  value={formSale}
                  onChange={(e) => setFormSale(e.target.value)}
                >
                  <option value="">{isRTL ? '— اختر —' : '— select —'}</option>
                  {unlinkedSales.map((s) => (
                    <option key={s.id} value={s.id}>{s.invoice_number || s.id.slice(0, 8)}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm space-y-1">
                <span className="text-slate-500">{isRTL ? 'نوع العلاقة (اختياري)' : 'Relation (optional)'}</span>
                <select
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                  value={formRelation}
                  onChange={(e) => setFormRelation(e.target.value)}
                >
                  <option value="">{isRTL ? '— بلا —' : '— none —'}</option>
                  <option value="supply">supply</option>
                  <option value="direct_cost">direct_cost</option>
                  <option value="subcontract">subcontract</option>
                  <option value="other">other</option>
                </select>
              </label>
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={createLink} disabled={busy} className="rounded-lg gap-1">
                <Link2 className="w-4 h-4" />
                {isRTL ? 'ربط' : 'Link'}
              </Button>
              {formMessage && (
                <span className={`text-sm ${formMessage.kind === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
                  {formMessage.text}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="w-4 h-4 text-emerald-600" />
              {isRTL ? 'العلاقات الحالية' : 'Current relationships'} ({links.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-slate-400 text-sm py-6 text-center">{isRTL ? 'جارٍ التحميل...' : 'Loading...'}</div>
            ) : links.length === 0 ? (
              <div className="text-slate-400 text-sm py-6 text-center">
                {isRTL ? 'لا توجد روابط بعد.' : 'No links yet.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500 border-b">
                      <th className="py-2">{isRTL ? 'فاتورة المشتريات' : 'Purchase bill'}</th>
                      <th className="py-2">{isRTL ? 'فاتورة البيع' : 'Sale invoice'}</th>
                      <th className="py-2">{isRTL ? 'نوع العلاقة' : 'Relation'}</th>
                      <th className="py-2">{isRTL ? 'المصدر' : 'Source'}</th>
                      <th className="py-2">{isRTL ? 'إجراء' : 'Action'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {links.map((l) => {
                      const p = purchaseById.get(l.purchase_invoice_id)
                      const s = saleById.get(l.invoice_id)
                      return (
                        <tr key={l.id} className="border-b last:border-0">
                          <td className="py-2">
                            <div className="flex items-center gap-2">
                              <ShoppingBag className="w-4 h-4 text-slate-400" />
                              <span>{p?.invoice_number || l.purchase_invoice_id.slice(0, 8)}</span>
                              {p?.bill_date && <span className="text-slate-400 text-xs">{formatDate(p.bill_date)}</span>}
                            </div>
                          </td>
                          <td className="py-2">
                            <div className="flex items-center gap-2">
                              <FileText className="w-4 h-4 text-slate-400" />
                              <span>{s?.invoice_number || l.invoice_id.slice(0, 8)}</span>
                              {s?.invoice_date && <span className="text-slate-400 text-xs">{formatDate(s.invoice_date)}</span>}
                            </div>
                          </td>
                          <td className="py-2">
                            {l.relation_type ? <Badge variant="secondary">{l.relation_type}</Badge> : <span className="text-slate-400">—</span>}
                          </td>
                          <td className="py-2 text-slate-500">{l.source || 'manual'}</td>
                          <td className="py-2">
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => removeLink(l.id)} className="rounded-lg gap-1">
                              <Unlink className="w-4 h-4" />
                              {isRTL ? 'إزالة' : 'Unlink'}
                            </Button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {isRTL ? 'مشتريات غير مرتبطة' : 'Unlinked purchases'} ({unlinkedPurchases.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {unlinkedPurchases.length === 0 ? (
                <div className="text-slate-400">{isRTL ? 'لا يوجد' : 'None'}</div>
              ) : (
                unlinkedPurchases.slice(0, 50).map((p) => (
                  <div key={p.id} className="flex items-center justify-between border-b last:border-0 py-1">
                    <span>{p.invoice_number || p.id.slice(0, 8)}</span>
                    <span className="text-slate-500">{formatCurrency(Number(p.total_amount) || 0)}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {isRTL ? 'مبيعات غير مرتبطة' : 'Unlinked sales'} ({unlinkedSales.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {unlinkedSales.length === 0 ? (
                <div className="text-slate-400">{isRTL ? 'لا يوجد' : 'None'}</div>
              ) : (
                unlinkedSales.slice(0, 50).map((s) => (
                  <div key={s.id} className="flex items-center justify-between border-b last:border-0 py-1">
                    <span>{s.invoice_number || s.id.slice(0, 8)}</span>
                    <span className="text-slate-500">{formatCurrency(Number(s.total_amount) || 0)}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  )
}

function Stat({ title, value, tone }: { title: string; value: string; tone: string }) {
  const tones: Record<string, string> = {
    emerald: 'text-emerald-600',
    indigo: 'text-indigo-600',
    amber: 'text-amber-600',
    slate: 'text-slate-700 dark:text-slate-200',
  }
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-slate-500 mb-1">{title}</p>
        <p className={`text-xl font-bold ${tones[tone] || tones.slate}`}>{value}</p>
      </CardContent>
    </Card>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <Content />
    </Suspense>
  )
}
