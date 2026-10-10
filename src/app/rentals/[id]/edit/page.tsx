"use client"
export const dynamic = "force-dynamic"

import { Suspense, useEffect, useState, useRef } from "react"
import { useRouter, useParams } from "next/navigation"
import { supabase } from "@/lib/supabase"
import DashboardLayout from "@/components/DashboardLayout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useLanguage } from "@/lib/LanguageContext"
import { ArrowLeft, Save, Loader2, User, Car, Calendar, DollarSign, MapPin, FileText, CreditCard } from "lucide-react"
import Link from "next/link"

function EditContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const params = useParams()
  const contractId = params.id as string

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [customers, setCustomers] = useState<any[]>([])
  const [cars, setCars] = useState<any[]>([])
  const [accounts, setAccounts] = useState<any[]>([])
  const [taxes, setTaxes] = useState<any[]>([])

  const [formData, setFormData] = useState({
    contract_number: "",
    contract_type: "rental",
    customer_id: "",
    car_id: "",
    start_date: "",
    end_date: "",
    daily_rate: "",
    rental_days: "",
    deposit_amount: "",
    total_amount: "",
    paid_amount: "",
    discount: "",
    discount_type: "fixed",
    tax_id: "",
    vat_rate: "",
    payment_type: "cash",
    payment_term: "cash",
    pickup_location: "",
    dropoff_location: "",
    pickup_mileage: "",
    dropoff_mileage: "",
    allowed_km_per_day: "",
    extra_km_charge: "",
    foc_days: "0",
    terms: "",
    clauses: "",
    status: "active",
    notes: ""
  })

  useEffect(() => {
    fetchData()
  }, [contractId])

  async function fetchData() {
    setLoading(true)
    try {
      const [{ data: contractData }, { data: customersData }, { data: carsData }, { data: accountsData }, { data: taxesData }] = await Promise.all([
        supabase.from("rental_contracts").select("*, customers(*), cars(*)").eq("id", contractId).single(),
        supabase.from("customers").select("id, full_name, email, phone, national_id, license_number").order("full_name"),
        supabase.from("cars").select("id, make, model, year, plate_number, daily_rate, mileage, color").order("make"),
        supabase.from("accounts").select("code, name, name_ar, name_en").eq("is_active", true).order("code"),
        supabase.from("tax_settings").select("id, name_ar, name_en, rate, type").eq("is_active", true).order("name_ar")
      ])

      if (contractData) {
        setFormData({
          contract_number: contractData.contract_number || "",
          contract_type: contractData.contract_type || "rental",
          customer_id: contractData.customer_id || "",
          car_id: contractData.car_id || "",
          start_date: contractData.start_date || "",
          end_date: contractData.end_date || "",
          daily_rate: String(contractData.daily_rate || ""),
          rental_days: String(contractData.rental_days || ""),
          deposit_amount: String(contractData.deposit_amount || ""),
          total_amount: String(contractData.total_amount || ""),
          paid_amount: String(contractData.paid_amount || ""),
          discount: String(contractData.discount || ""),
          discount_type: contractData.discount_type || "fixed",
          tax_id: contractData.tax_id || "",
          vat_rate: String(contractData.vat_rate || ""),
          payment_type: contractData.payment_type || "cash",
          payment_term: contractData.payment_term || "cash",
          pickup_location: contractData.pickup_location || "",
          dropoff_location: contractData.dropoff_location || "",
          pickup_mileage: String(contractData.pickup_mileage || ""),
          dropoff_mileage: String(contractData.dropoff_mileage || ""),
          allowed_km_per_day: String(contractData.allowed_km_per_day || ""),
          extra_km_charge: String(contractData.extra_km_charge || ""),
          foc_days: String(contractData.foc_days || "0"),
          terms: contractData.terms || "",
          clauses: contractData.clauses || "",
          status: contractData.status || "active",
          notes: contractData.notes || ""
        })
      }
      if (customersData) setCustomers(customersData)
      if (carsData) setCars(carsData)
      if (accountsData) setAccounts(accountsData)
      if (taxesData) setTaxes(taxesData)
    } catch (error) {
      console.error("Error:", error)
    }
    setLoading(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const { error } = await supabase
        .from("rental_contracts")
        .update({
          contract_type: formData.contract_type,
          customer_id: formData.customer_id,
          car_id: formData.car_id,
          start_date: formData.start_date,
          end_date: formData.end_date,
          daily_rate: parseFloat(formData.daily_rate) || 0,
          rental_days: parseInt(formData.rental_days) || 0,
          deposit_amount: parseFloat(formData.deposit_amount) || 0,
          total_amount: parseFloat(formData.total_amount) || 0,
          paid_amount: parseFloat(formData.paid_amount) || 0,
          discount: parseFloat(formData.discount) || 0,
          discount_type: formData.discount_type,
          tax_id: formData.tax_id || null,
          vat_rate: parseFloat(formData.vat_rate) || 0,
          payment_type: formData.payment_type,
          payment_term: formData.payment_term,
          pickup_location: formData.pickup_location,
          dropoff_location: formData.dropoff_location,
          pickup_mileage: formData.pickup_mileage ? parseInt(formData.pickup_mileage) : null,
          dropoff_mileage: formData.dropoff_mileage ? parseInt(formData.dropoff_mileage) : null,
          allowed_km_per_day: formData.allowed_km_per_day ? parseInt(formData.allowed_km_per_day) : null,
          extra_km_charge: formData.extra_km_charge ? parseFloat(formData.extra_km_charge) : null,
          foc_days: parseInt(formData.foc_days) || 0,
          terms: formData.terms,
          clauses: formData.clauses,
          status: formData.status,
          notes: formData.notes
        })
        .eq("id", contractId)

      if (error) throw error
      router.push("/rentals/" + contractId)
    } catch (error) {
      console.error("Error saving:", error)
      alert("Error: " + (error.message || JSON.stringify(error)))
      alert("Error saving contract")
    }
    setSaving(false)
  }

  function handleChange(field: string, value: string) {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-cyan-500" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href={"/rentals/" + contractId}>
              <Button variant="outline" size="sm"><ArrowLeft className="w-4 h-4 ml-2" />{isRTL ? "رجوع" : "Back"}</Button>
            </Link>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{isRTL ? "تعديل العقد" : "Edit Contract"}</h1>
          </div>
        </header>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Contract Info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-cyan-600" />
                {isRTL ? "معلومات العقد" : "Contract Info"}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{isRTL ? "رقم العقد" : "Contract Number"}</Label>
                <Input value={formData.contract_number} disabled className="bg-slate-100 font-mono" />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "نوع العقد" : "Contract Type"}</Label>
                <select value={formData.contract_type} onChange={(e) => handleChange("contract_type", e.target.value)} className="w-full p-2 border rounded-lg bg-white dark:bg-slate-800">
                  <option value="rental">{isRTL ? "تأجير" : "Rental"}</option>
                  <option value="lease">{isRTL ? "إيجار" : "Lease"}</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "الحالة" : "Status"}</Label>
                <select value={formData.status} onChange={(e) => handleChange("status", e.target.value)} className="w-full p-2 border rounded-lg bg-white dark:bg-slate-800">
                  <option value="active">{isRTL ? "نشط" : "Active"}</option>
                  <option value="pending">{isRTL ? "معلق" : "Pending"}</option>
                  <option value="completed">{isRTL ? "مكتمل" : "Completed"}</option>
                  <option value="cancelled">{isRTL ? "ملغي" : "Cancelled"}</option>
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Customer & Car */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="w-5 h-5 text-cyan-600" />
                {isRTL ? "العميل والسيارة" : "Customer & Vehicle"}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{isRTL ? "العميل" : "Customer"}</Label>
                <select value={formData.customer_id} onChange={(e) => handleChange("customer_id", e.target.value)} className="w-full p-2 border rounded-lg bg-white dark:bg-slate-800">
                  <option value="">{isRTL ? "اختر العميل" : "Select Customer"}</option>
                  {customers.map((c: any) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "السيارة" : "Car"}</Label>
                <select value={formData.car_id} onChange={(e) => handleChange("car_id", e.target.value)} className="w-full p-2 border rounded-lg bg-white dark:bg-slate-800">
                  <option value="">{isRTL ? "اختر السيارة" : "Select Car"}</option>
                  {cars.map((c: any) => <option key={c.id} value={c.id}>{c.make} {c.model} ({c.plate_number})</option>)}
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Dates */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="w-5 h-5 text-cyan-600" />
                {isRTL ? "التواريخ" : "Dates"}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>{isRTL ? "تاريخ البدء" : "Start Date"}</Label>
                <Input type="date" value={formData.start_date} onChange={(e) => handleChange("start_date", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "تاريخ الانتهاء" : "End Date"}</Label>
                <Input type="date" value={formData.end_date} onChange={(e) => handleChange("end_date", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "عدد الأيام" : "Rental Days"}</Label>
                <Input type="number" value={formData.rental_days} onChange={(e) => handleChange("rental_days", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "أيام مجانية" : "FOC Days"}</Label>
                <Input type="number" value={formData.foc_days} onChange={(e) => handleChange("foc_days", e.target.value)} />
              </div>
            </CardContent>
          </Card>

          {/* Financial */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-cyan-600" />
                {isRTL ? "المعلومات المالية" : "Financial Info"}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{isRTL ? "السعر اليومي" : "Daily Rate"}</Label>
                <Input type="number" step="0.01" value={formData.daily_rate} onChange={(e) => handleChange("daily_rate", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "مبلغ التأمين" : "Deposit"}</Label>
                <Input type="number" step="0.01" value={formData.deposit_amount} onChange={(e) => handleChange("deposit_amount", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "الإجمالي" : "Total Amount"}</Label>
                <Input type="number" step="0.01" value={formData.total_amount} onChange={(e) => handleChange("total_amount", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "المدفوع" : "Paid Amount"}</Label>
                <Input type="number" step="0.01" value={formData.paid_amount} onChange={(e) => handleChange("paid_amount", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "الخصم" : "Discount"}</Label>
                <div className="flex gap-2">
                  <Input type="number" step="0.01" value={formData.discount} onChange={(e) => handleChange("discount", e.target.value)} className="flex-1" />
                  <select value={formData.discount_type} onChange={(e) => handleChange("discount_type", e.target.value)} className="p-2 border rounded-lg bg-white dark:bg-slate-800">
                    <option value="fixed">{isRTL ? "ثابت" : "Fixed"}</option>
                    <option value="percentage">{isRTL ? "نسبة" : "%"}</option>
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "الضريبة" : "Tax"}</Label>
                <select value={formData.tax_id} onChange={(e) => handleChange("tax_id", e.target.value)} className="w-full p-2 border rounded-lg bg-white dark:bg-slate-800">
                  <option value="">{isRTL ? "بدون ضريبة" : "No Tax"}</option>
                  {taxes.map((t: any) => <option key={t.id} value={t.id}>{t.name_ar} ({t.rate}%)</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "نسبة الضريبة" : "VAT Rate"}</Label>
                <Input type="number" step="0.01" value={formData.vat_rate} onChange={(e) => handleChange("vat_rate", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "طريقة الدفع" : "Payment Type"}</Label>
                <select value={formData.payment_type} onChange={(e) => handleChange("payment_type", e.target.value)} className="w-full p-2 border rounded-lg bg-white dark:bg-slate-800">
                  <option value="cash">{isRTL ? "نقدي" : "Cash"}</option>
                  <option value="credit">{isRTL ? "آجل" : "Credit"}</option>
                  <option value="mixed">{isRTL ? "مختلط" : "Mixed"}</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "شروط الدفع" : "Payment Term"}</Label>
                <select value={formData.payment_term} onChange={(e) => handleChange("payment_term", e.target.value)} className="w-full p-2 border rounded-lg bg-white dark:bg-slate-800">
                  <option value="cash">{isRTL ? "نقدي" : "Cash"}</option>
                  <option value="7days">{isRTL ? "7 أيام" : "7 Days"}</option>
                  <option value="14days">{isRTL ? "14 يوم" : "14 Days"}</option>
                  <option value="30days">{isRTL ? "30 يوم" : "30 Days"}</option>
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Locations */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="w-5 h-5 text-cyan-600" />
                {isRTL ? "المواقع" : "Locations"}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{isRTL ? "مكان الاستلام" : "Pickup Location"}</Label>
                <Input value={formData.pickup_location} onChange={(e) => handleChange("pickup_location", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "مكان التسليم" : "Dropoff Location"}</Label>
                <Input value={formData.dropoff_location} onChange={(e) => handleChange("dropoff_location", e.target.value)} />
              </div>
            </CardContent>
          </Card>

          {/* Mileage */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Car className="w-5 h-5 text-cyan-600" />
                {isRTL ? "الكيلومترات" : "Mileage"}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>{isRTL ? "كيلومترات الاستلام" : "Pickup Mileage"}</Label>
                <Input type="number" value={formData.pickup_mileage} onChange={(e) => handleChange("pickup_mileage", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "كيلومترات التسليم" : "Dropoff Mileage"}</Label>
                <Input type="number" value={formData.dropoff_mileage} onChange={(e) => handleChange("dropoff_mileage", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "الكيلومترات المسموحة" : "Allowed KM/Day"}</Label>
                <Input type="number" value={formData.allowed_km_per_day} onChange={(e) => handleChange("allowed_km_per_day", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "رسوم الكيلومتر الزائد" : "Extra KM Charge"}</Label>
                <Input type="number" step="0.01" value={formData.extra_km_charge} onChange={(e) => handleChange("extra_km_charge", e.target.value)} />
              </div>
            </CardContent>
          </Card>

          {/* Terms & Notes */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-cyan-600" />
                {isRTL ? "البنود والملاحظات" : "Terms & Notes"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>{isRTL ? "البنود" : "Terms"}</Label>
                <textarea value={formData.terms} onChange={(e) => handleChange("terms", e.target.value)} className="w-full p-3 border rounded-lg bg-white dark:bg-slate-800 min-h-[80px]" />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "الشروط الإضافية" : "Clauses"}</Label>
                <textarea value={formData.clauses} onChange={(e) => handleChange("clauses", e.target.value)} className="w-full p-3 border rounded-lg bg-white dark:bg-slate-800 min-h-[80px]" />
              </div>
              <div className="space-y-2">
                <Label>{isRTL ? "ملاحظات" : "Notes"}</Label>
                <textarea value={formData.notes} onChange={(e) => handleChange("notes", e.target.value)} className="w-full p-3 border rounded-lg bg-white dark:bg-slate-800 min-h-[80px]" />
              </div>
            </CardContent>
          </Card>

          {/* Submit Buttons */}
          <div className="flex justify-end gap-3 sticky bottom-4 bg-white dark:bg-slate-900 p-4 rounded-xl shadow-lg border border-slate-200 dark:border-slate-700">
            <Link href={"/rentals/" + contractId}>
              <Button variant="outline" type="button">{isRTL ? "إلغاء" : "Cancel"}</Button>
            </Link>
            <Button type="submit" disabled={saving} className="bg-cyan-600 hover:bg-cyan-700">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4 ml-2" />}
              {isRTL ? "حفظ التغييرات" : "Save Changes"}
            </Button>
          </div>
        </form>
      </div>
    </DashboardLayout>
  )
}

export default function EditPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen"><Loader2 className="w-8 h-8 animate-spin text-cyan-500" /></div>}>
      <EditContent />
    </Suspense>
  )
}
