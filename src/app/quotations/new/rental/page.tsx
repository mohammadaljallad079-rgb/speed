"use client"
export const dynamic = "force-dynamic"

import { Suspense, useState, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ArrowLeft, Save, Printer, Car, Calendar, Hash, DollarSign, Clock, CheckCircle } from "lucide-react"
import { supabase } from "@/lib/supabase"

function RentalQuotationForm() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [customers, setCustomers] = useState([])
  const [cars, setCars] = useState([])
  const [savedData, setSavedData] = useState(null)
  const [form, setForm] = useState({
    customer_id: "",
    car_id: "",
    quotation_date: new Date().toISOString().split("T")[0],
    valid_until: "",
    daily_rate: "",
    total_days: "",
    notes: "",
    status: "draft",
  })

  useEffect(() => {
    supabase.from("customers").select("id, name, phone").then(({data}) => setCustomers(data || []))
    supabase.from("cars").select("id, make, model, plate_number").then(({data}) => setCars(data || []))
  }, [])

  const selectedCustomer = customers.find(c => c.id === form.customer_id)
  const selectedCar = cars.find(c => c.id === form.car_id)
  const dailyRate = parseFloat(form.daily_rate) || 0
  const totalDays = parseFloat(form.total_days) || 0
  const subtotal = dailyRate * totalDays
  const vatRate = 15
  const vatAmount = subtotal * (vatRate / 100)
  const grandTotal = subtotal + vatAmount
  const qn = "QT-RENT-" + Date.now().toString().slice(-6)

  const handleSave = async () => {
    if (!form.customer_id || !form.car_id) {
      alert(isRTL ? "يرجى اختيار العميل والسيارة" : "Please select customer and car")
      return
    }
    setLoading(true)
    try {
      const payload = {
        quotation_number: qn,
        customer_id: form.customer_id,
        car_id: form.car_id,
        quotation_date: form.quotation_date,
        valid_until: form.valid_until || null,
        daily_rate: dailyRate,
        total_days: totalDays,
        subtotal: subtotal,
        vat_amount: vatAmount,
        total_amount: grandTotal,
        status: form.status,
        notes: form.notes || null,
      }
      const res = await fetch("/api/quotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const result = await res.json()
      if (!result.success) throw new Error(result.error)
      setSavedData({
        qn, customer: selectedCustomer, car: selectedCar,
        form, subtotal, vatAmount, grandTotal, vatRate
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e) {
      alert("Error: " + e.message)
    } finally {
      setLoading(false)
    }
  }

  const label = (ar, en) => isRTL ? ar : en
  const dir = isRTL ? "rtl" : "ltr"

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto pb-20" dir={dir}>
        <style>{`
          @media print {
            .no-print { display: none !important; }
            .print-only { display: block !important; }
            body { background: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .quotation-paper { box-shadow: none !important; margin: 0 !important; width: 100% !important; max-width: none !important; }
          }
          .print-only { display: none; }
        `}</style>

        {saved && (
          <div className="no-print fixed top-20 right-1/2 translate-x-1/2 z-50 bg-emerald-600 text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-2 animate-bounce">
            <CheckCircle className="w-5 h-5"/>
            <span className="font-bold">{label("تم الحفظ بنجاح!","Saved Successfully!")}</span>
          </div>
        )}

        <div className="no-print flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <Link href="/quotations/new"><Button variant="outline" size="icon"><ArrowLeft className="w-4 h-4"/></Button></Link>
            <div><h1 className="text-2xl font-bold">{label("عرض سعر تأجير سيارة", "Car Rental Quotation")}</h1><p className="text-sm text-slate-500">{label("إنشاء عرض سعر احترافي", "Create professional quotation")}</p></div>
          </div>
          <div className="flex gap-2">
            {savedData && <Button variant="outline" onClick={() => window.print()} className="bg-white border-red-600 text-red-600 hover:bg-red-50"><Printer className="w-4 h-4 mr-2"/>{label("طباعة","Print")}</Button>}
            <Button onClick={handleSave} disabled={loading} className="bg-red-600 hover:bg-red-700"><Save className="w-4 h-4 mr-2"/>{loading ? label("جاري...","Saving...") : label("حفظ","Save")}</Button>
          </div>
        </div>

        <div className="no-print grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <Card className="border-2 border-slate-800 shadow-lg">
            <CardContent className="p-6 space-y-4">
              <h3 className="text-lg font-bold flex items-center gap-2 text-slate-800 border-b-2 border-slate-300 pb-2"><Car className="w-5 h-5"/>{label("معلومات التأجير","Rental Information")}</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2"><Label className="text-xs font-bold text-slate-600 uppercase">{label("رقم العرض","Quotation #")}</Label><div className="flex items-center gap-2 bg-slate-100 px-3 py-2 rounded-lg font-mono text-sm border border-slate-300"><Hash className="w-4 h-4 text-slate-500"/>{qn}</div></div>
                <div className="space-y-2"><Label className="text-xs font-bold text-slate-600 uppercase">{label("التاريخ","Date")}</Label><div className="flex items-center gap-2"><Calendar className="w-4 h-4 text-slate-500"/><Input type="date" value={form.quotation_date} onChange={e => setForm({...form, quotation_date: e.target.value})} className="border-slate-300"/></div></div>
              </div>
              <div className="space-y-2"><Label className="text-xs font-bold text-slate-600 uppercase">{label("العميل","Customer")} *</Label><Select value={form.customer_id} onValueChange={v => setForm({...form, customer_id: v})}><SelectTrigger className="border-slate-300"><SelectValue placeholder={label("اختر عميل...","Select customer...")}/></SelectTrigger><SelectContent>{customers.map(c => <SelectItem key={c.id} value={c.id}>{c.name} | {c.phone}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label className="text-xs font-bold text-slate-600 uppercase">{label("السيارة","Car")} *</Label><Select value={form.car_id} onValueChange={v => setForm({...form, car_id: v})}><SelectTrigger className="border-slate-300"><SelectValue placeholder={label("اختر سيارة...","Select car...")}/></SelectTrigger><SelectContent>{cars.map(c => <SelectItem key={c.id} value={c.id}>{c.make} {c.model} ({c.plate_number})</SelectItem>)}</SelectContent></Select></div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2"><Label className="text-xs font-bold text-slate-600 uppercase">{label("السعر اليومي","Daily Rate")}</Label><div className="relative"><DollarSign className="w-4 h-4 absolute left-3 top-3 text-slate-500"/><Input type="number" className="pl-8 border-slate-300" value={form.daily_rate} onChange={e => setForm({...form, daily_rate: e.target.value})} placeholder="0.00"/></div></div>
                <div className="space-y-2"><Label className="text-xs font-bold text-slate-600 uppercase">{label("عدد الأيام","Days")}</Label><div className="relative"><Clock className="w-4 h-4 absolute left-3 top-3 text-slate-500"/><Input type="number" className="pl-8 border-slate-300" value={form.total_days} onChange={e => setForm({...form, total_days: e.target.value})} placeholder="1"/></div></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2"><Label className="text-xs font-bold text-slate-600 uppercase">{label("صالح حتى","Valid Until")}</Label><Input type="date" className="border-slate-300" value={form.valid_until} onChange={e => setForm({...form, valid_until: e.target.value})}/></div>
                <div className="space-y-2"><Label className="text-xs font-bold text-slate-600 uppercase">{label("الحالة","Status")}</Label><Select value={form.status} onValueChange={v => setForm({...form, status: v})}><SelectTrigger className="border-slate-300"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="draft">{label("مسودة","Draft")}</SelectItem><SelectItem value="sent">{label("مرسل","Sent")}</SelectItem><SelectItem value="accepted">{label("مقبول","Accepted")}</SelectItem><SelectItem value="rejected">{label("مرفوض","Rejected")}</SelectItem></SelectContent></Select></div>
              </div>
              <div className="space-y-2"><Label className="text-xs font-bold text-slate-600 uppercase">{label("ملاحظات","Notes")}</Label><Textarea className="border-slate-300" value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} placeholder={label("أي ملاحظات...","Any notes...")} rows={3}/></div>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card className="border-2 border-slate-800 bg-slate-50 shadow-lg">
              <CardContent className="p-6">
                <h3 className="text-lg font-bold mb-4 text-slate-800 border-b-2 border-slate-300 pb-2">{label("ملخص التكاليف","Cost Summary")}</h3>
                <div className="space-y-3">
                  <div className="flex justify-between items-center p-3 bg-white rounded-lg shadow-sm border border-slate-300"><span className="text-slate-700 font-medium">{label("المجموع الفرعي","Subtotal")}</span><span className="text-xl font-bold text-slate-900">{subtotal.toFixed(2)} <span className="text-sm text-slate-500">BHD</span></span></div>
                  <div className="flex justify-between items-center p-3 bg-white rounded-lg shadow-sm border border-slate-300"><span className="text-slate-700 font-medium">{label("ضريبة القيمة المضافة (15%)","VAT (15%)")}</span><span className="text-xl font-bold text-red-600">{vatAmount.toFixed(2)} <span className="text-sm text-slate-500">BHD</span></span></div>
                  <div className="flex justify-between items-center p-4 bg-slate-900 rounded-lg text-white shadow-lg"><span className="text-lg font-bold">{label("الإجمالي","Grand Total")}</span><span className="text-3xl font-black">{grandTotal.toFixed(2)} <span className="text-sm opacity-80">BHD</span></span></div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {savedData && (
          <div className="print-only quotation-paper bg-white mx-auto p-0 shadow-none" style={{width: "210mm", minHeight: "297mm"}}>
            {/* Header */}
            <div className="bg-slate-900 text-white p-8">
              <div className="flex justify-between items-center">
                <div>
                  <h1 className="text-4xl font-black tracking-wider">SPEED</h1>
                  <p className="text-slate-400 text-sm tracking-widest uppercase mt-1">Car Rental Services</p>
                </div>
                <div className="text-right">
                  <p className="text-3xl font-black text-red-500">QUOTATION</p>
                  <p className="text-slate-400 text-sm mt-1">#{savedData.qn}</p>
                </div>
              </div>
            </div>

            {/* Info Bar */}
            <div className="bg-red-600 text-white p-4">
              <div className="grid grid-cols-3 gap-8 text-center">
                <div><p className="text-xs uppercase opacity-80">Date</p><p className="font-bold">{savedData.form.quotation_date}</p></div>
                <div><p className="text-xs uppercase opacity-80">Valid Until</p><p className="font-bold">{savedData.form.valid_until || "N/A"}</p></div>
                <div><p className="text-xs uppercase opacity-80">Status</p><p className="font-bold uppercase">{savedData.form.status}</p></div>
              </div>
            </div>

            {/* From/To */}
            <div className="p-8 grid grid-cols-2 gap-12 border-b-2 border-slate-200">
              <div>
                <p className="text-xs font-bold text-red-600 uppercase tracking-wider mb-2">From</p>
                <p className="text-xl font-bold text-slate-900">Speed Application</p>
                <p className="text-slate-600">Car Rental Services</p>
                <p className="text-slate-600 text-sm">Kingdom of Bahrain</p>
              </div>
              <div className="text-right">
                <p className="text-xs font-bold text-red-600 uppercase tracking-wider mb-2">To</p>
                <p className="text-xl font-bold text-slate-900">{savedData.customer?.name}</p>
                <p className="text-slate-600">{savedData.customer?.phone}</p>
              </div>
            </div>

            {/* Items Table */}
            <div className="p-8">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b-4 border-slate-900">
                    <th className="text-left py-4 text-sm font-bold text-slate-500 uppercase tracking-wider w-12">#</th>
                    <th className="text-left py-4 text-sm font-bold text-slate-500 uppercase tracking-wider">{label("الوصف","Description")}</th>
                    <th className="text-center py-4 text-sm font-bold text-slate-500 uppercase tracking-wider">{label("الكمية","Qty")}</th>
                    <th className="text-right py-4 text-sm font-bold text-slate-500 uppercase tracking-wider">{label("سعر الوحدة","Unit Price")}</th>
                    <th className="text-right py-4 text-sm font-bold text-slate-500 uppercase tracking-wider">{label("المجموع","Amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-slate-300">
                    <td className="py-6 text-slate-900 font-bold">1</td>
                    <td className="py-6">
                      <p className="font-bold text-lg text-slate-900">{savedData.car?.make} {savedData.car?.model}</p>
                      <p className="text-sm text-slate-500">Plate: {savedData.car?.plate_number}</p>
                      <p className="text-sm text-slate-500 mt-1">{savedData.form.notes}</p>
                    </td>
                    <td className="py-6 text-center text-slate-900 font-bold">{savedData.form.total_days} days</td>
                    <td className="py-6 text-right text-slate-900 font-bold">{parseFloat(savedData.form.daily_rate).toFixed(2)} BHD</td>
                    <td className="py-6 text-right text-slate-900 font-bold">{savedData.subtotal.toFixed(2)} BHD</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="px-8 pb-8">
              <div className="bg-slate-50 border-2 border-slate-200 p-6 ml-auto w-80">
                <div className="flex justify-between mb-3 text-slate-700"><span>Subtotal</span><span className="font-bold">{savedData.subtotal.toFixed(2)} BHD</span></div>
                <div className="flex justify-between mb-3 text-slate-700"><span>VAT (15%)</span><span className="font-bold">{savedData.vatAmount.toFixed(2)} BHD</span></div>
                <div className="border-t-2 border-slate-900 pt-3 flex justify-between text-xl font-black text-slate-900"><span>GRAND TOTAL</span><span>{savedData.grandTotal.toFixed(2)} BHD</span></div>
              </div>
            </div>

            {/* Footer */}
            <div className="mt-auto p-8 border-t-2 border-slate-200">
              <div className="grid grid-cols-2 gap-12 mb-8">
                <div className="border-t-2 border-slate-400 pt-4 mt-16">
                  <p className="text-xs text-slate-500 uppercase">Authorized Signature</p>
                </div>
                <div className="border-t-2 border-slate-400 pt-4 mt-16 text-right">
                  <p className="text-xs text-slate-500 uppercase">Customer Signature</p>
                </div>
              </div>
              <div className="text-center text-sm text-slate-500 pt-4 border-t border-slate-200">
                <p className="font-bold text-slate-700">Thank you for your business</p>
                <p className="mt-1">This quotation is valid for 7 days from issue date</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
      <RentalQuotationForm />
    </Suspense>
  )
}
