"use client"
import { Suspense } from 'react'
import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowLeft, Car as CarIcon, Save, Upload, X, ImagePlus, DollarSign, Shield, Wrench, FileText, Landmark, Battery, ImageIcon } from 'lucide-react'
import Link from 'next/link'

type SupplierOption = { id: string; name: string }

function SectionIcon({ tone, children }: { tone: 'sky' | 'violet' | 'emerald' | 'amber' | 'cyan' | 'blue' | 'rose' | 'slate'; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    sky: 'bg-sky-50 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400',
    violet: 'bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400',
    emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400',
    amber: 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
    cyan: 'bg-cyan-50 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-400',
    blue: 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
    rose: 'bg-rose-50 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400',
    slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  }
  return <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${tones[tone]}`}>{children}</div>
}

function NewCarForm() {
  const router = useRouter()
  const { isRTL } = useLanguage()
  const mainImageRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)

  const [loading, setLoading] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [tenantId, setTenantId] = useState<string | null>(null)
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [accounts, setAccounts] = useState<{code:string; name:string; name_ar:string|null; name_en:string|null}[]>([])
  const [expenses, setExpenses] = useState([
    { id: 'exp1', expense_type: 'Insurance', account_code: '', amount: '', vat_percent: '0' },
    { id: 'exp2', expense_type: 'Registration', account_code: '', amount: '', vat_percent: '0' },
    { id: 'exp3', expense_type: 'Maintenance', account_code: '', amount: '', vat_percent: '0' },
  ])

  const [mainImage, setMainImage] = useState<{ file: File; preview: string } | null>(null)
  const [galleryImages, setGalleryImages] = useState<{ file: File; preview: string }[]>([])

  const inputClass = "h-9 text-sm bg-slate-50 dark:bg-slate-900 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
  const labelClass = "text-xs font-semibold text-slate-600 dark:text-slate-300"
  const selectClass = "h-9 w-full rounded-md border border-input bg-slate-50 dark:bg-slate-900 px-3 text-sm"

  const [form, setForm] = useState({
    plate_number: '',
    make: '',
    model: '',
    year: String(new Date().getFullYear()),
    color: '',
    vin: '',
    chassis_number: '',
    engine_number: '',
    mileage: '',
    category: 'rental',
    fuel_type: 'petrol',
    transmission: 'automatic',
    seats: '5',
    location: '',
    status: 'available',
    // purchase & accounting
    purchase_price: '',
    purchase_date: '',
    purchase_source: '',
    supplier_id: '',
    purchase_costs: '',
    maintenance_costs: '',
    salvage_value: '',
    useful_life_years: '5',
    // financing
    down_payment: '',
    bank_name: '',
    monthly_installment: '',
    total_installments: '',
    remaining_installments: '',
    interest_rate: '',
    // insurance & registration
    insurance_company: '',
    insurance_policy_number: '',
    insurance_expiry: '',
    registration_expiry: '',
    // rental pricing
    daily_rate: '',
    weekly_rate: '',
    monthly_rate: '',
    sale_price: '',
    // maintenance & tires
    tire_condition: 'good',
    tire_last_changed: '',
    next_service_date: '',
    service_interval_km: '',
    maintenance_vat_rate: '0',
    // EV
    battery_capacity_kwh: '',
    battery_range_km: '',
    battery_health_percent: '',
    // notes
    notes: '',
  })

  const set = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }))
  const setExpenseField = (id: string, field: string, value: string) => {
    setExpenses(prev => prev.map(row => row.id === id ? { ...row, [field]: value } : row))
  }
  const addExpenseRow = () => {
    setExpenses(prev => [...prev, { id: 'exp' + Date.now(), expense_type: '', account_code: '', amount: '', vat_percent: '0' }])
  }
  const removeExpenseRow = (id: string) => {
    setExpenses(prev => prev.filter(row => row.id !== id))
  }
  const expensesWithTotals = expenses.map(row => {
    const amt = parseFloat(row.amount || '0') || 0
    const vat = parseFloat(row.vat_percent || '0') || 0
    const vatAmt = +(amt * vat / 100).toFixed(3)
    return { ...row, amount: amt, vat_percent: vat, vat_amount: vatAmt, total: +(amt + vatAmt).toFixed(3) }
  })
  const expensesGrandAmount = expensesWithTotals.reduce((s, r) => s + r.amount, 0)
  const expensesGrandVat = expensesWithTotals.reduce((s, r) => s + r.vat_amount, 0)
  const expensesGrandTotal = expensesWithTotals.reduce((s, r) => s + r.total, 0)

  // ---- Auto calculations ----
  const purchasePriceNum = parseFloat(form.purchase_price || '0') || 0
  const salvageNum = parseFloat(form.salvage_value || '0') || 0
  const usefulLifeNum = parseFloat(form.useful_life_years || '0') || 0
  const annualDepreciation = usefulLifeNum > 0 ? Math.max(0, (purchasePriceNum - salvageNum) / usefulLifeNum) : 0
  const monthlyDepreciation = annualDepreciation / 12

  const totalAcquisitionCost = purchasePriceNum + (parseFloat(form.purchase_costs || '0') || 0)

  const downPaymentNum = parseFloat(form.down_payment || '0') || 0
  const monthlyInstallmentNum = parseFloat(form.monthly_installment || '0') || 0
  const totalInstallmentsNum = parseFloat(form.total_installments || '0') || 0
  const financedAmount = Math.max(0, purchasePriceNum - downPaymentNum)
  const totalRepayment = monthlyInstallmentNum * totalInstallmentsNum
  const totalInterest = Math.max(0, totalRepayment - financedAmount)

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: profile } = await supabase.from('users').select('role,tenant_id').eq('id', user.id).single()
        if (profile) {
          setIsAdmin(profile.role === 'admin')
          setTenantId(profile.tenant_id || null)
        }
      }
      const { data: supplierData } = await supabase.from('suppliers').select('id,name').order('name')
      setSuppliers(supplierData || [])
      const { data: accountData } = await supabase.from('accounts').select('code,name,name_ar,name_en').eq('is_active', true).order('code')
      setAccounts(accountData || [])
    }
    init()
  }, [])

  const handleMainImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (mainImage) URL.revokeObjectURL(mainImage.preview)
    setMainImage({ file, preview: URL.createObjectURL(file) })
    if (mainImageRef.current) mainImageRef.current.value = ''
  }

  const handleGalleryImages = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    const newPhotos = files.map(file => ({ file, preview: URL.createObjectURL(file) }))
    setGalleryImages(prev => [...prev, ...newPhotos])
    if (galleryRef.current) galleryRef.current.value = ''
  }

  const removeGalleryImage = (index: number) => {
    setGalleryImages(prev => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.plate_number || !form.make || !form.model) {
      alert(isRTL ? 'يرجى تعبئة رقم اللوحة والماركة والموديل' : 'Please fill in plate number, make, and model')
      return
    }
    setLoading(true)
    try {
      let imageUrl: string | null = null
      if (mainImage) {
        const ext = mainImage.file.name.split('.').pop()
        const path = `cars/${Date.now()}_main.${ext}`
        const { error: upErr } = await supabase.storage.from('documents').upload(path, mainImage.file, { upsert: true })
        if (!upErr) {
          const { data } = supabase.storage.from('documents').getPublicUrl(path)
          imageUrl = data.publicUrl
        } else {
          console.error('Main image upload failed:', upErr)
          alert(isRTL ? 'فشل رفع الصورة الرئيسية: ' + upErr.message : 'Main image upload failed: ' + upErr.message)
        }
      }

      const galleryUrls: string[] = []
      for (const photo of galleryImages) {
        const ext = photo.file.name.split('.').pop()
        const path = `cars/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
        const { error: upErr } = await supabase.storage.from('documents').upload(path, photo.file, { upsert: true })
        if (!upErr) {
          const { data } = supabase.storage.from('documents').getPublicUrl(path)
          galleryUrls.push(data.publicUrl)
        }
      }

      const payload: Record<string, any> = {
        plate_number: form.plate_number,
        make: form.make,
        model: form.model,
        year: form.year ? parseInt(form.year) : null,
        color: form.color || null,
        vin: form.vin || null,
        chassis_number: form.chassis_number || null,
        engine_number: form.engine_number || null,
        mileage: form.mileage ? parseInt(form.mileage) : null,
        category: form.category || null,
        fuel_type: form.fuel_type || null,
        transmission: form.transmission || null,
        seats: form.seats ? parseInt(form.seats) : null,
        location: form.location || null,
        status: form.status,
        insurance_company: form.insurance_company || null,
        insurance_policy_number: form.insurance_policy_number || null,
        insurance_expiry: form.insurance_expiry || null,
        registration_expiry: form.registration_expiry || null,
        daily_rate: form.daily_rate ? parseFloat(form.daily_rate) : null,
        weekly_rate: form.weekly_rate ? parseFloat(form.weekly_rate) : null,
        monthly_rate: form.monthly_rate ? parseFloat(form.monthly_rate) : null,
        sale_price: form.sale_price ? parseFloat(form.sale_price) : null,
        tire_condition: form.tire_condition || null,
        tire_last_changed: form.tire_last_changed || null,
        next_service_date: form.next_service_date || null,
        service_interval_km: form.service_interval_km ? parseInt(form.service_interval_km) : null,
        maintenance_vat_rate: form.maintenance_vat_rate || '0',
        battery_capacity_kwh: form.battery_capacity_kwh ? parseFloat(form.battery_capacity_kwh) : null,
        battery_range_km: form.battery_range_km ? parseInt(form.battery_range_km) : null,
        battery_health_percent: form.battery_health_percent ? parseFloat(form.battery_health_percent) : null,
        notes: form.notes || null,
        image_url: imageUrl,
        gallery_images: galleryUrls,
        car_expenses: expensesWithTotals.length > 0 ? expensesWithTotals : null,
      }

      if (isAdmin) {
        Object.assign(payload, {
          purchase_price: form.purchase_price ? parseFloat(form.purchase_price) : null,
          purchase_date: form.purchase_date || null,
          purchase_source: form.purchase_source || null,
          supplier_id: form.supplier_id || null,
          purchase_costs: form.purchase_costs ? parseFloat(form.purchase_costs) : null,
          maintenance_costs: form.maintenance_costs ? parseFloat(form.maintenance_costs) : null,
          salvage_value: form.salvage_value ? parseFloat(form.salvage_value) : null,
          useful_life_years: form.useful_life_years ? parseInt(form.useful_life_years) : null,
          down_payment: form.down_payment ? parseFloat(form.down_payment) : null,
          bank_name: form.bank_name || null,
          monthly_installment: form.monthly_installment ? parseFloat(form.monthly_installment) : null,
          total_installments: form.total_installments ? parseInt(form.total_installments) : null,
          remaining_installments: form.remaining_installments ? parseInt(form.remaining_installments) : null,
          interest_rate: form.interest_rate ? parseFloat(form.interest_rate) : null,
        })
      }

      if (tenantId) payload.tenant_id = tenantId

      const { data: newCar, error } = await supabase.from('cars').insert([payload]).select().single()
      if (error) throw error

      if (isAdmin && newCar && form.down_payment && form.monthly_installment && form.total_installments) {
        try {
          const purchasePriceNum = form.purchase_price ? parseFloat(form.purchase_price) : 0
          const downPaymentAmt = parseFloat(form.down_payment) || 0
          const monthlyInstallmentAmt = parseFloat(form.monthly_installment) || 0
          const totalInstallmentsNum = parseInt(form.total_installments) || 0
          const annualRate = form.interest_rate ? parseFloat(form.interest_rate) : 0
          const monthlyRate = annualRate / 100 / 12
          const loanAmount = Math.max(0, purchasePriceNum - downPaymentAmt)
          const purchaseDateVal = form.purchase_date || new Date().toISOString().slice(0, 10)

          const { data: newLoan } = await supabase.from('car_loans').insert({
            car_id: newCar.id,
            loan_amount: loanAmount,
            down_payment: downPaymentAmt,
            monthly_installment: monthlyInstallmentAmt,
            total_installments: totalInstallmentsNum,
            paid_installments: 0,
            start_date: purchaseDateVal,
            status: 'active',
          }).select().single()

          if (newLoan && totalInstallmentsNum > 0) {
            let balance = loanAmount
            const installments: any[] = []
            const startDate = new Date(purchaseDateVal)
            for (let i = 1; i <= totalInstallmentsNum; i++) {
              const interestPortion = balance * monthlyRate
              let principalPortion = monthlyInstallmentAmt - interestPortion
              if (i === totalInstallmentsNum || principalPortion > balance) {
                principalPortion = balance
              }
              balance = Math.max(0, balance - principalPortion)
              const dueDate = new Date(startDate)
              dueDate.setMonth(dueDate.getMonth() + i)
              installments.push({
                loan_id: newLoan.id,
                installment_number: i,
                due_date: dueDate.toISOString().slice(0, 10),
                amount: principalPortion + interestPortion,
                paid_amount: 0,
                status: 'pending',
              })
            }
            await supabase.from('car_loan_installments').insert(installments)
          }

          const { data: jvNumberData } = await supabase.rpc('generate_document_number', { p_doc_type: 'journal_entry' })
          const { data: accountsData } = await supabase.from('accounts').select('id, code').in('code', ['13001', '11002', '22001'])
          const acc = (code: string) => accountsData?.find((a: any) => a.code === code)?.id

          const { data: newJournal } = await supabase.from('journal_entries').insert({
            journal_number: jvNumberData,
            entry_date: purchaseDateVal,
            reference_number: newCar.plate_number || newCar.id,
            description: isRTL ? `شراء سيارة ${newCar.make} ${newCar.model}` : `Vehicle purchase ${newCar.make} ${newCar.model}`,
            total_debit: purchasePriceNum,
            total_credit: purchasePriceNum,
            is_balanced: true,
            status: 'posted',
            entry_type: 'vehicle_purchase',
          }).select().single()

          if (newJournal) {
            const lines: any[] = []
            let lineOrder = 1
            lines.push({ journal_entry_id: newJournal.id, account_id: acc('13001'), debit: purchasePriceNum, credit: 0, description: isRTL ? 'أسطول المركبات' : 'Vehicle Fleet', line_order: lineOrder++ })
            if (downPaymentAmt > 0) {
              lines.push({ journal_entry_id: newJournal.id, account_id: acc('11002'), debit: 0, credit: downPaymentAmt, description: isRTL ? 'دفعة أولى' : 'Down payment', line_order: lineOrder++ })
            }
            if (loanAmount > 0) {
              lines.push({ journal_entry_id: newJournal.id, account_id: acc('22001'), debit: 0, credit: loanAmount, description: isRTL ? 'قرض بنكي' : 'Bank loan', line_order: lineOrder++ })
            }
            await supabase.from('journal_lines').insert(lines)
          }
        } catch (loanErr: any) {
          console.error('Loan/journal creation failed:', loanErr)
        }
      }

      router.push('/cars')
    } catch (error: any) {
      console.error('Error adding car:', error)
      alert(isRTL ? 'خطأ في إضافة السيارة: ' + (error?.message || '') : 'Error adding car: ' + (error?.message || ''))
    } finally {
      setLoading(false)
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        <div className="flex items-center gap-4">
          <Button variant="outline" size="icon" onClick={() => router.back()}>
            <ArrowLeft className={`w-4 h-4 ${isRTL ? 'rotate-180' : ''}`} />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-slate-800 dark:text-white">{isRTL ? 'إضافة سيارة جديدة' : 'Add New Car'}</h1>
            <p className="text-slate-500 text-sm">{isRTL ? 'أدخل بيانات السيارة الكاملة' : 'Enter complete vehicle information'}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Images */}
          <Card className="border-0 shadow-md">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                <SectionIcon tone="rose"><ImageIcon className="w-4 h-4" /></SectionIcon>
                {isRTL ? 'صور السيارة' : 'Vehicle Photos'}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="space-y-2">
                <Label className={labelClass}>{isRTL ? 'الصورة الرئيسية' : 'Main Photo'}</Label>
                <input ref={mainImageRef} type="file" accept="image/*" className="hidden" onChange={handleMainImage} />
                <div
                  onClick={() => mainImageRef.current?.click()}
                  className="relative h-48 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-700 flex items-center justify-center cursor-pointer overflow-hidden bg-slate-50 dark:bg-slate-900 hover:border-cyan-500 transition-colors"
                >
                  {mainImage ? (
                    <>
                      <img src={mainImage.preview} alt="main" className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); URL.revokeObjectURL(mainImage.preview); setMainImage(null) }}
                        className="absolute top-2 right-2 w-7 h-7 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center shadow-lg"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-slate-400">
                      <ImagePlus className="w-8 h-8" />
                      <span className="text-xs">{isRTL ? 'اضغط لرفع الصورة الرئيسية' : 'Click to upload main photo'}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="lg:col-span-2 space-y-2">
                <Label className={labelClass}>{isRTL ? 'معرض الصور (إضافية)' : 'Photo Gallery (additional)'}</Label>
                <div className="flex items-center gap-3">
                  <input ref={galleryRef} type="file" accept="image/*" multiple className="hidden" onChange={handleGalleryImages} />
                  <Button type="button" variant="outline" size="sm" onClick={() => galleryRef.current?.click()} className="flex items-center gap-2">
                    <Upload className="w-4 h-4" />
                    {isRTL ? 'رفع صور' : 'Upload Photos'}
                  </Button>
                  <span className="text-sm text-slate-500">{galleryImages.length} {isRTL ? 'صورة' : 'photo(s)'}</span>
                </div>
                {galleryImages.length > 0 && (
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 mt-2">
                    {galleryImages.map((photo, index) => (
                      <div key={index} className="relative h-24 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
                        <img src={photo.preview} alt={`gallery-${index}`} className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => removeGalleryImage(index)}
                          className="absolute top-1 right-1 w-5 h-5 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Basic Info */}
          <Card className="border-0 shadow-md">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                <SectionIcon tone="sky"><CarIcon className="w-4 h-4" /></SectionIcon>
                {isRTL ? 'المعلومات الأساسية' : 'Basic Information'}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'رقم اللوحة' : 'Plate Number'} *</Label>
                <Input className={inputClass} value={form.plate_number} onChange={e => set('plate_number', e.target.value)} required />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'الماركة' : 'Make'} *</Label>
                <Input className={inputClass} value={form.make} onChange={e => set('make', e.target.value)} required />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'الموديل' : 'Model'} *</Label>
                <Input className={inputClass} value={form.model} onChange={e => set('model', e.target.value)} required />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'السنة' : 'Year'}</Label>
                <Input className={inputClass} type="number" value={form.year} onChange={e => set('year', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'اللون' : 'Color'}</Label>
                <Input className={inputClass} value={form.color} onChange={e => set('color', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'الممشى (كم)' : 'Mileage (km)'}</Label>
                <Input className={inputClass} type="number" value={form.mileage} onChange={e => set('mileage', e.target.value)} placeholder="0" />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>VIN</Label>
                <Input className={inputClass} value={form.vin} onChange={e => set('vin', e.target.value)} dir="ltr" />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'رقم الشاصي' : 'Chassis Number'}</Label>
                <Input className={inputClass} value={form.chassis_number} onChange={e => set('chassis_number', e.target.value)} dir="ltr" />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'رقم المحرك' : 'Engine Number'}</Label>
                <Input className={inputClass} value={form.engine_number} onChange={e => set('engine_number', e.target.value)} dir="ltr" />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'عدد المقاعد' : 'Seats'}</Label>
                <Input className={inputClass} type="number" value={form.seats} onChange={e => set('seats', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'نوع الوقود' : 'Fuel Type'}</Label>
                <select className={selectClass} value={form.fuel_type} onChange={e => set('fuel_type', e.target.value)}>
                  <option value="petrol">{isRTL ? 'بنزين' : 'Petrol'}</option>
                  <option value="diesel">{isRTL ? 'ديزل' : 'Diesel'}</option>
                  <option value="hybrid">{isRTL ? 'هجين' : 'Hybrid'}</option>
                  <option value="electric">{isRTL ? 'كهربائي' : 'Electric'}</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'ناقل الحركة' : 'Transmission'}</Label>
                <select className={selectClass} value={form.transmission} onChange={e => set('transmission', e.target.value)}>
                  <option value="automatic">{isRTL ? 'أوتوماتيك' : 'Automatic'}</option>
                  <option value="manual">{isRTL ? 'يدوي' : 'Manual'}</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'الفئة' : 'Category'}</Label>
                <select className={selectClass} value={form.category} onChange={e => set('category', e.target.value)}>
                  <option value="rental">{isRTL ? 'تأجير' : 'Rental'}</option>
                  <option value="sale">{isRTL ? 'بيع' : 'Sale'}</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'الموقع' : 'Location'}</Label>
                <Input className={inputClass} value={form.location} onChange={e => set('location', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'الحالة' : 'Status'}</Label>
                <select className={selectClass} value={form.status} onChange={e => set('status', e.target.value)}>
                  <option value="available">{isRTL ? 'متاحة' : 'Available'}</option>
                  <option value="rented">{isRTL ? 'مؤجرة' : 'Rented'}</option>
                  <option value="maintenance">{isRTL ? 'صيانة' : 'Maintenance'}</option>
                  <option value="sold">{isRTL ? 'مباعة' : 'Sold'}</option>
                </select>
              </div>
            </CardContent>
          </Card>

          {/* EV Battery - conditional */}
          {form.fuel_type === 'electric' && (
            <Card className="border-0 shadow-md">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                  <SectionIcon tone="emerald"><Battery className="w-4 h-4" /></SectionIcon>
                  {isRTL ? 'بيانات البطارية' : 'Battery Information'}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'سعة البطارية (kWh)' : 'Battery Capacity (kWh)'}</Label>
                  <Input className={inputClass} type="number" step="0.1" value={form.battery_capacity_kwh} onChange={e => set('battery_capacity_kwh', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'مدى القيادة (كم)' : 'Range (km)'}</Label>
                  <Input className={inputClass} type="number" value={form.battery_range_km} onChange={e => set('battery_range_km', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'صحة البطارية (%)' : 'Battery Health (%)'}</Label>
                  <Input className={inputClass} type="number" step="0.1" value={form.battery_health_percent} onChange={e => set('battery_health_percent', e.target.value)} />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Purchase & Accounting - admin only */}
          {isAdmin && (
            <Card className="border-0 shadow-md">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                  <SectionIcon tone="amber"><DollarSign className="w-4 h-4" /></SectionIcon>
                  {isRTL ? 'الشراء والمحاسبة' : 'Purchase & Accounting'}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'سعر الشراء (د.ب)' : 'Purchase Price (BHD)'}</Label>
                  <Input className={inputClass} type="number" step="0.001" value={form.purchase_price} onChange={e => set('purchase_price', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'تاريخ الشراء' : 'Purchase Date'}</Label>
                  <Input className={inputClass} type="date" value={form.purchase_date} onChange={e => set('purchase_date', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'مصدر الشراء' : 'Purchase Source'}</Label>
                  <Input className={inputClass} value={form.purchase_source} onChange={e => set('purchase_source', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'المورّد' : 'Supplier'}</Label>
                  <select className={selectClass} value={form.supplier_id} onChange={e => set('supplier_id', e.target.value)}>
                    <option value="">{isRTL ? 'بدون' : 'None'}</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'تكاليف الشراء الإضافية (د.ب)' : 'Extra Purchase Costs (BHD)'}</Label>
                  <Input className={inputClass} type="number" step="0.001" value={form.purchase_costs} onChange={e => set('purchase_costs', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'تكاليف الصيانة (د.ب)' : 'Maintenance Costs (BHD)'}</Label>
                  <Input className={inputClass} type="number" step="0.001" value={form.maintenance_costs} onChange={e => set('maintenance_costs', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'القيمة المتبقية (د.ب)' : 'Salvage Value (BHD)'}</Label>
                  <Input className={inputClass} type="number" step="0.001" value={form.salvage_value} onChange={e => set('salvage_value', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'العمر الإنتاجي (سنوات)' : 'Useful Life (years)'}</Label>
                  <Input className={inputClass} type="number" value={form.useful_life_years} onChange={e => set('useful_life_years', e.target.value)} />
                </div>

                <div className="col-span-2 md:col-span-4 grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 bg-amber-50 dark:bg-amber-900/10 rounded-xl text-sm mt-1">
                  <div>
                    <span className="text-slate-500 block text-xs">{isRTL ? 'إجمالي تكلفة الاقتناء' : 'Total Acquisition Cost'}</span>
                    <span className="font-bold text-amber-700">{totalAcquisitionCost.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-xs">{isRTL ? 'الإهلاك السنوي (تلقائي)' : 'Annual Depreciation (auto)'}</span>
                    <span className="font-bold text-amber-700">{annualDepreciation.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-xs">{isRTL ? 'الإهلاك الشهري (تلقائي)' : 'Monthly Depreciation (auto)'}</span>
                    <span className="font-bold text-amber-700">{monthlyDepreciation.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Financing - admin only */}
          {isAdmin && (
            <Card className="border-0 shadow-md">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                  <SectionIcon tone="violet"><Landmark className="w-4 h-4" /></SectionIcon>
                  {isRTL ? 'التمويل / القرض' : 'Financing / Loan'}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'الدفعة الأولى (د.ب)' : 'Down Payment (BHD)'}</Label>
                  <Input className={inputClass} type="number" step="0.001" value={form.down_payment} onChange={e => set('down_payment', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'اسم البنك' : 'Bank Name'}</Label>
                  <Input className={inputClass} value={form.bank_name} onChange={e => set('bank_name', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'القسط الشهري (د.ب)' : 'Monthly Installment (BHD)'}</Label>
                  <Input className={inputClass} type="number" step="0.001" value={form.monthly_installment} onChange={e => set('monthly_installment', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'عدد الأقساط' : 'Total Installments'}</Label>
                  <Input className={inputClass} type="number" value={form.total_installments} onChange={e => set('total_installments', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'الأقساط المتبقية' : 'Remaining Installments'}</Label>
                  <Input className={inputClass} type="number" value={form.remaining_installments} onChange={e => set('remaining_installments', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'نسبة الفائدة (%)' : 'Interest Rate (%)'}</Label>
                  <Input className={inputClass} type="number" step="0.01" value={form.interest_rate} onChange={e => set('interest_rate', e.target.value)} />
                </div>

                <div className="col-span-2 md:col-span-4 grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 bg-violet-50 dark:bg-violet-900/10 rounded-xl text-sm mt-1">
                  <div>
                    <span className="text-slate-500 block text-xs">{isRTL ? 'المبلغ الممول (تلقائي)' : 'Financed Amount (auto)'}</span>
                    <span className="font-bold text-violet-700">{financedAmount.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-xs">{isRTL ? 'إجمالي السداد (تلقائي)' : 'Total Repayment (auto)'}</span>
                    <span className="font-bold text-violet-700">{totalRepayment.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-xs">{isRTL ? 'إجمالي الفوائد (تلقائي)' : 'Total Interest (auto)'}</span>
                    <span className="font-bold text-violet-700">{totalInterest.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Insurance & Registration + Rental Pricing */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <Card className="border-0 shadow-md">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                  <SectionIcon tone="blue"><Shield className="w-4 h-4" /></SectionIcon>
                  {isRTL ? 'التأمين والترخيص' : 'Insurance & Registration'}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'انتهاء التأمين' : 'Insurance Expiry'}</Label>
                  <Input className={inputClass} type="date" value={form.insurance_expiry} onChange={e => set('insurance_expiry', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'انتهاء الترخيص' : 'Registration Expiry'}</Label>
                  <Input className={inputClass} type="date" value={form.registration_expiry} onChange={e => set('registration_expiry', e.target.value)} />
                </div>
              </CardContent>
            </Card>

            <Card className="border-0 shadow-md">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                  <SectionIcon tone="cyan"><FileText className="w-4 h-4" /></SectionIcon>
                  {isRTL ? 'أسعار التأجير والبيع' : 'Rental & Sale Pricing'}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'السعر اليومي' : 'Daily Rate'}</Label>
                  <Input className={inputClass} type="number" step="0.001" value={form.daily_rate} onChange={e => set('daily_rate', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'السعر الأسبوعي' : 'Weekly Rate'}</Label>
                  <Input className={inputClass} type="number" step="0.001" value={form.weekly_rate} onChange={e => set('weekly_rate', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'السعر الشهري' : 'Monthly Rate'}</Label>
                  <Input className={inputClass} type="number" step="0.001" value={form.monthly_rate} onChange={e => set('monthly_rate', e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className={labelClass}>{isRTL ? 'سعر البيع' : 'Sale Price'}</Label>
                  <Input className={inputClass} type="number" step="0.001" value={form.sale_price} onChange={e => set('sale_price', e.target.value)} />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Maintenance & Tires */}
          <Card className="border-0 shadow-md">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                <SectionIcon tone="slate"><Wrench className="w-4 h-4" /></SectionIcon>
                {isRTL ? 'الصيانة والإطارات' : 'Maintenance & Tires'}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'موعد الصيانة القادمة' : 'Next Service Date'}</Label>
                <Input className={inputClass} type="date" value={form.next_service_date} onChange={e => set('next_service_date', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className={labelClass}>{isRTL ? 'دورية الصيانة (كم)' : 'Service Interval (km)'}</Label>
                <Input className={inputClass} type="number" value={form.service_interval_km} onChange={e => set('service_interval_km', e.target.value)} />
              </div>
            </CardContent>
          </Card>

          {/* Car Expenses (Insurance, Registration, Maintenance...) */}
          <Card className="border-0 shadow-md">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-3 text-base text-slate-700 dark:text-slate-200">
                <SectionIcon tone="emerald"><DollarSign className="w-4 h-4" /></SectionIcon>
                {isRTL ? 'مصاريف السيارة (تأمين، ترخيص، صيانة...)' : 'Car Expenses (Insurance, Registration, Maintenance...)'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold text-slate-500 dark:text-slate-400">
                      <th className="pb-2 pr-2">{isRTL ? 'نوع المصروف' : 'Expense Type'}</th>
                      <th className="pb-2 pr-2">{isRTL ? 'الحساب' : 'Account'}</th>
                      <th className="pb-2 pr-2">{isRTL ? 'المبلغ (د.ب)' : 'Amount (BHD)'}</th>
                      <th className="pb-2 pr-2">{isRTL ? 'ضريبة %' : 'VAT%'}</th>
                      <th className="pb-2 pr-2">{isRTL ? 'قيمة الضريبة' : 'VAT Amt'}</th>
                      <th className="pb-2 pr-2">{isRTL ? 'الإجمالي' : 'Total'}</th>
                      <th className="pb-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {expensesWithTotals.map(row => (
                      <tr key={row.id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="py-2 pr-2">
                          <Input className={inputClass} value={row.expense_type} onChange={e => setExpenseField(row.id, 'expense_type', e.target.value)} />
                        </td>
                        <td className="py-2 pr-2 min-w-[180px]">
                          <select className={selectClass} value={row.account_code} onChange={e => setExpenseField(row.id, 'account_code', e.target.value)}>
                            <option value="">{isRTL ? '-- اختر حساب --' : '-- Select Account --'}</option>
                            {accounts.map(a => (
                              <option key={a.code} value={a.code}>
                                {a.code} — {isRTL ? (a.name_ar || a.name) : (a.name_en || a.name)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 pr-2 w-28">
                          <Input className={inputClass} type="number" step="0.001" value={expenses.find(e => e.id === row.id)?.amount || ''} onChange={e => setExpenseField(row.id, 'amount', e.target.value)} />
                        </td>
                        <td className="py-2 pr-2 w-20">
                          <Input className={inputClass} type="number" step="0.01" value={expenses.find(e => e.id === row.id)?.vat_percent || '0'} onChange={e => setExpenseField(row.id, 'vat_percent', e.target.value)} />
                        </td>
                        <td className="py-2 pr-2 text-slate-500">{row.vat_amount.toFixed(3)}</td>
                        <td className="py-2 pr-2 font-semibold">{row.total.toFixed(3)}</td>
                        <td className="py-2">
                          <button type="button" onClick={() => removeExpenseRow(row.id)} className="text-rose-500 hover:text-rose-700">
                            <X className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-slate-200 dark:border-slate-700 font-semibold">
                      <td className="py-2" colSpan={2}>{isRTL ? 'الإجمالي' : 'Total'}</td>
                      <td className="py-2">{expensesGrandAmount.toFixed(3)}</td>
                      <td></td>
                      <td className="py-2 text-emerald-600">{expensesGrandVat.toFixed(3)}</td>
                      <td className="py-2 text-emerald-600">{expensesGrandTotal.toFixed(3)}</td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <button type="button" onClick={addExpenseRow} className="mt-3 text-sm text-emerald-600 hover:text-emerald-700 font-medium">
                + {isRTL ? 'إضافة مصروف' : 'Add Expense'}
              </button>
            </CardContent>
          </Card>

          {/* Notes */}
          <Card className="border-0 shadow-md">
            <CardHeader className="pb-4">
              <CardTitle className="text-base text-slate-700 dark:text-slate-200">{isRTL ? 'ملاحظات' : 'Notes'}</CardTitle>
            </CardHeader>
            <CardContent>
              <textarea className="min-h-[90px] w-full rounded-md border border-input bg-slate-50 dark:bg-slate-900 px-3 py-2 text-sm" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder={isRTL ? 'أي ملاحظات إضافية...' : 'Any additional notes...'} />
            </CardContent>
          </Card>

          <Card className="border-0 shadow-md">
            <CardContent className="pt-6 flex flex-col sm:flex-row gap-3">
              <Button type="submit" disabled={loading} className="flex-1 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white shadow-lg">
                <Save className="w-4 h-4 mr-2 ml-2" />
                {loading ? (isRTL ? 'جاري الحفظ...' : 'Saving...') : (isRTL ? 'حفظ السيارة' : 'Save Car')}
              </Button>
              <Link href="/cars" className="flex-1">
                <Button type="button" variant="outline" className="w-full">{isRTL ? 'إلغاء' : 'Cancel'}</Button>
              </Link>
            </CardContent>
          </Card>

        </form>
      </div>
    </DashboardLayout>
  )
}

export default function NewCarPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <NewCarForm />
    </Suspense>
  )
}
