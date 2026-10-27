"use client"
import { notifyDataChanged } from '@/lib/hooks/use-report-refresh'
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect } from "react"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { supabase, Supplier, Car } from "@/lib/supabase"
import RecordSelect from "@/components/records/RecordSelect"
import { formatCurrency } from "@/lib/utils"
import {
  ShoppingBag, Save, ArrowLeft, Plus, Trash2, Car as CarIcon, User, FileText
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { useRouter } from "next/navigation"

const EXPENSE_CATEGORIES = [
  { key: 'fuel', labelAr: 'وقود', labelEn: 'Fuel' },
  { key: 'maintenance', labelAr: 'صيانة', labelEn: 'Maintenance' },
  { key: 'insurance', labelAr: 'تأمين', labelEn: 'Insurance' },
  { key: 'registration', labelAr: 'تسجيل', labelEn: 'Registration' },
  { key: 'tyres', labelAr: 'إطارات', labelEn: 'Tyres' },
  { key: 'accident_repair', labelAr: 'إصلاح حادث', labelEn: 'Accident Repair' },
  { key: 'other', labelAr: 'أخرى', labelEn: 'Other' },
]

const BRANCHES = ['Manama', 'Airport', 'Muharraq', 'Riffa']

function NewBillPageContent() {
  const { t, isRTL } = useLanguage()
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const [form, setForm] = useState({
    supplier_id: '',
    bill_date: new Date().toISOString().split('T')[0],
    due_date: '',
    notes: '',
    car_id: '',
    expense_category: '',
    branch: '',
    vat_amount: 0,
    payment_type: 'cash',
    advance_payment: '',
  })

  const [items, setItems] = useState([
    { description: '', quantity: 1, unit_price: 0, vat_rate: 0, total_price: 0 }
  ])

  useEffect(() => {
    setMounted(true)
  }, [])

  const totalAmount = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0)
  const totalVat = items.reduce((sum, item) => sum + (item.quantity * item.unit_price * item.vat_rate / 100), 0)
  const grandTotal = totalAmount + totalVat
  const advancePayment = Math.min(parseFloat(form.advance_payment) || 0, grandTotal)
  const remainingAmount = Math.max(0, grandTotal - advancePayment)

  function updateItem(index: number, field: string, value: any) {
    const newItems = [...items]
    newItems[index] = { ...newItems[index], [field]: value }
    if (field === 'quantity' || field === 'unit_price' || field === 'vat_rate') {
      newItems[index].total_price = newItems[index].quantity * newItems[index].unit_price * (1 + newItems[index].vat_rate / 100)
    }
    setItems(newItems)
  }

  function addItem() {
    setItems([...items, { description: '', quantity: 1, unit_price: 0, vat_rate: 0, total_price: 0 }])
  }

  function removeItem(index: number) {
    if (items.length === 1) return
    setItems(items.filter((_, i) => i !== index))
  }

  async function handleSubmit() {
    if (!form.supplier_id) {
      alert(isRTL ? 'اختر المورد' : 'Select supplier')
      return
    }
    if (items.some(i => !i.description.trim())) {
      alert(isRTL ? 'أدخل وصف كل بند' : 'Enter description for all items')
      return
    }

    setSaving(true)
    try {
      const res = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_id: form.supplier_id,
          bill_date: form.bill_date,
          due_date: form.due_date || null,
          items: items.map(i => ({
            description: i.description,
            quantity: i.quantity,
            unit_price: i.unit_price,
            vat_rate: i.vat_rate,
          })),
          advance_payment: advancePayment,
          payment_type: form.payment_type,
          expense_category: form.expense_category || null,
          branch: form.branch || null,
          car_id: form.car_id || null,
          notes: form.notes || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Purchase failed')

      notifyDataChanged()
      router.push('/purchases')
    } catch (error: any) {
      alert(isRTL ? 'خطأ: ' + error.message : 'Error: ' + error.message)
    }
    setSaving(false)
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/purchases">
              <Button variant="outline" size="icon" className="rounded-xl">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <ShoppingBag className="w-6 h-6 text-emerald-500" />
                {isRTL ? 'فاتورة مورد جديدة' : 'New Supplier Bill'}
              </h1>
              <p className="text-slate-500 text-sm">{isRTL ? 'يُخصَّص الرقم عند الحفظ' : 'Number is assigned on save'}</p>
            </div>
          </div>
          <Button onClick={handleSubmit} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl gap-2">
            <Save className="w-4 h-4" />
            {saving ? (isRTL ? 'جاري الحفظ...' : 'Saving...') : (isRTL ? 'حفظ الفاتورة' : 'Save Bill')}
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Form */}
          <div className="lg:col-span-2 space-y-6">
            {/* Supplier & Basic Info */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 space-y-4">
              <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <User className="w-4 h-4 text-emerald-500" />
                {isRTL ? 'معلومات المورد' : 'Supplier Info'}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  {/* Searchable picker from the Suppliers module with an inline
                      (+) that reuses the module's own create form. */}
                  <RecordSelect
                    kind="supplier"
                    label={isRTL ? 'المورد' : 'Supplier'}
                    required
                    value={form.supplier_id}
                    onChange={(id) => setForm({ ...form, supplier_id: id })}
                    createMode="inline"
                    placeholder={isRTL ? 'اختر المورد...' : 'Select supplier...'}
                  />
                </div>
                <div>
                  <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'رقم الفاتورة' : 'Bill Number'}</label>
                  <Input value={isRTL ? 'يُخصَّص تلقائياً' : 'Assigned automatically'} readOnly className="h-11 rounded-xl bg-slate-50" />
                </div>
                <div>
                  <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'تاريخ الفاتورة' : 'Bill Date'} *</label>
                  <Input type="date" value={form.bill_date} onChange={(e) => setForm({ ...form, bill_date: e.target.value })} className="h-11 rounded-xl" />
                </div>
                <div>
                  <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'تاريخ الاستحقاق' : 'Due Date'}</label>
                  <Input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className="h-11 rounded-xl" /></div>
                <div>
                  <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'طريقة الدفع' : 'Payment Type'}</label>
                  <select
                    value={form.payment_type}
                    onChange={(e) => setForm({ ...form, payment_type: e.target.value })}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  >
                    <option value="cash">{isRTL ? 'نقدي' : 'Cash'}</option>
                    <option value="credit">{isRTL ? 'آجل' : 'Credit'}</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Vehicle & Category */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 space-y-4">
              <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <CarIcon className="w-4 h-4 text-blue-500" />
                {isRTL ? 'ربط بالمركبة والفرع' : 'Vehicle & Branch Link'}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <RecordSelect
                    kind="car"
                    label={isRTL ? 'المركبة' : 'Vehicle'}
                    value={form.car_id}
                    onChange={(id) => setForm({ ...form, car_id: id })}
                    createMode="inline"
                    placeholder={isRTL ? 'اختر المركبة...' : 'Select vehicle...'}
                  />
                </div>
                <div>
                  <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'فئة المصروف' : 'Expense Category'}</label>
                  <select
                    value={form.expense_category}
                    onChange={(e) => setForm({ ...form, expense_category: e.target.value })}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  >
                    <option value="">{isRTL ? 'اختر الفئة...' : 'Select category...'}</option>
                    {EXPENSE_CATEGORIES.map(cat => (
                      <option key={cat.key} value={cat.key}>{isRTL ? cat.labelAr : cat.labelEn}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'الفرع' : 'Branch'}</label>
                  <select
                    value={form.branch}
                    onChange={(e) => setForm({ ...form, branch: e.target.value })}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  >
                    <option value="">{isRTL ? 'اختر الفرع...' : 'Select branch...'}</option>
                    {BRANCHES.map(b => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Items */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <FileText className="w-4 h-4 text-violet-500" />
                  {isRTL ? 'بنود الفاتورة' : 'Bill Items'}
                </h3>
                <Button type="button" variant="outline" size="sm" onClick={addItem} className="rounded-lg gap-1">
                  <Plus className="w-3 h-3" /> {isRTL ? 'إضافة بند' : 'Add Item'}
                </Button>
              </div>
              <div className="space-y-3">
                {items.map((item, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-end bg-slate-50 dark:bg-slate-700/50 p-3 rounded-xl">
                    <div className="col-span-4">
                      <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'الوصف' : 'Description'}</label>
                      <Input value={item.description} onChange={(e) => updateItem(idx, 'description', e.target.value)} className="h-9 rounded-lg text-sm" placeholder={isRTL ? 'وصف البند...' : 'Item description...'} />
                    </div>
                    <div className="col-span-2">
                      <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'الكمية' : 'Qty'}</label>
                      <Input type="number" value={item.quantity} onChange={(e) => updateItem(idx, 'quantity', parseFloat(e.target.value) || 0)} className="h-9 rounded-lg text-sm" />
                    </div>
                    <div className="col-span-2">
                      <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'السعر' : 'Price'}</label>
                      <Input type="number" step="0.001" value={item.unit_price} onChange={(e) => updateItem(idx, 'unit_price', parseFloat(e.target.value) || 0)} className="h-9 rounded-lg text-sm" />
                    </div>
                    <div className="col-span-2">
                      <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'VAT%' : 'VAT%'}</label>
                      <Input type="number" value={item.vat_rate} onChange={(e) => updateItem(idx, 'vat_rate', parseFloat(e.target.value) || 0)} className="h-9 rounded-lg text-sm" />
                    </div>
                    <div className="col-span-1">
                      <p className="text-sm font-bold text-slate-900 dark:text-white">{formatCurrency(item.total_price)}</p>
                    </div>
                    <div className="col-span-1">
                      <Button type="button" variant="ghost" size="icon" onClick={() => removeItem(idx)} className="h-8 w-8 text-red-500">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Notes */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700">
              <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'ملاحظات' : 'Notes'}</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3}
                className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white resize-none"
                placeholder={isRTL ? 'أي ملاحظات إضافية...' : 'Any additional notes...'}
              />
            </div>
          </div>

          {/* Summary Sidebar */}
          <div className="space-y-4">
            <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 sticky top-6">
              <h3 className="font-bold text-slate-900 dark:text-white mb-4">{isRTL ? 'ملخص الفاتورة' : 'Bill Summary'}</h3>
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">{isRTL ? 'المجموع الفرعي' : 'Subtotal'}</span>
                  <span className="font-semibold text-slate-900 dark:text-white">{formatCurrency(totalAmount)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">{isRTL ? 'ضريبة القيمة المضافة' : 'VAT'}</span>
                  <span className="font-semibold text-slate-900 dark:text-white">{formatCurrency(totalVat)}</span>
                </div>
                <div className="border-t border-slate-200 dark:border-slate-600 pt-3 flex justify-between">
                  <span className="font-bold text-slate-900 dark:text-white">{isRTL ? 'الإجمالي' : 'Grand Total'}</span>
                  <span className="font-bold text-2xl text-emerald-600">{formatCurrency(grandTotal)}</span>
                </div>
                <div className="pt-2">
                  <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'دفعة مقدمة (BHD)' : 'Advance Payment (BHD)'}</label>
                  <Input type="number" step="0.001" value={form.advance_payment} onChange={(e) => setForm({ ...form, advance_payment: e.target.value })} className="h-11 rounded-xl" placeholder="0.000" />
                </div>
                {advancePayment > 0 && (
                  <div className="flex justify-between text-sm text-emerald-600">
                    <span>{isRTL ? 'الدفعة المقدمة' : 'Advance Payment'}</span>
                    <span className="font-bold">- {formatCurrency(advancePayment)}</span>
                  </div>
                )}
                <div className="border-t border-slate-200 dark:border-slate-600 pt-3 flex justify-between">
                  <span className="font-bold text-slate-900 dark:text-white">{isRTL ? 'المتبقي' : 'Remaining'}</span>
                  <span className="font-bold text-xl text-amber-600">{formatCurrency(remainingAmount)}</span>
                </div>
              </div>
              <div className="mt-6 p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl">
                <p className="text-xs text-emerald-700 dark:text-emerald-400">
                  {isRTL 
                    ? 'سيتم إنشاء القيد: Dr مصروف / Cr ذمم دائنة'
                    : 'Journal: Dr Expense / Cr Accounts Payable'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <NewBillPageContent />
    </Suspense>
  )
}
