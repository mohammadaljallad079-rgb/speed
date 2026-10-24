"use client"
import { Suspense } from 'react'
import { notifyDataChanged } from '@/lib/hooks/use-report-refresh'
export const dynamic = "force-dynamic"
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { nextDocumentNumber } from '@/lib/numbering'
import { postCustomerReceipt } from '@/lib/accounting/receipt-posting'
import RecordSelect from '@/components/records/RecordSelect'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Receipt, Save, ArrowLeft, Car, User, DollarSign, FileText, Printer, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import Link from 'next/link'

function NewPaymentPageContent() {
  const { t, isRTL } = useLanguage()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [mounted, setMounted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [customers, setCustomers] = useState<any[]>([])
  const [invoices, setInvoices] = useState<any[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null)
  const [customerBalance, setCustomerBalance] = useState(0)
  const [showPrintPreview, setShowPrintPreview] = useState(false)
  const [form, setForm] = useState({
    receipt_number: '',
    customer_id: '',
    invoice_id: '',
    amount: '',
    payment_type: 'receipt',
    payment_method: 'cash',
    payment_date: new Date().toISOString().split('T')[0],
    car_plate: '',
    car_info: '',
    notes: '',
  })

  useEffect(() => {
    setMounted(true)
    fetchCustomers()
    generateReceiptNumber()
    const invId = searchParams.get('invoice_id')
    if (invId) prefillFromInvoice(invId)
  }, [])

  async function prefillFromInvoice(invoiceId: string) {
    const { data: inv } = await supabase
      .from('invoices')
      .select('*, rental_contract:rental_contracts(car:cars(make,model,plate_number))')
      .eq('id', invoiceId)
      .single()
    if (!inv) return
    await fetchCustomerData(inv.customer_id)
    const remaining = (inv.total_amount || 0) - (inv.paid_amount || 0)
    setForm(prev => ({
      ...prev,
      customer_id: inv.customer_id,
      invoice_id: inv.id,
      amount: remaining > 0 ? remaining.toFixed(3) : '',
      car_plate: inv.rental_contract?.car?.plate_number || '',
      car_info: inv.rental_contract?.car ? `${inv.rental_contract.car.make} ${inv.rental_contract.car.model}` : '',
    }))
  }

  async function generateReceiptNumber() {
    // Row-locked numbering RPC. The old row-count number (`REC-<count+1>`)
    // collides whenever two receipts are created before the list refreshes.
    const number = await nextDocumentNumber(supabase as never, 'receipt', 'REC')
    setForm(prev => ({ ...prev, receipt_number: number }))
  }

  async function fetchCustomers() {
    const { data } = await supabase.from('customers').select('*').order('full_name')
    setCustomers(data || [])
  }

  async function fetchCustomerData(customerId: string) {
    const customer = customers.find(c => c.id === customerId)
    setSelectedCustomer(customer || null)

    const { data: invData } = await supabase
      .from('invoices')
      .select('*, rental_contract:rental_contracts(car:cars(make,model,plate_number))')
      .eq('customer_id', customerId)
      .in('status', ['pending', 'overdue', 'partial'])
      .order('invoice_date', { ascending: false })
    setInvoices(invData || [])

    const balance = (invData || []).reduce((sum: number, inv: any) => sum + (inv.total_amount - (inv.paid_amount || 0)), 0)
    setCustomerBalance(balance)
  }

  function handleCustomerChange(customerId: string) {
    setForm(prev => ({ ...prev, customer_id: customerId, invoice_id: '', car_plate: '', car_info: '' }))
    fetchCustomerData(customerId)
  }

  function handleInvoiceChange(invoiceId: string) {
    const invoice = invoices.find((inv: any) => inv.id === invoiceId)
    if (invoice) {
      const remaining = invoice.total_amount - (invoice.paid_amount || 0)
      const car = invoice.rental_contract?.car
      setForm(prev => ({
        ...prev,
        invoice_id: invoiceId,
        amount: remaining.toFixed(3),
        car_plate: car?.plate_number || '',
        car_info: car ? `${car.make || ''} ${car.model || ''}`.trim() : '',
      }))
    }
  }

  async function handleSubmit() {
    if (!form.customer_id || !form.amount) {
      alert(isRTL ? 'يرجى تعبئة الحقول المطلوبة' : 'Please fill required fields')
      return
    }
    setLoading(true)
    try {
      const { error } = await supabase.from('payments').insert([{
        receipt_number: form.receipt_number,
        customer_id: form.customer_id,
        invoice_id: form.invoice_id || null,
        amount: parseFloat(form.amount),
        payment_type: form.payment_type,
        payment_method: form.payment_method,
        payment_date: form.payment_date,
        car_plate: form.car_plate || null,
        notes: form.notes || null,
        status: 'completed',
      }])
      if (error) throw error

      if (form.invoice_id) {
        const invoice = invoices.find((inv: any) => inv.id === form.invoice_id)
        if (invoice) {
          const newPaid = (invoice.paid_amount || 0) + parseFloat(form.amount)
          const newStatus = newPaid >= invoice.total_amount ? 'paid' : 'pending'
          await supabase.from('invoices').update({ paid_amount: newPaid, status: newStatus }).eq('id', form.invoice_id)
        }
      }

      // Post the GL entry. Recording a receipt without a journal would leave the
      // ledger and the cash/AR balances disagreeing with the payments list
      // (Exec 33, Item 5/10). A receipt settles the receivable: Dr Cash/Bank,
      // Cr AR (12001). It must never credit revenue - revenue was recognised
      // when the invoice was issued.
      if (form.payment_type === 'receipt') {
        try {
          const journalNumber = await nextDocumentNumber(supabase as never, 'journal_entry', 'JV')
          await postCustomerReceipt(supabase as never, {
            journalNumber,
            receiptNumber: form.receipt_number,
            amount: parseFloat(form.amount),
            paymentDate: form.payment_date,
            paymentMethod: form.payment_method,
            description: isRTL
              ? 'قبض دفعة - ' + form.receipt_number
              : 'Payment received - ' + form.receipt_number,
          })
        } catch (postErr: any) {
          // The receipt row is already saved; surface the failure instead of
          // pretending the ledger is consistent.
          alert(isRTL ? 'تم حفظ الإيصال لكن فشل الترحيل المحاسبي: ' + (postErr?.message || '') : 'Receipt saved but the GL posting failed: ' + (postErr?.message || ''))
        }
      }

      notifyDataChanged()
      router.push('/payments')
    } catch (err: any) {
      alert(err.message || 'Error saving receipt')
    } finally {
      setLoading(false)
    }
  }

  if (!mounted) return null

  const isReceipt = form.payment_type === 'receipt'

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <header className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Link href="/payments">
              <Button variant="ghost" size="icon" className="rounded-lg h-8 w-8">
                <ArrowLeft className={`w-4 h-4 ${isRTL ? 'rotate-180' : ''}`} />
              </Button>
            </Link>
            <div>
              <h1 className="text-base font-bold text-slate-900 dark:text-white">{isRTL ? 'إضافة إيصال جديد' : 'Add New Receipt'}</h1>
              <p className="text-slate-400 text-xs">{isRTL ? 'إصدار سند قبض/صرف' : 'Issue payment receipt/voucher'}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowPrintPreview(true)} className="rounded-lg text-xs gap-1.5">
            <Printer className="w-3.5 h-3.5" />
            {isRTL ? 'معاينة' : 'Preview'}
          </Button>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 space-y-3">

            {/* Payment Type & Info */}
            <Card className="rounded-xl border border-slate-200 dark:border-slate-700 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3 text-slate-700 dark:text-slate-300">
                  {isReceipt ? <ArrowDownLeft className="w-4 h-4 text-emerald-500" /> : <ArrowUpRight className="w-4 h-4 text-rose-500" />}
                  <span className="text-xs font-semibold uppercase tracking-wider">{isRTL ? 'نوع العملية' : 'Transaction Type'}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'النوع' : 'Type'}</Label>
                    <Select value={form.payment_type} onValueChange={v => setForm({...form, payment_type: v})}>
                      <SelectTrigger className="text-xs h-8 rounded-lg bg-slate-50 dark:bg-slate-900 border-slate-200">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="receipt">{isRTL ? 'سند قبض' : 'Receipt'}</SelectItem>
                        <SelectItem value="refund">{isRTL ? 'سند صرف' : 'Refund'}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'رقم الإيصال' : 'Receipt No'}</Label>
                    <Input value={form.receipt_number} onChange={e => setForm({...form, receipt_number: e.target.value})} className="font-mono text-xs h-8 rounded-lg bg-slate-50 dark:bg-slate-900 border-slate-200" />
                  </div>
                  <div>
                    <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'تاريخ الدفع' : 'Date'}</Label>
                    <Input type="date" value={form.payment_date} onChange={e => setForm({...form, payment_date: e.target.value})} className="text-xs h-8 rounded-lg bg-slate-50 dark:bg-slate-900 border-slate-200" />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Payment Method */}
            <Card className="rounded-xl border border-slate-200 dark:border-slate-700 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3 text-slate-700 dark:text-slate-300">
                  <DollarSign className="w-4 h-4 text-slate-500" />
                  <span className="text-xs font-semibold uppercase tracking-wider">{isRTL ? 'طريقة الدفع' : 'Payment Method'}</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {[
                    { value: 'cash', label: isRTL ? 'نقداً' : 'Cash', labelAr: 'نقداً' },
                    { value: 'card', label: isRTL ? 'بطاقة' : 'Card', labelAr: 'بطاقة' },
                    { value: 'transfer', label: isRTL ? 'تحويل' : 'Transfer', labelAr: 'تحويل' },
                    { value: 'cheque', label: isRTL ? 'شيك' : 'Cheque', labelAr: 'شيك' },
                  ].map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setForm({...form, payment_method: m.value})}
                      className={`px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                        form.payment_method === m.value
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      {isRTL ? m.labelAr : m.label}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Customer & Invoice */}
            <Card className="rounded-xl border border-slate-200 dark:border-slate-700 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3 text-slate-700 dark:text-slate-300">
                  <User className="w-4 h-4 text-slate-500" />
                  <span className="text-xs font-semibold uppercase tracking-wider">{isRTL ? 'العميل والفاتورة' : 'Customer & Invoice'}</span>
                </div>
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'العميل' : 'Customer'} *</Label>
                    <RecordSelect
                      kind="customer"
                      value={form.customer_id}
                      onChange={(id) => handleCustomerChange(id)}
                      createMode="inline"
                      placeholder={isRTL ? 'اختر العميل' : 'Select customer'}
                    />
                  </div>

                  {selectedCustomer && (
                    <div className="flex items-center justify-between p-2 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-100">
                      <span className="text-xs text-slate-500">{isRTL ? 'الرصيد:' : 'Balance:'}</span>
                      <span className={`text-xs font-bold ${customerBalance > 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                        {customerBalance.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}
                      </span>
                    </div>
                  )}

                  {invoices.length > 0 && (
                    <div>
                      <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'الفاتورة' : 'Invoice'}</Label>
                      <Select value={form.invoice_id} onValueChange={handleInvoiceChange}>
                        <SelectTrigger className="text-xs h-8 rounded-lg bg-slate-50 dark:bg-slate-900 border-slate-200"><SelectValue placeholder={isRTL ? 'اختر فاتورة' : 'Select invoice'} /></SelectTrigger>
                        <SelectContent>
                          {invoices.map((inv: any) => (
                            <SelectItem key={inv.id} value={inv.id}>
                              {inv.invoice_number} — {(inv.total_amount - (inv.paid_amount || 0)).toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {form.car_plate && (
                    <div className="flex items-center gap-2 p-2 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-100">
                      <Car className="w-3.5 h-3.5 text-slate-500" />
                      <span className="text-xs font-medium text-slate-700">{form.car_info} — {form.car_plate}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Notes */}
            <Card className="rounded-xl border border-slate-200 dark:border-slate-700 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3 text-slate-700 dark:text-slate-300">
                  <FileText className="w-4 h-4 text-slate-500" />
                  <span className="text-xs font-semibold uppercase tracking-wider">{isRTL ? 'ملاحظات' : 'Notes'}</span>
                </div>
                <Input value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} placeholder={isRTL ? 'ملاحظات...' : 'Notes...'} className="text-xs h-8 rounded-lg bg-slate-50 dark:bg-slate-900 border-slate-200" />
              </CardContent>
            </Card>
          </div>

          {/* Amount & Submit */}
          <div className="space-y-3">
            <Card className="rounded-xl border border-slate-200 dark:border-slate-700 shadow-none sticky top-4">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3 text-slate-700 dark:text-slate-300">
                  <DollarSign className="w-4 h-4 text-slate-500" />
                  <span className="text-xs font-semibold uppercase tracking-wider">{isRTL ? 'المبلغ' : 'Amount'}</span>
                </div>
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'المبلغ (د.ب)' : 'Amount (BHD)'} *</Label>
                    <Input type="number" step="0.001" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} className={`text-xl font-bold text-center h-12 rounded-lg border-2 ${isReceipt ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-rose-50 border-rose-200 text-rose-700'}`} placeholder="0.000" />
                  </div>
                  {customerBalance > 0 && isReceipt && (
                    <button type="button" onClick={() => setForm({...form, amount: customerBalance.toFixed(3)})} className="w-full text-xs text-slate-600 hover:text-slate-800 font-medium py-1.5 bg-slate-100 rounded-lg transition-colors">
                      {isRTL ? `دفع كامل: ${customerBalance.toFixed(3)}` : `Pay full: ${customerBalance.toFixed(3)} BHD`}
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Button onClick={handleSubmit} disabled={loading} className={`w-full h-10 text-white rounded-lg text-sm font-semibold ${isReceipt ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}>
              <Save className="w-4 h-4 mr-2" />
              {loading ? (isRTL ? 'جاري...' : 'Saving...') : (isReceipt ? (isRTL ? 'حفظ قبض' : 'Save Receipt') : (isRTL ? 'حفظ صرف' : 'Save Refund'))}
            </Button>
          </div>
        </div>

        {/* Print Preview Modal */}
        {showPrintPreview && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowPrintPreview(false)}>
            <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-8 print:p-0 print:shadow-none" onClick={e => e.stopPropagation()}>
              <div className="text-center mb-6">
                <div className="w-12 h-12 bg-slate-900 rounded-lg mx-auto mb-3 flex items-center justify-center">
                  <Receipt className="w-6 h-6 text-white" />
                </div>
                <h2 className="text-lg font-bold text-slate-900">{isReceipt ? (isRTL ? 'سند قبض' : 'RECEIPT') : (isRTL ? 'سند صرف' : 'REFUND VOUCHER')}</h2>
                <p className="text-xs text-slate-400 mt-1">#{form.receipt_number}</p>
              </div>
              
              <div className="space-y-3 text-sm">
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-500">{isRTL ? 'التاريخ:' : 'Date:'}</span>
                  <span className="font-medium">{form.payment_date}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-500">{isRTL ? 'العميل:' : 'Customer:'}</span>
                  <span className="font-medium">{selectedCustomer?.full_name || '-'}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-500">{isRTL ? 'طريقة الدفع:' : 'Method:'}</span>
                  <span className="font-medium">{form.payment_method}</span>
                </div>
                {form.invoice_id && (
                  <div className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-slate-500">{isRTL ? 'الفاتورة:' : 'Invoice:'}</span>
                    <span className="font-medium">{invoices.find(i => i.id === form.invoice_id)?.invoice_number || '-'}</span>
                  </div>
                )}
                <div className="flex justify-between py-3 border-b-2 border-slate-900">
                  <span className="text-slate-500 font-semibold">{isRTL ? 'المبلغ:' : 'Amount:'}</span>
                  <span className={`text-xl font-bold ${isReceipt ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {form.amount ? parseFloat(form.amount).toFixed(3) : '0.000'} BHD
                  </span>
                </div>
                {form.notes && (
                  <div className="py-2">
                    <span className="text-slate-500 block text-xs mb-1">{isRTL ? 'ملاحظات:' : 'Notes:'}</span>
                    <span className="text-slate-700">{form.notes}</span>
                  </div>
                )}
              </div>

              <div className="mt-8 pt-4 border-t border-slate-200 text-center">
                <p className="text-xs text-slate-400">{isRTL ? 'شكراً لتعاملكم معنا' : 'Thank you for your business'}</p>
              </div>

              <div className="flex gap-2 mt-6 print:hidden">
                <Button onClick={() => window.print()} className="flex-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-white">
                  <Printer className="w-4 h-4 mr-2" />
                  {isRTL ? 'طباعة' : 'Print'}
                </Button>
                <Button variant="outline" onClick={() => setShowPrintPreview(false)} className="flex-1 rounded-lg">
                  {isRTL ? 'إغلاق' : 'Close'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function NewPaymentPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <NewPaymentPageContent />
    </Suspense>
  )
}
