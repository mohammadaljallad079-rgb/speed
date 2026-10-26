"use client"
import { Suspense } from 'react'
export const dynamic = "force-dynamic"
import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { createClient } from '@supabase/supabase-js'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, FileText, User, Car, Calendar, DollarSign, CheckCircle, XCircle, Clock, CreditCard, Save, Loader2, Receipt } from 'lucide-react'
import Link from 'next/link'
import { nextDocumentNumber } from '@/lib/numbering'
import { carStatusForContractChange } from '@/lib/rental/car-status'
import { submitReceipt } from '@/lib/sales/receipt-client'
import { notifyDataChanged } from '@/lib/hooks/use-report-refresh'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

function PageContent() {
  const { t, language } = useLanguage()
  // The posting company is resolved SERVER-side from the session by
  // `/api/receipts`; the page no longer needs it for a financial write.
  const router = useRouter()
  const params = useParams()
  const id = params?.id as string
  const isRTL = language === 'ar'
  const [contract, setContract] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState(false)

  const [paymentModalOpen, setPaymentModalOpen] = useState(false)
  const [paymentLoading, setPaymentLoading] = useState(false)
  const [invoice, setInvoice] = useState<any>(null)
  const [accounts, setAccounts] = useState<any[]>([])
  const [paymentForm, setPaymentForm] = useState({
    amount: '',
    payment_date: new Date().toISOString().split('T')[0],
    payment_method: 'cash',
    notes: '',
    receipt_number: '',
  })

  useEffect(() => { if (id) fetchContract() }, [id])

  async function fetchContract() {
    const { data } = await supabase
      .from('rental_contracts')
      .select('*, car:cars(*), customer:customers(*)')
      .eq('id', id)
      .single()
    setContract(data)
    setLoading(false)
  }

  async function updateStatus(status: string) {
    setApproving(true)
    try {
      if (status === 'active') {
        // Confirmation is server-authoritative and idempotent: one call
        // activates the contract AND issues its invoice through the single
        // sales posting path. The browser used to update the status and then
        // check-then-create the invoice, which two concurrent approvals could
        // both pass — billing the same rental twice.
        const res = await fetch('/api/rentals/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contract_id: id }),
        })
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(payload?.error || 'Failed to confirm the booking')
      } else {
        const { error } = await supabase.from('rental_contracts').update({ status }).eq('id', id)
        if (error) throw error
      }

      // Emit the matching operational notification (best-effort; the server
      // rebuilds the content from the contract row, tenant-scoped).
      const notifyEvent = status === 'active' ? 'booking_confirmed' : status === 'cancelled' ? 'booking_cancelled' : null
      if (notifyEvent) {
        fetch('/api/notifications?op=emit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: notifyEvent, contractId: id }),
        }).catch((e) => console.error('Notification emit failed:', e))
      }

      // A terminal transition returns the vehicle to the pool; otherwise the
      // denormalised `cars.status` flag stays `rented` forever (Exec 57).
      const releaseStatus = carStatusForContractChange(status)
      if (releaseStatus && contract?.car_id) {
        await supabase.from('cars').update({ status: releaseStatus }).eq('id', contract.car_id)
      }

      await fetchContract()
    } catch (err) {
      console.error('Status update failed:', err)
      alert((err as Error).message || 'Could not update the booking')
    } finally {
      setApproving(false)
    }
  }

  async function openPaymentModal() {
    const { data: invData } = await supabase
      .from('invoices')
      .select('*')
      .eq('rental_contract_id', id)
      .order('created_at', { ascending: false })
      .maybeSingle()
    setInvoice(invData)

    const { data: accData } = await supabase
      .from('accounts')
      .select('id, code, name_ar, name_en')
      .in('type', ['asset'])
      .order('code')
    setAccounts(accData || [])

    const receiptNumber = await nextDocumentNumber(supabase, 'receipt', 'REC')
    setPaymentForm({
      receipt_number: receiptNumber,
      amount: invData ? (invData.total_amount - (invData.paid_amount || 0)).toFixed(3) : (contract?.total_amount || 0).toFixed(3),
      payment_date: new Date().toISOString().split('T')[0],
      payment_method: 'cash',
      notes: '',
    })

    setPaymentModalOpen(true)
  }

  async function handlePaymentSubmit() {
    if (!paymentForm.amount || parseFloat(paymentForm.amount) <= 0) {
      alert(isRTL ? 'يرجى إدخال مبلغ صحيح' : 'Please enter a valid amount')
      return
    }

    setPaymentLoading(true)
    try {
      // ONE server-side transaction: the payment, its ledger posting and the
      // invoice settlement. The browser used to insert the payment, update the
      // invoice and then post the journal in a try/catch that swallowed the
      // failure - so a receipt could be recorded without its accounting entry
      // and the page still reported success. That defect is closed here: the
      // server either commits all three or refuses, and a refusal is shown.
      const result = await submitReceipt({
        receipt_number: paymentForm.receipt_number,
        customer_id: contract?.customer_id,
        invoice_id: invoice?.id || null,
        rental_contract_id: id,
        amount: parseFloat(paymentForm.amount),
        payment_method: paymentForm.payment_method,
        payment_date: paymentForm.payment_date,
        payment_type: 'receipt',
        notes: paymentForm.notes || null,
      })

      // A receipt that settles the invoice completes the contract and releases
      // the vehicle. This is a status transition, not a financial write.
      if (result.invoice_status === 'paid') {
        await supabase.from('rental_contracts').update({ status: 'completed' }).eq('id', id)
        if (contract?.car_id) {
          const releaseStatus = carStatusForContractChange('completed')
          if (releaseStatus) {
            await supabase.from('cars').update({ status: releaseStatus }).eq('id', contract.car_id)
          }
        }
      }

      setPaymentModalOpen(false)
      setPaymentForm({
        amount: '',
        payment_date: new Date().toISOString().split('T')[0],
        payment_method: 'cash',
        notes: '',
        receipt_number: '',
      })
      await fetchContract()
      notifyDataChanged()
      alert(isRTL ? 'تم تسجيل الدفعة بنجاح' : 'Payment recorded successfully')
    } catch (err: any) {
      console.error('Payment error:', err)
      // The server refused: nothing was written, so say exactly that.
      alert(err.message || (isRTL ? 'خطأ في تسجيل الدفعة' : 'Error recording payment'))
    } finally {
      setPaymentLoading(false)
    }
  }

  function formatCurrency(v: any) {
    return (parseFloat(v) || 0).toFixed(3) + ' BHD'
  }

  function getStatusColor(s: string) {
    if (s === 'active') return 'bg-green-100 text-green-700'
    if (s === 'pending') return 'bg-yellow-100 text-yellow-700'
    if (s === 'completed') return 'bg-blue-100 text-blue-700'
    if (s === 'cancelled') return 'bg-red-100 text-red-700'
    return 'bg-slate-100 text-slate-700'
  }

  if (loading) return <DashboardLayout><div className="flex items-center justify-center h-64"><div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div></div></DashboardLayout>
  if (!contract) return <DashboardLayout><div className="text-center py-20 text-slate-500">{isRTL ? 'العقد غير موجود' : 'Contract not found'}</div></DashboardLayout>

  const remainingAmount = invoice ? (invoice.total_amount - (invoice.paid_amount || 0)) : (contract?.total_amount || 0)

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/rentals"><Button variant="outline" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
            <div>
              <h1 className="text-2xl font-bold text-slate-800">{contract.contract_number}</h1>
              <p className="text-slate-500 text-sm">{isRTL ? 'تفاصيل عقد الإيجار' : 'Rental Contract Details'}</p>
            </div>
          </div>
          <Badge className={getStatusColor(contract.status)}>{contract.status}</Badge>
        </div>

        {contract.status === 'pending' && (
          <Card className="border-0 shadow-md bg-yellow-50">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Clock className="w-6 h-6 text-yellow-600" />
                  <div>
                    <p className="font-semibold text-yellow-800">{isRTL ? 'طلب حجز جديد - بانتظار الموافقة' : 'New Booking Request - Pending Approval'}</p>
                    <p className="text-sm text-yellow-600">{isRTL ? 'يرجى مراجعة التفاصيل والموافقة أو الرفض' : 'Please review details and approve or reject'}</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <Button onClick={() => updateStatus('active')} disabled={approving} className="bg-green-500 hover:bg-green-600 text-white">
                    <CheckCircle className="w-4 h-4 mr-2" />
                    {isRTL ? 'موافقة' : 'Approve'}
                  </Button>
                  <Button onClick={() => updateStatus('cancelled')} disabled={approving} variant="outline" className="border-red-300 text-red-600 hover:bg-red-50">
                    <XCircle className="w-4 h-4 mr-2" />
                    {isRTL ? 'رفض' : 'Reject'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border-0 shadow-md">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base text-slate-700">
                <User className="w-4 h-4 text-cyan-500" />
                {isRTL ? 'بيانات العميل' : 'Customer Details'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'الاسم' : 'Name'}</span><span className="font-medium">{contract.customer?.full_name}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'الهاتف' : 'Phone'}</span><span className="font-medium">{contract.customer?.phone}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'البريد' : 'Email'}</span><span className="font-medium">{contract.customer?.email || '-'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">CPR</span><span className="font-medium">{contract.customer?.cpr_number || '-'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'رخصة القيادة' : 'License'}</span><span className="font-medium">{contract.customer?.driver_license || '-'}</span></div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-md">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base text-slate-700">
                <Car className="w-4 h-4 text-cyan-500" />
                {isRTL ? 'بيانات السيارة' : 'Car Details'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'الماركة' : 'Make'}</span><span className="font-medium">{contract.car?.make} {contract.car?.model}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'السنة' : 'Year'}</span><span className="font-medium">{contract.car?.year}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'اللوحة' : 'Plate'}</span><span className="font-medium">{contract.car?.plate_number}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'اللون' : 'Color'}</span><span className="font-medium">{contract.car?.color || '-'}</span></div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-md">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base text-slate-700">
                <Calendar className="w-4 h-4 text-cyan-500" />
                {isRTL ? 'تفاصيل الحجز' : 'Booking Details'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'تاريخ البداية' : 'Start Date'}</span><span className="font-medium">{contract.start_date}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'تاريخ النهاية' : 'End Date'}</span><span className="font-medium">{contract.end_date}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'موقع الاستلام' : 'Pickup'}</span><span className="font-medium">{contract.pickup_location || '-'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'موقع الإرجاع' : 'Dropoff'}</span><span className="font-medium">{contract.dropoff_location || '-'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'ملاحظات' : 'Notes'}</span><span className="font-medium">{contract.notes || '-'}</span></div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-md">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base text-slate-700">
                <DollarSign className="w-4 h-4 text-cyan-500" />
                {isRTL ? 'المبالغ' : 'Financials'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'السعر اليومي' : 'Daily Rate'}</span><span className="font-medium">{formatCurrency(contract.daily_rate)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'عدد الأيام' : 'Total Days'}</span><span className="font-medium">{contract.total_days}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'المجموع الفرعي' : 'Subtotal'}</span><span className="font-medium">{formatCurrency(contract.subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'الضريبة' : 'VAT'}</span><span className="font-medium">{formatCurrency(contract.vat_amount)}</span></div>
              <div className="flex justify-between border-t pt-3"><span className="font-bold text-slate-700">{isRTL ? 'الإجمالي' : 'Total'}</span><span className="font-bold text-cyan-600 text-lg">{formatCurrency(contract.total_amount)}</span></div>
              {invoice && (
                <>
                  <div className="flex justify-between border-t pt-3"><span className="text-slate-500">{isRTL ? 'المدفوع' : 'Paid'}</span><span className="font-medium text-emerald-600">{formatCurrency(invoice.paid_amount || 0)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'المتبقي' : 'Remaining'}</span><span className="font-medium text-red-600">{formatCurrency(remainingAmount)}</span></div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {contract.status === 'active' && (
          <Card className="border-0 shadow-md">
            <CardContent className="pt-6 flex gap-3 flex-wrap">
              <Button onClick={openPaymentModal} className="bg-emerald-500 hover:bg-emerald-600 text-white">
                <CreditCard className="w-4 h-4 mr-2" />
                {isRTL ? 'تسجيل دفعة' : 'Record Payment'}
              </Button>
              <Button onClick={() => updateStatus('completed')} className="bg-blue-500 hover:bg-blue-600 text-white">
                <CheckCircle className="w-4 h-4 mr-2" />
                {isRTL ? 'إنهاء العقد' : 'Complete Contract'}
              </Button>
              <Button onClick={() => updateStatus('cancelled')} variant="outline" className="border-red-300 text-red-600 hover:bg-red-50">
                <XCircle className="w-4 h-4 mr-2" />
                {isRTL ? 'إلغاء العقد' : 'Cancel Contract'}
              </Button>
            </CardContent>
          </Card>
        )}

        <Dialog open={paymentModalOpen} onOpenChange={setPaymentModalOpen}>
          <DialogContent className="max-w-lg" dir={isRTL ? 'rtl' : 'ltr'}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Receipt className="w-5 h-5 text-emerald-500" />
                {isRTL ? 'تسجيل دفعة' : 'Record Payment'}
                <span className="text-sm text-slate-400 font-normal">- {contract.contract_number}</span>
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {invoice && (
                <div className="p-3 bg-slate-50 rounded-lg text-sm">
                  <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'الفاتورة:' : 'Invoice:'}</span><span className="font-medium">{invoice.invoice_number}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'الإجمالي:' : 'Total:'}</span><span className="font-medium">{formatCurrency(invoice.total_amount)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">{isRTL ? 'المتبقي:' : 'Remaining:'}</span><span className="font-medium text-red-600">{formatCurrency(remainingAmount)}</span></div>
                </div>
              )}

              <div className="space-y-2">
                <Label>{isRTL ? 'رقم الإيصال' : 'Receipt Number'}</Label>
                <Input value={paymentForm.receipt_number} onChange={e => setPaymentForm({...paymentForm, receipt_number: e.target.value})} className="font-mono" />
              </div>

              <div className="space-y-2">
                <Label>{isRTL ? 'المبلغ (د.ب)' : 'Amount (BHD)'} *</Label>
                <Input type="number" step="0.001" value={paymentForm.amount} onChange={e => setPaymentForm({...paymentForm, amount: e.target.value})} className="text-xl font-bold text-center" placeholder="0.000" />
                {remainingAmount > 0 && (
                  <button type="button" onClick={() => setPaymentForm({...paymentForm, amount: remainingAmount.toFixed(3)})} className="text-xs text-emerald-600 hover:underline">
                    {isRTL ? 'دفع المتبقي كاملاً: ' + remainingAmount.toFixed(3) + ' د.ب' : 'Pay full remaining: ' + remainingAmount.toFixed(3) + ' BHD'}
                  </button>
                )}
              </div>

              <div className="space-y-2">
                <Label>{isRTL ? 'تاريخ الدفع' : 'Payment Date'}</Label>
                <Input type="date" value={paymentForm.payment_date} onChange={e => setPaymentForm({...paymentForm, payment_date: e.target.value})} />
              </div>

              <div className="space-y-2">
                <Label>{isRTL ? 'طريقة الدفع' : 'Payment Method'}</Label>
                <Select value={paymentForm.payment_method} onValueChange={v => setPaymentForm({...paymentForm, payment_method: v})}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">{isRTL ? 'نقداً' : 'Cash'}</SelectItem>
                    <SelectItem value="card">{isRTL ? 'بطاقة' : 'Card'}</SelectItem>
                    <SelectItem value="transfer">{isRTL ? 'تحويل بنكي' : 'Bank Transfer'}</SelectItem>
                    <SelectItem value="cheque">{isRTL ? 'شيك' : 'Cheque'}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>{isRTL ? 'ملاحظات' : 'Notes'}</Label>
                <Input value={paymentForm.notes} onChange={e => setPaymentForm({...paymentForm, notes: e.target.value})} placeholder={isRTL ? 'ملاحظات اختيارية' : 'Optional notes'} />
              </div>
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setPaymentModalOpen(false)}>{isRTL ? 'إلغاء' : 'Cancel'}</Button>
              <Button onClick={handlePaymentSubmit} disabled={paymentLoading} className="bg-emerald-500 hover:bg-emerald-600 text-white">
                {paymentLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                {isRTL ? 'حفظ الدفعة' : 'Save Payment'}
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
    <Suspense fallback={<div>Loading...</div>}>
      <PageContent />
    </Suspense>
  )
}
