"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect, useMemo } from "react"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { supabase, PurchaseRequisition, generateReqNumber } from "@/lib/supabase"
import { nextDocumentNumber } from "@/lib/numbering"
import { formatCurrency, formatDate } from "@/lib/utils"
import {
  FilePlus, Plus, Search, Save, Trash2, CheckCircle, XCircle, ArrowRight,
  ClipboardList, Filter, X, Truck, ChevronDown, Building2, Car, CreditCard, User, StickyNote
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

const STATUS_OPTIONS = [
  { key: 'draft', labelAr: 'مسودة', labelEn: 'Draft', color: 'bg-slate-100 text-slate-700' },
  { key: 'pending', labelAr: 'معلقة', labelEn: 'Pending', color: 'bg-amber-100 text-amber-700' },
  { key: 'approved', labelAr: 'معتمدة', labelEn: 'Approved', color: 'bg-emerald-100 text-emerald-700' },
  { key: 'rejected', labelAr: 'مرفوضة', labelEn: 'Rejected', color: 'bg-red-100 text-red-700' },
  { key: 'converted', labelAr: 'محولة لأمر شراء', labelEn: 'Converted to PO', color: 'bg-blue-100 text-blue-700' },
]
const BRANCHES = [
  { id: "manama", name: "Manama" },
  { id: "airport", name: "Airport" },
  { id: "muharraq", name: "Muharraq" },
  { id: "riffa", name: "Riffa" },
]

type ReqRow = PurchaseRequisition & {
  branch?: string | null
  car_id?: string | null
  expense_account_id?: string | null
  approved_by?: string | null
  approved_at?: string | null
  rejection_reason?: string | null
  converted_to_po_id?: string | null
}
type VehicleItem = { id: string; make: string; model: string; plate_number: string }
type ExpenseAccount = { id: string; code: string; name: string }
type SupplierItem = { id: string; name: string }
type BranchItem = { id: string; name: string }

function SelectField({ label, icon: Icon, value, onChange, options, placeholder, required }: any) {
  return (
    <div className="relative group">
      <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wider">
        {Icon && <Icon className="w-3.5 h-3.5 text-violet-500" />}
        {label}
        {required && <span className="text-red-400">*</span>}
      </label>
      <div className="relative">
        <select
          value={value}
          onChange={onChange}
          className="h-12 w-full appearance-none rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-4 pr-10 text-sm text-slate-800 dark:text-slate-100 focus:border-violet-500 focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900 transition-all outline-none cursor-pointer hover:border-slate-300 dark:hover:border-slate-500"
        >
          <option value="">{placeholder}</option>
          {options}
        </select>
        <ChevronDown className="absolute top-1/2 -translate-y-1/2 right-3 w-4 h-4 text-slate-400 pointer-events-none" />
      </div>
    </div>
  )
}

function InputField({ label, icon: Icon, ...props }: any) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5 uppercase tracking-wider">
        {Icon && <Icon className="w-3.5 h-3.5 text-violet-500" />}
        {label}
        {props.required && <span className="text-red-400">*</span>}
      </label>
      <Input {...props} className="h-12 rounded-xl border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 focus:border-violet-500 focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900 transition-all" />
    </div>
  )
}

function PurchaseRequisitionsPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [reqs, setReqs] = useState<ReqRow[]>([])
  const [vehicles, setVehicles] = useState<VehicleItem[]>([])
  const [expenseAccounts, setExpenseAccounts] = useState<ExpenseAccount[]>([])
  const [suppliers, setSuppliers] = useState<SupplierItem[]>([])
  const [branches, setBranches] = useState<BranchItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [departmentFilter, setDepartmentFilter] = useState('all')
  const [requesterFilter, setRequesterFilter] = useState('all')
  const [searchDraft, setSearchDraft] = useState('')
  const [statusFilterDraft, setStatusFilterDraft] = useState('all')
  const [departmentFilterDraft, setDepartmentFilterDraft] = useState('all')
  const [requesterFilterDraft, setRequesterFilterDraft] = useState('all')
  const [dateFromDraft, setDateFromDraft] = useState('')
  const [dateToDraft, setDateToDraft] = useState('')

  function applyFilters() {
    setSearch(searchDraft)
    setStatusFilter(statusFilterDraft)
    setDepartmentFilter(departmentFilterDraft)
    setRequesterFilter(requesterFilterDraft)
    setDateFrom(dateFromDraft)
    setDateTo(dateToDraft)
  }

  const [form, setForm] = useState({
    requested_by: '',
    department: '',
    branch: '',
    car_id: '',
    expense_account_id: '',
    notes: '',
  })
  const [items, setItems] = useState([{ description: '', quantity: 1, estimated_price: 0 }])

  const [convertReq, setConvertReq] = useState<ReqRow | null>(null)
  const [convertSupplierId, setConvertSupplierId] = useState('')
  const [converting, setConverting] = useState(false)

  useEffect(() => {
    setMounted(true)
    fetchReqs()
    fetchOptions()
  }, [])

  async function fetchReqs() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('purchase_requisitions')
        .select('*')
        .order('request_date', { ascending: false })
      if (data) setReqs(data as any)
    } catch (error) {
      console.error('Error fetching requisitions:', error)
    }
    setLoading(false)
  }

  async function fetchOptions() {
    const results = await Promise.allSettled([
      supabase.from('cars').select('id, make, model, plate_number').order('make'),
      supabase.from('expense_accounts').select('id, code, name').order('code'),
      supabase.from('suppliers').select('id, name').order('name'),
      supabase.from('branches').select('id, name').order('name'),
    ])
    const [carsRes, accRes, supRes, branchRes] = results
    if (carsRes.status === 'fulfilled' && carsRes.value.data) setVehicles(carsRes.value.data as any)
    if (accRes.status === 'fulfilled' && accRes.value.data) setExpenseAccounts(accRes.value.data as any)
    if (supRes.status === 'fulfilled' && supRes.value.data) setSuppliers(supRes.value.data as any)
    if (branchRes.status === 'fulfilled' && branchRes.value.data) setBranches(branchRes.value.data as any)
  }

  function addItem() {
    setItems([...items, { description: '', quantity: 1, estimated_price: 0 }])
  }

  function updateItem(idx: number, field: string, value: any) {
    const newItems = [...items]
    newItems[idx] = { ...newItems[idx], [field]: value }
    setItems(newItems)
  }

  function removeItem(idx: number) {
    if (items.length === 1) return
    setItems(items.filter((_, i) => i !== idx))
  }

  const totalEstimated = items.reduce((s, i) => s + (i.quantity * i.estimated_price), 0)

  async function handleSubmit() {
    if (!form.requested_by.trim()) {
      alert(isRTL ? 'أدخل اسم الطالب' : 'Enter requester name')
      return
    }
    if (items.some(i => !i.description.trim())) {
      alert(isRTL ? 'أدخل وصف كل بند' : 'Enter description for all items')
      return
    }

    setSaving(true)
    try {
      const { data: reqData, error: reqError } = await supabase.from('purchase_requisitions').insert([{
        req_number: generateReqNumber(),
        requested_by: form.requested_by.trim(),
        request_date: new Date().toISOString().split('T')[0],
        department: form.department.trim() || null,
        branch: form.branch || null,
        car_id: form.car_id || null,
        expense_account_id: form.expense_account_id || null,
        status: 'draft',
        total_amount: totalEstimated,
        notes: form.notes || null,
      }]).select().single()

      if (reqError) throw reqError

      const reqId = reqData.id
      const itemsToInsert = items.map(item => ({
        purchase_requisition_id: reqId,
        description: item.description,
        quantity: item.quantity,
        estimated_price: item.estimated_price,
        total_price: item.quantity * item.estimated_price,
      }))

      await supabase.from('purchase_requisition_items').insert(itemsToInsert)

      setForm({ requested_by: '', department: '', branch: '', car_id: '', expense_account_id: '', notes: '' })
      setItems([{ description: '', quantity: 1, estimated_price: 0 }])
      setShowForm(false)
      fetchReqs()
    } catch (error: any) {
      alert(isRTL ? 'خطأ: ' + error.message : 'Error: ' + error.message)
    }
    setSaving(false)
  }

  async function updateStatus(req: ReqRow, status: string) {
    if (status === 'rejected') {
      const reason = prompt(isRTL ? 'سبب الرفض (اختياري):' : 'Rejection reason (optional):') || null
      await supabase.from('purchase_requisitions').update({ status, rejection_reason: reason }).eq('id', req.id)
    } else if (status === 'approved') {
      await supabase.from('purchase_requisitions').update({ status, approved_by: 'Admin', approved_at: new Date().toISOString() }).eq('id', req.id)
    } else {
      await supabase.from('purchase_requisitions').update({ status }).eq('id', req.id)
    }
    fetchReqs()
  }

  async function handleDelete(id: string) {
    if (!confirm(isRTL ? 'هل أنت متأكد؟' : 'Are you sure?')) return
    await supabase.from('purchase_requisition_items').delete().eq('purchase_requisition_id', id)
    await supabase.from('purchase_requisitions').delete().eq('id', id)
    fetchReqs()
  }

  function openConvert(req: ReqRow) {
    setConvertReq(req)
    setConvertSupplierId('')
  }

  async function confirmConvert() {
    if (!convertReq) return
    if (!convertSupplierId) { alert(isRTL ? 'اختر المورد' : 'Select a supplier'); return }
    setConverting(true)
    try {
      const { data: reqItems } = await supabase.from('purchase_requisition_items').select('*').eq('purchase_requisition_id', convertReq.id)
      const poNumber = await nextDocumentNumber(supabase as any, 'purchase_order', 'PO')
      const { data: poData, error: poError } = await supabase.from('purchase_orders').insert([{
        po_number: poNumber,
        supplier_id: convertSupplierId,
        order_date: new Date().toISOString().split('T')[0],
        status: 'draft',
        total_amount: convertReq.total_amount,
        notes: `Converted from requisition ${convertReq.req_number}`,
        purchase_requisition_id: convertReq.id,
        branch: convertReq.branch || null,
        car_id: convertReq.car_id || null,
      }]).select().single()
      if (poError) throw poError

      const poItems = (reqItems || []).map((it: any) => ({
        purchase_order_id: poData.id,
        description: it.description,
        quantity: it.quantity,
        unit_price: it.estimated_price,
        total_price: it.total_price,
      }))
      if (poItems.length > 0) await supabase.from('purchase_order_items').insert(poItems)

      await supabase.from('purchase_requisitions').update({ status: 'converted', converted_to_po_id: poData.id }).eq('id', convertReq.id)

      setConvertReq(null)
      fetchReqs()
      alert(isRTL ? 'تم إنشاء أمر الشراء: ' + poData.po_number : 'Purchase order created: ' + poData.po_number)
    } catch (error: any) {
      alert(isRTL ? 'خطأ: ' + error.message : 'Error: ' + error.message)
    }
    setConverting(false)
  }

  const departmentOptions = useMemo(() => {
    const set = new Set<string>()
    reqs.forEach(r => { if (r.department) set.add(r.department) })
    return Array.from(set).sort()
  }, [reqs])

  const requesterOptions = useMemo(() => {
    const set = new Set<string>()
    reqs.forEach(r => { if (r.requested_by) set.add(r.requested_by) })
    return Array.from(set).sort()
  }, [reqs])

  const filtered = reqs.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false
    if (departmentFilter !== 'all' && r.department !== departmentFilter) return false
    if (requesterFilter !== 'all' && r.requested_by !== requesterFilter) return false
    if (dateFrom && r.request_date < dateFrom) return false
    if (dateTo && r.request_date > dateTo) return false
    if (search) {
      const s = search.toLowerCase()
      if (!r.req_number.toLowerCase().includes(s) && !r.requested_by.toLowerCase().includes(s)) return false
    }
    return true
  })

  function resetFilters() {
    setSearch(''); setStatusFilter('all'); setDateFrom(''); setDateTo('')
    setDepartmentFilter('all'); setRequesterFilter('all'); setSearchDraft(''); setStatusFilterDraft('all'); setDateFromDraft(''); setDateToDraft(''); setDepartmentFilterDraft('all'); setRequesterFilterDraft('all')
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <FilePlus className="w-7 h-7 text-violet-500" />
              {isRTL ? 'طلبات الشراء' : 'Purchase Requisitions'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {isRTL ? 'طلبات شراء تنتظر الاعتماد' : 'Purchase requests awaiting approval'}
            </p>
          </div>
          <Button onClick={() => setShowForm(!showForm)} className="bg-violet-600 hover:bg-violet-700 text-white rounded-xl gap-2 shadow-lg shadow-violet-200 dark:shadow-none">
            <Plus className="w-4 h-4" />
            {showForm ? (isRTL ? 'إلغاء' : 'Cancel') : (isRTL ? 'طلب جديد' : 'New Requisition')}
          </Button>
        </div>

        {/* PROFESSIONAL FORM */}
        {showForm && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl shadow-slate-100 dark:shadow-none overflow-hidden">
            <div className="bg-gradient-to-r from-violet-50 to-indigo-50 dark:from-slate-700 dark:to-slate-700 px-6 py-4 border-b border-slate-200 dark:border-slate-600">
              <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-violet-600" />
                {isRTL ? 'طلب شراء جديد' : 'New Purchase Requisition'}
              </h3>
            </div>

            <div className="p-6 space-y-6">
              {/* Row 1 */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                <InputField
                  label={isRTL ? 'الطالب' : 'Requested By'}
                  icon={User}
                  required
                  value={form.requested_by}
                  onChange={(e: any) => setForm({ ...form, requested_by: e.target.value })}
                  placeholder={isRTL ? 'اسم الموظف' : 'Employee name'}
                />
                <InputField
                  label={isRTL ? 'القسم' : 'Department'}
                  icon={Building2}
                  value={form.department}
                  onChange={(e: any) => setForm({ ...form, department: e.target.value })}
                  placeholder={isRTL ? 'مثال: الصيانة' : 'e.g. Maintenance'}
                />
                <SelectField
                  label={isRTL ? 'الفرع' : 'Branch'}
                  icon={Building2}
                  value={form.branch}
                  onChange={(e: any) => setForm({ ...form, branch: e.target.value })}
                  placeholder={isRTL ? '— اختر الفرع —' : '— Select Branch —'}
                  options={branches.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                />
              </div>

              {/* Row 2 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <SelectField
                  label={isRTL ? 'السيارة' : 'Vehicle'}
                  icon={Car}
                  value={form.car_id}
                  onChange={(e: any) => setForm({ ...form, car_id: e.target.value })}
                  placeholder={isRTL ? '— بدون —' : '— None —'}
                  options={vehicles.map(v => (
                    <option key={v.id} value={v.id}>{v.make} {v.model} — {v.plate_number}</option>
                  ))}
                />
                <SelectField
                  label={isRTL ? 'حساب المصروف' : 'Expense Account'}
                  icon={CreditCard}
                  value={form.expense_account_id}
                  onChange={(e: any) => setForm({ ...form, expense_account_id: e.target.value })}
                  placeholder={isRTL ? '— بدون —' : '— None —'}
                  options={expenseAccounts.map(a => (
                    <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                  ))}
                />
              </div>

              {/* Row 3: Notes */}
              <InputField
                label={isRTL ? 'ملاحظات' : 'Notes'}
                icon={StickyNote}
                value={form.notes}
                onChange={(e: any) => setForm({ ...form, notes: e.target.value })}
                placeholder={isRTL ? 'أي ملاحظات إضافية...' : 'Any additional notes...'}
              />

              {/* Items */}
              <div className="border-t border-slate-200 dark:border-slate-600 pt-5">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                    <ClipboardList className="w-4 h-4 text-violet-500" />
                    {isRTL ? 'البنود المطلوبة' : 'Requested Items'}
                  </h4>
                  <Button type="button" variant="outline" size="sm" onClick={addItem} className="rounded-lg gap-1.5 border-violet-200 text-violet-600 hover:bg-violet-50 hover:text-violet-700">
                    <Plus className="w-3.5 h-3.5" /> {isRTL ? 'إضافة بند' : 'Add Item'}
                  </Button>
                </div>

                <div className="space-y-3">
                  {items.map((item, idx) => (
                    <div key={idx} className="group grid grid-cols-12 gap-3 items-end bg-slate-50 dark:bg-slate-700/40 p-3 rounded-xl border border-slate-200 dark:border-slate-600 hover:border-violet-300 dark:hover:border-violet-700 transition-colors">
                      <div className="col-span-5">
                        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1 block">{isRTL ? 'الوصف' : 'Description'}</label>
                        <Input value={item.description} onChange={(e) => updateItem(idx, 'description', e.target.value)} className="h-10 rounded-lg text-sm border-slate-200 dark:border-slate-600" placeholder={isRTL ? 'وصف البند' : 'Item description'} />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1 block">{isRTL ? 'الكمية' : 'Qty'}</label>
                        <Input type="number" min={1} value={item.quantity} onChange={(e) => updateItem(idx, 'quantity', parseFloat(e.target.value) || 0)} className="h-10 rounded-lg text-sm border-slate-200 dark:border-slate-600 text-center" />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1 block">{isRTL ? 'السعر' : 'Price'}</label>
                        <Input type="number" step="0.001" value={item.estimated_price} onChange={(e) => updateItem(idx, 'estimated_price', parseFloat(e.target.value) || 0)} className="h-10 rounded-lg text-sm border-slate-200 dark:border-slate-600 text-center" placeholder="0.000" />
                      </div>
                      <div className="col-span-2 flex items-center justify-center h-10 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-600">
                        <span className="text-sm font-bold text-violet-600 dark:text-violet-400">{formatCurrency(item.quantity * item.estimated_price)}</span>
                      </div>
                      <div className="col-span-1 flex justify-center">
                        <Button type="button" variant="ghost" size="icon" onClick={() => removeItem(idx)} className="h-9 w-9 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" disabled={items.length === 1}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-600 pt-5">
                <div className="bg-violet-50 dark:bg-violet-900/20 px-5 py-3 rounded-xl border border-violet-100 dark:border-violet-800">
                  <span className="text-xs text-violet-600 dark:text-violet-300 font-medium uppercase tracking-wider">{isRTL ? 'التقدير الكلي' : 'Total Estimated'}</span>
                  <p className="text-2xl font-black text-violet-700 dark:text-violet-300">{formatCurrency(totalEstimated)}</p>
                </div>
                <Button onClick={handleSubmit} disabled={saving} className="bg-violet-600 hover:bg-violet-700 text-white rounded-xl gap-2 h-12 px-8 text-sm font-bold shadow-lg shadow-violet-200 dark:shadow-none transition-all hover:scale-[1.02] active:scale-[0.98]">
                  <Save className="w-4 h-4" />
                  {saving ? (isRTL ? 'جاري الحفظ...' : 'Saving...') : (isRTL ? 'حفظ الطلب' : 'Save Requisition')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
            <Filter className="w-4 h-4" /> {isRTL ? 'فلاتر' : 'Filters'}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className={`absolute ${isRTL ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400`} />
              <Input placeholder={isRTL ? 'بحث برقم الطلب أو الطالب...' : 'Search by req # or requester...'} value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyFilters() }} className={`${isRTL ? 'pr-9' : 'pl-9'} h-9 rounded-lg text-sm`} />
            </div>
            <select value={statusFilterDraft} onChange={e => setStatusFilterDraft(e.target.value)} className="h-9 rounded-lg text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3">
              <option value="all">{isRTL ? 'كل الحالات' : 'All statuses'}</option>
              {STATUS_OPTIONS.map(s => <option key={s.key} value={s.key}>{isRTL ? s.labelAr : s.labelEn}</option>)}
            </select>
            <select value={departmentFilterDraft} onChange={e => setDepartmentFilterDraft(e.target.value)} className="h-9 rounded-lg text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3">
              <option value="all">{isRTL ? 'كل الأقسام' : 'All departments'}</option>
              {departmentOptions.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={requesterFilterDraft} onChange={e => setRequesterFilterDraft(e.target.value)} className="h-9 rounded-lg text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3">
              <option value="all">{isRTL ? 'كل مقدمي الطلبات' : 'All requesters'}</option>
              {requesterOptions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <Input type="date" value={dateFromDraft} onChange={e => setDateFromDraft(e.target.value)} className="h-9 rounded-lg text-sm w-auto" />
            <span className="text-slate-400 text-sm">{isRTL ? 'إلى' : 'to'}</span>
            <Input type="date" value={dateToDraft} onChange={e => setDateToDraft(e.target.value)} className="h-9 rounded-lg text-sm w-auto" />
            <Button size="sm" onClick={applyFilters} className="h-9 rounded-lg text-xs gap-1 bg-violet-600 hover:bg-violet-700 text-white">
              <Search className="w-3 h-3" /> {isRTL ? 'بحث' : 'Search'}
            </Button>
            <Button variant="outline" size="sm" onClick={resetFilters} className="h-9 rounded-lg text-xs gap-1">
              <X className="w-3 h-3" /> {isRTL ? 'إعادة تعيين' : 'Reset'}
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin w-8 h-8 border-4 border-violet-500 border-t-transparent rounded-full"></div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400">
              <FilePlus className="w-12 h-12 mb-3 opacity-30" />
              <p>{isRTL ? 'لا توجد طلبات' : 'No requisitions'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-700">
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'رقم الطلب' : 'Req #'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الطالب' : 'Requester'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'القسم' : 'Dept'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الفرع' : 'Branch'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'التاريخ' : 'Date'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'التقدير' : 'Est. Amount'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الحالة' : 'Status'}</th>
                    <th className="py-3 px-4 text-center">{isRTL ? 'إجراءات' : 'Actions'}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((req) => {
                    const statusOpt = STATUS_OPTIONS.find(s => s.key === req.status) || STATUS_OPTIONS[0]
                    const branchName = BRANCHES.find(b => b.id === req.branch)?.name || req.branch || '-'
                    return (
                      <tr key={req.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                        <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">{req.req_number}</td>
                        <td className="py-3 px-4 text-slate-700 dark:text-slate-300">{req.requested_by}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">{req.department || '-'}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">{branchName}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">{formatDate(req.request_date)}</td>
                        <td className="py-3 px-4 font-bold text-slate-900 dark:text-white">{formatCurrency(parseFloat(req.total_amount as any) || 0)}</td>
                        <td className="py-3 px-4">
                          <Badge className={statusOpt.color}>{isRTL ? statusOpt.labelAr : statusOpt.labelEn}</Badge>
                          {req.status === 'rejected' && req.rejection_reason && (
                            <div className="text-[10px] text-red-500 mt-1">{req.rejection_reason}</div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <div className="flex items-center justify-center gap-1">
                            {req.status === 'draft' && (
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-amber-600" onClick={() => updateStatus(req, 'pending')} title={isRTL ? 'إرسال' : 'Submit'}>
                                <ArrowRight className="w-4 h-4" />
                              </Button>
                            )}
                            {req.status === 'pending' && (
                              <>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600" onClick={() => updateStatus(req, 'approved')} title={isRTL ? 'اعتماد' : 'Approve'}>
                                  <CheckCircle className="w-4 h-4" />
                                </Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500" onClick={() => updateStatus(req, 'rejected')} title={isRTL ? 'رفض' : 'Reject'}>
                                  <XCircle className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                            {req.status === 'approved' && !req.converted_to_po_id && (
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-blue-600" onClick={() => openConvert(req)} title={isRTL ? 'تحويل لأمر شراء' : 'Convert to PO'}>
                                <Truck className="w-4 h-4" />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500" onClick={() => handleDelete(req.id)}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
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

      {/* Convert Modal */}
      {convertReq && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setConvertReq(null)}>
          <div className="bg-white dark:bg-slate-800 rounded-2xl w-full max-w-sm p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-3">
              {isRTL ? `تحويل ${convertReq.req_number} لأمر شراء` : `Convert ${convertReq.req_number} to PO`}
            </h3>
            <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'اختر المورد' : 'Select Supplier'} *</label>
            <select value={convertSupplierId} onChange={e => setConvertSupplierId(e.target.value)} className="h-10 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 w-full px-3 text-sm mb-4">
              <option value="">{isRTL ? '— اختر —' : '— Select —'}</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConvertReq(null)} className="rounded-lg h-8 text-xs">{isRTL ? 'إلغاء' : 'Cancel'}</Button>
              <Button size="sm" disabled={converting} onClick={confirmConvert} className="rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white h-8 text-xs">
                {converting ? (isRTL ? 'جاري...' : 'Converting...') : (isRTL ? 'تحويل' : 'Convert')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <PurchaseRequisitionsPageContent />
    </Suspense>
  )
}
