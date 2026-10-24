"use client"
export const dynamic = "force-dynamic"

import { Suspense } from "react"
import { useEffect, useState, useRef } from "react"
import { useRouter } from "next/navigation"
import { jsPDF } from "jspdf"
import DashboardLayout from "@/components/DashboardLayout"
import { supabase } from "@/lib/supabase"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import RecordSelect from "@/components/records/RecordSelect"
import { useLanguage } from "@/lib/LanguageContext"
import { ArrowLeft, Upload, X, Car, User, FileText, MapPin, DollarSign, Wrench, Image as ImageIcon, CreditCard } from "lucide-react"
import Link from "next/link"

interface Customer {
  id: string
  full_name: string | null
  email: string | null
  phone: string | null
  national_id: string | null
  license_number: string | null
}

interface Car {
  id: string
  make: string | null
  model: string | null
  year: number | null
  plate_number: string | null
  daily_rate: number | null
  mileage: number | null
}

interface ScratchPhoto {
  file: File
  preview: string
  description: string
  location: string
}

interface PlaceSuggestion {
  display_name: string
  lat: string
  lon: string
}

function carLabel(c: Car) {
  return [c.make, c.model, c.year].filter(Boolean).join(" ") + (c.plate_number ? ` — ${c.plate_number}` : "")
}

// Simple, minimal section header used across all cards: icon + bold title, thin bottom border.
function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100 dark:border-slate-700">
      <span className="text-slate-500 dark:text-slate-400">{icon}</span>
      <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">{title}</h3>
    </div>
  )
}

