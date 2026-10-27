"use client"
import { Suspense } from 'react'
export const dynamic = "force-dynamic"
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { deleteInvoice } from '@/lib/invoices/invoice-client'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Search, Plus, ArrowDownLeft, ArrowUpRight, MoreVertical, Pencil, Trash2, Printer, FileText } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import DashboardLayout from '@/components/DashboardLayout'
import Link from 'next/link'
import { formatCurrency } from '@/lib/utils'

function SalesInvoicesContent() {
  const { t, isRTL } = useLanguage()
  const [invoices, setInvoices] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetchInvoices()
  }, [])

  async function fetchInvoices() {
    setLoading(true)
    const { data } = await supabase
      .from('invoices')
      .select('*, customers(full_name, phone)')
      .eq('invoice_type', 'sale')
      .order('created_at', { ascending: false })
    setInvoices(data || [])
    setLoading(false)
  }

  const filtered = invoices.filter(inv => 
    !search || 
    (inv.invoice_number || '').toLowerCase().includes(search.toLowerCase()) ||
    (inv.customers?.full_name || '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-5" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">{isRTL ? 'فواتير المبيعات' : 'Sales Invoices'}</h1>
            <p className="text-slate-400 text-xs mt-0.5">
              {filtered.length} {isRTL ? 'فاتورة بيع' : 'sales invoices'}
            </p>
          </div>
          <Button asChild className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-9 text-xs font-semibold">
            <Link href="/sales/new">
              <Plus className="w-4 h-4 mr-1.5" />
              {isRTL ? 'فاتورة بيع جديدة' : 'New Sales Invoice'}
            </Link>
          </Button>
        </header>

        {/* Search */}
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className={`absolute ${isRTL ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400`} />
              <Input
                placeholder={isRTL ? 'بحث برقم الفاتورة أو العميل...' : 'Search by invoice or customer...'}
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') setSearch(searchDraft) }}
                className={`${isRTL ? 'pr-9' : 'pl-9'} h-9 text-sm bg-slate-50 dark:bg-slate-900 rounded-lg border-slate-200`}
              />
            </div>
            <Button onClick={() => setSearch(searchDraft)} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-9 text-xs font-semibold shrink-0">
              <Search className="w-4 h-4 mr-1.5" />{isRTL ? 'بحث' : 'Search'}
            </Button>
          </div>
        </div>

        {/* List */}
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-8 h-8 border-3 border-slate-300 border-t-slate-900 rounded-full"></div>
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map((inv) => (
              <div key={inv.id} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden hover:shadow-md transition-all">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
                      <FileText className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-bold text-sm text-slate-900 dark:text-white">{inv.invoice_number}</h3>
                      <p className="text-xs text-slate-500">{inv.customers?.full_name}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-6 flex-1 md:justify-center">
                    <div className="text-center">
                      <p className="text-[10px] text-slate-400 uppercase tracking-wider">{isRTL ? 'التاريخ' : 'Date'}</p>
                      <p className="text-xs font-medium text-slate-700 mt-0.5">{inv.invoice_date}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] text-slate-400 uppercase tracking-wider">{isRTL ? 'الحالة' : 'Status'}</p>
                      <p className="text-xs font-medium mt-0.5 capitalize">{inv.status}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] text-slate-400 uppercase tracking-wider">{isRTL ? 'المبلغ' : 'Amount'}</p>
                      <p className="text-sm font-bold text-emerald-600">{formatCurrency(inv.total_amount || 0)}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className="text-xs border-emerald-200 text-emerald-700 bg-emerald-50">
                      {isRTL ? 'بيع' : 'Sale'}
                    </Badge>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg hover:bg-slate-100">
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-36">
                        <DropdownMenuItem asChild>
                          <Link href={`/invoices/${inv.id}`} className="flex items-center gap-2 cursor-pointer text-xs">
                            <Pencil className="w-3.5 h-3.5" />
                            <span>{isRTL ? 'تعديل' : 'Edit'}</span>
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link href={`/invoices/${inv.id}/print`} className="flex items-center gap-2 cursor-pointer text-xs">
                            <Printer className="w-3.5 h-3.5" />
                            <span>{isRTL ? 'طباعة' : 'Print'}</span>
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={async () => {
                            if (!confirm(isRTL ? 'هل أنت متأكد من الحذف؟' : 'Are you sure?')) return
                            try {
                              // Guarded server-side: a posted invoice, or one
                              // with receipts/returns, is refused. Deleting the
                              // row here left the ledger describing a document
                              // that no longer existed.
                              await deleteInvoice(inv.id)
                              window.location.reload()
                            } catch (err: any) {
                              alert(err?.message || (isRTL ? 'تعذر حذف الفاتورة' : 'Could not delete the invoice'))
                            }
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
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-slate-400">
            <FileText className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm">{isRTL ? 'لا توجد فواتير بيع' : 'No sales invoices'}</p>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function SalesInvoicesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <SalesInvoicesContent />
    </Suspense>
  )
}
