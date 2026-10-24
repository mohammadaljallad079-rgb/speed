"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect } from "react"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { supabase, PurchaseInvoice } from "@/lib/supabase"
import { formatCurrency, formatDate, getStatusColor } from "@/lib/utils"
import {
  ShoppingBag, Plus, Search, FileText, MoreVertical, Trash2, Eye,
  Wallet, TrendingUp, AlertTriangle, Clock3, Filter, Download
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem
} from "@/components/ui/dropdown-menu"
import Link from "next/link"

const STATUS_PILLS = ['all', 'pending', 'partial', 'paid', 'cancelled']

function SupplierBillsPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [bills, setBills] = useState<PurchaseInvoice[]>([])
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

  const statusLabels: Record<string, string> = {
    all: isRTL ? 'الكل' : 'All',
    pending: isRTL ? 'معلقة' : 'Pending',
    partial: isRTL ? 'جزئية' : 'Partial',
    paid: isRTL ? 'مدفوعة' : 'Paid',
    cancelled: isRTL ? 'ملغاة' : 'Cancelled',
  }

  useEffect(() => {
    setMounted(true)
    fetchBills()
  }, [])

  async function fetchBills() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('purchase_invoices')
        .select('*, suppliers(name), cars(make, model, plate_number)')
        .order('bill_date', { ascending: false })
      if (data) setBills(data as any)
    } catch (error) {
      console.error('Error fetching bills:', error)
    }
    setLoading(false)
  }

  async function handleDelete(id: string) {
    if (!confirm(isRTL ? 'هل أنت متأكد من حذف الفاتورة؟' : 'Are you sure you want to delete this bill?')) return
    // The delete is server-authoritative: a posted bill, or one with payments,
    // debit notes or line items, is refused (the ledger must keep matching the
    // documents). The browser no longer removes the row itself.
    try {
      const res = await fetch('/api/purchases', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        alert(payload?.error || (isRTL ? 'تعذر حذف الفاتورة' : 'Could not delete the bill'))
        return
      }
      fetchBills()
    } catch {
      alert(isRTL ? 'تعذر حذف الفاتورة' : 'Could not delete the bill')
    }
  }

  const filtered = bills.filter(bill => {
    const matchesSearch = (bill.invoice_number || '').toLowerCase().includes(search.toLowerCase()) ||
      ((bill as any).suppliers?.name || '').toLowerCase().includes(search.toLowerCase()) ||
      ((bill as any).cars?.plate_number || '').toLowerCase().includes(search.toLowerCase())
    const matchesStatus = statusFilter === 'all' || bill.status === statusFilter
    const matchesDateFrom = !dateFrom || (bill.bill_date && bill.bill_date >= dateFrom)
    const matchesDateTo = !dateTo || (bill.bill_date && bill.bill_date <= dateTo)
    return matchesSearch && matchesStatus && matchesDateFrom && matchesDateTo
  })

  const totalBilled = bills.reduce((s, b) => s + (parseFloat(b.total_amount as any) || 0), 0)
  const totalPaid = bills.reduce((s, b) => s + (parseFloat(b.paid_amount as any) || 0), 0)
  const totalOutstanding = Math.max(0, totalBilled - totalPaid)
  const pendingCount = bills.filter(b => b.status === 'pending').length
  const overdueCount = bills.filter(b => b.status === 'pending' && b.due_date && new Date(b.due_date) < new Date()).length

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <FileText className="w-7 h-7 text-emerald-500" />
              {isRTL ? 'فواتير الموردين' : 'Supplier Bills'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {isRTL ? 'إدارة فواتير الموردين والمدفوعات' : 'Manage supplier bills and payments'}
            </p>
          </div>
          <Link href="/purchases/new">
            <Button className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl gap-2">
              <Plus className="w-4 h-4" />
              {isRTL ? 'فاتورة جديدة' : 'New Bill'}
            </Button>
          </Link>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-500">{isRTL ? 'إجمالي الفواتير' : 'Total Billed'}</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{formatCurrency(totalBilled)}</p>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-500">{isRTL ? 'المدفوع' : 'Total Paid'}</p>
            <p className="text-2xl font-bold text-emerald-600 mt-1">{formatCurrency(totalPaid)}</p>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-500">{isRTL ? 'المستحق' : 'Outstanding'}</p>
            <p className="text-2xl font-bold text-amber-600 mt-1">{formatCurrency(totalOutstanding)}</p>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-500">{isRTL ? 'متأخرة' : 'Overdue'}</p>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-2xl font-bold text-red-600">{overdueCount}</p>
              {overdueCount > 0 && <AlertTriangle className="w-5 h-5 text-red-500" />}
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className={`absolute ${isRTL ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400`} />
              <Input
                placeholder={isRTL ? 'بحث برقم الفاتورة أو المورد...' : 'Search by bill # or supplier...'}
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters() }}
                className={`${isRTL ? 'pr-9' : 'pl-9'} h-10 rounded-xl`}
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              {STATUS_PILLS.map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    statusFilter === s
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300'
                  }`}
                >
                  {statusLabels[s]}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input type="date" value={dateFromDraft} onChange={(e) => setDateFromDraft(e.target.value)} className="h-10 w-36 rounded-xl" />
              <Input type="date" value={dateToDraft} onChange={(e) => setDateToDraft(e.target.value)} className="h-10 w-36 rounded-xl" />
            </div>
            <Button onClick={applyFilters} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10 gap-2">
              <Search className="w-4 h-4" />
              {isRTL ? 'بحث' : 'Search'}
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full"></div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400">
              <FileText className="w-12 h-12 mb-3 opacity-30" />
              <p>{isRTL ? 'لا توجد فواتير' : 'No bills found'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-700">
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'رقم الفاتورة' : 'Bill #'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المورد' : 'Supplier'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المركبة' : 'Vehicle'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'التاريخ' : 'Date'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الإجمالي' : 'Total'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المدفوع' : 'Paid'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المتبقي' : 'Balance'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الحالة' : 'Status'}</th>
                    <th className="py-3 px-4 text-center">{isRTL ? 'إجراءات' : 'Actions'}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((bill) => {
                    const supplier = (bill as any).suppliers
                    const car = (bill as any).cars
                    const balance = (parseFloat(bill.total_amount as any) || 0) - (parseFloat(bill.paid_amount as any) || 0)
                    const isOverdue = bill.status === 'pending' && bill.due_date && new Date(bill.due_date) < new Date()
                    return (
                      <tr key={bill.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                        <td className="py-3 px-4">
                          <span className="font-semibold text-slate-900 dark:text-white">{bill.invoice_number}</span>
                        </td>
                        <td className="py-3 px-4">
                          <span className="text-slate-700 dark:text-slate-300">{supplier?.name || '-'}</span>
                        </td>
                        <td className="py-3 px-4">
                          <span className="text-sm text-slate-500">
                            {car ? `${car.make} ${car.model} (${car.plate_number})` : '-'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-sm text-slate-500">
                          {formatDate(bill.bill_date)}
                          {isOverdue && <span className="text-red-500 text-xs block">{isRTL ? 'متأخرة' : 'Overdue'}</span>}
                        </td>
                        <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">{formatCurrency(parseFloat(bill.total_amount as any) || 0)}</td>
                        <td className="py-3 px-4 text-emerald-600">{formatCurrency(parseFloat(bill.paid_amount as any) || 0)}</td>
                        <td className="py-3 px-4 font-bold text-amber-600">{formatCurrency(balance)}</td>
                        <td className="py-3 px-4">
                          <Badge className={getStatusColor(bill.status)}>
                            {statusLabels[bill.status]}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreVertical className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                              <DropdownMenuItem>
                                <Eye className="w-4 h-4 mr-2" /> {isRTL ? 'عرض' : 'View'}
                              </DropdownMenuItem>
                              <DropdownMenuItem>
                                <Wallet className="w-4 h-4 mr-2" /> {isRTL ? 'دفع' : 'Pay'}
                              </DropdownMenuItem>
                              <DropdownMenuItem className="text-red-600" onClick={() => handleDelete(bill.id)}>
                                <Trash2 className="w-4 h-4 mr-2" /> {isRTL ? 'حذف' : 'Delete'}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <SupplierBillsPageContent />
    </Suspense>
  )
}
