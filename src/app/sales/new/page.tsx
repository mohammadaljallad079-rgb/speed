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

function NewSaleContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [customers, setCustomers] = useState<any[]>([])
  const [taxSettings, setTaxSettings] = useState<TaxSetting[]>([])
  const [discountType, setDiscountType] = useState<"fixed" | "percentage">("fixed")
  const [discountValue, setDiscountValue] = useState("")

  const today = new Date().toISOString().split("T")[0]
  const [form, setForm] = useState({
    invoice_number: "",
    invoice_date: today,
    due_date: today,
    status: "pending",
    invoice_type: "sale",
    customer_id: "",
    amount: "",
    discount_amount: "",
    vat_amount: "",
    vat_tax_id: "",
    notes: "",
    payment_method: "",
    payment_term: "",
    advance_payment: "",
  })

  useEffect(() => {
    supabase.rpc("generate_document_number", { p_doc_type: "sale_invoice" })
      .then(({ data, error }) => {
        if (!error && data) setForm(prev => ({ ...prev, invoice_number: data }))
      })
  }, [])

  useEffect(() => {
    supabase.from("customers").select("id,full_name,name,phone").order("full_name")
      .then(({ data }) => setCustomers(data || []))
    supabase.from("tax_settings").select("*").eq("is_active", true).order("created_at")
      .then(({ data }) => setTaxSettings(data || []))
  }, [])

  function set(key: string, val: string) {
    setForm(prev => ({ ...prev, [key]: val }))
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
  const computedStatus = advancePayment <= 0 ? "pending" : remaining <= 0 ? "paid" : "partial"

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
        status: computedStatus,
        invoice_type: "sale",
        customer_id: form.customer_id,
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
          payment_type: "receipt",
          amount: advancePayment,
          payment_method: form.payment_method,
          payment_date: form.invoice_date,
          status: "completed",
        })
        if (paymentError) throw paymentError
      }

      if (newInvoice) {
        const cashOrBankCode = form.payment_method === "cash" ? "11001" : "11002"
        const { data: accountsData } = await supabase.from("accounts").select("id, code").in("code", [cashOrBankCode, "12001", "41002", "24000"])
        const acc = (code: string) => accountsData?.find((a: any) => a.code === code)?.id

        const { data: jvNumberData } = await supabase.rpc("generate_document_number", { p_doc_type: "journal_entry" })
        const { data: newJournal } = await supabase.from("journal_entries").insert({
          journal_number: jvNumberData,
          entry_date: form.invoice_date,
          reference_number: form.invoice_number,
          description: isRTL ? `فاتورة مبيعات - ${form.invoice_number}` : `Sale invoice - ${form.invoice_number}`,
          total_debit: total,
          total_credit: total,
          is_balanced: true,
          status: "posted",
          entry_type: "sale_invoice",
        }).select().single()

        if (newJournal) {
          const lines: any[] = []
          let lineOrder = 1
          if (advancePayment > 0) {
            lines.push({ journal_entry_id: newJournal.id, account_id: acc(cashOrBankCode), debit: advancePayment, credit: 0, description: isRTL ? "دفعة مقبوضة" : "Received payment", customer_id: form.customer_id, line_order: lineOrder++ })
          }
          if (remaining > 0) {
            lines.push({ journal_entry_id: newJournal.id, account_id: acc("12001"), debit: remaining, credit: 0, description: isRTL ? "رصيد مستحق على العميل" : "Amount due from customer", customer_id: form.customer_id, line_order: lineOrder++ })
          }
          lines.push({ journal_entry_id: newJournal.id, account_id: acc("41002"), debit: 0, credit: amount - discount, description: isRTL ? "إيراد مبيعات" : "Sales revenue", customer_id: form.customer_id, line_order: lineOrder++ })
          if (vat > 0) {
            lines.push({ journal_entry_id: newJournal.id, account_id: acc("24000"), debit: 0, credit: vat, description: isRTL ? "ضريبة القيمة المضافة" : "VAT payable", customer_id: form.customer_id, line_order: lineOrder++ })
          }
          await supabase.from("journal_lines").insert(lines)
        }
      }

      router.push("/sales")
    } catch (err: any) {
      alert(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/sales" className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50">
            <ArrowLeft className={`w-5 h-5 ${isRTL ? "rotate-180" : ""}`} />
          </Link>
          <h1 className="text-2xl font-black text-slate-800">{isRTL ? "فاتورة مبيعات جديدة" : "New Sale Invoice"}</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
            <h2 className="text-base font-black text-slate-700 flex items-center gap-2">
              <User className="w-4 h-4 text-red-500" />
              {isRTL ? "العميل" : "Customer"}
            </h2>
            <div className="space-y-1">
              <label className="text-xs text-slate-500 font-semibold">{isRTL ? "العميل" : "Customer"} *</label>
              <select value={form.customer_id} onChange={e => set("customer_id", e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
                <option value="">{isRTL ? "-- اختر العميل --" : "-- Select Customer --"}</option>
                {customers.map((c: any) => <option key={c.id} value={c.id}>{c.full_name || c.name}</option>)}
              </select>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
            <h2 className="text-base font-black text-slate-700 flex items-center gap-2">
              <FileText className="w-4 h-4 text-red-500" />
              {isRTL ? "معلومات الفاتورة" : "Invoice Information"}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "رقم الفاتورة" : "Invoice Number"}</label>
                <input value={form.invoice_number} onChange={e => set("invoice_number", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm font-mono" />
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
                  <option value="">{isRTL ? "-- اختر --" : "-- Select --"}</option>
                  <option value="cash">{isRTL ? "نقدي" : "Cash"}</option>
                  <option value="credit_card">{isRTL ? "بطاقة" : "Credit Card"}</option>
                  <option value="bank_transfer">{isRTL ? "تحويل" : "Bank Transfer"}</option>
                  <option value="cheque">{isRTL ? "شيك" : "Cheque"}</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "شروط الدفع" : "Payment Terms"} *</label>
                <select value={form.payment_term} onChange={e => set("payment_term", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
                  <option value="">{isRTL ? "-- اختر --" : "-- Select --"}</option>
                  <option value="cash">{isRTL ? "نقدي" : "Cash"}</option>
                  <option value="credit">{isRTL ? "آجل" : "On Credit"}</option>
                </select>
              </div>
            </div>
          </div>

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
                      className={`px-3 py-2 ${discountType === "fixed" ? "bg-red-500 text-white" : "bg-slate-50 text-slate-500"}`}>
                      <Hash className="w-3 h-3" />
                    </button>
                    <button type="button" onClick={() => setDiscountType("percentage")}
                      className={`px-3 py-2 ${discountType === "percentage" ? "bg-red-500 text-white" : "bg-slate-50 text-slate-500"}`}>
                      <Percent className="w-3 h-3" />
                    </button>
                  </div>
                  <input type="number" step="0.001" value={discountValue} onChange={e => setDiscountValue(e.target.value)}
                    className="flex-1 h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm font-mono" placeholder="0" dir="ltr" />
                </div>
                <p className="text-xs text-slate-400">{discount > 0 ? `= ${discount.toFixed(3)} BHD` : ""}</p>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-500 font-semibold">{isRTL ? "الضريبة" : "Tax"}</label>
                <select value={form.vat_tax_id} onChange={e => set("vat_tax_id", e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm">
                  <option value="">{isRTL ? "-- بدون --" : "-- No Tax --"}</option>
                  {taxSettings.map((tax) => (
                    <option key={tax.id} value={tax.id}>
                      {isRTL ? tax.name_ar : tax.name_en} ({tax.rate}%)
                    </option>
                  ))}
                </select>
                {selectedTax && <p className="text-xs text-slate-400">{vat.toFixed(3)} BHD</p>}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-500 font-semibold">{isRTL ? "دفعة مقدمة (BHD)" : "Advance Payment (BHD)"}</label>
              <input type="number" step="0.001" value={form.advance_payment} onChange={e => set("advance_payment", e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm font-mono" placeholder="0.000" dir="ltr" />
            </div>
            <div className="border-t pt-4 space-y-2">
              <div className="flex justify-between items-center text-sm text-slate-500">
                <span>{isRTL ? "الإجمالي" : "Total"}</span>
                <span className="font-bold text-slate-700">{total.toFixed(3)} BHD</span>
              </div>
              {advancePayment > 0 && (
                <div className="flex justify-between items-center text-sm text-emerald-600">
                  <span>{isRTL ? "الدفعة المقدمة" : "Advance Payment"}</span>
                  <span className="font-bold">- {advancePayment.toFixed(3)} BHD</span>
                </div>
              )}
              <div className="flex justify-between items-center pt-2 border-t">
                <span className="font-bold text-slate-700">{isRTL ? "المتبقي" : "Remaining"}</span>
                <span className="text-2xl font-black text-slate-800">{remaining.toFixed(3)} BHD</span>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm p-6 space-y-2">
            <label className="text-xs text-slate-500 font-semibold">{isRTL ? "ملاحظات" : "Notes"}</label>
            <textarea value={form.notes} onChange={e => set("notes", e.target.value)} rows={3}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-sm resize-none" />
          </div>

          <button type="submit" disabled={loading}
            className="w-full h-14 bg-red-600 hover:bg-red-700 text-white font-black text-lg rounded-2xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50">
            <Save className="w-5 h-5" />
            {loading ? (isRTL ? "جاري..." : "Saving...") : (isRTL ? "حفظ فاتورة المبيعات" : "Save Sale Invoice")}
          </button>
        </form>
      </div>
    </DashboardLayout>
  )
}

export default function NewSalePage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <NewSaleContent />
    </Suspense>
  )
}
