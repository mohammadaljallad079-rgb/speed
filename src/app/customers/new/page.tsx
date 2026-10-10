"use client"
export const dynamic = "force-dynamic"

import { Suspense, useState, useRef, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  UserPlus, Save, ArrowLeft, Building2, User, Upload, FileText,
  Star, Phone, Mail, MapPin, CreditCard, Calendar, Globe,
  Briefcase, Users, Shield, AlertTriangle, CheckCircle
} from 'lucide-react'

type CustomerType = 'individual' | 'company'

interface FormData {
  customer_type: CustomerType
  full_name: string
  email: string
  phone: string
  phone_2: string
  address: string
  city: string
  country: string
  notes: string
  status: 'active' | 'defaulted' | 'vip' | 'blocked'
  rating: string
credit_limit: string
  national_id: string
  id_expiry: string
  date_of_birth: string
  license_number: string
  license_expiry: string
  nationality: string
  has_police_case: boolean
  company_name: string
  commercial_reg: string
  contract_end: string
  tax_number: string
  industry: string
  employee_count: string
  emergency_phone: string
}

function NewCustomerForm() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<CustomerType>('individual')
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [formData, setFormData] = useState<FormData>({
    customer_type: 'individual',
    full_name: '',
    email: '',
    phone: '',
    phone_2: '',
    address: '',
    city: '',
    country: 'Bahrain',
    notes: '',
    status: 'active',
    rating: "5",
credit_limit: "0",
    national_id: '',
    id_expiry: '',
    date_of_birth: '',
    license_number: '',
    license_expiry: '',
    nationality: '',
    has_police_case: false,
    company_name: '',
    commercial_reg: '',
    contract_end: '',
    tax_number: '',
    industry: '',
    employee_count: '',
    emergency_phone: ''
  })

  const handleTypeChange = (type: CustomerType) => {
    setActiveTab(type)
    setFormData(prev => ({ ...prev, customer_type: type }))
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setUploadedFiles(Array.from(e.target.files))
    }
  }

  const toNumberOrZero = (value: string) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    let payload: any = {
      customer_type: formData.customer_type,
      full_name: formData.full_name.trim(),
      email: formData.email.trim() || null,
      phone: formData.phone.trim(),
      phone_2: formData.phone_2.trim() || null,
      address: formData.address.trim() || null,
      city: formData.city.trim() || null,
      country: formData.country.trim() || null,
      notes: formData.notes.trim() || null,
      status: formData.status || 'active',
      rating: toNumberOrZero(formData.rating),
credit_limit: toNumberOrZero(formData.credit_limit),
    }

    if (formData.customer_type === 'individual') {
      payload = {
        ...payload,
        national_id: formData.national_id.trim() || null,
        id_expiry: formData.id_expiry || null,
        date_of_birth: formData.date_of_birth || null,
        license_number: formData.license_number.trim() || null,
        license_expiry: formData.license_expiry || null,
        nationality: formData.nationality.trim() || null,
        has_police_case: formData.has_police_case || false,
      }
    } else {
      payload = {
        ...payload,
        company_name: formData.company_name.trim(),
        commercial_reg: formData.commercial_reg.trim() || null,
        contract_end: formData.contract_end || null,
        tax_number: formData.tax_number.trim() || null,
        industry: formData.industry.trim() || null,
        employee_count: formData.employee_count.trim() || null,
        emergency_phone: formData.emergency_phone.trim() || null,
      }
    }

    if (!payload.full_name || !payload.phone) {
      alert(isRTL ? 'الاسم ورقم الهاتف مطلوبان' : 'Full name and phone are required')
      return
    }

    if (formData.customer_type === 'company' && !payload.company_name) {
      alert(isRTL ? 'اسم الشركة مطلوب' : 'Company name is required')
      return
    }

    setLoading(true)
    try {
      const { error } = await supabase.from('customers').insert([payload])
      if (error) throw error
      router.push('/customers')
    } catch (error: any) {
      alert(isRTL ? 'خطأ في إضافة العميل: ' + error.message : 'Error adding customer: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const statusConfig = {
    active: { label: isRTL ? 'نشط' : 'Active', color: 'bg-emerald-100 text-emerald-700', icon: CheckCircle },
    vip: { label: isRTL ? 'VIP' : 'VIP', color: 'bg-amber-100 text-amber-700', icon: Star },
    defaulted: { label: isRTL ? 'متعثر' : 'Defaulted', color: 'bg-red-100 text-red-700', icon: AlertTriangle },
    blocked: { label: isRTL ? 'محظور' : 'Blocked', color: 'bg-slate-100 text-slate-700', icon: Shield }
  }

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-6" dir={isRTL ? "rtl" : "ltr"}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="outline" size="icon" onClick={() => router.back()} className="rounded-lg h-9 text-sm">
              <ArrowLeft className={isRTL ? 'rotate-180' : ''} />
            </Button>
            <div>
              <h1 className="text-xl font-bold text-slate-900">{isRTL ? 'إضافة عميل جديد' : 'Add New Customer'}</h1>
              <p className="text-sm text-slate-500">{isRTL ? 'أدخل بيانات العميل بشكل كامل' : 'Enter complete customer details'}</p>
            </div>
          </div>
          <Badge variant="outline" className="px-3 py-1">
            {isRTL ? 'الخطوة 1 من 2' : 'Step 1 of 2'}
          </Badge>
        </div>

        {/* Customer Type Selection */}
        <Card className="border-0 shadow-md">
          <CardContent className="p-4">
            <Label className="text-lg font-bold mb-4 block">{isRTL ? 'نوع العميل' : 'Customer Type'}</Label>
            <div className="grid grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => handleTypeChange('individual')}
                className={`p-6 rounded-2xl border-2 transition-all flex flex-col items-center gap-3 ${
                  activeTab === 'individual'
                    ? 'border-cyan-500 bg-cyan-50 shadow-md'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <User className={`w-10 h-10 ${activeTab === 'individual' ? 'text-cyan-600' : 'text-slate-400'}`} />
                <div className="text-center">
                  <p className={`font-bold ${activeTab === 'individual' ? 'text-cyan-700' : 'text-slate-600'}`}>
                    {isRTL ? 'فرد' : 'Individual'}
                  </p>
                  <p className="text-xs text-slate-400">{isRTL ? 'عميل شخصي' : 'Personal customer'}</p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => handleTypeChange('company')}
                className={`p-6 rounded-2xl border-2 transition-all flex flex-col items-center gap-3 ${
                  activeTab === 'company'
                    ? 'border-cyan-500 bg-cyan-50 shadow-md'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <Building2 className={`w-10 h-10 ${activeTab === 'company' ? 'text-cyan-600' : 'text-slate-400'}`} />
                <div className="text-center">
                  <p className={`font-bold ${activeTab === 'company' ? 'text-cyan-700' : 'text-slate-600'}`}>
                    {isRTL ? 'شركة' : 'Company'}
                  </p>
                  <p className="text-xs text-slate-400">{isRTL ? 'عميل تجاري' : 'Business customer'}</p>
                </div>
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Main Form */}
        <form onSubmit={handleSubmit}>
          <Tabs value={activeTab} onValueChange={(v) => handleTypeChange(v as CustomerType)} className="space-y-6">
            <TabsList className="hidden">
              <TabsTrigger value="individual">Individual</TabsTrigger>
              <TabsTrigger value="company">Company</TabsTrigger>
            </TabsList>

            {/* INDIVIDUAL FORM */}
            <TabsContent value="individual" className="space-y-6">
              <Card className="border-0 shadow-md">
                <CardHeader className="bg-gradient-to-r from-slate-900 to-slate-800 text-white rounded-t-2xl">
                  <CardTitle className="flex items-center gap-2">
                    <User className="w-5 h-5" />
                    {isRTL ? 'البيانات الشخصية' : 'Personal Information'}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-4">
                  {/* Basic Info */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2">
                        <User className="w-4 h-4 text-slate-400" />
                        {isRTL ? 'الاسم الكامل *' : 'Full Name *'}
                      </Label>
                      <Input
                        required
                        value={formData.full_name}
                        onChange={e => setFormData({...formData, full_name: e.target.value})}
                        className="rounded-lg h-9 text-sm"
                        placeholder={isRTL ? 'محمد أحمد' : 'Mohammed Ahmed'}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2">
                        <Mail className="w-4 h-4 text-slate-400" />
                        {isRTL ? 'البريد الإلكتروني' : 'Email'}
                      </Label>
                      <Input
                        type="email"
                        value={formData.email}
                        onChange={e => setFormData({...formData, email: e.target.value})}
                        className="rounded-lg h-9 text-sm"
                        placeholder="email@example.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2">
                        <Phone className="w-4 h-4 text-slate-400" />
                        {isRTL ? 'رقم الهاتف *' : 'Phone *'}
                      </Label>
                      <Input
                        required
                        value={formData.phone}
                        onChange={e => setFormData({...formData, phone: e.target.value})}
                        className="rounded-lg h-9 text-sm"
                        placeholder="+973 3XXX XXXX"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2">
                        <Phone className="w-4 h-4 text-slate-400" />
                        {isRTL ? 'رقم الهاتف 2' : 'Phone 2'}
                      </Label>
                      <Input
                        value={formData.phone_2}
                        onChange={e => setFormData({...formData, phone_2: e.target.value})}
                        className="rounded-lg h-9 text-sm"
                        placeholder="+973 3XXX XXXX"
                      />
                    </div>
                  </div>

                  <Separator className="my-2" />

                  {/* ID Information */}
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                      <CreditCard className="w-5 h-5 text-cyan-600" />
                      {isRTL ? 'بيانات الهوية' : 'ID Information'}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div className="space-y-2">
                        <Label>{isRTL ? 'رقم الهوية / الجواز' : 'ID / Passport Number'}</Label>
                        <Input
                          value={formData.national_id}
                          onChange={e => setFormData({...formData, national_id: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-slate-400" />
                          {isRTL ? 'تاريخ الانتهاء' : 'Expiry Date'}
                        </Label>
                        <Input
                          type="date"
                          value={formData.id_expiry}
                          onChange={e => setFormData({...formData, id_expiry: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                    </div>
                  </div>

                  <Separator className="my-2" />

                  {/* License Information */}
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                      <Shield className="w-5 h-5 text-cyan-600" />
                      {isRTL ? 'بيانات الرخصة' : 'License Information'}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <Label>{isRTL ? 'رقم رخصة القيادة' : 'License Number'}</Label>
                        <Input
                          value={formData.license_number}
                          onChange={e => setFormData({...formData, license_number: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-slate-400" />
                          {isRTL ? 'تاريخ انتهاء الرخصة' : 'License Expiry'}
                        </Label>
                        <Input
                          type="date"
                          value={formData.license_expiry}
                          onChange={e => setFormData({...formData, license_expiry: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                    </div>
                  </div>

                  <Separator className="my-2" />

                  {/* Personal Details */}
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                      <Globe className="w-5 h-5 text-cyan-600" />
                      {isRTL ? 'البيانات الشخصية' : 'Personal Details'}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-slate-400" />
                          {isRTL ? 'تاريخ الميلاد' : 'Date of Birth'}
                        </Label>
                        <Input
                          type="date"
                          value={formData.date_of_birth}
                          onChange={e => setFormData({...formData, date_of_birth: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{isRTL ? 'الجنسية' : 'Nationality'}</Label>
                        <Input
                          value={formData.nationality}
                          onChange={e => setFormData({...formData, nationality: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                          placeholder={isRTL ? 'بحريني' : 'Bahraini'}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{isRTL ? 'الدولة' : 'Country'}</Label>
                        <Input
                          value={formData.country}
                          onChange={e => setFormData({...formData, country: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                          defaultValue="Bahrain"
                        />
                      </div>
                    </div>
                  </div>

                  <Separator className="my-2" />

                  {/* Police Case Warning */}
                  <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-red-100 dark:bg-red-900/40 flex items-center justify-center">
                          <Shield className="w-5 h-5 text-red-600 dark:text-red-400" />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-red-800 dark:text-red-300">
                            {isRTL ? 'عليه قضية / Police Case' : 'Police Case'}
                          </p>
                          <p className="text-xs text-red-600 dark:text-red-400">
                            {isRTL ? 'تنبيه: هذا العميل لديه قضية قانونية' : 'Warning: This customer has a legal case'}
                          </p>
                        </div>
                      </div>
                      <Switch
                        checked={formData.has_police_case}
                        onCheckedChange={(checked) => setFormData({...formData, has_police_case: checked})}
                        className="data-[state=checked]:bg-red-500"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* COMPANY FORM */}
            <TabsContent value="company" className="space-y-6">
              <Card className="border-0 shadow-md">
                <CardHeader className="bg-gradient-to-r from-slate-900 to-slate-800 text-white rounded-t-2xl">
                  <CardTitle className="flex items-center gap-2">
                    <Building2 className="w-5 h-5" />
                    {isRTL ? 'بيانات الشركة' : 'Company Information'}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2">
                        <Building2 className="w-4 h-4 text-slate-400" />
                        {isRTL ? 'اسم الشركة *' : 'Company Name *'}
                      </Label>
                      <Input
                        required={activeTab === 'company'}
                        value={formData.company_name}
                        onChange={e => setFormData({...formData, company_name: e.target.value})}
                        className="rounded-lg h-9 text-sm"
                        placeholder={isRTL ? 'شركة الخليج للتجارة' : 'Gulf Trading Co.'}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2">
                        <Briefcase className="w-4 h-4 text-slate-400" />
                        {isRTL ? 'القطاع' : 'Industry'}
                      </Label>
                      <Select
                        value={formData.industry}
                        onValueChange={(v) => setFormData({...formData, industry: v})}
                      >
                        <SelectTrigger className="rounded-lg h-9 text-sm">
                          <SelectValue placeholder={isRTL ? 'اختر القطاع' : 'Select industry'} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="trading">{isRTL ? 'تجارة' : 'Trading'}</SelectItem>
                          <SelectItem value="construction">{isRTL ? 'مقاولات' : 'Construction'}</SelectItem>
                          <SelectItem value="tourism">{isRTL ? 'سياحة' : 'Tourism'}</SelectItem>
                          <SelectItem value="transport">{isRTL ? 'نقل' : 'Transport'}</SelectItem>
                          <SelectItem value="other">{isRTL ? 'أخرى' : 'Other'}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>{isRTL ? 'حجم الشركة' : 'Company Size'}</Label>
                      <Select
                        value={formData.employee_count}
                        onValueChange={(v) => setFormData({...formData, employee_count: v})}
                      >
                        <SelectTrigger className="rounded-lg h-9 text-sm">
                          <SelectValue placeholder={isRTL ? 'اختر الحجم' : 'Select size'} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="small">{isRTL ? 'صغيرة (1-10)' : 'Small (1-10)'}</SelectItem>
                          <SelectItem value="medium">{isRTL ? 'متوسطة (11-50)' : 'Medium (11-50)'}</SelectItem>
                          <SelectItem value="large">{isRTL ? 'كبيرة (50+)' : 'Large (50+)'}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="flex items-center gap-2">
                        <Phone className="w-4 h-4 text-slate-400" />
                        {isRTL ? 'هاتف الشركة' : 'Company Phone'}
                      </Label>
                      <Input
                        value={formData.phone}
                        onChange={e => setFormData({...formData, phone: e.target.value})}
                        className="rounded-lg h-9 text-sm"
                        placeholder="+973 1XXX XXXX"
                      />
                    </div>
                  </div>

                  <Separator className="my-2" />

                  <div>
                    <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                      <FileText className="w-5 h-5 text-cyan-600" />
                      {isRTL ? 'التراخيص والضرائب' : 'Licenses & Tax'}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div className="space-y-2">
                        <Label>{isRTL ? 'رقم الترخيص التجاري' : 'Trade License'}</Label>
                        <Input
                          value={formData.commercial_reg}
                          onChange={e => setFormData({...formData, commercial_reg: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-slate-400" />
                          {isRTL ? 'تاريخ الانتهاء' : 'Expiry Date'}
                        </Label>
                        <Input
                          type="date"
                          value={formData.contract_end}
                          onChange={e => setFormData({...formData, contract_end: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{isRTL ? 'رقم VAT' : 'VAT Number'}</Label>
                        <Input
                          value={formData.tax_number}
                          onChange={e => setFormData({...formData, tax_number: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                    </div>
                  </div>

                  <Separator className="my-2" />

                  <div>
                    <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                      <Users className="w-5 h-5 text-cyan-600" />
                      {isRTL ? 'الشخص المسؤول' : 'Contact Person'}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div className="space-y-2">
                        <Label>{isRTL ? 'الاسم الكامل' : 'Full Name'}</Label>
                        <Input
                          value={formData.full_name}
                          onChange={e => setFormData({...formData, full_name: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <Phone className="w-4 h-4 text-slate-400" />
                          {isRTL ? 'رقم الهاتف' : 'Phone'}
                        </Label>
                        <Input
                          value={formData.emergency_phone}
                          onChange={e => setFormData({...formData, emergency_phone: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="flex items-center gap-2">
                          <Mail className="w-4 h-4 text-slate-400" />
                          {isRTL ? 'البريد الإلكتروني' : 'Email'}
                        </Label>
                        <Input
                          type="email"
                          value={formData.email}
                          onChange={e => setFormData({...formData, email: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                    </div>
                  </div>

                  <Separator className="my-2" />

                  <div>
                    <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                      <MapPin className="w-5 h-5 text-cyan-600" />
                      {isRTL ? 'عنوان الشركة' : 'Company Address'}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div className="space-y-2 md:col-span-2">
                        <Label>{isRTL ? 'العنوان' : 'Address'}</Label>
                        <Input
                          value={formData.address}
                          onChange={e => setFormData({...formData, address: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{isRTL ? 'المدينة' : 'City'}</Label>
                        <Input
                          value={formData.city}
                          onChange={e => setFormData({...formData, city: e.target.value})}
                          className="rounded-lg h-9 text-sm"
                        />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* Common Fields */}
          <Card className="border-0 shadow-lg mt-6">
            <CardHeader className="bg-gradient-to-r from-slate-100 to-slate-50 rounded-t-2xl">
              <CardTitle className="flex items-center gap-2 text-slate-700">
                <MapPin className="w-5 h-5" />
                {isRTL ? 'العنوان والملاحظات' : 'Address & Notes'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-slate-400" />
                    {isRTL ? 'العنوان' : 'Address'}
                  </Label>
                  <Textarea
                    value={formData.address}
                    onChange={e => setFormData({...formData, address: e.target.value})}
                    className="rounded-lg min-h-[60px] text-sm"
                    placeholder={isRTL ? 'المنطقة، الشارع، المبنى' : 'Area, Street, Building'}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{isRTL ? 'المدينة' : 'City'}</Label>
                  <Input
                    value={formData.city}
                    onChange={e => setFormData({...formData, city: e.target.value})}
                    className="rounded-lg h-9 text-sm"
                    placeholder={isRTL ? 'المنامة' : 'Manama'}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-slate-400" />
                  {isRTL ? 'ملاحظات' : 'Notes'}
                </Label>
                <Textarea
                  value={formData.notes}
                  onChange={e => setFormData({...formData, notes: e.target.value})}
                  className="rounded-lg min-h-[60px] text-sm"
                  placeholder={isRTL ? 'أي ملاحظات إضافية...' : 'Any additional notes...'}
                />
              </div>
            </CardContent>
          </Card>

          {/* Status & Rating */}
          <Card className="border-0 shadow-lg mt-6">
            <CardHeader className="bg-gradient-to-r from-slate-100 to-slate-50 rounded-t-2xl">
              <CardTitle className="flex items-center gap-2 text-slate-700">
                <Star className="w-5 h-5" />
                {isRTL ? 'التصنيف والحالة' : 'Rating & Status'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>{isRTL ? 'التقييم' : 'Rating'}</Label>
                  <div className="flex items-center gap-2">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        onClick={() => setFormData({...formData, rating: star.toString()})}
                        className="p-1 hover:scale-110 transition-transform"
                      >
                        <Star
                          className={`w-8 h-8 ${Number(formData.rating) >= star ? 'text-amber-400 fill-amber-400' : 'text-slate-200'}`}
                        />
                      </button>
                    ))}
                    <span className="ml-2 text-sm text-slate-500">({formData.rating}/5)</span>
                  </div>
                </div>
                <div className="space-y-2">
                <div className="space-y-2 mt-4">
                  <Label>{isRTL ? 'حد الائتمان (د.ب)' : 'Credit Limit (BHD)'}</Label>
                  <Input type="number" step="0.001" value={formData.credit_limit} onChange={e => setFormData({...formData, credit_limit: e.target.value})} placeholder={isRTL ? '0.000' : '0.000'} className="h-10" />
                </div>
                  <Label>{isRTL ? 'حالة العميل' : 'Customer Status'}</Label>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(statusConfig).map(([key, config]) => {
                      const StatusIcon = config.icon
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setFormData({...formData, status: key as any})}
                          className={`flex items-center gap-2 px-4 py-2 rounded-xl border-2 transition-all ${
                            formData.status === key
                              ? 'border-cyan-500 bg-cyan-50 shadow-sm'
                              : 'border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          <StatusIcon className={`w-4 h-4 ${formData.status === key ? 'text-cyan-600' : 'text-slate-400'}`} />
                          <span className={`text-sm font-semibold ${formData.status === key ? 'text-cyan-700' : 'text-slate-600'}`}>
                            {config.label}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* File Upload */}
          <Card className="border-0 shadow-lg mt-6">
            <CardHeader className="bg-gradient-to-r from-slate-100 to-slate-50 rounded-t-2xl">
              <CardTitle className="flex items-center gap-2 text-slate-700">
                <Upload className="w-5 h-5" />
                {isRTL ? 'المستندات' : 'Documents'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-300 rounded-2xl p-8 text-center cursor-pointer hover:border-cyan-400 hover:bg-cyan-50 transition-all"
              >
                <Upload className="w-10 h-10 text-slate-400 mx-auto mb-3" />
                <p className="text-slate-600 font-semibold">{isRTL ? 'اضغط لرفع المستندات' : 'Click to upload documents'}</p>
                <p className="text-sm text-slate-400 mt-1">{isRTL ? 'رخصة قيادة، هوية، جواز سفر' : 'License, ID, Passport'}</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.pdf"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </div>
              {uploadedFiles.length > 0 && (
                <div className="mt-4 space-y-2">
                  {uploadedFiles.map((file, idx) => (
                    <div key={idx} className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl">
                      <FileText className="w-5 h-5 text-cyan-600" />
                      <span className="text-sm text-slate-700 flex-1">{file.name}</span>
                      <Badge variant="outline" className="text-xs">{(file.size / 1024).toFixed(0)} KB</Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Submit Button */}
          <div className="pt-6 pb-12">
            <Button
              type="submit"
              className="w-full h-14 text-lg rounded-2xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-700 hover:to-blue-700 shadow-lg shadow-cyan-500/25"
              disabled={loading}
            >
              <Save className="w-5 h-5 mr-2" />
              {loading ? (isRTL ? 'جاري الحفظ...' : 'Saving...') : (isRTL ? 'حفظ البيانات' : 'Save Customer')}
            </Button>
          </div>
        </form>
      </div>
    </DashboardLayout>
  )
}

export default function NewCustomerPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-600"></div>
      </div>
    }>
      <NewCustomerForm />
    </Suspense>
  )
}
