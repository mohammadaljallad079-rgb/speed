"use client"
export const dynamic = "force-dynamic"

import { Suspense, useState, useEffect } from 'react'
import { notifyDataChanged } from '@/lib/hooks/use-report-refresh'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { formatCurrency, formatDate } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, RotateCcw, Search, Plus, Calendar, Loader2, Save, X, Filter, FileText, DollarSign } from 'lucide-react'

interface Invoice {
  id: string
  invoice_number: string
  invoice_date: string
  total_amount: number
  paid_amount: number
  status: string
  invoice_type: string
  customer_id: string
  notes: string
  customers: { full_name: string } | null
}

interface ReturnRecord {
  id: string
  invoice_id: string
  invoice_number: string
  return_date: string
  amount: number
  reason: string
  status: string
  created_at: string
  customers: { full_name: string } | null
}

function SalesReturnsContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  
  // Filters
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateFromDraft, setDateFromDraft] = useState('')
  const [dateToDraft, setDateToDraft] = useState('')

  // Apply the date range only on an explicit GO press, so editing a date does
  // not re-filter the returns list before the user confirms it.
  function applyDates() {
    setDateFrom(dateFromDraft)
    setDateTo(dateToDraft)
  }

  // Data
  const [returns, setReturns] = useState<ReturnRecord[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  
  // Return Modal
  const [returnModalOpen, setReturnModalOpen] = useState(false)
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null)
  const [returnAmount, setReturnAmount] = useState('')
  const [returnReason, setReturnReason] = useState('')
  const [returnDate, setReturnDate] = useState(new Date().toISOString().split('T')[0])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    setLoading(true)
    try {
      const { data: retData } = await supabase
        .from('sales_returns')
        .select('*, customers(full_name)')
        .order('created_at', { ascending: false })

      if (retData) setReturns(retData as ReturnRecord[])

      const { data: invData } = await supabase
        .from('invoices')
        .select('*, customers(full_name)')
        .in('status', ['paid', 'partial', 'completed'])
        .order('created_at', { ascending: false })

      if (invData) setInvoices(invData as Invoice[])
    } catch (error) {
      console.error('Error fetching data:', error)
    }
    setLoading(false)
  }

  const filteredInvoices = invoices.filter(inv => {
    const matchesSearch = !search || 
      inv.invoice_number?.toLowerCase().includes(search.toLowerCase()) ||
      inv.customers?.full_name?.toLowerCase().includes(search.toLowerCase())
    return matchesSearch
  })

  const filteredReturns = returns.filter(ret => {
    const matchesSearch = !search || 
      ret.invoice_number?.toLowerCase().includes(search.toLowerCase()) ||
      ret.customers?.full_name?.toLowerCase().includes(search.toLowerCase()) ||
      ret.reason?.toLowerCase().includes(search.toLowerCase())
    const matchesStatus = statusFilter === 'all' || ret.status === statusFilter
    const matchesDate = (!dateFrom || new Date(ret.return_date) >= new Date(dateFrom)) &&
      (!dateTo || new Date(ret.return_date) <= new Date(dateTo))
    return matchesSearch && matchesStatus && matchesDate
  })

  function openReturnModal(inv: Invoice) {
    setSelectedInvoice(inv)
    setReturnAmount((inv.paid_amount || 0).toString())
    setReturnReason('')
    setReturnDate(new Date().toISOString().split('T')[0])
    setReturnModalOpen(true)
  }

  async function handleCreateReturn() {
    if (!selectedInvoice) return
    const amount = parseFloat(returnAmount)
    if (!amount || amount <= 0) {
      alert(isRTL ? 'أدخل مبلغ صحيح' : 'Enter a valid amount')
      return
    }
    if (amount > (selectedInvoice.paid_amount || 0)) {
      alert(isRTL ? 'مبلغ المرتجع لا يمكن أن يتجاوز المبلغ المدفوع' : 'Return amount cannot exceed paid amount')
      return
    }

    setSaving(true)
    try {
      const { error: retError } = await supabase.from('sales_returns').insert({
        invoice_id: selectedInvoice.id,
        return_date: returnDate,
        amount: amount,
        reason: returnReason,
        status: 'pending',
        customer_id: selectedInvoice.customer_id,
        invoice_number: selectedInvoice.invoice_number
      })

      if (retError) throw retError

      const newPaid = Math.max(0, (selectedInvoice.paid_amount || 0) - amount)
      const newStatus = newPaid === 0 ? 'returned' : 'partial_return'

      const { error: invError } = await supabase
        .from('invoices')
        .update({ 
          paid_amount: newPaid,
          status: newStatus
        })
        .eq('id', selectedInvoice.id)

      if (invError) throw invError

      notifyDataChanged()
      alert(isRTL ? 'تم إنشاء المرتجع بنجاح' : 'Return created successfully')
      setReturnModalOpen(false)
      setSelectedInvoice(null)
      setReturnAmount('')
      setReturnReason('')
      fetchData()
    } catch (error: any) {
      console.error('Error creating return:', error)
      alert('Error: ' + error.message)
    }
    setSaving(false)
  }

  function getStatusBadge(status: string) {
    const colors: Record<string, string> = {
      'paid': 'bg-emerald-100 text-emerald-700',
      'partial': 'bg-amber-100 text-amber-700',
      'completed': 'bg-blue-100 text-blue-700',
      'returned': 'bg-red-100 text-red-700',
      'partial_return': 'bg-orange-100 text-orange-700',
      'pending': 'bg-slate-100 text-slate-700',
      'approved': 'bg-emerald-100 text-emerald-700',
      'rejected': 'bg-red-100 text-red-700'
    }
    return colors[status] || 'bg-slate-100 text-slate-700'
  }

  const statusOptions = [
    { value: 'all', label: isRTL ? 'الكل' : 'All' },
    { value: 'pending', label: isRTL ? 'معلق' : 'Pending' },
    { value: 'approved', label: isRTL ? 'معتمد' : 'Approved' },
    { value: 'rejected', label: isRTL ? 'مرفوض' : 'Rejected' },
  ]

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto p-4 space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => router.push('/sales')} className="rounded-lg gap-1">
              <ArrowLeft className="w-4 h-4" /> {isRTL ? 'رجوع' : 'Back'}
            </Button>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <RotateCcw className="w-6 h-6 text-red-500" /> {isRTL ? 'مرتجعات المبيعات' : 'Sales Returns'}
            </h1>
          </div>
        </div>

        {/* Filters */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Filter className="w-4 h-4 text-slate-400" />
              <span className="text-sm font-medium text-slate-500">{isRTL ? 'فلاتر البحث' : 'Search Filters'}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input 
                  placeholder={isRTL ? 'بحث...' : 'Search...'}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-10 h-9 rounded-lg text-sm"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 rounded-lg text-sm">
                  <SelectValue placeholder={isRTL ? 'الحالة' : 'Status'} />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <Input type="date" value={dateFromDraft} onChange={e => setDateFromDraft(e.target.value)} className="h-9 rounded-lg text-sm" placeholder={isRTL ? 'من' : 'From'} />
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <Input type="date" value={dateToDraft} onChange={e => setDateToDraft(e.target.value)} className="h-9 rounded-lg text-sm" placeholder={isRTL ? 'إلى' : 'To'} />
              </div>
              <Button size="sm" onClick={applyDates} className="h-9 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white">
                {isRTL ? 'عرض' : 'GO'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Available Invoices for Return */}
        <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider flex items-center justify-between">
              <span>{isRTL ? 'الفواتير المتاحة للمرتجع' : 'Available Invoices for Return'}</span>
              <Badge variant="secondary">{filteredInvoices.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
              </div>
            ) : filteredInvoices.length === 0 ? (
              <div className="text-center py-8 text-slate-500">
                {isRTL ? 'لا توجد فواتير متاحة للمرتجع' : 'No invoices available for return'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-700 sticky top-0">
                    <tr>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'الفاتورة' : 'Invoice'}</th>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'العميل' : 'Customer'}</th>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'التاريخ' : 'Date'}</th>
                      <th className="text-right py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'المبلغ' : 'Amount'}</th>
                      <th className="text-right py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'المدفوع' : 'Paid'}</th>
                      <th className="text-center py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'الحالة' : 'Status'}</th>
                      <th className="text-center py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'إجراء' : 'Action'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInvoices.map(inv => (
                      <tr key={inv.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                        <td className="py-2.5 px-3 font-medium">{inv.invoice_number}</td>
                        <td className="py-2.5 px-3">{inv.customers?.full_name || '-'}</td>
                        <td className="py-2.5 px-3 text-slate-500">{formatDate(inv.invoice_date)}</td>
                        <td className="py-2.5 px-3 text-right font-medium">{formatCurrency(inv.total_amount)}</td>
                        <td className="py-2.5 px-3 text-right text-emerald-600 font-medium">{formatCurrency(inv.paid_amount || 0)}</td>
                        <td className="py-2.5 px-3 text-center">
                          <Badge className={getStatusBadge(inv.status)}>{inv.status}</Badge>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <Button 
                            size="sm" 
                            variant="outline"
                            onClick={() => openReturnModal(inv)}
                            className="rounded-lg gap-1 text-red-600 border-red-200 hover:bg-red-50 hover:border-red-300"
                          >
                            <RotateCcw className="w-3 h-3" /> {isRTL ? 'مرتجع' : 'Return'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Return History */}
        {returns.length > 0 && (
          <Card className="rounded-xl border border-slate-200 dark:border-slate-700">
            <CardHeader>
              <CardTitle className="text-sm font-semibold text-slate-500 uppercase tracking-wider flex items-center justify-between">
                <span>{isRTL ? 'سجل المرتجعات' : 'Return History'}</span>
                <Badge variant="secondary">{filteredReturns.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-700 sticky top-0">
                    <tr>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'رقم المرتجع' : 'Return #'}</th>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'الفاتورة' : 'Invoice'}</th>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'العميل' : 'Customer'}</th>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'التاريخ' : 'Date'}</th>
                      <th className="text-right py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'المبلغ' : 'Amount'}</th>
                      <th className="text-left py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'السبب' : 'Reason'}</th>
                      <th className="text-center py-2.5 px-3 font-semibold text-slate-500">{isRTL ? 'الحالة' : 'Status'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReturns.map(ret => (
                      <tr key={ret.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                        <td className="py-2.5 px-3 font-mono text-xs text-slate-500">{ret.id.slice(0, 8)}</td>
                        <td className="py-2.5 px-3 font-medium">{ret.invoice_number}</td>
                        <td className="py-2.5 px-3">{ret.customers?.full_name || '-'}</td>
                        <td className="py-2.5 px-3 text-slate-500">{formatDate(ret.return_date)}</td>
                        <td className="py-2.5 px-3 text-right font-bold text-red-600">{formatCurrency(ret.amount)}</td>
                        <td className="py-2.5 px-3 text-slate-600 max-w-xs truncate">{ret.reason || '-'}</td>
                        <td className="py-2.5 px-3 text-center">
                          <Badge className={getStatusBadge(ret.status)}>{ret.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Return Modal */}
        <Dialog open={returnModalOpen} onOpenChange={setReturnModalOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <RotateCcw className="w-5 h-5 text-red-500" />
                {isRTL ? 'إنشاء مرتجع' : 'Create Return'}
              </DialogTitle>
            </DialogHeader>
            {selectedInvoice && (
              <div className="space-y-4 py-4">
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3 text-sm border border-slate-200 dark:border-slate-600">
                  <p><span className="text-slate-500">{isRTL ? 'الفاتورة:' : 'Invoice:'}</span> <span className="font-medium">{selectedInvoice.invoice_number}</span></p>
                  <p><span className="text-slate-500">{isRTL ? 'العميل:' : 'Customer:'}</span> <span className="font-medium">{selectedInvoice.customers?.full_name}</span></p>
                  <p><span className="text-slate-500">{isRTL ? 'المبلغ المدفوع:' : 'Paid Amount:'}</span> <span className="font-medium text-emerald-600">{formatCurrency(selectedInvoice.paid_amount || 0)}</span></p>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs">{isRTL ? 'تاريخ المرتجع *' : 'Return Date *'}</Label>
                  <Input type="date" value={returnDate} onChange={e => setReturnDate(e.target.value)} className="h-10 rounded-lg" />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs">{isRTL ? 'مبلغ المرتجع (د.ب) *' : 'Return Amount (BHD) *'}</Label>
                  <div className="relative">
                    <DollarSign className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input 
                      type="number" 
                      step="0.001" 
                      value={returnAmount} 
                      onChange={e => setReturnAmount(e.target.value)}
                      className="pl-10 h-10 text-lg font-bold text-red-600 rounded-lg"
                    />
                  </div>
                  {selectedInvoice.paid_amount && parseFloat(returnAmount || '0') > selectedInvoice.paid_amount && (
                    <p className="text-xs text-red-500">{isRTL ? 'المبلغ يتجاوز المدفوع!' : 'Amount exceeds paid amount!'}</p>
                  )}
                  <button 
                    type="button"
                    onClick={() => setReturnAmount((selectedInvoice.paid_amount || 0).toString())}
                    className="text-xs text-emerald-600 hover:underline"
                  >
                    {isRTL ? 'استخدام المبلغ المدفوع كاملاً' : 'Use full paid amount'}
                  </button>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs">{isRTL ? 'سبب المرتجع' : 'Return Reason'}</Label>
                  <Input 
                    type="text" 
                    value={returnReason} 
                    onChange={e => setReturnReason(e.target.value)}
                    placeholder={isRTL ? 'سبب المرتجع...' : 'Enter return reason...'}
                    className="h-10 rounded-lg"
                  />
                </div>
              </div>
            )}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setReturnModalOpen(false)} className="rounded-lg">
                <X className="w-4 h-4 mr-1" /> {isRTL ? 'إلغاء' : 'Cancel'}
              </Button>
              <Button 
                onClick={handleCreateReturn} 
                disabled={Boolean(saving || !returnAmount || parseFloat(returnAmount || '0') <= 0 || (selectedInvoice?.paid_amount && parseFloat(returnAmount || '0') > selectedInvoice.paid_amount))}
                className="rounded-lg bg-red-500 hover:bg-red-600 text-white gap-1"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {isRTL ? 'حفظ المرتجع' : 'Save Return'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>}>
      <SalesReturnsContent />
    </Suspense>
  )
}
