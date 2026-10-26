"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect } from "react"
import { notifyDataChanged } from '@/lib/hooks/use-report-refresh'
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { supabase, DebitNote, Supplier, PurchaseInvoice } from "@/lib/supabase"
import { formatCurrency, formatDate, getStatusColor } from "@/lib/utils"
import RecordSelect from "@/components/records/RecordSelect"
import { isSelectablePostableAccount } from "@/lib/records/sources"
import {
  RotateCcw, Plus, Search, Save, Trash2, ArrowLeft, FileText, AlertTriangle
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import Link from "next/link"

function DebitNotesPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [notes, setNotes] = useState<DebitNote[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [bills, setBills] = useState<PurchaseInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  const [form, setForm] = useState({
    supplier_id: '',
    purchase_invoice_id: '',
    amount: '',
    vat_amount: '',
    expense_account_id: '',
    note_date: new Date().toISOString().split('T')[0],
    reason: '',
  })

  useEffect(() => {
    setMounted(true)
    fetchNotes()
    fetchSuppliers()
    fetchBills()
  }, [])

  async function fetchNotes() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('debit_notes')
        .select('*, suppliers(name), purchase_invoices(invoice_number)')
        .order('note_date', { ascending: false })
      if (data) setNotes(data as any)
    } catch (error) {
      console.error('Error fetching debit notes:', error)
    }
    setLoading(false)
  }

  async function fetchSuppliers() {
    const { data } = await supabase.from('suppliers').select('*').order('name')
    if (data) setSuppliers(data)
  }

  async function fetchBills() {
    const { data } = await supabase.from('purchase_invoices').select('id, invoice_number, supplier_id').order('bill_date', { ascending: false })
    if (data) setBills(data as any)
  }

  async function handleSubmit() {
    if (!form.supplier_id || !form.amount || parseFloat(form.amount) <= 0) {
      alert(isRTL ? 'أدخل المورد والمبلغ' : 'Enter supplier and amount')
      return
    }

    setSaving(true)
    try {
      // The note and its ledger journal are written together by the server.
      // The browser must not insert `debit_notes` itself: a note that reaches the
      // supplier statement without a journal makes the books disagree with the
      // screens, which is the defect Execution 54 closes.
      const res = await fetch('/api/debit-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_id: form.supplier_id,
          purchase_invoice_id: form.purchase_invoice_id || null,
          amount: parseFloat(form.amount),
          vat_amount: parseFloat(form.vat_amount || '0'),
          note_date: form.note_date,
          reason: form.reason || null,
          expense_account_id: form.expense_account_id || null,
        }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error || 'Could not create the debit note')

      setForm({
        supplier_id: '',
        purchase_invoice_id: '',
        amount: '',
        vat_amount: '',
        expense_account_id: '',
        note_date: new Date().toISOString().split('T')[0],
        reason: '',
      })
      notifyDataChanged()
      setShowForm(false)
      fetchNotes()
    } catch (error: any) {
      alert(isRTL ? 'خطأ: ' + error.message : 'Error: ' + error.message)
    }
    setSaving(false)
  }

  async function handleDelete(id: string) {
    // A posted note is not deleted: its journal would be orphaned. It is
    // cancelled (status 'cancelled') so the audit trail keeps the document.
    if (!confirm(isRTL ? 'هل أنت متأكد من إلغاء الإشعار؟' : 'Are you sure you want to cancel this note?')) return
    const { error } = await supabase.from('debit_notes').update({ status: 'cancelled' }).eq('id', id)
    if (error) {
      alert(isRTL ? 'خطأ: ' + error.message : 'Error: ' + error.message)
      return
    }
    notifyDataChanged()
    fetchNotes()
  }

  const filtered = notes.filter(n => {
    const matchesSearch = !search ||
      (n.note_number || '').toLowerCase().includes(search.toLowerCase()) ||
      ((n as any).suppliers?.name || '').toLowerCase().includes(search.toLowerCase())
    return matchesSearch
  })

  const totalAmount = notes.reduce((s, n) => s + (parseFloat(n.amount as any) || 0), 0)

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <RotateCcw className="w-7 h-7 text-amber-500" />
              {isRTL ? 'إشعارات المدين (مردودات)' : 'Debit Notes (Returns)'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {isRTL ? 'تسجيل مردودات المشتريات وإشعارات الخصم' : 'Record purchase returns and debit notes'}
            </p>
          </div>
          <Button onClick={() => setShowForm(!showForm)} className="bg-amber-600 hover:bg-amber-700 text-white rounded-xl gap-2">
            <Plus className="w-4 h-4" />
            {showForm ? (isRTL ? 'إلغاء' : 'Cancel') : (isRTL ? 'إشعار جديد' : 'New Debit Note')}
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-500">{isRTL ? 'إجمالي الإشعارات' : 'Total Debit Notes'}</p>
            <p className="text-2xl font-bold text-amber-600 mt-1">{formatCurrency(totalAmount)}</p>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-500">{isRTL ? 'العدد' : 'Count'}</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{notes.length}</p>
          </div>
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-500">{isRTL ? 'القيد المحاسبي' : 'Journal Entry'}</p>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
              Dr ذمم دائنة / Cr مصروف<br/>
              <span className="text-emerald-600">Dr A/P &nbsp; Cr Expense</span>
            </p>
          </div>
        </div>

        {/* Form */}
        {showForm && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 space-y-4">
            <h3 className="font-bold text-slate-900 dark:text-white">{isRTL ? 'إشعار مدين جديد' : 'New Debit Note'}</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <RecordSelect
                  kind="supplier"
                  label={isRTL ? 'المورد' : 'Supplier'}
                  required
                  value={form.supplier_id}
                  onChange={(id) => setForm({ ...form, supplier_id: id, purchase_invoice_id: '' })}
                  createMode="inline"
                  placeholder={isRTL ? 'اختر المورد...' : 'Select supplier...'}
                />
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'الفاتورة الأصلية' : 'Original Bill'}</label>
                <select
                  value={form.purchase_invoice_id}
                  onChange={(e) => setForm({ ...form, purchase_invoice_id: e.target.value })}
                  className="w-full h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  <option value="">{isRTL ? 'اختر الفاتورة...' : 'Select bill...'}</option>
                  {bills.filter(b => b.supplier_id === form.supplier_id).map(b => (
                    <option key={b.id} value={b.id}>{b.invoice_number}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'المبلغ' : 'Amount'} *</label>
                <Input type="number" step="0.001" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="h-11 rounded-xl" placeholder="0.000" />
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'ضريبة القيمة المضافة' : 'VAT'}</label>
                <Input type="number" step="0.001" value={form.vat_amount} onChange={(e) => setForm({ ...form, vat_amount: e.target.value })} className="h-11 rounded-xl" placeholder="0.000" />
              </div>
              <div>
                <RecordSelect
                  kind="account"
                  label={isRTL ? 'حساب المصروف' : 'Expense account'}
                  value={form.expense_account_id}
                  onChange={(v) => setForm({ ...form, expense_account_id: v })}
                  filter={isSelectablePostableAccount}
                  placeholder={isRTL ? 'اختر الحساب (افتراضي: مصروفات أخرى)' : 'Select account (default: other expenses)'}
                />
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'التاريخ' : 'Date'}</label>
                <Input type="date" value={form.note_date} onChange={(e) => setForm({ ...form, note_date: e.target.value })} className="h-11 rounded-xl" />
              </div>
              <div className="md:col-span-2">
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'السبب' : 'Reason'}</label>
                <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="h-11 rounded-xl" placeholder={isRTL ? 'سبب الإشعار...' : 'Reason for debit note...'} />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSubmit} disabled={saving} className="bg-amber-600 hover:bg-amber-700 text-white rounded-xl gap-2">
                <Save className="w-4 h-4" />
                {saving ? (isRTL ? 'جاري الحفظ...' : 'Saving...') : (isRTL ? 'حفظ' : 'Save')}
              </Button>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700">
          <div className="relative">
            <Search className={`absolute ${isRTL ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400`} />
            <Input
              placeholder={isRTL ? 'بحث برقم الإشعار أو المورد...' : 'Search by note # or supplier...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={`${isRTL ? 'pr-9' : 'pl-9'} h-10 rounded-xl`}
            />
          </div>
        </div>

        {/* Table */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin w-8 h-8 border-4 border-amber-500 border-t-transparent rounded-full"></div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400">
              <RotateCcw className="w-12 h-12 mb-3 opacity-30" />
              <p>{isRTL ? 'لا توجد إشعارات' : 'No debit notes found'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-700">
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'رقم الإشعار' : 'Note #'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المورد' : 'Supplier'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الفاتورة' : 'Bill'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'التاريخ' : 'Date'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المبلغ' : 'Amount'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'السبب' : 'Reason'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الحالة' : 'Status'}</th>
                    <th className="py-3 px-4 text-center">{isRTL ? 'إجراء' : 'Action'}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((note) => {
                    const supplier = (note as any).suppliers
                    const invoice = (note as any).purchase_invoices
                    return (
                      <tr key={note.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                        <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">{note.note_number}</td>
                        <td className="py-3 px-4 text-slate-700 dark:text-slate-300">{supplier?.name || '-'}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">{invoice?.invoice_number || '-'}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">{formatDate(note.note_date)}</td>
                        <td className="py-3 px-4 font-bold text-amber-600">{formatCurrency(parseFloat(note.amount as any) || 0)}</td>
                        <td className="py-3 px-4 text-sm text-slate-500 max-w-[200px] truncate">{note.reason || '-'}</td>
                        <td className="py-3 px-4">
                          <Badge className={getStatusColor(note.status)}>{note.status}</Badge>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <Button variant="ghost" size="icon" onClick={() => handleDelete(note.id)} className="h-8 w-8 text-red-500">
                            <Trash2 className="w-4 h-4" />
                          </Button>
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
      <DebitNotesPageContent />
    </Suspense>
  )
}
