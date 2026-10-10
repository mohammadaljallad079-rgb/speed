"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect } from "react"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { supabase, SupplierPayment, Supplier, PurchaseInvoice } from "@/lib/supabase"
import { formatCurrency, formatDate, getStatusColor } from "@/lib/utils"
import {
  Wallet, Plus, Search, ArrowLeft, Save, Trash2, Eye,
  TrendingDown, CreditCard, Calendar, MoreVertical, FileText
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem
} from "@/components/ui/dropdown-menu"
import Link from "next/link"
import { useRouter } from "next/navigation"

const PAYMENT_METHODS = [
  { key: 'cash', labelAr: 'نقدي', labelEn: 'Cash' },
  { key: 'bank_transfer', labelAr: 'تحويل بنكي', labelEn: 'Bank Transfer' },
  { key: 'cheque', labelAr: 'شيك', labelEn: 'Cheque' },
  { key: 'card', labelAr: 'بطاقة', labelEn: 'Card' },
]

function SupplierPaymentsPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [payments, setPayments] = useState<SupplierPayment[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [bills, setBills] = useState<PurchaseInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)

  const [form, setForm] = useState({
    supplier_id: '',
    purchase_invoice_id: '',
    amount: '',
    payment_date: new Date().toISOString().split('T')[0],
    payment_method: 'cash',
    reference_number: '',
    notes: '',
  })

  useEffect(() => {
    setMounted(true)
    fetchPayments()
    fetchSuppliers()
    fetchBills()
  }, [])

  async function fetchPayments() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('supplier_payments')
        .select('*, suppliers(name), purchase_invoices(invoice_number, total_amount, paid_amount)')
        .order('payment_date', { ascending: false })
      if (data) setPayments(data as any)
    } catch (error) {
      console.error('Error fetching payments:', error)
    }
    setLoading(false)
  }

  async function fetchSuppliers() {
    const { data } = await supabase.from('suppliers').select('*').order('name')
    if (data) setSuppliers(data)
  }

  async function fetchBills() {
    const { data } = await supabase
      .from('purchase_invoices')
      .select('id, invoice_number, total_amount, paid_amount, supplier_id, status')
      .in('status', ['pending', 'partial'])
      .order('bill_date', { ascending: false })
    if (data) setBills(data as any)
  }

  const filtered = payments.filter(pay => {
    const matchesSearch = !search ||
      (pay.payment_number || '').toLowerCase().includes(search.toLowerCase()) ||
      ((pay as any).suppliers?.name || '').toLowerCase().includes(search.toLowerCase())
    return matchesSearch
  })

  const totalPaid = payments.reduce((s, p) => s + (parseFloat(p.amount as any) || 0), 0)

  async function handleSubmit() {
    if (!form.supplier_id || !form.amount || parseFloat(form.amount) <= 0) {
      alert(isRTL ? 'أدخل المورد والمبلغ' : 'Enter supplier and amount')
      return
    }

    setSaving(true)
    try {
      const { data: payData, error: payError } = await supabase.from('supplier_payments').insert([{
        payment_number: `SP-${Date.now().toString().slice(-6)}`,
        supplier_id: form.supplier_id,
        purchase_invoice_id: form.purchase_invoice_id || null,
        amount: parseFloat(form.amount),
        payment_date: form.payment_date,
        payment_method: form.payment_method,
        reference_number: form.reference_number || null,
        notes: form.notes || null,
        status: 'completed',
      }]).select().single()

      if (payError) throw payError

      // Update bill paid_amount if linked
      if (form.purchase_invoice_id) {
        const bill = bills.find(b => b.id === form.purchase_invoice_id)
        if (bill) {
          const newPaid = (parseFloat(bill.paid_amount as any) || 0) + parseFloat(form.amount)
          const newStatus = newPaid >= (parseFloat(bill.total_amount as any) || 0) ? 'paid' : 'partial'
          await supabase.from('purchase_invoices').update({
            paid_amount: newPaid,
            status: newStatus,
          }).eq('id', form.purchase_invoice_id)
        }
      }

      setForm({
        supplier_id: '',
        purchase_invoice_id: '',
        amount: '',
        payment_date: new Date().toISOString().split('T')[0],
        payment_method: 'cash',
        reference_number: '',
        notes: '',
      })
      setShowForm(false)
      fetchPayments()
      fetchBills()
    } catch (error: any) {
      alert(isRTL ? 'خطأ: ' + error.message : 'Error: ' + error.message)
    }
    setSaving(false)
  }

  async function handleDelete(id: string) {
    if (!confirm(isRTL ? 'هل أنت متأكد من الحذف؟' : 'Are you sure?')) return
    await supabase.from('supplier_payments').delete().eq('id', id)
    fetchPayments()
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <Wallet className="w-7 h-7 text-emerald-500" />
              {isRTL ? 'مدفوعات الموردين' : 'Supplier Payments'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {isRTL ? 'تسجيل مدفوعات للموردين وربطها بالفواتير' : 'Record supplier payments linked to bills'}
            </p>
          </div>
          <Button onClick={() => setShowForm(!showForm)} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl gap-2">
            <Plus className="w-4 h-4" />
            {showForm ? (isRTL ? 'إلغاء' : 'Cancel') : (isRTL ? 'دفع جديد' : 'New Payment')}
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-500">{isRTL ? 'إجمالي المدفوعات' : 'Total Paid'}</p>
            <p className="text-2xl font-bold text-emerald-600 mt-1">{formatCurrency(totalPaid)}</p>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-500">{isRTL ? 'عدد المدفوعات' : 'Payment Count'}</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{payments.length}</p>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-500">{isRTL ? 'آخر دفع' : 'Last Payment'}</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white mt-1">
              {payments[0] ? formatDate(payments[0].payment_date) : '-'}
            </p>
          </div>
        </div>

        {/* Payment Form */}
        {showForm && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 space-y-4">
            <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-emerald-500" />
              {isRTL ? 'تسجيل دفع جديد' : 'Record New Payment'}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'المورد' : 'Supplier'} *</label>
                <select
                  value={form.supplier_id}
                  onChange={(e) => setForm({ ...form, supplier_id: e.target.value, purchase_invoice_id: '' })}
                  className="w-full h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  <option value="">{isRTL ? 'اختر المورد...' : 'Select supplier...'}</option>
                  {suppliers.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'الفاتورة (اختياري)' : 'Bill (Optional)'}</label>
                <select
                  value={form.purchase_invoice_id}
                  onChange={(e) => setForm({ ...form, purchase_invoice_id: e.target.value })}
                  className="w-full h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  <option value="">{isRTL ? 'اختر الفاتورة...' : 'Select bill...'}</option>
                  {bills.filter(b => b.supplier_id === form.supplier_id).map(b => {
                    const balance = (parseFloat(b.total_amount as any) || 0) - (parseFloat(b.paid_amount as any) || 0)
                    return (
                      <option key={b.id} value={b.id}>
                        {b.invoice_number} - {formatCurrency(balance)} {isRTL ? 'متبقي' : 'due'}
                      </option>
                    )
                  })}
                </select>
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'المبلغ' : 'Amount'} *</label>
                <Input type="number" step="0.001" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="h-11 rounded-xl" placeholder="0.000" />
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'تاريخ الدفع' : 'Payment Date'}</label>
                <Input type="date" value={form.payment_date} onChange={(e) => setForm({ ...form, payment_date: e.target.value })} className="h-11 rounded-xl" />
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'طريقة الدفع' : 'Method'}</label>
                <select
                  value={form.payment_method}
                  onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
                  className="w-full h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  {PAYMENT_METHODS.map(m => (
                    <option key={m.key} value={m.key}>{isRTL ? m.labelAr : m.labelEn}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'رقم المرجع' : 'Reference'}</label>
                <Input value={form.reference_number} onChange={(e) => setForm({ ...form, reference_number: e.target.value })} className="h-11 rounded-xl" placeholder="TRX-12345" />
              </div>
            </div>
            <div>
              <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'ملاحظات' : 'Notes'}</label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="h-11 rounded-xl" />
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSubmit} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl gap-2">
                <Save className="w-4 h-4" />
                {saving ? (isRTL ? 'جاري الحفظ...' : 'Saving...') : (isRTL ? 'حفظ الدفع' : 'Save Payment')}
              </Button>
            </div>
            <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                {isRTL 
                  ? 'القيد المحاسبي: Dr ذمم دائنة / Cr بنك'
                  : 'Journal: Dr Accounts Payable / Cr Bank'}
              </p>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700">
          <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className={`absolute ${isRTL ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400`} />
            <Input
              placeholder={isRTL ? 'بحث برقم الدفع أو المورد...' : 'Search by payment # or supplier...'}
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSearch(searchDraft) }}
              className={`${isRTL ? 'pr-9' : 'pl-9'} h-10 rounded-xl`}
            />
          </div>
          <Button onClick={() => setSearch(searchDraft)} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10 gap-2 shrink-0">
            <Search className="w-4 h-4" />{isRTL ? 'بحث' : 'Search'}
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
              <Wallet className="w-12 h-12 mb-3 opacity-30" />
              <p>{isRTL ? 'لا توجد مدفوعات' : 'No payments found'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-700">
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'رقم الدفع' : 'Payment #'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المورد' : 'Supplier'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الفاتورة' : 'Bill'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'التاريخ' : 'Date'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الطريقة' : 'Method'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المبلغ' : 'Amount'}</th>
                    <th className="py-3 px-4 text-center">{isRTL ? 'إجراءات' : 'Actions'}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((payment) => {
                    const supplier = (payment as any).suppliers
                    const invoice = (payment as any).purchase_invoices
                    return (
                      <tr key={payment.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                        <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">{payment.payment_number}</td>
                        <td className="py-3 px-4 text-slate-700 dark:text-slate-300">{supplier?.name || '-'}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">{invoice?.invoice_number || '-'}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">{formatDate(payment.payment_date)}</td>
                        <td className="py-3 px-4">
                          <Badge variant="outline" className="text-xs capitalize">{payment.payment_method}</Badge>
                        </td>
                        <td className="py-3 px-4 font-bold text-emerald-600">{formatCurrency(parseFloat(payment.amount as any) || 0)}</td>
                        <td className="py-3 px-4 text-center">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreVertical className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                              <DropdownMenuItem onClick={() => handleDelete(payment.id)} className="text-red-600">
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
      <SupplierPaymentsPageContent />
    </Suspense>
  )
}
