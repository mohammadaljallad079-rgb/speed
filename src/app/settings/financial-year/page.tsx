"use client"
import { Suspense } from 'react'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { Calendar, CheckCircle, Plus, Trash2, Edit3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export const dynamic = 'force-dynamic'

function FinancialYearContent() {
  const { isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [years, setYears] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', start_date: '', end_date: '', is_current: false })

  useEffect(() => { setMounted(true); fetchYears() }, [])

  async function fetchYears() {
    setLoading(true)
    const { data } = await supabase.from('financial_years').select('*').order('start_date', { ascending: false })
    if (data) setYears(data)
    setLoading(false)
  }

  async function handleSave() {
    if (!form.name || !form.start_date || !form.end_date) {
      alert(isRTL ? 'املأ جميع الحقول' : 'Fill all fields')
      return
    }
    try {
      if (form.is_current) {
        await supabase.from('financial_years').update({ is_current: false }).neq('id', '00000000-0000-0000-0000-000000000000')
      }
      if (editingId) {
        await supabase.from('financial_years').update(form).eq('id', editingId)
      } else {
        await supabase.from('financial_years').insert(form)
      }
      setModalOpen(false)
      setEditingId(null)
      setForm({ name: '', start_date: '', end_date: '', is_current: false })
      await fetchYears()
    } catch (err: any) {
      alert(err.message)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(isRTL ? 'هل أنت متأكد؟' : 'Are you sure?')) return
    await supabase.from('financial_years').delete().eq('id', id)
    await fetchYears()
  }

  function openEdit(y: any) {
    setEditingId(y.id)
    setForm({ name: y.name, start_date: y.start_date, end_date: y.end_date, is_current: y.is_current })
    setModalOpen(true)
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
              {isRTL ? 'السنة المالية' : 'Financial Year'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {years.length} {isRTL ? 'سنة مالية' : 'financial years'}
            </p>
          </div>
          <Button onClick={() => { setEditingId(null); setForm({ name: '', start_date: '', end_date: '', is_current: false }); setModalOpen(true) }}
            className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white shadow-lg shadow-cyan-500/25">
            <Plus className="w-5 h-5 ml-2 mr-2" />
            {isRTL ? 'سنة جديدة' : 'New Year'}
          </Button>
        </header>

        <div className="grid gap-4">
          {years.map(y => (
            <div key={y.id} className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-cyan-50 dark:bg-cyan-900/20 text-cyan-600 dark:text-cyan-400 flex items-center justify-center">
                  <Calendar className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 dark:text-white text-lg">{y.name}</h3>
                  <p className="text-sm text-slate-500">{y.start_date} → {y.end_date}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {y.is_current && (
                  <Badge className="bg-emerald-100 text-emerald-700 flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" /> {isRTL ? 'الحالية' : 'Current'}
                  </Badge>
                )}
                <Button size="sm" variant="outline" onClick={() => openEdit(y)}>
                  <Edit3 className="w-4 h-4" />
                </Button>
                <Button size="sm" variant="outline" className="text-red-500 hover:text-red-600" onClick={() => handleDelete(y.id)}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        {years.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-64 text-slate-500">
            <Calendar className="w-16 h-16 mb-4 opacity-20" />
            <p>{isRTL ? 'لا توجد سنوات مالية' : 'No financial years'}</p>
          </div>
        )}
      </div>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-md" dir={isRTL ? 'rtl' : 'ltr'}>
          <DialogHeader>
            <DialogTitle>{editingId ? (isRTL ? 'تعديل السنة' : 'Edit Year') : (isRTL ? 'سنة مالية جديدة' : 'New Financial Year')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium mb-1 block">{isRTL ? 'الاسم' : 'Name'}</label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="2025-2026" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1 block">{isRTL ? 'من' : 'Start'}</label>
                <Input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">{isRTL ? 'إلى' : 'End'}</label>
                <Input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.is_current} onChange={e => setForm({ ...form, is_current: e.target.checked })} className="w-4 h-4" />
              <span className="text-sm">{isRTL ? 'السنة الحالية' : 'Current Year'}</span>
            </label>
            <div className="flex gap-3 justify-end pt-2">
              <Button variant="outline" onClick={() => setModalOpen(false)}>{isRTL ? 'إلغاء' : 'Cancel'}</Button>
              <Button onClick={handleSave} className="bg-cyan-500 hover:bg-cyan-600 text-white">{isRTL ? 'حفظ' : 'Save'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

export default function FinancialYearPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <FinancialYearContent />
    </Suspense>
  )
}
