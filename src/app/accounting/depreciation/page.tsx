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
import { TrendingDown, Plus, Calculator } from 'lucide-react'

type Car = { id: string; make: string; model: string; year: number; plate_number: string; purchase_price: number; purchase_date?: string | null }
type DepreciationRecord = {
  id: string
  car_id: string
  method: string
  useful_life_years: number
  salvage_value: number
  annual_rate: number
  start_date: string
  car?: Car
}

function PageContent() {
  const { isRTL } = useLanguage()
  const [records, setRecords] = useState<DepreciationRecord[]>([])
  const [cars, setCars] = useState<Car[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('auto')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState({ car_id: '', method: 'straight_line', useful_life_years: 5, salvage_value: 0, annual_rate: 20, start_date: new Date().toISOString().split('T')[0] })

  const fetchData = async () => {
    setLoading(true)
    const [recRes, carsRes] = await Promise.all([
      supabase.from('depreciation_schedules').select('*, car:cars(make,model,year,plate_number,purchase_price)').order('created_at', { ascending: false }),
      supabase.from('cars').select('id,make,model,year,plate_number,purchase_price,purchase_date').order('make'),
    ])
    setRecords(recRes.data || [])
    setCars(carsRes.data || [])
    setLoading(false)
  }

  useEffect(() => { fetchData() }, [])

  const handleSave = async () => {
    await supabase.from('depreciation_schedules').insert([form])
    setDialogOpen(false)
    setForm({ car_id: '', method: 'straight_line', useful_life_years: 5, salvage_value: 0, annual_rate: 20, start_date: new Date().toISOString().split('T')[0] })
    fetchData()
  }

  const calcAnnualDepreciation = (rec: DepreciationRecord) => {
    const car = rec.car
    if (!car || !car.purchase_price) return 0
    if (rec.method === 'straight_line') {
      return (car.purchase_price - rec.salvage_value) / rec.useful_life_years
    }
    return car.purchase_price * (rec.annual_rate / 100)
  }

  const calcAutoDepreciation = (car: Car, usefulLifeYears = 5) => {
    if (!car.purchase_price || !car.purchase_date) return null
    const purchaseDate = new Date(car.purchase_date)
    const today = new Date()
    const yearsElapsed = (today.getTime() - purchaseDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25)
    const annualDep = car.purchase_price / usefulLifeYears
    const accumulatedDep = Math.min(annualDep * yearsElapsed, car.purchase_price)
    const bookValue = Math.max(0, car.purchase_price - accumulatedDep)
    const depPercent = Math.min(100, (yearsElapsed / usefulLifeYears) * 100)
    return { annualDep, accumulatedDep, bookValue, yearsElapsed, depPercent }
  }

  const carsWithPurchaseData = cars.filter((c: Car) => c.purchase_price && c.purchase_date)

  const methods = [
    { value: 'straight_line', ar: 'القسط الثابت', en: 'Straight Line' },
    { value: 'declining_balance', ar: 'القسط المتناقص', en: 'Declining Balance' },
  ]

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-600 to-slate-800 flex items-center justify-center text-white shadow-lg">
              <TrendingDown className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
                {isRTL ? 'الإهلاك' : 'Depreciation'}
              </h1>
              <p className="text-sm text-slate-500">{isRTL ? 'جداول إهلاك الأصول' : 'Asset depreciation schedules'}</p>
            </div>
          </div>
          {activeTab === 'manual' && (
            <Button onClick={() => setDialogOpen(true)} className="bg-gradient-to-r from-slate-600 to-slate-800 text-white">
              <Plus className="w-4 h-4 ml-2" />
              {isRTL ? 'إضافة جدول إهلاك' : 'Add Schedule'}
            </Button>
          )}
        </div>

        <div className="flex gap-2 border-b border-slate-200 dark:border-slate-700">
          <button onClick={() => setActiveTab('auto')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'auto' ? 'border-slate-700 text-slate-900 dark:text-white' : 'border-transparent text-slate-500'}`}>
            {isRTL ? 'احتساب تلقائي' : 'Auto Calculate'}
          </button>
          <button onClick={() => setActiveTab('manual')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'manual' ? 'border-slate-700 text-slate-900 dark:text-white' : 'border-transparent text-slate-500'}`}>
            {isRTL ? 'جداول يدوية' : 'Manual Schedules'}
          </button>
        </div>

        {activeTab === 'auto' && (
          <div className="space-y-4">
            {carsWithPurchaseData.length === 0 ? (
              <div className="bg-white dark:bg-slate-800 rounded-2xl p-12 text-center border border-slate-200 dark:border-slate-700">
                <TrendingDown className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p className="text-slate-500">{isRTL ? 'لا توجد سيارات بمعلومات شراء كاملة' : 'No cars with complete purchase information'}</p>
              </div>
            ) : (
              <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-700/50">
                        <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'السيارة' : 'Car'}</th>
                        <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'سعر الشراء' : 'Purchase Price'}</th>
                        <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'تاريخ الشراء' : 'Purchase Date'}</th>
                        <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'الإهلاك السنوي' : 'Annual Dep.'}</th>
                        <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'الإهلاك المتراكم' : 'Accumulated'}</th>
                        <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'القيمة الدفترية' : 'Book Value'}</th>
                        <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'نسبة الإهلاك' : 'Dep. %'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {carsWithPurchaseData.map((car: Car) => {
                        const dep = calcAutoDepreciation(car)
                        if (!dep) return null
                        return (
                          <tr key={car.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                            <td className="py-3 px-4">
                              <p className="font-medium text-slate-900 dark:text-white">{car.make} {car.model} {car.year}</p>
                              <p className="text-xs text-slate-500">{car.plate_number}</p>
                            </td>
                            <td className="py-3 px-4 text-sm font-medium">{car.purchase_price?.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}</td>
                            <td className="py-3 px-4 text-sm text-slate-600 dark:text-slate-300">{car.purchase_date}</td>
                            <td className="py-3 px-4 text-sm font-medium text-amber-600">{dep.annualDep.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}</td>
                            <td className="py-3 px-4 text-sm font-medium text-red-600">{dep.accumulatedDep.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}</td>
                            <td className="py-3 px-4 text-sm font-bold text-emerald-600">{dep.bookValue.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}</td>
                            <td className="py-3 px-4">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 bg-slate-100 dark:bg-slate-700 rounded-full h-2">
                                  <div className="bg-red-500 h-2 rounded-full" style={{width: `${dep.depPercent}%`}} />
                                </div>
                                <span className="text-xs font-bold text-slate-600">{dep.depPercent.toFixed(0)}%</span>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'manual' && (

        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <div className="animate-spin w-8 h-8 border-4 border-slate-600 border-t-transparent rounded-full" />
            </div>
          ) : records.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-400">
              <TrendingDown className="w-12 h-12 mb-3 opacity-30" />
              <p>{isRTL ? 'لا توجد جداول إهلاك بعد' : 'No depreciation schedules yet'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-700/50">
                    <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'السيارة' : 'Car'}</th>
                    <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'سعر الشراء' : 'Purchase Price'}</th>
                    <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'الطريقة' : 'Method'}</th>
                    <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'العمر الافتراضي' : 'Useful Life'}</th>
                    <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'الإهلاك السنوي' : 'Annual Depreciation'}</th>
                    <th className="text-start py-3 px-4 text-xs font-semibold text-slate-500 uppercase">{isRTL ? 'تاريخ البداية' : 'Start Date'}</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((rec) => (
                    <tr key={rec.id} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="py-3 px-4">
                        <p className="font-medium text-slate-900 dark:text-white">{rec.car?.make} {rec.car?.model} {rec.car?.year}</p>
                        <p className="text-xs text-slate-500">{rec.car?.plate_number}</p>
                      </td>
                      <td className="py-3 px-4 text-sm text-slate-700 dark:text-slate-300">
                        {rec.car?.purchase_price?.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-xs px-2 py-1 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                          {isRTL ? methods.find(m => m.value === rec.method)?.ar : methods.find(m => m.value === rec.method)?.en}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-sm text-slate-700 dark:text-slate-300">
                        {rec.useful_life_years} {isRTL ? 'سنة' : 'years'}
                      </td>
                      <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                        <div className="flex items-center gap-1">
                          <Calculator className="w-4 h-4 text-slate-400" />
                          {calcAnnualDepreciation(rec).toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-sm text-slate-600 dark:text-slate-300">{rec.start_date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}
      </div>

      {dialogOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-4">
              {isRTL ? 'إضافة جدول إهلاك' : 'Add Depreciation Schedule'}
            </h2>
            <div className="space-y-4">
              <div>
                <Label>{isRTL ? 'السيارة' : 'Car'}</Label>
                <Select value={form.car_id || 'none'} onValueChange={v => setForm({ ...form, car_id: v === 'none' ? '' : v })}>
                  <SelectTrigger><SelectValue placeholder={isRTL ? 'اختر سيارة' : 'Select car'} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">—</SelectItem>
                    {cars.map((c: Car) => (
                      <SelectItem key={c.id} value={c.id}>{c.make} {c.model} {c.year} — {c.plate_number}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{isRTL ? 'طريقة الإهلاك' : 'Depreciation Method'}</Label>
                <Select value={form.method} onValueChange={v => setForm({ ...form, method: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {methods.map(m => (
                      <SelectItem key={m.value} value={m.value}>{isRTL ? m.ar : m.en}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>{isRTL ? 'العمر الافتراضي (سنة)' : 'Useful Life (years)'}</Label>
                  <Input type="number" value={form.useful_life_years} onChange={e => setForm({ ...form, useful_life_years: parseInt(e.target.value) })} dir="ltr" />
                </div>
                <div>
                  <Label>{isRTL ? 'القيمة المتبقية' : 'Salvage Value'}</Label>
                  <Input type="number" value={form.salvage_value} onChange={e => setForm({ ...form, salvage_value: parseFloat(e.target.value) })} dir="ltr" />
                </div>
              </div>
              {form.method === 'declining_balance' && (
                <div>
                  <Label>{isRTL ? 'نسبة الإهلاك السنوية %' : 'Annual Rate %'}</Label>
                  <Input type="number" value={form.annual_rate} onChange={e => setForm({ ...form, annual_rate: parseFloat(e.target.value) })} dir="ltr" />
                </div>
              )}
              <div>
                <Label>{isRTL ? 'تاريخ البداية' : 'Start Date'}</Label>
                <Input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} dir="ltr" />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <Button variant="outline" className="flex-1" onClick={() => setDialogOpen(false)}>{isRTL ? 'إلغاء' : 'Cancel'}</Button>
              <Button className="flex-1 bg-gradient-to-r from-slate-600 to-slate-800 text-white" onClick={handleSave}>{isRTL ? 'حفظ' : 'Save'}</Button>
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