function NewRentalForm() {
  const router = useRouter()
  const { isRTL } = useLanguage()
  const scratchInputRef = useRef<HTMLInputElement>(null)
  const pickupTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dropoffTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [cars, setCars] = useState<Car[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedCar, setSelectedCar] = useState<Car | null>(null)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [scratchPhotos, setScratchPhotos] = useState<ScratchPhoto[]>([])
  const [plateSearch, setPlateSearch] = useState('')
  const [plateNotFound, setPlateNotFound] = useState(false)
  const [showPlateSuggestions, setShowPlateSuggestions] = useState(false)
  const [companySettings, setCompanySettings] = useState({ name: "", phone: "", email: "", address: "", crNumber: "" })
  const [pickupSuggestions, setPickupSuggestions] = useState<PlaceSuggestion[]>([])
  const [dropoffSuggestions, setDropoffSuggestions] = useState<PlaceSuggestion[]>([])
  const [showPickupSuggestions, setShowPickupSuggestions] = useState(false)
  const [showDropoffSuggestions, setShowDropoffSuggestions] = useState(false)
  const [accounts, setAccounts] = useState<{code:string; name:string; name_ar:string|null; name_en:string|null}[]>([])
  const [taxOptions, setTaxOptions] = useState<{id:string; name_ar:string|null; name_en:string|null; rate:number; type:string|null}[]>([])
  const [expenses, setExpenses] = useState([
    { id: 'exp1', expense_type: 'Insurance', account_code: '', amount: '', vat_percent: '0' },
    { id: 'exp2', expense_type: 'Registration', account_code: '', amount: '', vat_percent: '0' },
    { id: 'exp3', expense_type: 'Maintenance' },
    { id: 'exp4', expense_type: 'Fuel', account_code: '', amount: '', vat_percent: '0' },
    { id: 'exp5', expense_type: 'Damage', account_code: '', amount: '', vat_percent: '0' },
  ])

  const [contract, setContract] = useState({
    contract_number: "",
    contract_type: "rental",
    customer_id: "",
    car_id: "",
    start_date: "",
    end_date: "",
    daily_rate: "",
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
  })

  const totalDays = (() => {
    if (!contract.start_date || !contract.end_date) return 0
    const diff = new Date(contract.end_date).getTime() - new Date(contract.start_date).getTime()
    return Math.max(1, Math.floor(diff / 86400000) + 1)
  })()

  const billableDays = Math.max(0, totalDays - parseInt(contract.foc_days || "0"))
  const dailyRate = parseFloat(contract.daily_rate || "0")
  const discountInputCalc = parseFloat(contract.discount || "0") || 0
  const subtotalCalc = dailyRate * billableDays
  const discountNum = contract.discount_type === "percent"
    ? +(subtotalCalc * discountInputCalc / 100).toFixed(3)
    : discountInputCalc
  const selectedTaxCalc = taxOptions.find(t => t.id === contract.tax_id)
  const vatRateNum = selectedTaxCalc ? (selectedTaxCalc.rate || 0) : 0
  const afterDiscountCalc = Math.max(0, subtotalCalc - discountNum)
  const vatAmountCalc = +(afterDiscountCalc * vatRateNum / 100).toFixed(3)
  const autoTotal = (afterDiscountCalc + vatAmountCalc).toFixed(3)
  const paidAmountCalc = parseFloat(contract.paid_amount || "0") || 0
  const effectiveTotalCalc = contract.total_amount ? (parseFloat(contract.total_amount) || 0) : parseFloat(autoTotal)
  const remainingAmount = effectiveTotalCalc - paidAmountCalc

  const plateMatches = plateSearch.length > 0
    ? cars.filter(c => c.plate_number?.toLowerCase().includes(plateSearch.toLowerCase().trim())).slice(0, 6)
    : []

  useEffect(() => {
    const fetchData = async () => {
      const [carsRes, customersRes, settingsRes, accountsRes, taxesRes] = await Promise.all([
        supabase.from("cars").select("id,make,model,year,plate_number,daily_rate,mileage").order("make"),
        supabase.from("customers").select("id,full_name,email,phone,national_id,license_number").order("full_name"),
        supabase.from("settings").select("company_profile").single(),
        supabase.from("accounts").select("code,name,name_ar,name_en").eq("is_active", true).order("code"),
        supabase.from("tax_settings").select("id,name_ar,name_en,rate,type").eq("is_active", true).order("name_ar"),
      ])
      setCars(carsRes.data || [])
      setCustomers(customersRes.data || [])
      setAccounts(accountsRes.data || [])
      setTaxOptions(taxesRes.data || [])
      const { data: nextNumber } = await supabase.rpc('get_next_contract_number')
      if (nextNumber) setContract(prev => ({ ...prev, contract_number: nextNumber }))
      if (settingsRes.data?.company_profile) {
        const p = settingsRes.data.company_profile
        setCompanySettings({ name: p.name || "", phone: p.phone || "", email: p.email || "", address: p.address || "", crNumber: p.crNumber || "" })
      }
    }
    fetchData()
  }, [])
  const addExpenseRow = () => {
    setExpenses(prev => [...prev, { id: 'exp' + Date.now(), expense_type: '', account_code: '', amount: '', vat_percent: '0' }])
  }
  const updateExpenseRow = (id: string, field: string, value: string) => {
    setExpenses(prev => prev.map(row => row.id === id ? { ...row, [field]: value } : row))
  }
  const removeExpenseRow = (id: string) => {
    setExpenses(prev => prev.filter(row => row.id !== id))
  }
  const expensesWithTotals = expenses.map(row => {
    const amt = parseFloat(row.amount || "0") || 0
    const vatPct = parseFloat(row.vat_percent || "0") || 0
    const vatAmt = amt * vatPct / 100
    return { ...row, vat_amt: vatAmt, total: amt + vatAmt }
  })
  const expensesGrandAmount = expensesWithTotals.reduce((s, r) => s + (parseFloat(r.amount || "0") || 0), 0)
  const expensesGrandTotal = expensesWithTotals.reduce((s, r) => s + r.total, 0)

  const handlePlateSearch = (plate: string) => {
    setPlateSearch(plate)
    setShowPlateSuggestions(true)
    setPlateNotFound(false)
    const found = cars.find(c => c.plate_number?.toLowerCase() === plate.toLowerCase().trim())
    if (found) {
      handleCarChange(found.id)
      setPlateNotFound(false)
    } else {
      setSelectedCar(null)
      setContract(prev => ({ ...prev, car_id: '' }))
      if (plate.length >= 3) setPlateNotFound(true)
    }
  }

  const selectCarFromSuggestion = (c: Car) => {
    handleCarChange(c.id)
    setPlateSearch(c.plate_number || '')
    setPlateNotFound(false)
    setShowPlateSuggestions(false)
  }

  const handleCarChange = (carId: string) => {
    const car = cars.find(c => c.id === carId) || null
    setSelectedCar(car)
    setContract(prev => ({
      ...prev,
      car_id: carId,
      daily_rate: car?.daily_rate?.toString() || "",
      pickup_mileage: car?.mileage?.toString() || "",
    }))
  }

  const handleCustomerChange = (customerId: string) => {
    const customer = customers.find(c => c.id === customerId) || null
    setSelectedCustomer(customer)
    setContract(prev => ({ ...prev, customer_id: customerId }))
  }

  // Free, no-API-key place search via OpenStreetMap's Nominatim service.
  const searchPlaces = async (query: string, setter: (r: PlaceSuggestion[]) => void) => {
    if (query.trim().length < 3) { setter([]); return }
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=bh&q=${encodeURIComponent(query)}`)
      const data = await res.json()
      setter(Array.isArray(data) ? data : [])
    } catch {
      setter([])
    }
  }

  const handlePickupLocationChange = (value: string) => {
    setContract(prev => ({ ...prev, pickup_location: value }))
    setShowPickupSuggestions(true)
    if (pickupTimeout.current) clearTimeout(pickupTimeout.current)
    pickupTimeout.current = setTimeout(() => searchPlaces(value, setPickupSuggestions), 400)
  }

  const handleDropoffLocationChange = (value: string) => {
    setContract(prev => ({ ...prev, dropoff_location: value }))
    setShowDropoffSuggestions(true)
    if (dropoffTimeout.current) clearTimeout(dropoffTimeout.current)
    dropoffTimeout.current = setTimeout(() => searchPlaces(value, setDropoffSuggestions), 400)
  }

  const handleScratchPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    const newPhotos: ScratchPhoto[] = files.map(file => ({
      file,
      preview: URL.createObjectURL(file),
      description: "",
      location: "",
    }))
    setScratchPhotos(prev => [...prev, ...newPhotos])
    if (scratchInputRef.current) scratchInputRef.current.value = ""
  }

  const removeScratchPhoto = (index: number) => {
    setScratchPhotos(prev => prev.filter((_, i) => i !== index))
  }

  const updateScratchPhoto = (index: number, field: "description" | "location", value: string) => {
    setScratchPhotos(prev => prev.map((p, i) => i === index ? { ...p, [field]: value } : p))
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      const customer = customers.find(c => c.id === contract.customer_id)
      const car = cars.find(c => c.id === contract.car_id)
      if (!customer || !car) {
        alert(isRTL ? "يرجى اختيار العميل والسيارة" : "Please select customer and car")
        setLoading(false)
        return
      }

      const startDate = contract.start_date ? new Date(contract.start_date) : null
      const endDate = contract.end_date ? new Date(contract.end_date) : null
      const dayMs = 86400000
      const rawDays = startDate && endDate ? Math.floor((endDate.getTime() - startDate.getTime()) / dayMs) + 1 : 1
      const totalDaysCalc = Math.max(1, rawDays)
      const focDays = parseInt(contract.foc_days || "0")
      const billable = Math.max(0, totalDaysCalc - focDays)
      const dailyRateNum = parseFloat(contract.daily_rate || "0") || 0
      const depositNum = parseFloat(contract.deposit_amount || "0") || 0
      const paidNum = parseFloat(contract.paid_amount || "0") || 0
      const subtotal = dailyRateNum * billable
      const discountInput = parseFloat(contract.discount || "0") || 0
      const discountNum = contract.discount_type === "percent"
        ? +(subtotal * discountInput / 100).toFixed(3)
        : discountInput
      const selectedTax = taxOptions.find(t => t.id === contract.tax_id)
      const vatRate = selectedTax ? (selectedTax.rate || 0) : 0
      const afterDiscount = Math.max(0, subtotal - discountNum)
      const vatAmount = +(afterDiscount * vatRate / 100).toFixed(3)
      const autoCalcTotal = +(afterDiscount + vatAmount).toFixed(3)
      const totalAmount = parseFloat(contract.total_amount || "") || autoCalcTotal

      // Upload scratch photos
      const scratchData: any[] = []
      for (const photo of scratchPhotos) {
        const ext = photo.file.name.split(".").pop()
        const path = `scratches/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
        const { error: uploadErr } = await supabase.storage.from("documents").upload(path, photo.file, { upsert: true })
        if (!uploadErr) {
          const { data: urlData } = supabase.storage.from("documents").getPublicUrl(path)
          scratchData.push({ url: urlData.publicUrl, description: photo.description, location: photo.location })
        }
      }

      // Generate PDF
      const pdf = new jsPDF()
      pdf.setFont("helvetica", "bold")
      pdf.setFontSize(18)
      pdf.text("RENTAL CONTRACT", 105, 20, { align: "center" })
      pdf.setFontSize(10)
      pdf.setFont("helvetica", "normal")
      pdf.text(companySettings.name, 105, 28, { align: "center" })
      pdf.text(`Tel: ${companySettings.phone} | CR: ${companySettings.crNumber}`, 105, 34, { align: "center" })
      pdf.line(20, 38, 190, 38)
      let y = 45
      pdf.setFont("helvetica", "bold")
      pdf.text(`Contract #: ${contract.contract_number}`, 20, y)
      pdf.text(`Type: ${contract.contract_type}`, 120, y); y += 10
      pdf.text("CUSTOMER DETAILS", 20, y); y += 7
      pdf.setFont("helvetica", "normal")
      pdf.text(`Name: ${customer.full_name || ""}`, 20, y)
      pdf.text(`ID: ${customer.national_id || ""}`, 120, y); y += 7
      pdf.text(`Phone: ${customer.phone || ""}`, 20, y)
      pdf.text(`License: ${customer.license_number || ""}`, 120, y); y += 10
      pdf.setFont("helvetica", "bold")
      pdf.text("VEHICLE DETAILS", 20, y); y += 7
      pdf.setFont("helvetica", "normal")
      pdf.text(`Car: ${car.make} ${car.model} ${car.year}`, 20, y)
      pdf.text(`Plate: ${car.plate_number || ""}`, 120, y); y += 7
      pdf.text(`Start: ${contract.start_date}`, 20, y)
      pdf.text(`End: ${contract.end_date}`, 120, y); y += 7
      pdf.text(`Pickup KM: ${contract.pickup_mileage || "—"}`, 20, y)
      pdf.text(`Dropoff KM: ${contract.dropoff_mileage || "—"}`, 120, y); y += 7
      pdf.text(`Allowed KM/Day: ${contract.allowed_km_per_day || "—"}`, 20, y)
      pdf.text(`Extra KM Charge: ${contract.extra_km_charge || "—"}`, 120, y); y += 10
      pdf.setFont("helvetica", "bold")
      pdf.text("PRICING", 20, y); y += 7
      pdf.setFont("helvetica", "normal")
      pdf.text(`Total Days: ${totalDaysCalc}`, 20, y)
      pdf.text(`FOC Days: ${focDays}`, 120, y); y += 7
      pdf.text(`Billable Days: ${billable}`, 20, y)
      pdf.text(`Daily Rate: ${dailyRateNum.toFixed(3)} BHD`, 120, y); y += 7
      pdf.text(`Subtotal: ${subtotal.toFixed(3)} BHD`, 20, y)
      pdf.text(`Deposit: ${depositNum.toFixed(3)} BHD`, 120, y); y += 7
      pdf.text(`Total: ${totalAmount.toFixed(3)} BHD`, 20, y)
      pdf.text(`Paid: ${paidNum.toFixed(3)} BHD`, 120, y); y += 7
      pdf.text(`Payment Type: ${contract.payment_type}`, 20, y)
      pdf.text(`Payment Term: ${contract.payment_term}`, 120, y); y += 10
      pdf.text(`Pickup: ${contract.pickup_location}`, 20, y); y += 7
      pdf.text(`Dropoff: ${contract.dropoff_location}`, 20, y); y += 10
      if (contract.terms) { pdf.setFont("helvetica", "bold"); pdf.text("Terms:", 20, y); y += 7; pdf.setFont("helvetica", "normal"); const lines = pdf.splitTextToSize(contract.terms, 170); pdf.text(lines, 20, y); y += lines.length * 7 }
      pdf.line(20, y + 10, 80, y + 10)
      pdf.line(120, y + 10, 190, y + 10)
      pdf.text("Customer Signature", 35, y + 16)
      pdf.text("Company Signature", 135, y + 16)

      const pdfBlob = new Blob([pdf.output("arraybuffer")], { type: "application/pdf" })
      let pdfUrlData = null
      const { data: uploadData, error: uploadError } = await supabase.storage.from("contracts").upload(`contract-${Date.now()}.pdf`, pdfBlob, { contentType: "application/pdf" })
      if (!uploadError && uploadData) {
        const { data: urlResult } = supabase.storage.from("contracts").getPublicUrl(uploadData.path)
        pdfUrlData = urlResult
      }

      // Resolve the tenant from the authenticated session - never from any
      // caller input - so the contract is written tenant-scoped. Without this
      // the contract was created tenant-less, a cross-tenant leak on a
      // multi-tenant install (Exec 34, Item 3).
      let tenantId: string | null = null
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const { data: profile } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle()
          tenantId = profile?.tenant_id || null
        }
      } catch {
        /* stay tenant-less on the single-tenant install */
      }

      const { data: newContract, error } = await supabase.from("rental_contracts").insert({
        ...(tenantId ? { tenant_id: tenantId } : {}),
        contract_number: contract.contract_number,
        contract_type: contract.contract_type,
        customer_id: contract.customer_id,
        car_id: contract.car_id,
        start_date: contract.start_date,
        end_date: contract.end_date,
        daily_rate: dailyRateNum,
        deposit_amount: depositNum,
        total_days: totalDaysCalc,
        foc_days: focDays,
        billable_days: billable,
        subtotal,
        vat_rate: vatRate,
        vat_amount: vatAmount,
        discount: discountNum,
        total_amount: totalAmount,
        paid_amount: paidNum,
        payment_type: contract.payment_type,
        payment_term: contract.payment_term,
        pickup_location: contract.pickup_location,
        dropoff_location: contract.dropoff_location,
        pickup_mileage: contract.pickup_mileage ? parseInt(contract.pickup_mileage) : null,
        dropoff_mileage: contract.dropoff_mileage ? parseInt(contract.dropoff_mileage) : null,
        allowed_km_per_day: contract.allowed_km_per_day ? parseInt(contract.allowed_km_per_day) : null,
        extra_km_charge: contract.extra_km_charge ? parseFloat(contract.extra_km_charge) : null,
        terms: contract.terms,
        clauses: contract.clauses,
        scratch_photos: scratchData.length > 0 ? JSON.stringify(scratchData) : null,
        contract_pdf_url: pdfUrlData?.publicUrl || null,
        car_expenses: expensesWithTotals,
        status: "active",
      }).select().single()
      if (error) throw error

      // 3. Issue the rental invoice through the single server-side posting path.
      //    The server allocates the number (row-locked), takes the tenant and
      //    financial year from the authenticated session, derives the paid
      //    amount/status from the amounts, and posts the balanced journal
      //    (41001 rental revenue). Posting is idempotent per contract, so a
      //    retry returns the existing invoice instead of double-posting
      //    (Exec 34, Items 2-5).
      try {
        const invoiceRes = await fetch("/api/invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customer_id: contract.customer_id,
            rental_contract_id: newContract.id,
            invoice_date: new Date().toISOString().slice(0, 10),
            due_date: contract.end_date,
            invoice_type: "rental",
            amount: subtotal,
            discount: discountNum,
            vat: vatAmount,
            paid_amount: paidNum,
            payment_method: contract.payment_type,
            payment_type: contract.payment_type,
            payment_term: contract.payment_term,
            rental_days: billable,
          }),
        })
        const invoicePayload = await invoiceRes.json().catch(() => ({}))
        if (!invoiceRes.ok) throw new Error(invoicePayload?.error || "Failed to create the rental invoice")
      } catch (invoiceErr: any) {
        console.error("Invoice generation failed:", invoiceErr)
        alert((isRTL ? "تم إنشاء العقد لكن فشل توليد الفاتورة: " : "Contract created but invoice generation failed: ") + (invoiceErr?.message || ""))
      }

      router.push("/rentals")
    } catch (error: any) {
      console.error("Failed to create contract:", error)
      const msg = error?.message || JSON.stringify(error)
      alert(isRTL ? `فشل إنشاء العقد: ${msg}` : `Failed to create contract: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  const inputClass = "h-9 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
  const labelClass = "text-xs font-semibold text-slate-600 dark:text-slate-300"
  const selectClass = `${inputClass} w-full rounded-md border border-input bg-background px-3`

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-4">
        <header className="flex items-center gap-3 flex-wrap">
          <Button variant="outline" size="icon" onClick={() => router.back()} className="h-9 w-9 shrink-0">
            <ArrowLeft className={`w-4 h-4 ${isRTL ? "rotate-180" : ""}`} />
          </Button>
          <div className="flex-1 min-w-[180px]">
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">
              {isRTL ? "عقد تأجير جديد" : "New Rental Contract"}
            </h1>
            <p className="text-xs text-slate-500">{isRTL ? "أضف عقد تأجير أو مبيعات جديد" : "Add a new rental or sales contract"}</p>
          </div>
          <div className="w-full sm:w-44 space-y-1">
            <Label className={labelClass}>{isRTL ? "رقم العقد" : "Contract #"}</Label>
            <Input className={inputClass} value={contract.contract_number} onChange={e => setContract({...contract, contract_number: e.target.value})} required />
          </div>
        </header>

        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Section 1: Customer + Car + Contract Type */}
          <Card className="rounded-xl shadow-sm border-slate-200 dark:border-slate-700 overflow-hidden">
            <CardContent className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "العميل" : "Customer"}</Label>
                {/* Searchable picker from the Customers module; the full
                    two-tab customer form opens as a link. */}
                <RecordSelect
                  kind="customer"
                  value={contract.customer_id}
                  onChange={(id) => handleCustomerChange(id)}
                  createMode="inline"
                  placeholder={isRTL ? "اختر العميل..." : "Select customer..."}
                />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "السيارة" : "Car"}</Label>
                <RecordSelect
                  kind="car"
                  value={contract.car_id}
                  onChange={(id) => {
                    handleCarChange(id)
                    const c = cars.find(x => x.id === id)
                    if (c) setPlateSearch(c.plate_number || '')
                  }}
                  createMode="inline"
                  placeholder={isRTL ? "اختر السيارة..." : "Select car..."}
                />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "نوع العقد" : "Contract Type"}</Label>
                <select className={selectClass} value={contract.contract_type} onChange={e => setContract({...contract, contract_type: e.target.value})}>
                  <option value="rental">{isRTL ? "تأجير" : "Rental"}</option>
                </select>
              </div>

              {selectedCustomer && (
                <div className="md:col-span-3 grid grid-cols-3 gap-2 p-2.5 bg-slate-50 dark:bg-slate-800/40 rounded-lg text-xs">
                  <div><span className="text-slate-500">{isRTL ? "الهاتف:" : "Phone:"}</span> <span className="font-medium">{selectedCustomer.phone}</span></div>
                  <div><span className="text-slate-500">{isRTL ? "الهوية:" : "ID:"}</span> <span className="font-medium">{selectedCustomer.national_id || "—"}</span></div>
                  <div><span className="text-slate-500">{isRTL ? "الرخصة:" : "License:"}</span> <span className="font-medium">{selectedCustomer.license_number || "—"}</span></div>
                </div>
              )}

              <div className="md:col-span-3 space-y-1 relative">
                <Label className={labelClass}>{isRTL ? "بحث برقم اللوحة" : "Search by Plate Number"}</Label>
                <div className="relative">
                  <Input
                    placeholder={isRTL ? "أدخل رقم اللوحة..." : "Enter plate number..."}
                    value={plateSearch}
                    onChange={e => handlePlateSearch(e.target.value)}
                    onFocus={() => setShowPlateSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowPlateSuggestions(false), 150)}
                    className={`${inputClass} pr-10`}
                    dir="ltr"
                    autoComplete="off"
                  />
                  {selectedCar && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-emerald-500 text-xs font-bold">✓</span>}
                </div>
                {showPlateSuggestions && plateMatches.length > 0 && (
                  <div className="absolute z-20 mt-1 w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                    {plateMatches.map(c => (
                      <button
                        type="button"
                        key={c.id}
                        onMouseDown={() => selectCarFromSuggestion(c)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center justify-between"
                      >
                        <span>{carLabel(c)}</span>
                        <span className="text-xs text-slate-400">{c.daily_rate} {isRTL ? "د.ب" : "BHD"}</span>
                      </button>
                    ))}
                  </div>
                )}
                {plateNotFound && <p className="text-xs text-red-500">{isRTL ? "لم يتم العثور على سيارة بهذا الرقم" : "No car found with this plate number"}</p>}
              </div>

              {selectedCar && (
                <div className="md:col-span-3 p-2.5 bg-slate-50 dark:bg-slate-800/40 rounded-lg text-xs flex gap-6">
                  <span><span className="text-slate-500">{isRTL ? "السعر اليومي:" : "Daily Rate:"}</span> <span className="font-bold text-cyan-700">{selectedCar.daily_rate} {isRTL ? "د.ب" : "BHD"}</span></span>
                  <span><span className="text-slate-500">{isRTL ? "الممشى:" : "Mileage:"}</span> <span className="font-medium">{selectedCar.mileage} {isRTL ? "كم" : "km"}</span></span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Section: Dates & Mileage — 3 columns */}
          <Card className="rounded-xl shadow-sm border-slate-200 dark:border-slate-700 overflow-hidden">
            <SectionHeader icon={<Wrench className="w-4 h-4" />} title={isRTL ? "التواريخ والكيلومترات" : "Dates & Mileage"} />
            <CardContent className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "تاريخ البداية" : "Start Date"}</Label>
                <Input className={inputClass} type="date" value={contract.start_date} onChange={e => setContract({...contract, start_date: e.target.value})} required />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "تاريخ النهاية" : "End Date"}</Label>
                <Input className={inputClass} type="date" value={contract.end_date} onChange={e => setContract({...contract, end_date: e.target.value})} required />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "الكيلومترات المسموحة يومياً" : "Allowed KM/Day"}</Label>
                <Input className={inputClass} type="number" value={contract.allowed_km_per_day} onChange={e => setContract({...contract, allowed_km_per_day: e.target.value})} placeholder="200" />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "رسوم الكيلومتر الإضافي (د.ب)" : "Extra KM Charge (BHD)"}</Label>
                <Input className={inputClass} type="number" step="0.001" value={contract.extra_km_charge} onChange={e => setContract({...contract, extra_km_charge: e.target.value})} placeholder="0.100" />
              </div>
              {totalDays > 0 && (
                <div className="md:col-span-3 p-2.5 bg-slate-50 dark:bg-slate-800/40 rounded-lg text-xs flex gap-6">
                  <span>{isRTL ? "إجمالي الأيام:" : "Total Days:"} <strong>{totalDays}</strong></span>
                  <span>{isRTL ? "أيام FOC:" : "FOC Days:"} <strong>{contract.foc_days}</strong></span>
                  <span>{isRTL ? "أيام قابلة للفوترة:" : "Billable Days:"} <strong>{billableDays}</strong></span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Section: Pricing & Payments — 3 columns */}
          <Card className="rounded-xl shadow-sm border-slate-200 dark:border-slate-700 overflow-hidden">
            <SectionHeader icon={<DollarSign className="w-4 h-4" />} title={isRTL ? "التسعير والمدفوعات" : "Pricing & Payments"} />
            <CardContent className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "أيام مجانية (FOC)" : "Free of Charge Days (FOC)"}</Label>
                <Input className={inputClass} type="number" min="0" value={contract.foc_days} onChange={e => setContract({...contract, foc_days: e.target.value})} placeholder="0" />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "السعر اليومي (د.ب)" : "Daily Rate (BHD)"}</Label>
                <Input className={inputClass} type="number" step="0.001" value={contract.daily_rate} onChange={e => setContract({...contract, daily_rate: e.target.value})} required />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "الخصم" : "Discount"}</Label>
                <div className="flex gap-1 items-stretch whitespace-nowrap">
                  <Input className={`${inputClass} flex-1 min-w-0`} type="number" step="0.001" value={contract.discount} onChange={e => setContract({...contract, discount: e.target.value})} placeholder="0" />
                  <select className="h-9 w-16 shrink-0 rounded-md border border-input bg-background px-1 text-xs" value={contract.discount_type} onChange={e => setContract({...contract, discount_type: e.target.value})}>
                    <option value="fixed">{isRTL ? "د.ب" : "BHD"}</option>
                    <option value="percent">%</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "الضريبة" : "VAT"}</Label>
                <select className={selectClass} value={contract.tax_id} onChange={e => setContract({...contract, tax_id: e.target.value})}>
                  <option value="">{isRTL ? "بدون ضريبة" : "No VAT"}</option>
                  {taxOptions.map(t => (
                    <option key={t.id} value={t.id}>{(isRTL ? (t.name_ar || t.name_en) : (t.name_en || t.name_ar))} — {t.rate}%</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "الإجمالي التلقائي (د.ب)" : "Auto Total (BHD)"}</Label>
                <Input className={`${inputClass} bg-slate-50 dark:bg-slate-700 font-bold text-emerald-600`} value={autoTotal} readOnly />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "الإجمالي الفعلي (د.ب)" : "Final Total (BHD)"}</Label>
                <Input className={inputClass} type="number" step="0.001" value={contract.total_amount} onChange={e => setContract({...contract, total_amount: e.target.value})} placeholder={autoTotal} />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "مبلغ التأمين (د.ب)" : "Deposit (BHD)"}</Label>
                <Input className={inputClass} type="number" step="0.001" value={contract.deposit_amount} onChange={e => setContract({...contract, deposit_amount: e.target.value})} />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "المبلغ المدفوع (د.ب)" : "Paid Amount (BHD)"}</Label>
                <Input className={inputClass} type="number" step="0.001" value={contract.paid_amount} onChange={e => setContract({...contract, paid_amount: e.target.value})} />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "المتبقي (د.ب)" : "Remaining (BHD)"}</Label>
                <Input className={`${inputClass} bg-slate-50 dark:bg-slate-700 font-bold text-orange-600`} value={remainingAmount.toFixed(3)} readOnly />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "نوع الدفع" : "Payment Type"}</Label>
                <select className={selectClass} value={contract.payment_type} onChange={e => setContract({...contract, payment_type: e.target.value})}>
                  <option value="cash">{isRTL ? "كاش" : "Cash"}</option>
                  <option value="card">{isRTL ? "بطاقة" : "Card"}</option>
                  <option value="bank_transfer">{isRTL ? "تحويل بنكي" : "Bank Transfer"}</option>
                  <option value="cheque">{isRTL ? "شيك" : "Cheque"}</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "مدة الدفع" : "Payment Term"}</Label>
                <select className={selectClass} value={contract.payment_term} onChange={e => setContract({...contract, payment_term: e.target.value})}>
                  <option value="cash">{isRTL ? "كاش" : "Cash"}</option>
                  <option value="credit">{isRTL ? "كريدت" : "Credit"}</option>
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Section: Car Expenses — green themed */}
          <Card className="rounded-xl shadow-sm border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600">
              <DollarSign className="w-4 h-4 text-white" />
              <h3 className="text-sm font-bold text-white">{isRTL ? "مصاريف السيارة (تأمين، تسجيل، صيانة...)" : "Car Expenses (Insurance, Registration, Maintenance...)"}</h3>
            </div>
            <CardContent className="p-4 space-y-3">
              <div className="grid grid-cols-12 gap-2 text-xs font-bold text-slate-500 px-1">
                <div className="col-span-3">{isRTL ? "نوع المصروف" : "Expense Type"}</div>
                <div className="col-span-3">{isRTL ? "الحساب" : "Account"}</div>
                <div className="col-span-2">{isRTL ? "المبلغ (د.ب)" : "Amount (BHD)"}</div>
                <div className="col-span-1">{isRTL ? "ضريبة%" : "VAT%"}</div>
                <div className="col-span-2">{isRTL ? "الإجمالي" : "Total"}</div>
                <div className="col-span-1"></div>
              </div>
              {expensesWithTotals.map(row => (
                <div key={row.id} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-3">
                    <Input className={inputClass} value={row.expense_type} onChange={e => updateExpenseRow(row.id, "expense_type", e.target.value)} placeholder={isRTL ? "نوع المصروف" : "Expense type"} />
                  </div>
                  <div className="col-span-3">
                    <select className={selectClass} value={row.account_code} onChange={e => updateExpenseRow(row.id, "account_code", e.target.value)}>
                      <option value="">{isRTL ? "اختر حساب" : "Select account"}</option>
                      {accounts.map(a => (
                        <option key={a.code} value={a.code}>{a.code} — {isRTL ? (a.name_ar || a.name) : (a.name_en || a.name)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <Input className={inputClass} type="number" step="0.001" value={row.amount} onChange={e => updateExpenseRow(row.id, "amount", e.target.value)} placeholder="0.000" />
                  </div>
                  <div className="col-span-1">
                    <Input className={inputClass} type="number" step="1" value={row.vat_percent} onChange={e => updateExpenseRow(row.id, "vat_percent", e.target.value)} placeholder="0" />
                  </div>
                  <div className="col-span-2">
                    <Input className={`${inputClass} bg-slate-50 dark:bg-slate-700 font-bold text-emerald-600`} value={row.total.toFixed(3)} readOnly />
                  </div>
                  <div className="col-span-1 flex justify-center">
                    <button type="button" onClick={() => removeExpenseRow(row.id)} className="text-red-500 hover:text-red-700">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
              <div className="grid grid-cols-12 gap-2 items-center border-t border-slate-100 dark:border-slate-700 pt-3 font-bold text-sm">
                <div className="col-span-3">{isRTL ? "الإجمالي" : "Total"}</div>
                <div className="col-span-3"></div>
                <div className="col-span-2 text-slate-700 dark:text-slate-200">{expensesGrandAmount.toFixed(3)}</div>
                <div className="col-span-1"></div>
                <div className="col-span-2 text-emerald-600">{expensesGrandTotal.toFixed(3)}</div>
                <div className="col-span-1"></div>
              </div>
              <button type="button" onClick={addExpenseRow} className="text-emerald-600 hover:text-emerald-700 text-sm font-bold flex items-center gap-1">
                + {isRTL ? "إضافة مصروف" : "Add Expense"}
              </button>
            </CardContent>
          </Card>

          {/* Section: Locations — with free OSM Nominatim autocomplete */}
          <Card className="rounded-xl shadow-sm border-slate-200 dark:border-slate-700 overflow-hidden">
            <SectionHeader icon={<MapPin className="w-4 h-4" />} title={isRTL ? "مواقع الاستلام والتسليم" : "Pickup & Dropoff Locations"} />
            <CardContent className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1 relative">
                <Label className={labelClass}>{isRTL ? "موقع الاستلام" : "Pickup Location"}</Label>
                <Input
                  className={inputClass}
                  value={contract.pickup_location}
                  onChange={e => handlePickupLocationChange(e.target.value)}
                  onFocus={() => { if (pickupSuggestions.length) setShowPickupSuggestions(true) }}
                  onBlur={() => setTimeout(() => setShowPickupSuggestions(false), 150)}
                  placeholder={isRTL ? "اكتب اسم الموقع..." : "Type a location..."}
                  autoComplete="off"
                  required
                />
                {showPickupSuggestions && pickupSuggestions.length > 0 && (
                  <div className="absolute z-20 mt-1 w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                    {pickupSuggestions.map((s, i) => (
                      <button
                        type="button"
                        key={i}
                        onMouseDown={() => { setContract(prev => ({ ...prev, pickup_location: s.display_name })); setShowPickupSuggestions(false) }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-700"
                      >
                        {s.display_name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="space-y-1 relative">
                <Label className={labelClass}>{isRTL ? "موقع التسليم" : "Dropoff Location"}</Label>
                <Input
                  className={inputClass}
                  value={contract.dropoff_location}
                  onChange={e => handleDropoffLocationChange(e.target.value)}
                  onFocus={() => { if (dropoffSuggestions.length) setShowDropoffSuggestions(true) }}
                  onBlur={() => setTimeout(() => setShowDropoffSuggestions(false), 150)}
                  placeholder={isRTL ? "اكتب اسم الموقع..." : "Type a location..."}
                  autoComplete="off"
                  required
                />
                {showDropoffSuggestions && dropoffSuggestions.length > 0 && (
                  <div className="absolute z-20 mt-1 w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg max-h-56 overflow-y-auto">
                    {dropoffSuggestions.map((s, i) => (
                      <button
                        type="button"
                        key={i}
                        onMouseDown={() => { setContract(prev => ({ ...prev, dropoff_location: s.display_name })); setShowDropoffSuggestions(false) }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-700"
                      >
                        {s.display_name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Section: Scratch Photos */}
          <Card className="rounded-xl shadow-sm border-slate-200 dark:border-slate-700 overflow-hidden">
            <SectionHeader icon={<ImageIcon className="w-4 h-4" />} title={isRTL ? "تسجيل الخدوش والأضرار" : "Scratch & Damage Recording"} />
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-3">
                <input ref={scratchInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleScratchPhoto} />
                <Button type="button" variant="outline" size="sm" onClick={() => scratchInputRef.current?.click()} className="flex items-center gap-2">
                  <Upload className="w-3.5 h-3.5" />
                  {isRTL ? "رفع صور الخدوش" : "Upload Scratch Photos"}
                </Button>
                <span className="text-xs text-slate-500">{scratchPhotos.length} {isRTL ? "صورة" : "photo(s)"}</span>
              </div>

              {scratchPhotos.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {scratchPhotos.map((photo, index) => (
                    <div key={index} className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                      <div className="relative">
                        <img src={photo.preview} alt={`scratch-${index}`} className="w-full h-40 object-cover" />
                        <button
                          type="button"
                          onClick={() => removeScratchPhoto(index)}
                          className="absolute top-2 right-2 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center shadow-lg"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="p-2.5 space-y-2">
                        <Input
                          placeholder={isRTL ? "موقع الخدش (مثال: الباب الأمامي)" : "Location (e.g. Front door)"}
                          value={photo.location}
                          onChange={e => updateScratchPhoto(index, "location", e.target.value)}
                          className="text-xs h-8"
                        />
                        <Input
                          placeholder={isRTL ? "وصف الخدش" : "Description"}
                          value={photo.description}
                          onChange={e => updateScratchPhoto(index, "description", e.target.value)}
                          className="text-xs h-8"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Section: Terms */}
          <Card className="rounded-xl shadow-sm border-slate-200 dark:border-slate-700 overflow-hidden">
            <SectionHeader icon={<FileText className="w-4 h-4" />} title={isRTL ? "الشروط والبنود" : "Terms & Clauses"} />
            <CardContent className="p-4 space-y-3">
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "الشروط والأحكام" : "Terms & Conditions"}</Label>
                <textarea className="min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={contract.terms} onChange={e => setContract({...contract, terms: e.target.value})} />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? "بنود إضافية" : "Additional Clauses"}</Label>
                <textarea className="min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={contract.clauses} onChange={e => setContract({...contract, clauses: e.target.value})} />
              </div>
            </CardContent>
          </Card>

          <Button type="submit" disabled={loading} className="w-full h-12 text-base rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white shadow-lg">
            {loading ? (isRTL ? "جاري الحفظ..." : "Saving...") : (isRTL ? "حفظ العقد وتوليد PDF" : "Save Contract & Generate PDF")}
          </Button>

        </form>

      </div>
    </DashboardLayout>
  )
}

export default function NewRentalPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <NewRentalForm />
    </Suspense>
  )
}
