"use client"
import { Suspense } from 'react'
import { notifyDataChanged } from '@/lib/hooks/use-report-refresh'
export const dynamic = "force-dynamic"
import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { createClient } from '@supabase/supabase-js'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowLeft, Save, FileText, User, DollarSign, Trash2, CreditCard, RotateCcw } from 'lucide-react'
import Link from 'next/link'
import { Customer, RentalContract } from '@/lib/supabase'
import { isSaleInvoicePosted, hasInvoiceDependents } from '@/lib/accounting/invoice-guards'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

function SectionIcon({ tone, children }: { tone: 'sky' | 'violet' | 'emerald' | 'amber'; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    sky: 'bg-sky-50 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400',
    violet: 'bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400',
    emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400',
    amber: 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
  }
  return <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${tones[tone]}`}>{children}</div>
}

function PageContent() {
  const { language } = useLanguage()
  const router = useRouter()
  const params = useParams()
  const id = params?.id as string
  const isRTL = language === 'ar'
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [fetching, setFetching] = useState(true)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [rentals, setRentals] = useState<RentalContract[]>([])
  const [filteredRentals, setFilteredRentals] = useState<RentalContract[]>([])
  const [isPosted, setIsPosted] = useState(false)
  const [form, setForm] = useState({
    invoice_number: '',
    customer_id: '',
    rental_contract_id: '',
    invoice_date: '',
    due_date: '',
    amount: '',
    discount_amount: '',
    vat_amount: '',
    total_amount: '',
    paid_amount: '',
    payment_type: 'cash',
    payment_method: 'cash',
    status: 'pending',
    notes: '',
    rental_days: '',
    car_plate: '',
    car_info: '',
  })

  useEffect(() => { fetchCustomers(); fetchRentals(); fetchInvoice() }, [id])

  useEffect(() => {
    if (form.customer_id) setFilteredRentals(rentals.filter((r: any) => r.customer_id === form.customer_id))
    else setFilteredRentals(rentals)
  }, [form.customer_id, rentals])

  useEffect(() => {
    const amount = parseFloat(form.amount) || 0
    const discount = parseFloat((form as any).discount_amount) || 0
    const vat = parseFloat(form.vat_amount) || 0
    const total = Math.max(0, amount - discount + vat)
    setForm(prev => ({ ...prev, total_amount: total.toFixed(3) }))
  }, [form.amount, (form as any).discount_amount, form.vat_amount])

  async function fetchInvoice() {
    if (!id) return
    setFetching(true)
    const { data } = await supabase.from('invoices').select('*, rental_contracts(car:cars(make,model,plate_number,license_plate))').eq('id', id).single()
    if (data) {
      setIsPosted(await isSaleInvoicePosted(supabase as any, data.invoice_number || ''))
      setForm(prev => ({
        ...prev,
        invoice_number: data.invoice_number || '',
        customer_id: data.customer_id || '',
        rental_contract_id: data.rental_contract_id || 'none',
        invoice_date: data.invoice_date || '',
        due_date: data.due_date || '',
        amount: (data.amount ?? '').toString(),
        discount_amount: (data.discount_amount ?? 0).toString(),
        vat_amount: (data.vat_amount ?? '').toString(),
        total_amount: (data.total_amount ?? '').toString(),
        paid_amount: (data.paid_amount ?? 0).toString(),
        payment_type: data.payment_type || 'cash',
        payment_method: data.payment_method || 'cash',
        status: data.status || 'pending',
        notes: data.notes || '',
        rental_days: (data.rental_days ?? '').toString(),
        car_plate: data.car_plate || '',
        car_info: data.rental_contracts?.car ? `${data.rental_contracts.car.make || ''} ${data.rental_contracts.car.model || ''}`.trim() : '',
      }))
    }
    setFetching(false)
  }

  async function fetchCustomers() {
    const { data } = await supabase.from('customers').select('*').order('full_name')
    setCustomers(data || [])
  }

  async function fetchRentals() {
    const { data } = await supabase.from('rental_contracts').select('*, car:cars(make,model,plate_number,license_plate), customer:customers(full_name)').order('created_at', { ascending: false })
    setRentals((data || []) as any)
  }

  function handleChange(field: string, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  function applyVat() {
    const amount = parseFloat(form.amount) || 0
    setForm(prev => ({ ...prev, vat_amount: (amount * 0.10).toFixed(3) }))
  }

  async function handleSubmit() {
    if (isPosted) {
      alert(isRTL ? 'لا يمكن تعديل فاتورة مرحّلة محاسبيًا. استخدم إشعار دائن/مرتجع لعكسها ثم أنشئ فاتورة جديدة.' : 'This invoice is posted to the ledger and cannot be edited. Reverse it with a credit note/return, then create a new invoice.')
      return
    }
    if (!form.customer_id) { alert(isRTL ? 'يرجى اختيار العميل' : 'Please select a customer'); return }
    if (!form.amount) { alert(isRTL ? 'يرجى إدخال المبلغ' : 'Please enter an amount'); return }
    setLoading(true)
    try {
      const { error } = await supabase.from('invoices').update({
        invoice_number: form.invoice_number,
        customer_id: form.customer_id,
        rental_contract_id: form.rental_contract_id === "none" ? null : form.rental_contract_id || null,
        invoice_date: form.invoice_date,
        due_date: form.due_date || null,
        amount: parseFloat(form.amount),
        discount_amount: parseFloat((form as any).discount_amount) || 0,
        vat_amount: parseFloat(form.vat_amount) || 0,
        total_amount: parseFloat(form.total_amount) || parseFloat(form.amount),
        paid_amount: parseFloat(form.paid_amount) || 0,
        payment_type: (form as any).payment_type || 'cash',
        payment_method: (form as any).payment_method || 'cash',
        status: form.status,
        notes: form.notes || null,
        rental_days: (form as any).rental_days ? parseInt((form as any).rental_days) : null,
        car_plate: (form as any).car_plate || null,
      }).eq('id', id)
      if (error) throw error
      notifyDataChanged()
      router.push('/invoices')
    } catch (err: any) {
      alert(err.message || 'Error saving invoice')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete() {
    if (isPosted) {
      alert(isRTL ? 'لا يمكن حذف فاتورة مرحّلة محاسبيًا. استخدم إشعار دائن/مرتجع لعكسها.' : 'This invoice is posted to the ledger and cannot be deleted. Reverse it with a credit note/return instead.')
      return
    }
    if (!confirm(isRTL ? 'هل أنت متأكد من حذف هذه الفاتورة؟' : 'Are you sure you want to delete this invoice?')) return
    setDeleting(true)
    try {
      // An invoice with receipts or returns must not be deleted: those rows would
      // be orphaned. Reverse/cancel the document instead (Exec 29, Item 11).
      if (await hasInvoiceDependents(supabase as any, id)) {
        alert(isRTL ? 'لا يمكن حذف فاتورة لها دفعات أو مرتجعات مرتبطة. استخدم الإلغاء/العكس.' : 'This invoice has payments or returns attached and cannot be deleted. Cancel/reverse it instead.')
        setDeleting(false)
        return
      }
      const { error } = await supabase.from('invoices').delete().eq('id', id)
      if (error) throw error
      notifyDataChanged()
      router.push('/invoices')
    } catch (err: any) {
      alert(err.message || 'Error deleting invoice')
      setDeleting(false)
    }
  }

  async function handleReverse() {
    if (!confirm(isRTL ? 'سيتم عكس القيد المحاسبي وإلغاء الفاتورة. هل أنت متأكد؟' : 'This will post a reversing journal and cancel the invoice. Continue?')) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/invoices/${id}/reverse`, { method: "POST" })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error || 'Error reversing invoice')
      notifyDataChanged()
      router.push('/invoices')
    } catch (err: any) {
      alert(err.message || 'Error reversing invoice')
      setDeleting(false)
    }
  }

  if (fetching) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
        </div>
      </DashboardLayout>
    )
  }

  const amountNum = parseFloat(form.amount) || 0
  const discountNum = parseFloat((form as any).discount_amount) || 0
  const vatNum = parseFloat(form.vat_amount) || 0
  const totalNum = parseFloat(form.total_amount) || 0
  const paidNum = parseFloat(form.paid_amount) || 0
  const balanceNum = totalNum - paidNum

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? "rtl" : "ltr"}>
        <div className="flex items-center gap-4 justify-between">
          <div className="flex items-center gap-4">
            <Link href="/invoices">
              <Button variant="outline" size="icon"><ArrowLeft className={`w-4 h-4 ${isRTL ? 'rotate-180' : ''}`} /></Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-slate-800 dark:text-white">{isRTL ? "تعديل الفاتورة" : "Edit Invoice"}</h1>
              <p className="text-slate-500 text-sm">{form.invoice_number}</p>
            </div>
          </div>
          {isPosted ? (
            <Button onClick={handleReverse} disabled={deleting} variant="outline" className="border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50">
              <RotateCcw className="w-4 h-4 mr-2 ml-2" />
              {deleting ? (isRTL ? "جاري العكس..." : "Reversing...") : (isRTL ? "عكس القيد" : "Reverse")}
            </Button>
          ) : (
            <Button onClick={handleDelete} disabled={deleting} variant="outline" className="border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50">
              <Trash2 className="w-4 h-4 mr-2 ml-2" />
              {deleting ? (isRTL ? "جاري الحذف..." : "Deleting...") : (isRTL ? "حذف" : "Delete")}
            </Button>
          )}
        </div>
        {isPosted && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            {isRTL
              ? 'هذه الفاتورة مرحّلة إلى دفتر اليومية، لذلك لا يمكن تعديلها أو حذفها. لعكسها استخدم إشعار دائن/مرتجع.'
              : 'This invoice is posted to the general ledger, so it cannot be edited or deleted. Reverse it with a credit note/return instead.'}
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card className="border-0 shadow-md">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                  <SectionIcon tone="sky"><FileText className="w-4 h-4" /></SectionIcon>
                  {isRTL ? "معلومات الفاتورة" : "Invoice Information"}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{isRTL ? "رقم الفاتورة" : "Invoice Number"}</Label>
                  <Input value={form.invoice_number} onChange={e => handleChange("invoice_number", e.target.value)} className="bg-slate-50 dark:bg-slate-900 tabular-nums" />
                </div>
                <div className="space-y-2">
                  <Label>{isRTL ? "الحالة" : "Status"}</Label>
                  <Select value={form.status} onValueChange={v => handleChange("status", v)}>
                    <SelectTrigger className="bg-slate-50 dark:bg-slate-900"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pending">{isRTL ? "معلقة" : "Pending"}</SelectItem>
                      <SelectItem value="partial">{isRTL ? "مدفوعة جزئياً" : "Partial"}</SelectItem>
                      <SelectItem value="paid">{isRTL ? "مدفوعة" : "Paid"}</SelectItem>
                      <SelectItem value="overdue">{isRTL ? "متاخرة" : "Overdue"}</SelectItem>
                      <SelectItem value="cancelled">{isRTL ? "ملغاة" : "Cancelled"}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{isRTL ? "تاريخ الفاتورة" : "Invoice Date"}</Label>
                  <Input type="date" value={form.invoice_date} onChange={e => handleChange("invoice_date", e.target.value)} className="bg-slate-50 dark:bg-slate-900" />
                </div>
                <div className="space-y-2">
                  <Label>{isRTL ? "تاريخ الاستحقاق" : "Due Date"}</Label>
                  <Input type="date" value={form.due_date} onChange={e => handleChange("due_date", e.target.value)} className="bg-slate-50 dark:bg-slate-900" />
                </div>
                {(form as any).rental_days && (
                  <div className="space-y-2">
                    <Label>{isRTL ? "عدد أيام الإيجار" : "Rental Days"}</Label>
                    <Input value={(form as any).rental_days} readOnly className="bg-emerald-50 font-bold text-emerald-700 tabular-nums" />
                  </div>
                )}
                {(form as any).car_plate && (
                  <div className="space-y-2">
                    <Label>{isRTL ? "السيارة" : "Car"}</Label>
                    <Input value={`${(form as any).car_info} — ${(form as any).car_plate}`} readOnly className="bg-cyan-50 font-bold text-cyan-700" />
                  </div>
                )}
              </CardContent>
            </Card>
            <Card className="border-0 shadow-md">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                  <SectionIcon tone="violet"><User className="w-4 h-4" /></SectionIcon>
                  {isRTL ? "العميل والعقد" : "Customer & Contract"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{isRTL ? "العميل" : "Customer"} *</Label>
                  <Select value={form.customer_id} onValueChange={v => handleChange("customer_id", v)}>
                    <SelectTrigger className="bg-slate-50 dark:bg-slate-900"><SelectValue placeholder={isRTL ? "اختر العميل" : "Select customer"} /></SelectTrigger>
                    <SelectContent>
                      {customers.map(c => <SelectItem key={c.id} value={c.id}>{c.full_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{isRTL ? "عقد الايجار (اختياري)" : "Rental Contract (optional)"}</Label>
                  <Select value={form.rental_contract_id} onValueChange={v => handleChange("rental_contract_id", v)}>
                    <SelectTrigger className="bg-slate-50 dark:bg-slate-900"><SelectValue placeholder={isRTL ? "اختر عقد" : "Select contract"} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{isRTL ? "بدون عقد" : "No contract"}</SelectItem>
                      {filteredRentals.map((r: any) => (
                        <SelectItem key={r.id} value={r.id}>{r.car?.make} {r.car?.model} — {r.car?.plate_number || r.car?.license_plate} ({r.contract_number || r.id.slice(0,8)})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-md">
              <CardHeader className="pb-4"><CardTitle className="text-base text-slate-700 dark:text-slate-200">{isRTL ? "ملاحظات" : "Notes"}</CardTitle></CardHeader>
              <CardContent>
                <Textarea value={form.notes} onChange={e => handleChange("notes", e.target.value)} className="bg-slate-50 dark:bg-slate-900 min-h-[100px]" placeholder={isRTL ? "ادخل اي ملاحظات..." : "Enter any notes..."} />
              </CardContent>
            </Card>
          </div>
          <div className="space-y-6 lg:sticky lg:top-6 self-start">
            <Card className="border-0 shadow-md">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                  <SectionIcon tone="emerald"><DollarSign className="w-4 h-4" /></SectionIcon>
                  {isRTL ? "المبالغ" : "Amounts"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{isRTL ? "المبلغ (BHD)" : "Amount (BHD)"} *</Label>
                  <Input type="number" step="0.001" value={form.amount} onChange={e => handleChange("amount", e.target.value)} className="bg-slate-50 dark:bg-slate-900 text-lg font-semibold tabular-nums" placeholder="0.000" />
                </div>
                <div className="space-y-2">
                  <Label>{isRTL ? "الخصم (BHD)" : "Discount (BHD)"}</Label>
                  <Input type="number" step="0.001" value={(form as any).discount_amount} onChange={e => handleChange("discount_amount", e.target.value)} className="bg-slate-50 dark:bg-slate-900 tabular-nums" placeholder="0.000" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>{isRTL ? "ضريبة القيمة المضافة" : "VAT"}</Label>
                    <Button type="button" variant="outline" size="sm" onClick={applyVat} className="text-xs h-6 px-2">{isRTL ? "تطبيق 10%" : "Apply 10%"}</Button>
                  </div>
                  <Input type="number" step="0.001" value={form.vat_amount} onChange={e => handleChange("vat_amount", e.target.value)} className="bg-slate-50 dark:bg-slate-900 tabular-nums" placeholder="0.000" />
                </div>

                <div className="border-t border-dashed border-slate-200 dark:border-slate-700 pt-3 space-y-1.5 text-sm">
                  <div className="flex items-center justify-between text-slate-500">
                    <span>{isRTL ? "المبلغ" : "Amount"}</span>
                    <span className="tabular-nums">{amountNum.toFixed(3)}</span>
                  </div>
                  <div className="flex items-center justify-between text-slate-500">
                    <span>{isRTL ? "الخصم" : "Discount"}</span>
                    <span className="tabular-nums">− {discountNum.toFixed(3)}</span>
                  </div>
                  <div className="flex items-center justify-between text-slate-500">
                    <span>{isRTL ? "الضريبة" : "VAT"}</span>
                    <span className="tabular-nums">+ {vatNum.toFixed(3)}</span>
                  </div>
                </div>
                <div className="border-t pt-3 flex items-center justify-between">
                  <span className="font-medium text-slate-600 dark:text-slate-300">{isRTL ? "الاجمالي" : "Total"}</span>
                  <span className="text-xl font-bold text-cyan-600 tabular-nums">{totalNum.toFixed(3)} BHD</span>
                </div>
                <div className="space-y-2 border-t pt-4">
                  <Label>{isRTL ? "المبلغ المدفوع (BHD)" : "Paid Amount (BHD)"}</Label>
                  <Input type="number" step="0.001" value={form.paid_amount} onChange={e => handleChange("paid_amount", e.target.value)} className="bg-emerald-50 text-lg font-semibold tabular-nums" placeholder="0.000" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-600 dark:text-slate-300">{isRTL ? "المتبقي" : "Balance Due"}</span>
                  <span className="text-lg font-bold text-red-600 tabular-nums">{balanceNum.toFixed(3)} BHD</span>
                </div>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-md">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                  <SectionIcon tone="amber"><CreditCard className="w-4 h-4" /></SectionIcon>
                  {isRTL ? "الدفع" : "Payment"}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{isRTL ? "نوع الدفع" : "Payment Type"}</Label>
                  <Select value={(form as any).payment_type} onValueChange={v => handleChange("payment_type", v)}>
                    <SelectTrigger className="bg-slate-50 dark:bg-slate-900"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">{isRTL ? "نقدي" : "Cash"}</SelectItem>
                      <SelectItem value="credit">{isRTL ? "آجل" : "Credit"}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{isRTL ? "طريقة الدفع" : "Payment Method"}</Label>
                  <Select value={(form as any).payment_method} onValueChange={v => handleChange("payment_method", v)}>
                    <SelectTrigger className="bg-slate-50 dark:bg-slate-900"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">{isRTL ? "كاش" : "Cash"}</SelectItem>
                      <SelectItem value="bank_transfer">{isRTL ? "تحويل بنكي" : "Bank Transfer"}</SelectItem>
                      <SelectItem value="card">{isRTL ? "بطاقة" : "Card"}</SelectItem>
                      <SelectItem value="cheque">{isRTL ? "شيك" : "Cheque"}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-md">
              <CardContent className="pt-6 space-y-3">
                <Button onClick={handleSubmit} disabled={loading || isPosted} className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white shadow-lg disabled:opacity-50">
                  <Save className="w-4 h-4 mr-2 ml-2" />
                  {loading ? (isRTL ? "جاري الحفظ..." : "Saving...") : (isRTL ? "حفظ التعديلات" : "Save Changes")}
                </Button>
                <Link href="/invoices">
                  <Button variant="outline" className="w-full">{isRTL ? "الغاء" : "Cancel"}</Button>
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
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
