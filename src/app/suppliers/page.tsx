"use client"
export const dynamic = "force-dynamic"
import { Suspense, useEffect, useMemo, useState } from 'react'
import { supabase, Supplier } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Users, Trash2, Phone, Mail, MapPin, User, Hash, CreditCard, Plus, Search, Building2, FileText } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

function SuppliersPageContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)

  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    address: '',
    trn_number: '',
    contact_person: '',
    payment_terms: '',
    opening_balance: '',
    notes: '',
  })

  useEffect(() => {
    setMounted(true)
    fetchSuppliers()
  }, [])

  async function fetchSuppliers() {
    setLoading(true)
    const { data, error } = await supabase.from('suppliers').select('*').order('created_at', { ascending: false })
    if (error) {
      console.error('Error fetching suppliers:', error)
    }
    if (data) setSuppliers(data as Supplier[])
    setLoading(false)
  }

  const filteredSuppliers = useMemo(() => {
    if (!search) return suppliers
    const term = search.toLowerCase()
    return suppliers.filter((supplier) =>
      supplier.name.toLowerCase().includes(term) ||
      (supplier.phone || '').toLowerCase().includes(term) ||
      (supplier.email || '').toLowerCase().includes(term) ||
      (supplier.trn_number || '').toLowerCase().includes(term)
    )
  }, [suppliers, search])

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      alert(isRTL ? 'اسم المورد مطلوب' : 'Supplier name is required')
      return
    }

    setSaving(true)
    const { error } = await supabase.from('suppliers').insert([
      {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        address: form.address.trim() || null,
        trn_number: form.trn_number.trim() || null,
        contact_person: form.contact_person.trim() || null,
        payment_terms: form.payment_terms.trim() || null,
        opening_balance: parseFloat(form.opening_balance) || 0,
        balance: parseFloat(form.opening_balance) || 0,
        notes: form.notes.trim() || null,
      },
    ])

    if (error) {
      console.error('Insert error:', error)
      alert(isRTL ? 'خطأ في الحفظ: ' + error.message : 'Save error: ' + error.message)
      setSaving(false)
      return
    }

    setForm({
      name: '',
      phone: '',
      email: '',
      address: '',
      trn_number: '',
      contact_person: '',
      payment_terms: '',
      opening_balance: '',
      notes: '',
    })
    setShowForm(false)
    await fetchSuppliers()
    setSaving(false)
  }

  async function handleDelete(id: string) {
    if (!confirm(isRTL ? 'هل أنت متأكد من حذف هذا المورد؟' : 'Are you sure you want to delete this supplier?')) return
    const { error } = await supabase.from('suppliers').delete().eq('id', id)
    if (error) {
      alert(isRTL ? 'خطأ في الحذف' : 'Delete error')
      return
    }
    await fetchSuppliers()
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <Users className="w-7 h-7 text-cyan-500" />
              {isRTL ? 'الموردون' : 'Suppliers'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {isRTL ? 'إدارة الموردين ومعلوماتهم الضريبية والمالية' : 'Manage suppliers with tax and financial info'}
            </p>
          </div>
          <Button onClick={() => setShowForm(!showForm)} className="bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl gap-2">
            {showForm ? (isRTL ? 'إلغاء' : 'Cancel') : <><Plus className="w-4 h-4" /> {isRTL ? 'مورد جديد' : 'New Supplier'}</>}
          </Button>
        </div>

        {/* Add Form */}
        {showForm && (
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 space-y-4">
            <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Building2 className="w-4 h-4 text-cyan-500" />
              {isRTL ? 'إضافة مورد جديد' : 'Add New Supplier'}
            </h3>
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'اسم المورد' : 'Supplier Name'} *</label>
                <Input
                  placeholder={isRTL ? 'اسم الشركة أو المورد' : 'Company or supplier name'}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="h-11 rounded-xl"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'الشخص المسؤول' : 'Contact Person'}</label>
                <Input
                  placeholder={isRTL ? 'اسم الشخص المسؤول' : 'Contact person name'}
                  value={form.contact_person}
                  onChange={(e) => setForm({ ...form, contact_person: e.target.value })}
                  className="h-11 rounded-xl"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'رقم الهاتف' : 'Phone'}</label>
                <Input
                  placeholder="+973 xxxx xxxx"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="h-11 rounded-xl"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'البريد الإلكتروني' : 'Email'}</label>
                <Input
                  type="email"
                  placeholder="email@company.com"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="h-11 rounded-xl"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'الرقم الضريبي (TRN)' : 'Tax Reg. No. (TRN)'}</label>
                <Input
                  placeholder={isRTL ? 'مثال: 200012345600003' : 'e.g. 200012345600003'}
                  value={form.trn_number}
                  onChange={(e) => setForm({ ...form, trn_number: e.target.value })}
                  className="h-11 rounded-xl"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'شروط الدفع' : 'Payment Terms'}</label>
                <Input
                  placeholder={isRTL ? 'مثال: 30 يوم' : 'e.g. Net 30'}
                  value={form.payment_terms}
                  onChange={(e) => setForm({ ...form, payment_terms: e.target.value })}
                  className="h-11 rounded-xl"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'الرصيد الافتتاحي' : 'Opening Balance'}</label>
                <Input
                  type="number"
                  step="0.001"
                  placeholder="0.000"
                  value={form.opening_balance}
                  onChange={(e) => setForm({ ...form, opening_balance: e.target.value })}
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'العنوان' : 'Address'}</label>
                <Input
                  placeholder={isRTL ? 'عنوان المورد' : 'Supplier address'}
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="md:col-span-3">
                <label className="text-xs text-slate-500 mb-1 block">{isRTL ? 'ملاحظات' : 'Notes'}</label>
                <Input
                  placeholder={isRTL ? 'أي ملاحظات إضافية...' : 'Any additional notes...'}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="h-11 rounded-xl"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSubmit} disabled={saving} className="bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl gap-2">
                {saving ? (isRTL ? 'جاري الحفظ...' : 'Saving...') : <><Plus className="w-4 h-4" /> {isRTL ? 'حفظ المورد' : 'Save Supplier'}</>}
              </Button>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 border border-slate-200 dark:border-slate-700">
          <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className={`absolute ${isRTL ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400`} />
            <Input
              placeholder={isRTL ? 'بحث باسم المورد أو الهاتف أو TRN...' : 'Search by name, phone, or TRN...'}
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSearch(searchDraft) }}
              className={`${isRTL ? 'pr-9' : 'pl-9'} h-10 rounded-xl`}
            />
          </div>
          <Button onClick={() => setSearch(searchDraft)} className="bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl h-10 gap-2 shrink-0">
            <Search className="w-4 h-4" />{isRTL ? 'بحث' : 'Search'}
          </Button>
        </div>
        </div>

        {/* Suppliers List */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin w-8 h-8 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
            </div>
          ) : filteredSuppliers.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-400">
              <Users className="w-12 h-12 mb-3 opacity-30" />
              <p>{isRTL ? 'لا يوجد موردون' : 'No suppliers found'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-700">
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'المورد' : 'Supplier'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'التواصل' : 'Contact'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'TRN' : 'TRN'}</th>
                    <th className={`py-3 px-4 ${isRTL ? 'text-right' : 'text-left'}`}>{isRTL ? 'الرصيد' : 'Balance'}</th>
                    <th className="py-3 px-4 text-center">{isRTL ? 'إجراء' : 'Action'}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSuppliers.map((supplier) => (
                    <tr key={supplier.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-cyan-100 text-cyan-600 flex items-center justify-center">
                            <Building2 className="w-5 h-5" />
                          </div>
                          <div>
                            <p className="font-semibold text-slate-900 dark:text-white">{supplier.name}</p>
                            {supplier.contact_person && (
                              <p className="text-xs text-slate-500 flex items-center gap-1">
                                <User className="w-3 h-3" /> {supplier.contact_person}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <div className="space-y-1">
                          {supplier.phone && (
                            <p className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1">
                              <Phone className="w-3 h-3" /> {supplier.phone}
                            </p>
                          )}
                          {supplier.email && (
                            <p className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1">
                              <Mail className="w-3 h-3" /> {supplier.email}
                            </p>
                          )}
                          {supplier.address && (
                            <p className="text-sm text-slate-500 flex items-center gap-1">
                              <MapPin className="w-3 h-3" /> {supplier.address}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        {supplier.trn_number ? (
                          <Badge variant="outline" className="font-mono text-xs">
                            <Hash className="w-3 h-3 mr-1" /> {supplier.trn_number}
                          </Badge>
                        ) : (
                          <span className="text-xs text-slate-400">-</span>
                        )}
                      </td>
                      <td className="py-4 px-4">
                        <p className={`font-bold ${(supplier.balance || 0) > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                          {formatCurrency(supplier.balance || 0)}
                        </p>
                        {supplier.payment_terms && (
                          <p className="text-xs text-slate-500">{supplier.payment_terms}</p>
                        )}
                      </td>
                      <td className="py-4 px-4 text-center">
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(supplier.id)} className="h-8 w-8 text-red-500 hover:text-red-600">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function SuppliersPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <SuppliersPageContent />
    </Suspense>
  )
}
