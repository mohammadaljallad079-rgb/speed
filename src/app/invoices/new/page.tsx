"use client"
import { Suspense, useState, useEffect } from "react"
export const dynamic = "force-dynamic"
import { useRouter } from "next/navigation"
import DashboardLayout from "@/components/DashboardLayout"
import { supabase } from "@/lib/supabase"
import { useLanguage } from "@/lib/LanguageContext"
import { ArrowLeft, Save, FileText, User, DollarSign, CreditCard, Percent, Hash } from "lucide-react"
import Link from "next/link"

type TaxSetting = {
  id: string
  name_ar: string
  name_en: string
  rate: number
  type: string
  is_active: boolean
  applies_to: string
}

function NewInvoiceContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [customers, setCustomers] = useState<any[]>([])
  const [contracts, setContracts] = useState<any[]>([])
  const [filteredContracts, setFilteredContracts] = useState<any[]>([])
  const [showAddCustomer, setShowAddCustomer] = useState(false)
  const [newCustomer, setNewCustomer] = useState({ full_name: "", phone: "", email: "" })
  const [savingCustomer, setSavingCustomer] = useState(false)
  const [taxSettings, setTaxSettings] = useState<TaxSetting[]>([])
  const [discountType, setDiscountType] = useState<"fixed" | "percentage">("fixed")
  const [discountValue, setDiscountValue] = useState("")

  const today = new Date().toISOString().split("T")[0]
  const [form, setForm] = useState({
    invoice_number: "INV-" + Date.now().toString().slice(-6),
    invoice_date: today,
    due_date: today,
    status: "pending",
    invoice_type: "rental",
    customer_id: "",
    rental_contract_id: "",
    amount: "",
    discount_amount: "",
    vat_amount: "",
    vat_tax_id: "",
    notes: "",
    car_info: "",
    car_plate: "",
    rental_days: "",
    payment_method: "",
    payment_term: "",
    advance_payment: "",
  })

  useEffect(() => {
    supabase.from("customers").select("id,full_name,name,phone").order("full_name")
      .then(({ data }) => setCustomers(data || []))
    supabase.from("rental_contracts").select("id,contract_number,car_id,customer_id,start_date,end_date,daily_rate,total_amount,cars(make,model,plate_number)")
      .then(({ data }) => setContracts(data || []))
    supabase.from("tax_settings").select("*").eq("is_active", true).order("created_at")
      .then(({ data }) => setTaxSettings(data || []))
  }, [])

  useEffect(() => {
    if (form.customer_id) {
      setFilteredContracts(contracts.filter((c: any) => c.customer_id == form.customer_id))
    } else {
      setFilteredContracts(contracts)
    }
  }, [form.customer_id, contracts])

  function set(key: string, val: string) {
    setForm(prev => {
      const next = { ...prev, [key]: val }
      if (key === "rental_contract_id") {
        const contract = contracts.find((c: any) => c.id === val)
        if (contract) {
          const start = new Date(contract.start_date)
          const end = new Date(contract.end_date)
          const days = Math.ceil((end.getTime() - start.getTime()) / 86400000)
          const total = contract.total_amount || (contract.daily_rate * days)
          next.amount = total?.toFixed(3) || ""
          next.rental_days = String(days)
          next.car_info = `${contract.cars?.make || ""} ${contract.cars?.model || ""}`.trim()
          next.car_plate = contract.cars?.plate_number || ""
          if (!next.customer_id) next.customer_id = contract.customer_id
        }
      }
      return next
    })
  }

  const amount = parseFloat(form.amount) || 0
  let discount = 0
  if (discountType === "percentage" && discountValue) {
    discount = amount * (parseFloat(discountValue) / 100)
  } else if (discountType === "fixed" && discountValue) {
    discount = parseFloat(discountValue) || 0
  }

  const selectedTax = taxSettings.find(t => t.id === form.vat_tax_id)
  const vatRate = selectedTax?.rate || 0
  const vat = amount * (vatRate / 100)

  const total = Math.max(0, amount - discount + vat)
  const advancePayment = Math.min(parseFloat(form.advance_payment) || 0, total)
  const remaining = Math.max(0, total - advancePayment)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.customer_id) { alert(isRTL ? "اختر العميل" : "Select a customer"); return }
    if (!form.amount) { alert(isRTL ? "أدخل المبلغ" : "Enter amount"); return }
    if (!form.payment_method) { alert(isRTL ? "اختر طريقة الدفع" : "Select payment method"); return }
    if (!form.payment_term) { alert(isRTL ? "اختر شروط الدفع" : "Select payment terms"); return }
    setLoading(true)
    try {
      const { data: newInvoice, error } = await supabase.from("invoices").insert([{
        invoice_number: form.invoice_number,
        invoice_date: form.invoice_date,
        due_date: form.due_date,
        status: form.status,
        invoice_type: form.invoice_type,
        customer_id: form.customer_id,
        rental_contract_id: form.rental_contract_id && form.rental_contract_id !== "none" ? form.rental_contract_id : null,
        total_amount: total,
        paid_amount: 0,
        discount_amount: discount,
        vat_amount: vat,
        vat_tax_id: form.vat_tax_id || null,
        payment_method: form.payment_method,
        payment_term: form.payment_term,
        notes: form.notes || null,
      }]).select().single()
      if (error) throw error

      if (advancePayment > 0 && newInvoice) {
        const { error: paymentError } = await supabase.from("payments").insert({
          receipt_number: `REC-${Date.now().toString().slice(-8)}`,
          invoice_id: newInvoice.id,
          customer_id: form.customer_id,
          rental_contract_id: form.rental_contract_id && form.rental_contract_id !== "none" ? form.rental_contract_id : null,
          payment_type: "receipt",
          amount: advancePayment,
          payment_method: form.payment_method,
          payment_date: form.invoice_date,
          status: "completed",
        })
        if (paymentError) throw paymentError
      }

      router.push("/invoices")
    } catch (err: any) {
      alert(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleAddCustomer() {
    if (!newCustomer.full_name) return
    setSavingCustomer(true)
    const { data, error } = await supabase.from("customers").insert([{
      full_name: newCustomer.full_name,
      name: newCustomer.full_name,
      phone: newCustomer.phone || null,
      email: newCustomer.email || null,
    }]).select().single()
    setSavingCustomer(false)
    if (!error && data) {
      setCustomers(prev => [...prev, data].sort((a, b) => (a.full_name||"").localeCompare(b.full_name||"")))
      set("customer_id", data.id)
      setShowAddCustomer(false)
      setNewCustomer({ full_name: "", phone: "", email: "" })
    }
  }

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/invoices" className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50">
            <ArrowLeft className={`w-5 h-5 ${isRTL ? "rotate-180" : ""}`} />
          </Link>
          <h1 className="text-2xl font-black text-slate-800">{isRTL ? "فاتورة جديدة" : "New Invoice"}</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">

          {/* Customer & Contract */}
          <div className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
            <h2 className="text-base font-black text-slate-700 flex items-center gap-2">
              <User className="w-4 h-4 text-red-500" />
              {isRTL ? "العميل والعقد" : "Customer & Contract"}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <label className="text-xs text-slate-500 font-semibold">{isRTL ? "العميل" : "Customer"} *</label>
                  <button type="button" onClick={() => setShowAddCustomer(true)} className="text-xs text-red-500 font-bold hover:underline">
                    + {isRTL ? "عميل جديد" : "New Customer"}
                  </button>
                </div>
                <select value={form.customer_id} onChange={e => set("customer_id", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
                  <option value="">{isRTL ? "-- اختر العميل --" : "-- Select Customer --"}</option>
                  {customers.map((c: any) => <option key={c.id} value={c.id}>{c.full_name || c.name}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "عقد الإيجار (اختياري)" : "Rental Contract (optional)"}</label>
                <select value={form.rental_contract_id} onChange={e => set("rental_contract_id", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
                  <option value="none">{isRTL ? "-- بدون عقد --" : "-- No Contract --"}</option>
                  {filteredContracts.map((r: any) => (
                    <option key={r.id} value={r.id}>
                      {r.cars?.make} {r.cars?.model} — {r.cars?.plate_number} ({r.contract_number || r.id.slice(0,8)})
                    </option>
                  ))}
                </select>
              </div>
              {form.car_plate && (
                <div className="space-y-1">
                  <label className="text-xs text-slate-500 font-semibold">{isRTL ? "السيارة" : "Car"}</label>
                  <div className="h-10 px-3 rounded-xl bg-cyan-50 border border-cyan-200 flex items-center text-sm font-bold text-cyan-700">
                    {form.car_info} — {form.car_plate}
                  </div>
                </div>
              )}
              {form.rental_days && (
                <div className="space-y-1">
                  <label className="text-xs text-slate-500 font-semibold">{isRTL ? "عدد الأيام" : "Rental Days"}</label>
                  <div className="h-10 px-3 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center text-sm font-bold text-emerald-700">
                    {form.rental_days} {isRTL ? "يوم" : "days"}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Invoice Info */}
          <div className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
            <h2 className="text-base font-black text-slate-700 flex items-center gap-2">
              <FileText className="w-4 h-4 text-red-500" />
              {isRTL ? "معلومات الفاتورة" : "Invoice Information"}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "رقم الفاتورة" : "Invoice Number"}</label>
                <input value={form.invoice_number} onChange={e => set("invoice_number", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm font-mono" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "نوع الفاتورة" : "Type"}</label>
                <select value={form.invoice_type} onChange={e => set("invoice_type", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
                  <option value="sale">{isRTL ? "بيع" : "Sale"}</option>
                  <option value="rental">{isRTL ? "إيجار" : "Rental"}</option>
                  <option value="service">{isRTL ? "خدمة" : "Service"}</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "الحالة" : "Status"}</label>
                <select value={form.status} onChange={e => set("status", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
                  <option value="pending">{isRTL ? "معلقة" : "Pending"}</option>
                  <option value="paid">{isRTL ? "مدفوعة" : "Paid"}</option>
                  <option value="overdue">{isRTL ? "متأخرة" : "Overdue"}</option>
                  <option value="cancelled">{isRTL ? "ملغاة" : "Cancelled"}</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "تاريخ الفاتورة" : "Invoice Date"}</label>
                <input type="date" value={form.invoice_date} onChange={e => set("invoice_date", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm" dir="ltr" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "تاريخ الاستحقاق" : "Due Date"}</label>
                <input type="date" value={form.due_date} onChange={e => set("due_date", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm" dir="ltr" />
              </div>
            </div>
          </div>

          {/* Payment Method & Terms */}
          <div className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
            <h2 className="text-base font-black text-slate-700 flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-red-500" />
              {isRTL ? "الدفع" : "Payment"}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "طريقة الدفع" : "Payment Method"} *</label>
                <select value={form.payment_method} onChange={e => set("payment_method", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
                  <option value="">{isRTL ? "-- اختر طريقة الدفع --" : "-- Select Payment Method --"}</option>
                  <option value="cash">{isRTL ? "نقدي" : "Cash"}</option>
                  <option value="credit_card">{isRTL ? "بطاقة ائتمان" : "Credit Card"}</option>
                  <option value="bank_transfer">{isRTL ? "تحويل بنكي" : "Bank Transfer"}</option>
                  <option value="cheque">{isRTL ? "شيك" : "Cheque"}</option>
                  <option value="online">{isRTL ? "دفع إلكتروني" : "Online Payment"}</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "شروط الدفع" : "Payment Terms"} *</label>
                <select value={form.payment_term} onChange={e => set("payment_term", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
                  <option value="">{isRTL ? "-- اختر شروط الدفع --" : "-- Select Payment Terms --"}</option>
                  <option value="cash">{isRTL ? "نقدي" : "Cash"}</option>
                  <option value="credit">{isRTL ? "آجل" : "On Credit"}</option>
                </select>
              </div>
            </div>
          </div>

          {/* Amounts */}
          <div className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
            <h2 className="text-base font-black text-slate-700 flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-red-500" />
              {isRTL ? "المبالغ" : "Amounts"}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "المبلغ (BHD)" : "Amount (BHD)"} *</label>
                <input type="number" step="0.001" value={form.amount} onChange={e => set("amount", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm font-mono" placeholder="0.000" dir="ltr" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "الخصم" : "Discount"}</label>
                <div className="flex gap-2">
                  <div className="flex rounded-xl border border-slate-200 overflow-hidden">
                    <button type="button" onClick={() => setDiscountType("fixed")}
                      className={`px-3 py-2 text-xs font-bold ${discountType === "fixed" ? "bg-red-500 text-white" : "bg-slate-50 text-slate-500"}`}>
                      <Hash className="w-3 h-3" />
                    </button>
                    <button type="button" onClick={() => setDiscountType("percentage")}
                      className={`px-3 py-2 text-xs font-bold ${discountType === "percentage" ? "bg-red-500 text-white" : "bg-slate-50 text-slate-500"}`}>
                      <Percent className="w-3 h-3" />
                    </button>
                  </div>
                  <input type="number" step="0.001" value={discountValue} onChange={e => setDiscountValue(e.target.value)}
                    className="flex-1 h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm font-mono" placeholder={discountType === "percentage" ? "0%" : "0.000"} dir="ltr" />
                </div>
                <p className="text-xs text-slate-400">
                  {discountType === "percentage" ? (isRTL ? "نسبة %" : "Percentage %") : (isRTL ? "مبلغ ثابت" : "Fixed Amount")}
                  {discount > 0 && ` = ${discount.toFixed(3)} BHD`}
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "الضريبة" : "Tax"}</label>
                <select value={form.vat_tax_id} onChange={e => set("vat_tax_id", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
                  <option value="">{isRTL ? "-- بدون ضريبة --" : "-- No Tax --"}</option>
                  {taxSettings.map((tax) => (
                    <option key={tax.id} value={tax.id}>
                      {isRTL ? tax.name_ar : tax.name_en} ({tax.rate}%)
                    </option>
                  ))}
                </select>
                {selectedTax && (
                  <p className="text-xs text-slate-400">
                    {isRTL ? selectedTax.name_ar : selectedTax.name_en}: {vat.toFixed(3)} BHD
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-500 font-semibold">{isRTL ? "دفعة مقدمة (BHD)" : "Advance Payment (BHD)"}</label>
              <input type="number" step="0.001" value={form.advance_payment} onChange={e => set("advance_payment", e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm font-mono" placeholder="0.000" dir="ltr" />
            </div>
            <div className="border-t pt-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">{isRTL ? "المبلغ" : "Amount"}</span>
                <span className="font-mono">{amount.toFixed(3)} BHD</span>
              </div>
              {discount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">{isRTL ? "الخصم" : "Discount"}</span>
                  <span className="font-mono text-red-500">-{discount.toFixed(3)} BHD</span>
                </div>
              )}
              {vat > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">{isRTL ? "الضريبة" : "Tax"} ({selectedTax?.rate}%)</span>
                  <span className="font-mono">+{vat.toFixed(3)} BHD</span>
                </div>
              )}
              <div className="flex justify-between items-center border-t pt-2">
                <span className="font-bold text-slate-700">{isRTL ? "الإجمالي" : "Total"}</span>
                <span className="text-2xl font-black text-slate-800">{total.toFixed(3)} BHD</span>
              </div>
              {advancePayment > 0 && (
                <div className="flex justify-between text-sm text-emerald-600">
                  <span>{isRTL ? "الدفعة المقدمة" : "Advance Payment"}</span>
                  <span className="font-bold">- {advancePayment.toFixed(3)} BHD</span>
                </div>
              )}
              <div className="flex justify-between items-center border-t pt-2">
                <span className="font-bold text-slate-700">{isRTL ? "المتبقي" : "Remaining"}</span>
                <span className="text-xl font-black text-amber-600">{remaining.toFixed(3)} BHD</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="bg-white rounded-2xl shadow-sm p-6 space-y-2">
            <label className="text-xs text-slate-500 font-semibold">{isRTL ? "ملاحظات" : "Notes"}</label>
            <textarea value={form.notes} onChange={e => set("notes", e.target.value)} rows={3}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-sm resize-none"
              placeholder={isRTL ? "أي ملاحظات إضافية..." : "Any additional notes..."} />
          </div>

          <button type="submit" disabled={loading}
            className="w-full h-14 bg-red-600 hover:bg-red-700 text-white font-black text-lg rounded-2xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50">
            <Save className="w-5 h-5" />
            {loading ? (isRTL ? "جاري الحفظ..." : "Saving...") : (isRTL ? "حفظ الفاتورة" : "Save Invoice")}
          </button>
        </form>

        {showAddCustomer && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
              <h3 className="text-lg font-bold text-slate-900 mb-4">{isRTL ? "إضافة عميل جديد" : "Add New Customer"}</h3>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-500 mb-1 block">{isRTL ? "الاسم الكامل" : "Full Name"} *</label>
                  <input value={newCustomer.full_name} onChange={e => setNewCustomer(p => ({...p, full_name: e.target.value}))}
                    className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm"
                    placeholder={isRTL ? "أدخل الاسم" : "Enter name"} />
                </div>
                <div>
                  <label className="text-xs text-slate-500 mb-1 block">{isRTL ? "رقم الهاتف" : "Phone"}</label>
                  <input value={newCustomer.phone} onChange={e => setNewCustomer(p => ({...p, phone: e.target.value}))}
                    className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm"
                    placeholder="+973 XXXX XXXX" dir="ltr" />
                </div>
                <div>
                  <label className="text-xs text-slate-500 mb-1 block">{isRTL ? "البريد الإلكتروني" : "Email"}</label>
                  <input type="email" value={newCustomer.email} onChange={e => setNewCustomer(p => ({...p, email: e.target.value}))}
                    className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm"
                    placeholder="email@example.com" dir="ltr" />
                </div>
              </div>
              <div className="flex gap-3 mt-5">
                <button onClick={handleAddCustomer} disabled={savingCustomer || !newCustomer.full_name}
                  className="flex-1 h-10 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl text-sm disabled:opacity-50">
                  {savingCustomer ? "..." : (isRTL ? "حفظ العميل" : "Save Customer")}
                </button>
                <button onClick={() => setShowAddCustomer(false)}
                  className="flex-1 h-10 border border-slate-200 rounded-xl text-sm hover:bg-slate-50">
                  {isRTL ? "إلغاء" : "Cancel"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function NewInvoicePage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <NewInvoiceContent />
    </Suspense>
  )
}
