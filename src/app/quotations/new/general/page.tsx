"use client"
export const dynamic = "force-dynamic"

import { Suspense, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ArrowLeft, Plus, Trash2, Save, Printer, FileText, CalendarDays, User, Building2, Phone, Mail, Hash, Calculator } from "lucide-react"

function GeneralQuotationForm() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  const [header, setHeader] = useState({
    quotation_number: "QT-GEN-" + Date.now().toString().slice(-6),
    quotation_date: new Date().toISOString().split("T")[0],
    valid_until: "",
    customer_name: "",
    company_name: "",
    phone: "",
    email: "",
    notes: "",
    status: "draft",
  })

  const [items, setItems] = useState([
    { id: 1, description: "", quantity: 1, unit_price: 0, discount: 0, total: 0 }
  ])

  const [vatRate, setVatRate] = useState(15)

  const addItem = () => {
    setItems([...items, { id: Date.now(), description: "", quantity: 1, unit_price: 0, discount: 0, total: 0 }])
  }

  const removeItem = (id) => {
    if (items.length > 1) setItems(items.filter(i => i.id !== id))
  }

  const updateItem = (id, field, value) => {
    setItems(items.map(item => {
      if (item.id !== id) return item
      const updated = { ...item, [field]: value }
      const qty = parseFloat(updated.quantity) || 0
      const price = parseFloat(updated.unit_price) || 0
      const disc = parseFloat(updated.discount) || 0
      updated.total = (qty * price) - disc
      return updated
    }))
  }

  const subtotal = items.reduce((sum, item) => sum + item.total, 0)
  const vatAmount = subtotal * (vatRate / 100)
  const grandTotal = subtotal + vatAmount

  const handleSave = async () => {
    setLoading(true)
    try {
      const payload = {
        ...header,
        items: items.filter(i => i.description.trim()),
        subtotal,
        vat_rate: vatRate,
        vat_amount: vatAmount,
        total_amount: grandTotal,
      }
      console.log("Saving:", payload)
      await new Promise(r => setTimeout(r, 800))
      router.push("/quotations")
    } catch (e) {
      alert("Error saving")
    } finally {
      setLoading(false)
    }
  }

  const label = (ar, en) => isRTL ? ar : en
  const dir = isRTL ? "rtl" : "ltr"

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-6 pb-20" dir={dir}>

        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <Link href="/quotations/new">
              <Button variant="outline" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{label("عرض سعر عام", "General Quotation")}</h1>
              <p className="text-sm text-slate-500">{label("إنشاء عرض سعر احترافي", "Create a professional quotation")}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => window.print()}><Printer className="w-4 h-4 mr-2"/>{label("طباعة","Print")}</Button>
            <Button onClick={handleSave} disabled={loading} className="bg-emerald-600 hover:bg-emerald-700"><Save className="w-4 h-4 mr-2"/>{loading ? label("جاري...","Saving...") : label("حفظ","Save")}</Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card><CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4 text-emerald-600"/>{label("معلومات العرض","Quotation Info")}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2"><Label><Hash className="w-3 h-3 inline"/> {label("رقم العرض","Quotation #")}</Label><Input value={header.quotation_number} readOnly className="bg-slate-50"/></div>
              <div className="space-y-2"><Label><CalendarDays className="w-3 h-3 inline"/> {label("التاريخ","Date")}</Label><Input type="date" value={header.quotation_date} onChange={e => setHeader({...header, quotation_date: e.target.value})}/></div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2"><Label>{label("صالح حتى","Valid Until")}</Label><Input type="date" value={header.valid_until} onChange={e => setHeader({...header, valid_until: e.target.value})}/></div>
              <div className="space-y-2"><Label>{label("الحالة","Status")}</Label><Select value={header.status} onValueChange={v => setHeader({...header, status: v})}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="draft">{label("مسودة","Draft")}</SelectItem><SelectItem value="sent">{label("مرسل","Sent")}</SelectItem><SelectItem value="accepted">{label("مقبول","Accepted")}</SelectItem><SelectItem value="rejected">{label("مرفوض","Rejected")}</SelectItem></SelectContent></Select></div>
            </div>
          </CardContent></Card>

          <Card><CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2"><User className="w-4 h-4 text-blue-600"/>{label("معلومات العميل","Customer Info")}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2"><Label><User className="w-3 h-3 inline"/> {label("اسم العميل","Customer Name")} *</Label><Input value={header.customer_name} onChange={e => setHeader({...header, customer_name: e.target.value})} placeholder={label("محمد أحمد","John Doe")}/></div>
              <div className="space-y-2"><Label><Building2 className="w-3 h-3 inline"/> {label("الشركة","Company")}</Label><Input value={header.company_name} onChange={e => setHeader({...header, company_name: e.target.value})} placeholder={label("شركة...","Company...")}/></div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2"><Label><Phone className="w-3 h-3 inline"/> {label("الهاتف","Phone")}</Label><Input value={header.phone} onChange={e => setHeader({...header, phone: e.target.value})} placeholder="+966 5X XXX XXXX"/></div>
              <div className="space-y-2"><Label><Mail className="w-3 h-3 inline"/> {label("البريد","Email")}</Label><Input type="email" value={header.email} onChange={e => setHeader({...header, email: e.target.value})} placeholder="email@example.com"/></div>
            </div>
          </CardContent></Card>
        </div>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2"><Calculator className="w-4 h-4 text-purple-600"/>{label("بنود العرض","Quotation Items")}</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead className="w-12">#</TableHead><TableHead>{label("البيان","Description")}</TableHead><TableHead className="w-24">{label("الكمية","Qty")}</TableHead><TableHead className="w-32">{label("السعر","Unit Price")}</TableHead><TableHead className="w-32">{label("الخصم","Discount")}</TableHead><TableHead className="w-32">{label("المجموع","Total")}</TableHead><TableHead className="w-12"></TableHead></TableRow></TableHeader>
              <TableBody>
                {items.map((item, idx) => (
                  <TableRow key={item.id}>
                    <TableCell>{idx + 1}</TableCell>
                    <TableCell><Input value={item.description} onChange={e => updateItem(item.id, "description", e.target.value)} placeholder={label("وصف...","Description...")}/></TableCell>
                    <TableCell><Input type="number" min="1" value={item.quantity} onChange={e => updateItem(item.id, "quantity", e.target.value)}/></TableCell>
                    <TableCell><Input type="number" min="0" step="0.01" value={item.unit_price} onChange={e => updateItem(item.id, "unit_price", e.target.value)}/></TableCell>
                    <TableCell><Input type="number" min="0" step="0.01" value={item.discount} onChange={e => updateItem(item.id, "discount", e.target.value)}/></TableCell>
                    <TableCell className="font-semibold">{item.total.toFixed(2)}</TableCell>
                    <TableCell><Button variant="ghost" size="icon" onClick={() => removeItem(item.id)} className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4"/></Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Button variant="outline" onClick={addItem} className="mt-4"><Plus className="w-4 h-4 mr-2"/>{label("إضافة بند","Add Item")}</Button>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="md:col-span-2"><CardHeader className="pb-3"><CardTitle className="text-base">{label("ملاحظات","Notes")}</CardTitle></CardHeader><CardContent><Textarea value={header.notes} onChange={e => setHeader({...header, notes: e.target.value})} placeholder={label("أي ملاحظات...","Any notes...")} rows={4}/></CardContent></Card>
          <Card><CardContent className="p-6 space-y-3">
            <div className="flex justify-between items-center"><span className="text-slate-600">{label("المجموع الفرعي:","Subtotal:")}</span><span className="font-semibold text-lg">{subtotal.toFixed(2)}</span></div>
            <div className="flex justify-between items-center"><div className="flex items-center gap-2"><span className="text-slate-600">{label("ضريبة القيمة المضافة","VAT")}</span><Input type="number" value={vatRate} onChange={e => setVatRate(parseFloat(e.target.value) || 0)} className="w-16 h-8 text-center"/><span>%</span></div><span className="font-semibold">{vatAmount.toFixed(2)}</span></div>
            <div className="border-t pt-3 flex justify-between items-center"><span className="text-lg font-bold">{label("الإجمالي:","Grand Total:")}</span><span className="text-2xl font-bold text-emerald-600">{grandTotal.toFixed(2)}</span></div>
          </CardContent></Card>
        </div>

      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
      <GeneralQuotationForm />
    </Suspense>
  )
}
