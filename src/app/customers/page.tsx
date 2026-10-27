"use client"
import { Suspense } from 'react'
import { } from 'react'

import { useState, useEffect } from 'react'
import { supabase, Customer } from '@/lib/supabase'
import { Language } from '@/lib/i18n'
import { useLanguage } from '@/lib/LanguageContext'
import { formatNumber, getStatusColor } from '@/lib/utils'
import { 
  Plus, 
  Search, 
  Edit,
  Trash2,
  Users,
  Phone,
  Mail,
  MapPin,
  Star
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import DashboardLayout from '@/components/DashboardLayout'

export const dynamic = 'force-dynamic'

function CustomersPageContent() {
  const { lang, t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [showPoliceCases, setShowPoliceCases] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [customerToDelete, setCustomerToDelete] = useState<string | null>(null)
  const searchParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "")
  const [formData, setFormData] = useState({
    full_name: '',
    email: '',
    phone: '',
    phone_2: '',
    national_id: '',
    license_number: '',
    license_expiry: '',
    address: '',
    city: '',
    country: 'Bahrain',
    status: 'active' as 'active' | 'defaulted' | 'vip' | 'blocked',
    rating: 5,
    notes: '',
    customer_type: 'individual' as 'individual' | 'company',
    company_name: '',
    commercial_reg: '',
    tax_number: '',
    industry: '',
    employee_count: '',
    date_of_birth: '',
    nationality: '',
    id_expiry: '',
    id_type: 'national_id' as 'national_id' | 'passport' | 'residence',
    contact_person_name: '',
    contact_person_phone: '',
    contact_person_email: '',
    company_address: '',
    company_city: '',
    company_country: 'Bahrain',
  })

  const queryStatus = searchParams.get('status')
  const normalizedQueryStatus = queryStatus === 'inactive' ? 'blocked' : queryStatus



  useEffect(() => {
    setMounted(true)
    fetchCustomers()
  }, [])


  useEffect(() => {
    if (normalizedQueryStatus) setStatusFilter(normalizedQueryStatus)
  }, [normalizedQueryStatus])
  async function fetchCustomers() {
    setLoading(true)
    try {
      const { data } = await supabase.from('customers').select('*').order('created_at', { ascending: false })
      if (data) setCustomers(data)
    } catch (error) {
      console.error('Error fetching customers:', error)
    }
    setLoading(false)
  }

  const filteredCustomers = customers.filter(c => {
    const matchesSearch = c.full_name.toLowerCase().includes(search.toLowerCase()) ||
      c.phone.includes(search) || (c.email && c.email.toLowerCase().includes(search.toLowerCase()))
    const effectiveStatus = statusFilter === 'all' && normalizedQueryStatus ? normalizedQueryStatus : statusFilter
    const matchesStatus = effectiveStatus === 'all' || c.status === effectiveStatus
    const matchesPolice = !showPoliceCases || c.has_police_case === true
    return matchesSearch && matchesStatus && matchesPolice
  })

  // The customer is written server-side: `customers` is tenant-owned, and a
  // browser insert never set `tenant_id`, so every customer created here was an
  // orphan visible to the single-tenant install. The route takes the tenant from
  // the session and scopes the update by it, so a foreign id is a 404.
  async function handleSave() {
    try {
      const res = await fetch(editingCustomer ? `/api/customers/${editingCustomer.id}` : '/api/customers', {
        method: editingCustomer ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Request failed (${res.status})`)
      }
      setDialogOpen(false)
      setEditingCustomer(null)
      resetForm()
      fetchCustomers()
    } catch (error) {
      console.error('Error saving customer:', error)
      alert(error instanceof Error ? error.message : 'Error saving customer')
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/customers/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Request failed (${res.status})`)
      }
      setDeleteDialogOpen(false)
      setCustomerToDelete(null)
      fetchCustomers()
    } catch (error) {
      console.error('Error deleting customer:', error)
      alert(error instanceof Error ? error.message : 'Error deleting customer')
    }
  }

  function confirmDelete(id: string) {
    setCustomerToDelete(id)
    setDeleteDialogOpen(true)
  }

  function openEditDialog(customer: Customer) {
    setEditingCustomer(customer)
    setFormData({
      full_name: customer.full_name,
      email: customer.email || '',
      phone: customer.phone,
      phone_2: customer.phone_2 || '',
      national_id: customer.national_id || '',
      license_number: customer.license_number || '',
      license_expiry: customer.license_expiry || '',
      address: customer.address || '',
      city: customer.city || '',
      country: customer.country || 'Bahrain',
      status: (customer.status as any) || 'active',
      rating: customer.rating ?? 5,
      notes: customer.notes || '',
      customer_type: (customer.customer_type as any) || 'individual',
      company_name: customer.company_name || '',
      commercial_reg: customer.commercial_reg || '',
      tax_number: customer.tax_number || '',
      industry: customer.industry || '',
      employee_count: customer.employee_count || '',
      date_of_birth: customer.date_of_birth || '',
      nationality: customer.nationality || '',
      id_expiry: customer.id_expiry || '',
      id_type: (customer.id_type as any) || 'national_id',
      contact_person_name: customer.name || '',
      contact_person_phone: customer.emergency_phone || '',
      contact_person_email: customer.email || '',
      company_address: customer.address || '',
      company_city: customer.city || '',
      company_country: customer.country || 'Bahrain',
    })
    setDialogOpen(true)
  }

  function resetForm() {
    setFormData({ 
      full_name: '', email: '', phone: '', phone_2: '', national_id: '', license_number: '', license_expiry: '',
      address: '', city: '', country: 'Bahrain', status: 'active', rating: 5, notes: '',
      customer_type: 'individual', company_name: '', commercial_reg: '', tax_number: '',
      industry: '', employee_count: '', date_of_birth: '', nationality: '', id_expiry: '',
      id_type: 'national_id', contact_person_name: '', contact_person_phone: '',
      contact_person_email: '', company_address: '', company_city: '', company_country: 'Bahrain'
    })
  }

  const statusLabels: Record<string, string> = { active: t.active, defaulted: t.defaulted, vip: t.vip, blocked: t.blocked }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">{t.customers}</h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {formatNumber(customers.length)} {t.customers}
            </p>
          </div>
          <Button onClick={() => { resetForm(); setEditingCustomer(null); setDialogOpen(true); }} className="bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700 text-white shadow-lg shadow-violet-500/25">
            <Plus className="w-5 h-5 ml-2" />
            <span>{t.newCustomer}</span>
          </Button>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
          <div className="flex flex-col lg:flex-row gap-4">
            <div className="flex-1 relative flex gap-2">
              <div className="flex-1 relative">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <Input placeholder={t.search} value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setSearch(searchDraft) }} className="pr-10 bg-slate-50 dark:bg-slate-700 border-slate-200 dark:border-slate-600" />
              </div>
              <Button onClick={() => setSearch(searchDraft)} className="bg-violet-600 hover:bg-violet-700 text-white shrink-0">
                <Search className="w-4 h-4 md:mr-2" /><span className="hidden md:inline">{isRTL ? 'بحث' : 'Search'}</span>
              </Button>
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full lg:w-48 bg-slate-50 dark:bg-slate-700 border-slate-200 dark:border-slate-600">
                <SelectValue placeholder={t.status} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t.allCars}</SelectItem>
                <SelectItem value="active">{t.active}</SelectItem>
                <SelectItem value="vip">{t.vip}</SelectItem>
                <SelectItem value="defaulted">{t.defaulted}</SelectItem>
                <SelectItem value="blocked">{t.blocked}</SelectItem>
              </SelectContent>
            </Select>
            <button
              onClick={() => setShowPoliceCases(!showPoliceCases)}
              className={`px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${showPoliceCases ? 'bg-red-600 text-white border-red-600' : 'bg-slate-50 dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300'}`}
            >
              {isRTL ? 'قضايا شرطة' : 'Police Cases'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin w-10 h-10 border-4 border-violet-500 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredCustomers.map((customer) => (
              <div key={customer.id} className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 hover:shadow-lg transition-shadow">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 text-white flex items-center justify-center text-xl font-bold">
                      {customer.full_name.charAt(0)}
                    </div>
                    <div>
                      <h3 className="font-bold text-lg text-slate-900 dark:text-white">{customer.full_name}</h3>
                      <Badge className={getStatusColor(customer.status || 'active')}>{statusLabels[customer.status || 'active']}</Badge>
                      {customer.has_police_case && <Badge className="bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400">{isRTL ? 'قضية شرطة' : 'Police Case'}</Badge>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {[...Array(5)].map((_, i) => (
                      <Star key={i} className={`w-4 h-4 ${i < (customer.rating ?? 5) ? 'text-amber-400 fill-amber-400' : 'text-slate-300'}`} />
                    ))}
                  </div>
                </div>
                <div className="space-y-2 mb-4">
                  <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                    <Phone className="w-4 h-4 text-slate-400" />
                    <span className="text-sm" dir="ltr">{customer.phone}</span>
                  </div>
                  {customer.email && (
                    <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                      <Mail className="w-4 h-4 text-slate-400" />
                      <span className="text-sm">{customer.email}</span>
                    </div>
                  )}
                  {customer.city && (
                    <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                      <MapPin className="w-4 h-4 text-slate-400" />
                      <span className="text-sm">{customer.city}</span>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 pt-4 border-t border-slate-200 dark:border-slate-700">
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => openEditDialog(customer)}>
                    <Edit className="w-4 h-4 ml-1" />
                    <span>{t.edit}</span>
                  </Button>
                  <Button variant="outline" size="sm" className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onClick={() => confirmDelete(customer.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && filteredCustomers.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 text-slate-500 dark:text-slate-400">
            <Users className="w-16 h-16 mb-4 opacity-50" />
            <p className="text-lg">{t.noData}</p>
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingCustomer ? t.edit : t.newCustomer}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4 max-h-[70vh] overflow-y-auto px-1">
            {/* Customer Type */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setFormData({...formData, customer_type: 'individual'})}
                className={`p-3 rounded-xl border-2 text-center text-sm font-bold transition-all ${formData.customer_type === 'individual' ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-slate-200 text-slate-500'}`}
              >
                {isRTL ? 'فرد' : 'Individual'}
              </button>
              <button
                type="button"
                onClick={() => setFormData({...formData, customer_type: 'company'})}
                className={`p-3 rounded-xl border-2 text-center text-sm font-bold transition-all ${formData.customer_type === 'company' ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-slate-200 text-slate-500'}`}
              >
                {isRTL ? 'شركة' : 'Company'}
              </button>
            </div>

            {/* Full Name / Company Name */}
            <div>
              <Label className="text-xs font-semibold text-slate-500">{formData.customer_type === 'company' ? (isRTL ? 'اسم الشركة *' : 'Company Name *') : (isRTL ? 'الاسم الكامل *' : 'Full Name *')}</Label>
              <Input className="h-9 text-sm rounded-lg mt-1" value={formData.customer_type === 'company' ? formData.company_name : formData.full_name} onChange={(e) => setFormData({ ...formData, [formData.customer_type === 'company' ? 'company_name' : 'full_name']: e.target.value })} />
            </div>

            {/* Phone & Email */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'الهاتف *' : 'Phone *'}</Label>
                <Input className="h-9 text-sm rounded-lg mt-1" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} dir="ltr" />
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'الهاتف 2' : 'Phone 2'}</Label>
                <Input className="h-9 text-sm rounded-lg mt-1" value={formData.phone_2} onChange={(e) => setFormData({ ...formData, phone_2: e.target.value })} dir="ltr" />
              </div>
            </div>

            <div>
              <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'البريد الإلكتروني' : 'Email'}</Label>
              <Input type="email" className="h-9 text-sm rounded-lg mt-1" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} dir="ltr" />
            </div>

            {/* ID Info */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'نوع الهوية' : 'ID Type'}</Label>
                <Select value={formData.id_type} onValueChange={(v) => setFormData({ ...formData, id_type: v as any })}>
                  <SelectTrigger className="h-9 text-sm rounded-lg mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="national_id">{isRTL ? 'بطاقة الهوية' : 'National ID'}</SelectItem>
                    <SelectItem value="passport">{isRTL ? 'جواز السفر' : 'Passport'}</SelectItem>
                    <SelectItem value="residence">{isRTL ? 'إقامة' : 'Residence'}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'رقم الهوية' : 'ID Number'}</Label>
                <Input className="h-9 text-sm rounded-lg mt-1" value={formData.national_id} onChange={(e) => setFormData({ ...formData, national_id: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'انتهاء الهوية' : 'ID Expiry'}</Label>
                <Input type="date" className="h-9 text-sm rounded-lg mt-1" value={formData.id_expiry} onChange={(e) => setFormData({ ...formData, id_expiry: e.target.value })} />
              </div>
            </div>

            {/* License Info */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'رقم الرخصة' : 'License No.'}</Label>
                <Input className="h-9 text-sm rounded-lg mt-1" value={formData.license_number} onChange={(e) => setFormData({ ...formData, license_number: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'انتهاء الرخصة' : 'License Expiry'}</Label>
                <Input type="date" className="h-9 text-sm rounded-lg mt-1" value={formData.license_expiry} onChange={(e) => setFormData({ ...formData, license_expiry: e.target.value })} />
              </div>
            </div>

            {/* Personal Info */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'تاريخ الميلاد' : 'Date of Birth'}</Label>
                <Input type="date" className="h-9 text-sm rounded-lg mt-1" value={formData.date_of_birth} onChange={(e) => setFormData({ ...formData, date_of_birth: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'الجنسية' : 'Nationality'}</Label>
                <Input className="h-9 text-sm rounded-lg mt-1" value={formData.nationality} onChange={(e) => setFormData({ ...formData, nationality: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'الدولة' : 'Country'}</Label>
                <Input className="h-9 text-sm rounded-lg mt-1" value={formData.country} onChange={(e) => setFormData({ ...formData, country: e.target.value })} />
              </div>
            </div>

            {/* Company Fields - Only show if company */}
            {formData.customer_type === 'company' && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'السجل التجاري' : 'Commercial Reg'}</Label>
                    <Input className="h-9 text-sm rounded-lg mt-1" value={formData.commercial_reg} onChange={(e) => setFormData({ ...formData, commercial_reg: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'رقم VAT' : 'VAT Number'}</Label>
                    <Input className="h-9 text-sm rounded-lg mt-1" value={formData.tax_number} onChange={(e) => setFormData({ ...formData, tax_number: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'القطاع' : 'Industry'}</Label>
                    <Select value={formData.industry} onValueChange={(v) => setFormData({ ...formData, industry: v })}>
                      <SelectTrigger className="h-9 text-sm rounded-lg mt-1"><SelectValue placeholder="..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="trading">{isRTL ? 'تجارة' : 'Trading'}</SelectItem>
                        <SelectItem value="construction">{isRTL ? 'مقاولات' : 'Construction'}</SelectItem>
                        <SelectItem value="tourism">{isRTL ? 'سياحة' : 'Tourism'}</SelectItem>
                        <SelectItem value="transport">{isRTL ? 'نقل' : 'Transport'}</SelectItem>
                        <SelectItem value="other">{isRTL ? 'أخرى' : 'Other'}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'حجم الشركة' : 'Company Size'}</Label>
                    <Select value={formData.employee_count} onValueChange={(v) => setFormData({ ...formData, employee_count: v })}>
                      <SelectTrigger className="h-9 text-sm rounded-lg mt-1"><SelectValue placeholder="..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="small">{isRTL ? 'صغيرة' : 'Small'}</SelectItem>
                        <SelectItem value="medium">{isRTL ? 'متوسطة' : 'Medium'}</SelectItem>
                        <SelectItem value="large">{isRTL ? 'كبيرة' : 'Large'}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'الشخص المسؤول' : 'Contact Person'}</Label>
                    <Input className="h-9 text-sm rounded-lg mt-1" value={formData.contact_person_name} onChange={(e) => setFormData({ ...formData, contact_person_name: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'هاتف المسؤول' : 'Contact Phone'}</Label>
                    <Input className="h-9 text-sm rounded-lg mt-1" value={formData.contact_person_phone} onChange={(e) => setFormData({ ...formData, contact_person_phone: e.target.value })} dir="ltr" />
                  </div>
                </div>
              </>
            )}

            {/* Address */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'المدينة' : 'City'}</Label>
                <Input className="h-9 text-sm rounded-lg mt-1" value={formData.city} onChange={(e) => setFormData({ ...formData, city: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'الحالة' : 'Status'}</Label>
                <Select value={formData.status} onValueChange={(v) => setFormData({ ...formData, status: v as any })}>
                  <SelectTrigger className="h-9 text-sm rounded-lg mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">{t.active}</SelectItem>
                    <SelectItem value="vip">{t.vip}</SelectItem>
                    <SelectItem value="defaulted">{t.defaulted}</SelectItem>
                    <SelectItem value="blocked">{t.blocked}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'العنوان' : 'Address'}</Label>
              <Textarea className="text-sm rounded-lg mt-1 min-h-[50px]" value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} />
            </div>

            <div>
              <Label className="text-xs font-semibold text-slate-500">{isRTL ? 'ملاحظات' : 'Notes'}</Label>
              <Textarea className="text-sm rounded-lg mt-1 min-h-[50px]" value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t.cancel}</Button>
            <Button onClick={handleSave} className="bg-gradient-to-r from-violet-500 to-purple-600">{t.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.confirmDelete}</DialogTitle>
          </DialogHeader>
          <p className="text-slate-600 dark:text-slate-300">{isRTL ? 'هل أنت متأكد من حذف هذا العميل؟' : 'Are you sure you want to delete this customer?'}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>{t.cancel}</Button>
            <Button variant="destructive" onClick={() => customerToDelete && handleDelete(customerToDelete)}>{isRTL ? 'حذف' : 'Delete'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

export default function CustomersPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CustomersPageContent />
    </Suspense>
  )
}
