"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect, useMemo } from "react"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { supabase, Supplier, PurchaseOrder, PurchaseOrderItem, generatePONumber } from "@/lib/supabase"
import { nextDocumentNumber } from "@/lib/numbering"
import { formatCurrency, formatDate } from "@/lib/utils"
import {
  ClipboardList, Plus, Search, Save, Trash2, CheckCircle, XCircle, Clock,
  ArrowRight, FileText, Truck, Package, Filter, X, Eye, Printer, Receipt
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

const STATUS_OPTIONS = [
  { key: 'draft', labelAr: 'مسودة', labelEn: 'Draft', color: 'bg-slate-100 text-slate-700' },
  { key: 'pending', labelAr: 'معلقة', labelEn: 'Pending', color: 'bg-amber-100 text-amber-700' },
  { key: 'approved', labelAr: 'معتمدة', labelEn: 'Approved', color: 'bg-blue-100 text-blue-700' },
  { key: 'ordered', labelAr: 'تم الطلب', labelEn: 'Ordered', color: 'bg-violet-100 text-violet-700' },
  { key: 'received', labelAr: 'مستلمة', labelEn: 'Received', color: 'bg-emerald-100 text-emerald-700' },
  { key: 'cancelled', labelAr: 'ملغاة', labelEn: 'Cancelled', color: 'bg-red-100 text-red-700' },
]
const BRANCHES = [
  { id: "manama", name: "Manama" },
  { id: "airport", name: "Airport" },
  { id: "muharraq", name: "Muharraq" },
  { id: "riffa", name: "Riffa" },
]

type POEntry = PurchaseOrder & {
  branch?: string | null
  car_id?: string | null
  purchase_requisition_id?: string | null
  suppliers?: { name: string }
}
type VehicleItem = { id: string; make: string; model: string; plate_number: string }

function PurchaseOrdersPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [orders, setOrders] = useState<POEntry[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [vehicles, setVehicles] = useState<VehicleItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)

  // Filters
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [supplierFilter, setSupplierFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [searchDraft, setSearchDraft] = useState('')
  const [statusFilterDraft, setStatusFilterDraft] = useState('all')
  const [supplierFilterDraft, setSupplierFilterDraft] = useState('all')
  const [dateFromDraft, setDateFromDraft] = useState('')
  const [dateToDraft, setDateToDraft] = useState('')

  function applyFilters() {
    setSearch(searchDraft)
    setStatusFilter(statusFilterDraft)
    setSupplierFilter(supplierFilterDraft)
    setDateFrom(dateFromDraft)
    setDateTo(dateToDraft)
  }

  const [form, setForm] = useState({
    supplier_id: '',
    expected_date: '',
    branch: '',
    car_id: '',
    notes: '',
  })
  const [items, setItems] = useState([{ description: '', quantity: 1, unit_price: 0 }])

  const [convertOrder, setConvertOrder] = useState<POEntry | null>(null)
  const [converting, setConverting] = useState(false)

  useEffect(() => {
    setMounted(true)
    fetchOrders()
    fetchSuppliers()
    fetchVehicles()
  }, [])

  async function fetchOrders() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('purchase_orders')
        .select('*, suppliers(name)')
        .order('order_date', { ascending: false })
      if (data) setOrders(data as any)
    } catch (error) {
      console.error('Error fetching POs:', error)
    }
    setLoading(false)
  }

  async function fetchSuppliers() {
    const { data } = await supabase.from('suppliers').select('*').order('name')
    if (data) setSuppliers(data as any)
  }

  async function fetchVehicles() {
    const { data } = await supabase.from('cars').select('id, make, model, plate_number').order('make')
    if (data) setVehicles(data as any)
  }

  function addItem() {
    setItems([...items, { description: '', quantity: 1, unit_price: 0 }])
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

  const totalAmount = items.reduce((s, i) => s + (i.quantity * i.unit_price), 0)

  async function handleSubmit() {
    if (!form.supplier_id) {
      alert(isRTL ? 'اختر المورد' : 'Select a supplier')
      return
    }
    if (items.some(i => !i.description.trim())) {
      alert(isRTL ? 'أدخل وصف كل بند' : 'Enter description for all items')
      return
    }
    setSaving(true)
    try {
      const { data: poData, error: poError } = await supabase.from('purchase_orders').insert([{
        po_number: generatePONumber(),
        supplier_id: form.supplier_id,
        order_date: new Date().toISOString().split('T')[0],
        expected_date: form.expected_date || null,
        branch: form.branch || null,
        car_id: form.car_id || null,
        status: 'draft',
        total_amount: totalAmount,
        notes: form.notes || null,
      }]).select().single()
      if (poError) throw poError

      const itemsToInsert = items.map(item => ({
        purchase_order_id: poData.id,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        total_price: item.quantity * item.unit_price,
      }))
      await supabase.from('purchase_order_items').insert(itemsToInsert)

      setForm({ supplier_id: '', expected_date: '', branch: '', car_id: '', notes: '' })
      setItems([{ description: '', quantity: 1, unit_price: 0 }])
      setShowForm(false)
      fetchOrders()
    } catch (error: any) {
      alert(isRTL ? 'خطأ: ' + error.message : 'Error: ' + error.message)
    }
    setSaving(false)
  }

  async function updateStatus(order: POEntry, status: string) {
    await supabase.from('purchase_orders').update({ status }).eq('id', order.id)
    fetchOrders()
  }

  async function handleDelete(id: string) {
    if (!confirm(isRTL ? 'هل أنت متأكد؟' : 'Are you sure?')) return
    await supabase.from('purchase_order_items').delete().eq('purchase_order_id', id)
    await supabase.from('purchase_orders').delete().eq('id', id)
    fetchOrders()
  }

  function handlePrint(order: POEntry) {
    const w = window.open('', '_blank')
    if (!w) return
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${order.po_number}</title>
      <style>body{font-family:Arial,sans-serif;padding:30px;max-width:800px;margin:0 auto}
      .header{text-align:center;border-bottom:2px solid #4f46e5;padding-bottom:12px;margin-bottom:16px}
      .info{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;font-size:13px}
      </style></head><body>
      <div class="header"><h2>Purchase Order</h2></div>
      <div class="info">
        <div><b>PO Number:</b> ${order.po_number}</div>
        <div><b>Date:</b> ${order.order_date}</div>
        <div><b>Supplier:</b> ${order.suppliers?.name || '-'}</div>
        <div><b>Status:</b> ${order.status}</div>
        <div><b>Total:</b> ${formatCurrency(order.total_amount as any)}</div>
        <div><b>Notes:</b> ${order.notes || '-'}</div>
      </div>
    </body></html>`
    w.document.write(html); w.document.close(); w.focus()
    setTimeout(() => w.print(), 300)
  }

  function openConvert(order: POEntry) {
    setConvertOrder(order)
  }

  async function confirmConvertToInvoice() {
    if (!convertOrder) return
    setConverting(true)
    try {
      const { data: poItems } = await supabase.from('purchase_order_items').select('*').eq('purchase_order_id', convertOrder.id)
      const invoiceNumber = await nextDocumentNumber(supabase as any, 'purchase_invoice', 'INV')
      const { data: invData, error: invError } = await supabase.from('purchase_invoices').insert([{
        invoice_number: invoiceNumber,
        supplier_id: convertOrder.supplier_id,
        bill_date: new Date().toISOString().split('T')[0],
        due_date: null,
        total_amount: convertOrder.total_amount,
        paid_amount: 0,
        vat_amount: 0,
        status: 'unpaid',
        notes: `From PO ${convertOrder.po_number}`,
        car_id: convertOrder.car_id || null,
        branch: convertOrder.branch || null,
        purchase_order_id: convertOrder.id,
      }]).select().single()
      if (invError) throw invError

      const invItems = (poItems || []).map((it: any) => ({
        purchase_invoice_id: invData.id,
        description: it.description,
        quantity: it.quantity,
        unit_price: it.unit_price,
        vat_rate: 0,
        total_price: it.total_price,
      }))
      if (invItems.length > 0) await supabase.from('purchase_invoice_items').insert(invItems)

      await supabase.from('purchase_orders').update({ status: 'received' }).eq('id', convertOrder.id)

      setConvertOrder(null)
      fetchOrders()
      alert(isRTL ? 'تم إنشاء فاتورة المورد: ' + invData.invoice_number : 'Supplier invoice created: ' + invData.invoice_number)
    } catch (error: any) {
      alert(isRTL ? 'خطأ: ' + error.message : 'Error: ' + error.message)
    }
    setConverting(false)
  }

  const filtered = orders.filter(o => {
    if (statusFilter !== 'all' && o.status !== statusFilter) return false
    if (supplierFilter !== 'all' && o.supplier_id !== supplierFilter) return false
    if (dateFrom && o.order_date < dateFrom) return false
    if (dateTo && o.order_date > dateTo) return false
    if (search) {
      const s = search.toLowerCase()
      if (!o.po_number.toLowerCase().includes(s) && !(o.suppliers?.name || '').toLowerCase().includes(s)) return false
    }
    return true
  })

  function resetFilters() {
    setSearch(''); setStatusFilter('all'); setSupplierFilter('all'); setDateFrom(''); setDateTo(''); setSearchDraft(''); setStatusFilterDraft('all'); setSupplierFilterDraft('all'); setDateFromDraft(''); setDateToDraft('')
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <ClipboardList className="w-7 h-7 text-indigo-500" />
              {isRTL ? 'أوامر الشراء' : 'Purchase Orders'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {isRTL ? 'أوامر شراء صادرة للموردين' : 'Purchase orders issued to suppliers'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/purchase-orders/requisitions" className="text-sm text-violet-600 hover:underline">
              {isRTL ? '← طلبات الشراء' : '← Requisitions'}
            </a>
            <Button onClick={() => setShowForm(!showForm)} className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl gap-2">
              <Plus className="w-4 h-4" />
              {showForm ? (isRTL ? 'إلغاء' : 'Cancel') : (isRTL ? 'أمر شراء جديد' : 'New PO')}
            </Button>
          </div>
        </div>

        {/* Form */}
        {showForm && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 space-y-4">
            <h3 className="font-bold text-slate-900 dark:text-white">{isRTL ? 'أمر شراء جديد' : 'New Purchase Order'}</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'المورد' : 'Supplier'} *</label>
                <select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })} className="h-11 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 w-full px-3 text-sm">
                  <option value="">{isRTL ? '— اختر —' : '— Select —'}</option>
                  {suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'تاريخ التسليم المتوقع' : 'Expected Date'}</label>
                <Input type="date" value={form.expected_date} onChange={(e) => setForm({ ...form, expected_date: e.target.value })} className="h-11 rounded-xl" />
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'الفرع' : 'Branch'}</label>
                <select value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} className="h-11 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 w-full px-3 text-sm">
                  <option value="">{isRTL ? '— اختر —' : '— Select —'}</option>
                  {BRANCHES.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'السيارة (اختياري)' : 'Vehicle (optional)'}</label>
                <select value={form.car_id} onChange={(e) => setForm({ ...form, car_id: e.target.value })} className="h-11 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 w-full px-3 text-sm">
                  <option value="">{isRTL ? '— بدون —' : '— None —'}</option>
                  {vehicles.map(v => <option key={v.id} value={v.id}>{v.make} {v.model} - {v.plate_number}</option>)}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-sm text-slate-500 mb-1 block">{isRTL ? 'ملاحظات' : 'Notes'}</label>
                <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="h-11 rounded-xl" />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-slate-700 dark:text-slate-300">{isRTL ? 'البنود' : 'Items'}</h4>
                <Button type="button" variant="outline" size="sm" onClick={addItem} className="rounded-lg gap-1">
                  <Plus className="w-3 h-3" /> {isRTL ? 'إضافة' : 'Add'}
                </Button>
              </div>
              {items.map((item, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-end bg-slate-50 dark:bg-slate-700/50 p-2 rounded-xl">
                  <div className="col-span-5">
                    <Input value={item.description} onChange={(e) => updateItem(idx, 'description', e.target.value)} className="h-9 rounded-lg text-sm" placeholder={isRTL ? 'وصف البند' : 'Item description'} />
                  </div>
                  <div className="col-span-2">
                    <Input type="number" value={item.quantity} onChange={(e) => updateItem(idx, 'quantity', parseFloat(e.target.value) || 0)} className="h-9 rounded-lg text-sm" placeholder="Qty" />
                  </div>
                  <div className="col-span-2">
                    <Input type="number" step="0.001" value={item.unit_price} onChange={(e) => updateItem(idx, 'unit_price', parseFloat(e.target.value) || 0)} className="h-9 rounded-lg text-sm" placeholder="Unit Price" />
                  </div>
                  <div className="col-span-2 text-sm font-bold text-slate-900 dark:text-white">
                    {formatCurrency(item.quantity * item.unit_price)}
                  </div>
                  <div className="col-span-1">
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeItem(idx)} className="h-8 w-8 text-red-500">
                      <Trash2 className="w-4 h-4" />
                    </Button>
</div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-600 pt-4">
              <p className="text-lg font-bold text-slate-900 dark:text-white">
                {isRTL ? 'الإجمالي:' : 'Total:'} {formatCurrency(totalAmount)}
              </p>
              <Button onClick={handleSubmit} disabled={saving} className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl gap-2">
                <Save className="w-4 h-4" /> {saving ? (isRTL ? 'جاري...' : 'Saving...') : (isRTL ? 'حفظ الأمر' : 'Save PO')}
              </Button>
            </div>
          </div>
        )}

        {/* Dynamic Filters */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
            <Filter className="w-4 h-4" /> {isRTL ? 'فلاتر' : 'Filters'}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className={`absolute ${isRTL ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400`} />
              <Input
                placeholder={isRTL ? 'بحث برقم الأمر أو المورد...' : 'Search by PO # or supplier...'}
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters() }}
                className={`${isRTL ? 'pr-9' : 'pl-9'} h-9 rounded-lg text-sm`}
              />
            </div>
            <select value={statusFilterDraft} onChange={e => setStatusFilterDraft(e.target.value)} className="h-9 rounded-lg text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3">
              <option value="all">{isRTL ? 'كل الحالات' : 'All statuses'}</option>
              {STATUS_OPTIONS.map(s => <option key={s.key} value={s.key}>{isRTL ? s.labelAr : s.labelEn}</option>)}
            </select>
            <select value={supplierFilterDraft} onChange={e => setSupplierFilterDraft(e.target.value)} className="h-9 rounded-lg text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3">
              <option value="all">{isRTL ? 'كل الموردين' : 'All suppliers'}</option>
              {suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <Input type="date" value={dateFromDraft} onChange={e => setDateFromDraft(e.target.value)} className="h-9 rounded-lg text-sm w-auto" />
            <span className="text-slate-400 text-sm">{isRTL ? 'إلى' : 'to'}</span>
            <Input type="date" value={dateToDraft} onChange={e => setDateToDraft(e.target.value)} className="h-9 rounded-lg text-sm w-auto" />
            <Button size="sm" onClick={applyFilters} className="h-9 rounded-lg text-xs gap-1 bg-indigo-600 hover:bg-indigo-700 text-white">
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
              <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400">
              <ClipboardList className="w-12 h-12 mb-3 opacity-30" />
              <p>{isRTL ? 'لا توجد أوامر شراء' : 'No purchase orders'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-700">
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'رقم الأمر' : 'PO #'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المورد' : 'Supplier'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'التاريخ' : 'Date'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الإجمالي' : 'Total'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الحالة' : 'Status'}</th>
                    <th className="py-3 px-4 text-center">{isRTL ? 'إجراءات' : 'Actions'}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((order) => {
                    const statusOpt = STATUS_OPTIONS.find(s => s.key === order.status) || STATUS_OPTIONS[0]
                    return (
                      <tr key={order.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                        <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                          {order.po_number}
                          {order.purchase_requisition_id && (
                            <div className="text-[10px] text-violet-500">{isRTL ? 'محوّل من طلب' : 'From requisition'}</div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-700 dark:text-slate-300">{order.suppliers?.name || '-'}</td>
                        <td className="py-3 px-4 text-sm text-slate-500">{formatDate(order.order_date)}</td>
                        <td className="py-3 px-4 font-bold text-slate-900 dark:text-white">{formatCurrency(parseFloat(order.total_amount as any) || 0)}</td>
                        <td className="py-3 px-4">
                          <Badge className={statusOpt.color}>{isRTL ? statusOpt.labelAr : statusOpt.labelEn}</Badge>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <div className="flex items-center justify-center gap-1">
                            {order.status === 'draft' && (
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-amber-600" onClick={() => updateStatus(order, 'pending')} title={isRTL ? 'إرسال' : 'Submit'}>
                                <ArrowRight className="w-4 h-4" />
                              </Button>
                            )}
                            {order.status === 'pending' && (
                              <>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-blue-600" onClick={() => updateStatus(order, 'approved')} title={isRTL ? 'اعتماد' : 'Approve'}>
                                  <CheckCircle className="w-4 h-4" />
                                </Button>
                                <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500" onClick={() => updateStatus(order, 'cancelled')} title={isRTL ? 'إلغاء' : 'Cancel'}>
                                  <XCircle className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                            {order.status === 'approved' && (
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-violet-600" onClick={() => updateStatus(order, 'ordered')} title={isRTL ? 'تم الطلب' : 'Mark Ordered'}>
                                <Truck className="w-4 h-4" />
                              </Button>
                            )}
                            {(order.status === 'ordered' || order.status === 'approved') && (
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600" onClick={() => openConvert(order)} title={isRTL ? 'تحويل لفاتورة مورد' : 'Convert to Invoice'}>
                                <Receipt className="w-4 h-4" />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-slate-500" onClick={() => handlePrint(order)} title={isRTL ? 'طباعة' : 'Print'}>
                              <Printer className="w-4 h-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500" onClick={() => handleDelete(order.id)} title={isRTL ? 'حذف' : 'Delete'}>
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

      {/* Convert to Invoice Modal */}
      {convertOrder && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setConvertOrder(null)}>
          <div className="bg-white dark:bg-slate-800 rounded-2xl w-full max-w-sm p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-900 dark:text-white mb-3">
              {isRTL ? `تحويل ${convertOrder.po_number} لفاتورة مورد` : `Convert ${convertOrder.po_number} to Invoice`}
            </h3>
            <p className="text-sm text-slate-500 mb-4">
              {isRTL ? 'سيتم إنشاء فاتورة مورد جديدة بنفس بنود ومبلغ أمر الشراء.' : 'A new supplier invoice will be created with the same items and amount.'}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConvertOrder(null)} className="rounded-lg h-8 text-xs">{isRTL ? 'إلغاء' : 'Cancel'}</Button>
              <Button size="sm" disabled={converting} onClick={confirmConvertToInvoice} className="rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white h-8 text-xs">
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
      <PurchaseOrdersPageContent />
    </Suspense>
  )
}
