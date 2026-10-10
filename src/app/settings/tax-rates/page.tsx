"use client"
export const dynamic = "force-dynamic"

import { Suspense } from "react"
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Settings, Plus, Edit, Trash2, ToggleLeft, ToggleRight } from 'lucide-react'

type TaxSetting = {
  id: string
  name_ar: string
  name_en: string
  rate: number
  type: string
  is_active: boolean
  applies_to: string
}

function PageContent() {
  const { isRTL } = useLanguage()
  const [taxes, setTaxes] = useState<TaxSetting[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<TaxSetting | null>(null)
  const [form, setForm] = useState({ name_ar: '', name_en: '', rate: 5, type: 'vat', is_active: true, applies_to: 'all' })

  const fetchTaxes = async () => {
    setLoading(true)
    const { data } = await supabase.from('tax_settings').select('*').order('created_at')
    setTaxes(data || [])
    setLoading(false)
  }

  useEffect(() => { fetchTaxes() }, [])

  const openAdd = () => {
    setEditing(null)
    setForm({ name_ar: '', name_en: '', rate: 5, type: 'vat', is_active: true, applies_to: 'all' })
    setDialogOpen(true)
  }

  const openEdit = (tax: TaxSetting) => {
    setEditing(tax)
    setForm({ name_ar: tax.name_ar, name_en: tax.name_en, rate: tax.rate, type: tax.type, is_active: tax.is_active, applies_to: tax.applies_to })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    const { error } = editing
      ? await supabase.from('tax_settings').update(form).eq('id', editing.id)
      : await supabase.from('tax_settings').insert([form])
    if (error) {
      alert((isRTL ? "فشل الحفظ: " : "Save failed: ") + error.message)
      console.error("tax_settings save error:", error)
      return
    }
    setDialogOpen(false)
    fetchTaxes()
  }

  const handleDelete = async (id: string) => {
    await supabase.from('tax_settings').delete().eq('id', id)
    fetchTaxes()
  }

  const toggleActive = async (tax: TaxSetting) => {
    await supabase.from('tax_settings').update({ is_active: !tax.is_active }).eq('id', tax.id)
    fetchTaxes()
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center text-white shadow-lg">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
                {isRTL ? 'إعدادات الضريبة' : 'Tax Settings'}
              </h1>
              <p className="text-sm text-slate-500">{isRTL ? 'إدارة أنواع الضرائب والرسوم' : 'Manage tax types and rates'}</p>
            </div>
          </div>
          <Button onClick={openAdd} className="bg-gradient-to-r from-orange-500 to-red-600 text-white">
            <Plus className="w-4 h-4 ml-2" />
            {isRTL ? 'إضافة ضريبة' : 'Add Tax'}
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {loading ? (
            <div className="col-span-3 flex items-center justify-center h-48">
              <div className="animate-spin w-8 h-8 border-4 border-orange-500 border-t-transparent rounded-full" />
            </div>
          ) : taxes.length === 0 ? (
            <div className="col-span-3 flex flex-col items-center justify-center h-48 text-slate-400">
              <Settings className="w-12 h-12 mb-3 opacity-30" />
              <p>{isRTL ? 'لا توجد إعدادات ضريبية بعد' : 'No tax settings yet'}</p>
            </div>
          ) : taxes.map((tax) => (
            <div key={tax.id} className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-bold text-slate-900 dark:text-white">{isRTL ? tax.name_ar : tax.name_en}</h3>
                  <p className="text-sm text-slate-500">{isRTL ? tax.name_en : tax.name_ar}</p>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${tax.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                  {tax.is_active ? (isRTL ? 'نشط' : 'Active') : (isRTL ? 'معطل' : 'Inactive')}
                </span>
              </div>
              <div className="flex items-center gap-2 mb-4">
                <span className="text-3xl font-bold text-orange-600">{tax.rate}%</span>
                <span className="text-sm text-slate-500">{tax.type === 'vat' ? (isRTL ? 'ضريبة قيمة مضافة' : 'VAT') : tax.type}</span>
              </div>
              <p className="text-xs text-slate-400 mb-4">
                {isRTL ? 'يطبق على:' : 'Applies to:'} {tax.applies_to === 'all' ? (isRTL ? 'الكل' : 'All') : tax.applies_to}
              </p>
              <div className="flex items-center gap-2 pt-3 border-t border-slate-100 dark:border-slate-700">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => openEdit(tax)}>
                  <Edit className="w-4 h-4 ml-1" />
                  {isRTL ? 'تعديل' : 'Edit'}
                </Button>
                <button onClick={() => toggleActive(tax)} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500">
                  {tax.is_active ? <ToggleRight className="w-5 h-5 text-emerald-500" /> : <ToggleLeft className="w-5 h-5" />}
                </button>
                <button onClick={() => handleDelete(tax.id)} className="p-2 rounded-lg hover:bg-red-100 text-red-500">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {dialogOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-4">
              {editing ? (isRTL ? 'تعديل الضريبة' : 'Edit Tax') : (isRTL ? 'إضافة ضريبة جديدة' : 'Add New Tax')}
            </h2>
            <div className="space-y-4">
              <div>
                <Label>{isRTL ? 'الاسم بالعربية' : 'Arabic Name'}</Label>
                <Input value={form.name_ar} onChange={e => setForm({ ...form, name_ar: e.target.value })} dir="rtl" />
              </div>
              <div>
                <Label>{isRTL ? 'الاسم بالإنجليزية' : 'English Name'}</Label>
                <Input value={form.name_en} onChange={e => setForm({ ...form, name_en: e.target.value })} dir="ltr" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>{isRTL ? 'النسبة %' : 'Rate %'}</Label>
                  <Input type="number" value={form.rate} onChange={e => setForm({ ...form, rate: parseFloat(e.target.value) })} dir="ltr" />
                </div>
                <div>
                  <Label>{isRTL ? 'النوع' : 'Type'}</Label>
                  <Select value={form.type} onValueChange={v => setForm({ ...form, type: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="vat">{isRTL ? 'ضريبة قيمة مضافة' : 'VAT'}</SelectItem>
                      <SelectItem value="service">{isRTL ? 'رسوم خدمة' : 'Service Fee'}</SelectItem>
                      <SelectItem value="customs">{isRTL ? 'جمارك' : 'Customs'}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>{isRTL ? 'يطبق على' : 'Applies To'}</Label>
                <Select value={form.applies_to} onValueChange={v => setForm({ ...form, applies_to: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{isRTL ? 'الكل' : 'All'}</SelectItem>
                    <SelectItem value="rentals">{isRTL ? 'التأجير' : 'Rentals'}</SelectItem>
                    <SelectItem value="sales">{isRTL ? 'المبيعات' : 'Sales'}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-3">
                <input type="checkbox" id="is_active_tax" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} className="w-4 h-4 rounded" />
                <Label htmlFor="is_active_tax">{isRTL ? 'ضريبة نشطة' : 'Active tax'}</Label>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <Button variant="outline" className="flex-1" onClick={() => setDialogOpen(false)}>{isRTL ? 'إلغاء' : 'Cancel'}</Button>
              <Button className="flex-1 bg-gradient-to-r from-orange-500 to-red-600 text-white" onClick={handleSave}>{isRTL ? 'حفظ' : 'Save'}</Button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageContent />
    </Suspense>
  )
}
