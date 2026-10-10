"use client"
import { Suspense } from 'react'
import { useState, useEffect, useMemo } from 'react'
import { supabase, Payment } from '@/lib/supabase'
import { formatCurrency } from '@/lib/utils'
import {
  CreditCard,
  Plus,
  Search,
  ArrowDownLeft,
  ArrowUpRight,
  MoreVertical,
  Pencil,
  Trash2,
  Printer,
  Filter,
  TrendingUp,
  TrendingDown,
  Wallet,
  Calendar,
  X
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

function PaymentsPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'receipt' | 'refund'>('all')
  const [filterMethod, setFilterMethod] = useState<string>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [searchDraft, setSearchDraft] = useState('')
  const [filterTypeDraft, setFilterTypeDraft] = useState<'all' | 'receipt' | 'refund'>('all')
  const [filterMethodDraft, setFilterMethodDraft] = useState<string>('all')
  const [dateFromDraft, setDateFromDraft] = useState('')
  const [dateToDraft, setDateToDraft] = useState('')

  function applyFilters() {
    setSearch(searchDraft)
    setFilterType(filterTypeDraft)
    setFilterMethod(filterMethodDraft)
    setDateFrom(dateFromDraft)
    setDateTo(dateToDraft)
  }

  useEffect(() => {
    setMounted(true)
    fetchPayments()
  }, [])

  async function fetchPayments() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('payments')
        .select('*, customers(full_name)')
        .order('payment_date', { ascending: false })
      if (data) setPayments(data as any)
    } catch (error) {
      console.error('Error fetching payments:', error)
    }
    setLoading(false)
  }

  const filtered = useMemo(() => {
    return payments.filter(pay => {
      const matchesSearch = !search || 
        (pay.receipt_number || '').toLowerCase().includes(search.toLowerCase()) ||
        (pay.customers?.full_name || '').toLowerCase().includes(search.toLowerCase())
      const matchesType = filterType === 'all' || pay.payment_type === filterType
      const matchesMethod = filterMethod === 'all' || pay.payment_method === filterMethod
      const matchesDateFrom = !dateFrom || (pay.payment_date || '') >= dateFrom
      const matchesDateTo = !dateTo || (pay.payment_date || '') <= dateTo
      return matchesSearch && matchesType && matchesMethod && matchesDateFrom && matchesDateTo
    })
  }, [payments, search, filterType, filterMethod, dateFrom, dateTo])

  const stats = useMemo(() => {
    const receipts = filtered.filter(p => p.payment_type === 'receipt')
    const refunds = filtered.filter(p => p.payment_type === 'refund')
    const totalReceipts = receipts.reduce((sum, p) => sum + (p.amount || 0), 0)
    const totalRefunds = refunds.reduce((sum, p) => sum + (p.amount || 0), 0)
    return { totalReceipts, totalRefunds, net: totalReceipts - totalRefunds, count: filtered.length }
  }, [filtered])

  const methods = useMemo(() => {
    const set = new Set(payments.map(p => p.payment_method).filter(Boolean))
    return Array.from(set)
  }, [payments])

  const hasActiveFilters = filterType !== 'all' || filterMethod !== 'all' || dateFrom || dateTo

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-5" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">{t.payments}</h1>
            <p className="text-slate-400 text-xs mt-0.5">
              {stats.count} {isRTL ? 'عملية' : 'transactions'} · {isRTL ? 'صافي' : 'Net'}: {formatCurrency(stats.net)}
            </p>
          </div>
          <Button asChild className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-9 text-xs font-semibold">
            <Link href="/payments/new">
              <Plus className="w-4 h-4 mr-1.5" />
              {isRTL ? 'سند جديد' : 'New Receipt'}
            </Link>
          </Button>
        </header>

        {/* Stats Cards */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-emerald-50 dark:bg-emerald-900/10 rounded-xl p-4 border border-emerald-100 dark:border-emerald-800">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-emerald-600" />
              <span className="text-xs font-semibold text-emerald-700 uppercase">{isRTL ? 'القبض' : 'Receipts'}</span>
            </div>
            <p className="text-xl font-bold text-emerald-700">{formatCurrency(stats.totalReceipts)}</p>
          </div>
          <div className="bg-rose-50 dark:bg-rose-900/10 rounded-xl p-4 border border-rose-100 dark:border-rose-800">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="w-4 h-4 text-rose-600" />
              <span className="text-xs font-semibold text-rose-700 uppercase">{isRTL ? 'الصرف' : 'Refunds'}</span>
            </div>
            <p className="text-xl font-bold text-rose-700">{formatCurrency(stats.totalRefunds)}</p>
          </div>
          <div className="bg-slate-50 dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center gap-2 mb-2">
              <Wallet className="w-4 h-4 text-slate-500" />
              <span className="text-xs font-semibold text-slate-600 uppercase">{isRTL ? 'الصافي' : 'Net'}</span>
            </div>
            <p className={`text-xl font-bold ${stats.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{formatCurrency(stats.net)}</p>
          </div>
        </div>

        {/* Search & Filters */}
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
          <div className="p-3 flex items-center gap-3">
            <div className="flex-1 relative">
              <Search className={`absolute ${isRTL ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400`} />
              <Input
                placeholder={isRTL ? 'بحث برقم السند أو العميل...' : 'Search by receipt or customer...'}
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters() }}
                className={`${isRTL ? 'pr-9' : 'pl-9'} h-9 text-sm bg-slate-50 dark:bg-slate-900 rounded-lg border-slate-200`}
              />
            </div>
            <Button onClick={applyFilters} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-9 text-xs font-semibold shrink-0">
              <Search className="w-3.5 h-3.5 mr-1.5" />{isRTL ? 'بحث' : 'Search'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
              className={`h-9 rounded-lg text-xs gap-1.5 ${hasActiveFilters ? 'border-emerald-300 text-emerald-700 bg-emerald-50' : ''}`}
            >
              <Filter className="w-3.5 h-3.5" />
              {isRTL ? 'فلتر' : 'Filter'}
              {hasActiveFilters && <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>}
            </Button>
          </div>

          {showFilters && (
            <div className="px-3 pb-3 border-t border-slate-100 dark:border-slate-700 pt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
              <select 
                value={filterTypeDraft}
                onChange={e => setFilterTypeDraft(e.target.value as any)}
                className="h-8 text-xs rounded-lg border border-slate-200 bg-slate-50 px-2"
              >
                <option value="all">{isRTL ? 'كل الأنواع' : 'All Types'}</option>
                <option value="receipt">{isRTL ? 'قبض' : 'Receipt'}</option>
                <option value="refund">{isRTL ? 'صرف' : 'Refund'}</option>
              </select>
              <select 
                value={filterMethodDraft}
                onChange={e => setFilterMethodDraft(e.target.value)}
                className="h-8 text-xs rounded-lg border border-slate-200 bg-slate-50 px-2"
              >
                <option value="all">{isRTL ? 'كل الطرق' : 'All Methods'}</option>
                {methods.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <div className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                <input 
                  type="date" 
                  value={dateFromDraft}
                  onChange={e => setDateFromDraft(e.target.value)}
                  className="h-8 text-xs rounded-lg border border-slate-200 bg-slate-50 px-2 flex-1"
                  placeholder="From"
                />
              </div>
              <div className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                <input 
                  type="date" 
                  value={dateToDraft}
                  onChange={e => setDateToDraft(e.target.value)}
                  className="h-8 text-xs rounded-lg border border-slate-200 bg-slate-50 px-2 flex-1"
                  placeholder="To"
                />
              </div>
              <button onClick={applyFilters} className="col-span-full h-8 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center gap-1.5">
                <Search className="w-3.5 h-3.5" />{isRTL ? 'بحث' : 'Search'}
              </button>
              {hasActiveFilters && (
                <button
                  onClick={() => { setFilterType('all'); setFilterMethod('all'); setDateFrom(''); setDateTo(''); setFilterTypeDraft('all'); setFilterMethodDraft('all'); setDateFromDraft(''); setDateToDraft(''); }}
                  className="col-span-full text-xs text-slate-500 hover:text-red-500 flex items-center gap-1 justify-center py-1"
                >
                  <X className="w-3 h-3" /> {isRTL ? 'إلغاء الفلاتر' : 'Clear filters'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Cards Grid */}
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-8 h-8 border-3 border-slate-300 border-t-slate-900 rounded-full"></div>
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map((payment) => {
              const isReceipt = payment.payment_type === 'receipt'
              return (
                <div key={payment.id} className={`bg-white dark:bg-slate-800 rounded-xl border shadow-sm overflow-hidden transition-all hover:shadow-md ${isReceipt ? 'border-emerald-100 dark:border-emerald-800' : 'border-rose-100 dark:border-rose-800'}`}>
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isReceipt ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                        {isReceipt ? <ArrowDownLeft className="w-5 h-5" /> : <ArrowUpRight className="w-5 h-5" />}
                      </div>
                      <div>
                        <h3 className="font-bold text-sm text-slate-900 dark:text-white">{payment.receipt_number}</h3>
                        <p className="text-xs text-slate-500">{payment.customers?.full_name}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-6 flex-1 md:justify-center">
                      <div className="text-center">
                        <p className="text-[10px] text-slate-400 uppercase tracking-wider">{t.date}</p>
                        <p className="text-xs font-medium text-slate-700 mt-0.5">{payment.payment_date}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] text-slate-400 uppercase tracking-wider">{t.paymentMethod}</p>
                        <p className="text-xs font-medium text-slate-700 mt-0.5 capitalize">{payment.payment_method}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] text-slate-400 uppercase tracking-wider">{t.amount}</p>
                        <p className={`text-sm font-bold ${isReceipt ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {isReceipt ? '+' : '-'}{formatCurrency(payment.amount ?? 0)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className={`text-xs ${isReceipt ? 'border-emerald-200 text-emerald-700 bg-emerald-50' : 'border-rose-200 text-rose-700 bg-rose-50'}`}>
                        {isReceipt ? (isRTL ? 'قبض' : 'Receipt') : (isRTL ? 'صرف' : 'Refund')}
                      </Badge>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg hover:bg-slate-100">
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-36">
                          <DropdownMenuItem asChild>
                            <Link href={`/payments/${payment.id}/edit`} className="flex items-center gap-2 cursor-pointer text-xs">
                              <Pencil className="w-3.5 h-3.5" />
                              <span>{isRTL ? 'تعديل' : 'Edit'}</span>
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/payments/${payment.id}/print`} className="flex items-center gap-2 cursor-pointer text-xs">
                              <Printer className="w-3.5 h-3.5" />
                              <span>{isRTL ? 'طباعة' : 'Print'}</span>
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={async () => {
                              if (!confirm(isRTL ? 'هل أنت متأكد من الحذف؟' : 'Are you sure?')) return
                              await supabase.from('payments').delete().eq('id', payment.id)
                              window.location.reload()
                            }}
                            className="flex items-center gap-2 text-red-600 cursor-pointer focus:text-red-600 text-xs"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>{isRTL ? 'حذف' : 'Delete'}</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-slate-400">
            <CreditCard className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm">{t.noData}</p>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function PaymentsPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PaymentsPageContent />
    </Suspense>
  )
}
