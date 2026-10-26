"use client"
import { Suspense } from 'react'
import { useState, useEffect } from 'react'
import { supabase, Invoice } from '@/lib/supabase'
import { deleteInvoice } from '@/lib/invoices/invoice-client'
import { formatCurrency, formatDate, getStatusColor } from '@/lib/utils'
import {
  Receipt,
  Plus,
  Search,
  FileText,
  MoreVertical,
  Pencil,
  Trash2,
  Wallet,
  Printer,
  TrendingUp,
  AlertTriangle,
  Clock3,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const STATUS_STRIPE: Record<string, string> = {
  paid: 'bg-emerald-500',
  pending: 'bg-amber-400',
  partial: 'bg-blue-400',
  overdue: 'bg-red-500',
  cancelled: 'bg-slate-300',
}

const STATUS_PILLS = ['all', 'pending', 'paid', 'partial', 'overdue', 'cancelled']

function RentalInvoicesPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [searchDraft, setSearchDraft] = useState('')
  const [dateFromDraft, setDateFromDraft] = useState('')
  const [dateToDraft, setDateToDraft] = useState('')

  function applyFilters() {
    setSearch(searchDraft)
    setDateFrom(dateFromDraft)
    setDateTo(dateToDraft)
  }
  const searchParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "")
  const queryStatus = searchParams.get('status')

  const statusLabels: Record<string, string> = {
    all: isRTL ? 'الكل' : 'All',
    pending: isRTL ? 'معلقة' : 'Pending',
    paid: isRTL ? 'مدفوعة' : 'Paid',
    partial: isRTL ? 'جزئية' : 'Partial',
    overdue: isRTL ? 'متأخرة' : 'Overdue',
    cancelled: isRTL ? 'ملغاة' : 'Cancelled',
  }

  useEffect(() => {
    setMounted(true)
    fetchInvoices()
  }, [])

  async function fetchInvoices() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('invoices')
        .select('*, customers(full_name)')
        .not('rental_contract_id', 'is', null)
        .order('invoice_date', { ascending: false })
      if (data) setInvoices(data as any)
    } catch (error) {
      console.error('Error fetching rental invoices:', error)
    }
    setLoading(false)
  }

  async function handleDelete(invId: string) {
    if (!confirm(isRTL ? 'هل أنت متأكد من حذف هذه الفاتورة؟' : 'Are you sure you want to delete this invoice?')) return
    try {
      // Guarded server-side: a posted invoice, or one with receipts/returns, is
      // refused rather than silently orphaning its ledger entry.
      await deleteInvoice(invId)
      fetchInvoices()
    } catch (err: any) {
      alert(err?.message || (isRTL ? 'تعذر حذف الفاتورة' : 'Could not delete the invoice'))
    }
  }

  const filtered = invoices.filter(inv => {
    const matchesSearch = (inv.invoice_number || '').toLowerCase().includes(search.toLowerCase()) ||
      ((inv as any).customers?.full_name || '').toLowerCase().includes(search.toLowerCase())
    const matchesStatus = !queryStatus || inv.status === queryStatus
    const matchesStatusFilter = statusFilter === 'all' || inv.status === statusFilter
    const matchesDateFrom = !dateFrom || (inv.invoice_date && inv.invoice_date >= dateFrom)
    const matchesDateTo = !dateTo || (inv.invoice_date && inv.invoice_date <= dateTo)
    return matchesSearch && matchesStatus && matchesStatusFilter && matchesDateFrom && matchesDateTo
  })

  const totalInvoiced = invoices.reduce((s, i: any) => s + (parseFloat(i.total_amount) || 0), 0)
  const collected = invoices.reduce((s, i: any) => s + (parseFloat(i.paid_amount) || 0), 0)
  const outstanding = Math.max(0, totalInvoiced - collected)
  const overdueList = invoices.filter((i: any) => i.status === 'overdue')
  const overdueAmount = overdueList.reduce((s, i: any) => s + Math.max(0, (parseFloat(i.total_amount) || 0) - (parseFloat(i.paid_amount) || 0)), 0)

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">{isRTL ? 'فواتير الإيجار' : 'Rental Invoices'}</h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">{invoices.length} {isRTL ? 'فاتورة مسجلة' : 'Recorded invoices'}</p>
          </div>
          <Button asChild className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white shadow-lg shadow-cyan-500/25">
            <Link href="/invoices/new">
              <Plus className="w-5 h-5 ml-2 mr-2" />
              {isRTL ? 'إضافة فاتورة' : 'Add Invoice'}
            </Link>
          </Button>
        </header>

        {/* Summary strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 shadow-sm border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-cyan-50 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-400 flex items-center justify-center shrink-0">
                <FileText className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-slate-500 uppercase tracking-wider">{isRTL ? 'إجمالي الفوترة' : 'Total Invoiced'}</p>
                <p className="text-lg font-bold text-slate-900 dark:text-white tabular-nums truncate">{formatCurrency(totalInvoiced)}</p>
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 shadow-sm border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <TrendingUp className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-slate-500 uppercase tracking-wider">{isRTL ? 'المحصّل' : 'Collected'}</p>
                <p className="text-lg font-bold text-emerald-600 tabular-nums truncate">{formatCurrency(collected)}</p>
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 shadow-sm border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                <Wallet className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-slate-500 uppercase tracking-wider">{isRTL ? 'المتبقي' : 'Outstanding'}</p>
                <p className="text-lg font-bold text-amber-600 tabular-nums truncate">{formatCurrency(outstanding)}</p>
              </div>
            </div>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 shadow-sm border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-slate-500 uppercase tracking-wider">{isRTL ? 'متأخرة' : 'Overdue'}</p>
                <p className="text-lg font-bold text-red-600 tabular-nums truncate">{overdueList.length} · {formatCurrency(overdueAmount)}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 shadow-sm border border-slate-200 dark:border-slate-700 space-y-4">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="flex-1 relative">
              <Search className={`absolute ${isRTL ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400`} />
              <Input
                placeholder={isRTL ? 'بحث برقم الفاتورة أو العميل...' : 'Search by invoice number or customer...'}
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters() }}
                className={isRTL ? 'pr-10 bg-slate-50 dark:bg-slate-700' : 'pl-10 bg-slate-50 dark:bg-slate-700'}
              />
            </div>
            <Input type="date" value={dateFromDraft} onChange={(e) => setDateFromDraft(e.target.value)} className="h-10 bg-slate-50 dark:bg-slate-700 w-auto" />
            <Input type="date" value={dateToDraft} onChange={(e) => setDateToDraft(e.target.value)} className="h-10 bg-slate-50 dark:bg-slate-700 w-auto" />
            <Button onClick={applyFilters} className="bg-cyan-600 hover:bg-cyan-700 text-white h-10 shrink-0">
              <Search className="w-4 h-4 md:mr-2" /><span className="hidden md:inline">{isRTL ? 'بحث' : 'Search'}</span>
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {STATUS_PILLS.map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                  statusFilter === s
                    ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900'
                    : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100 dark:bg-slate-700 dark:text-slate-300 dark:border-slate-600'
                }`}
              >
                {statusLabels[s]}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map((invoice: any) => (
              <div key={invoice.id} className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className={`absolute inset-y-0 ${isRTL ? 'right-0' : 'left-0'} w-1.5 ${STATUS_STRIPE[invoice.status] || 'bg-slate-300'}`} />
                <div className={`p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 ${isRTL ? 'pr-7' : 'pl-7'}`}>
                  <div className="flex items-center gap-4 min-w-[180px]">
                    <div className="w-11 h-11 rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 flex items-center justify-center shrink-0">
                      <Receipt className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-bold text-slate-900 dark:text-white truncate">{invoice.invoice_number}</h3>
                      <p className="text-sm text-slate-500 truncate">{invoice.customers?.full_name}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 gap-6 flex-1 md:px-4">
                    <div>
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{t.date}</p>
                      <p className="font-medium text-slate-900 dark:text-slate-100 tabular-nums">{invoice.invoice_date}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {invoice.status === 'overdue' && <Clock3 className="w-3.5 h-3.5 text-red-500" />}
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{t.dueDate}</p>
                        <p className="font-medium text-slate-900 dark:text-slate-100 tabular-nums">{invoice.due_date || '-'}</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{t.total}</p>
                      <p className="font-bold text-slate-900 dark:text-white tabular-nums">{formatCurrency(invoice.total_amount ?? 0)}</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between md:justify-end gap-3">
                    <Badge className={getStatusColor(invoice.status ?? 'pending')}>{statusLabels[invoice.status] || invoice.status}</Badge>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="w-5 h-5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                        <DropdownMenuItem asChild>
                          <Link href={`/invoices/${invoice.id}`} className="flex items-center gap-2 cursor-pointer">
                            <Pencil className="w-4 h-4" />
                            {isRTL ? 'تعديل' : 'Edit'}
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => window.open(`/invoices/${invoice.id}/print`, "_blank")} className="flex items-center gap-2 cursor-pointer"><Printer className="w-4 h-4" />{isRTL ? "طباعة" : "Print"}</DropdownMenuItem><DropdownMenuItem onClick={() => handleDelete(invoice.id)} className="flex items-center gap-2 cursor-pointer text-red-600 focus:text-red-600">
                          <Trash2 className="w-4 h-4" />
                          {isRTL ? 'حذف' : 'Delete'}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 text-slate-500">
            <Receipt className="w-16 h-16 mb-4 opacity-20" />
            <p>{t.noData}</p>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function RentalInvoicesPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <RentalInvoicesPageContent />
    </Suspense>
  )
}
