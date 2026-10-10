"use client"
import { Suspense } from 'react'
import { } from 'react'
export const dynamic = "force-dynamic"

import { useState, useEffect } from 'react'
import { supabase, Maintenance, Car } from '@/lib/supabase'
import {
  Wrench,
  Plus,
  Search,
  CheckCircle2,
  Clock,
  Car as CarIcon,
  Droplets,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatCurrency, formatDate } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'

function MaintenancePageContent() {
  const { lang, t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [activeTab, setActiveTab] = useState('maintenance')
  const [maintenanceList, setMaintenanceList] = useState<Maintenance[]>([])
  const [oilRecords, setOilRecords] = useState<any[]>([])
  const [cars, setCars] = useState<Car[]>([])
  const [loading, setLoading] = useState(true)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [oilDialogOpen, setOilDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formData, setFormData] = useState({
    car_id: '', service_type: '', service_date: '', next_service_date: '', cost: '', status: 'scheduled', vendor: '', notes: ''
  })
  const [oilForm, setOilForm] = useState({
    car_id: '', change_date: '', mileage_at_change: '', next_change_km: '', oil_type: '', notes: ''
  })

  useEffect(() => {
    setMounted(true)
    fetchMaintenance()
    fetchCars()
    fetchOilRecords()
  }, [])

  async function fetchCars() {
    const { data } = await supabase.from('cars').select('*').order('plate_number')
    setCars(data || [])
  }

  async function fetchMaintenance() {
    const { data } = await supabase.from('maintenance').select('*, car:cars(*)').order('service_date', { ascending: false })
    if (data) setMaintenanceList(data as unknown as Maintenance[])
    setLoading(false)
  }

  async function fetchOilRecords() {
    const { data } = await supabase.from('oil_service_records').select('*, car:cars(make,model,plate_number,mileage)').order('change_date', { ascending: false })
    setOilRecords(data || [])
  }

  const filteredMaintenance = maintenanceList.filter(m =>
    (m.car?.plate_number || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    m.service_type.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (m.vendor || '').toLowerCase().includes(searchTerm.toLowerCase())
  )

  async function handleCreateMaintenance() {
    const payload = {
      car_id: formData.car_id,
      service_type: formData.service_type.trim(),
      service_date: formData.service_date || new Date().toISOString().slice(0, 10),
      next_service_date: formData.next_service_date || null,
      cost: Number(formData.cost) || 0,
      status: formData.status || 'scheduled',
      vendor: formData.vendor.trim() || null,
      notes: formData.notes.trim() || null,
    }
    if (!payload.car_id || !payload.service_type) {
      alert(isRTL ? 'الرجاء تعبئة الحقول المطلوبة' : 'Please fill required fields')
      return
    }
    setSaving(true)
    const { error } = await supabase.from('maintenance').insert([payload])
    if (!error) {
      setDialogOpen(false)
      setFormData({ car_id: '', service_type: '', service_date: '', next_service_date: '', cost: '', status: 'scheduled', vendor: '', notes: '' })
      fetchMaintenance()
    }
    setSaving(false)
  }

  async function handleCreateOilRecord() {
    if (!oilForm.car_id || !oilForm.change_date || !oilForm.mileage_at_change) {
      alert(isRTL ? 'يرجى تعبئة الحقول المطلوبة' : 'Please fill required fields')
      return
    }
    setSaving(true)
    const { error } = await supabase.from('oil_service_records').insert([{
      car_id: oilForm.car_id,
      change_date: oilForm.change_date,
      mileage_at_change: parseInt(oilForm.mileage_at_change),
      next_change_km: oilForm.next_change_km ? parseInt(oilForm.next_change_km) : 5000,
      oil_type: oilForm.oil_type || null,
      notes: oilForm.notes || null,
    }])
    if (!error) {
      setOilDialogOpen(false)
      setOilForm({ car_id: '', change_date: '', mileage_at_change: '', next_change_km: '', oil_type: '', notes: '' })
      fetchOilRecords()
    }
    setSaving(false)
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6 overflow-x-hidden">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">{t.maintenance}</h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">{isRTL ? 'إدارة سجلات الصيانة والمصروفات' : 'Manage maintenance records and expenses'}</p>
          </div>
          {activeTab === 'maintenance' ? (
            <Button onClick={() => setDialogOpen(true)} className="bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl px-6">
              <Plus className="w-5 h-5 mr-2" />
              {isRTL ? 'إضافة سجل صيانة' : 'Add Maintenance'}
            </Button>
          ) : (
            <Button onClick={() => setOilDialogOpen(true)} className="bg-amber-600 hover:bg-amber-700 text-white rounded-xl px-6">
              <Plus className="w-5 h-5 mr-2" />
              {isRTL ? 'إضافة سجل زيت' : 'Add Oil Record'}
            </Button>
          )}
        </header>

        <div className="flex gap-2 border-b border-slate-200 dark:border-slate-700">
          <button onClick={() => setActiveTab('maintenance')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'maintenance' ? 'border-cyan-500 text-cyan-600' : 'border-transparent text-slate-500'}`}>
            {isRTL ? 'الصيانة العامة' : 'General Maintenance'}
          </button>
          <button onClick={() => setActiveTab('oil')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'oil' ? 'border-amber-500 text-amber-600' : 'border-transparent text-slate-500'}`}>
            {isRTL ? 'سجل تغيير الزيت' : 'Oil Service Records'}
          </button>
        </div>

        {activeTab === 'maintenance' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center"><Clock className="w-6 h-6" /></div>
                  <div><p className="text-sm text-slate-500">{isRTL ? 'مجدولة' : 'Scheduled'}</p><p className="text-2xl font-bold">{maintenanceList.filter((m: any) => m.status === 'scheduled').length}</p></div>
                </div>
              </div>
              <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center"><Wrench className="w-6 h-6" /></div>
                  <div><p className="text-sm text-slate-500">{isRTL ? 'قيد التنفيذ' : 'In Progress'}</p><p className="text-2xl font-bold">{maintenanceList.filter((m: any) => m.status === 'in_progress').length}</p></div>
                </div>
              </div>
              <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center"><CheckCircle2 className="w-6 h-6" /></div>
                  <div><p className="text-sm text-slate-500">{isRTL ? 'مكتملة' : 'Completed'}</p><p className="text-2xl font-bold">{maintenanceList.filter((m: any) => m.status === 'completed').length}</p></div>
                </div>
              </div>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
              <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className={`absolute top-1/2 ${isRTL ? 'right-4' : 'left-4'} -translate-y-1/2 w-5 h-5 text-slate-400`} />
                <Input placeholder={isRTL ? 'ابحث...' : 'Search...'} className={`${isRTL ? 'pr-12' : 'pl-12'} h-12 rounded-xl`} value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setSearchTerm(searchDraft) }} />
              </div>
              <Button onClick={() => setSearchTerm(searchDraft)} className="bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl h-12 px-5 shrink-0">
                <Search className="w-4 h-4 mr-2" />{isRTL ? 'بحث' : 'Search'}
              </Button>
            </div>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px]">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 text-sm border-b border-slate-200 dark:border-slate-700">
                      <th className="px-6 py-4 font-bold text-start">{t.cars}</th>
                      <th className="px-6 py-4 font-bold text-start">{isRTL ? 'نوع الصيانة' : 'Type'}</th>
                      <th className="px-6 py-4 font-bold text-start">{t.date}</th>
                      <th className="px-6 py-4 font-bold text-start">{t.amount}</th>
                      <th className="px-6 py-4 font-bold text-start">{t.status}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                    {loading ? (
                      <tr><td colSpan={5} className="p-8 text-center">{t.loading}</td></tr>
                    ) : filteredMaintenance.length === 0 ? (
                      <tr><td colSpan={5} className="px-6 py-12 text-center text-slate-500"><Wrench className="w-12 h-12 mx-auto mb-3 opacity-20" />{t.noData}</td></tr>
                    ) : filteredMaintenance.map((m) => (
                      <tr key={m.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center"><CarIcon className="w-5 h-5 text-slate-500" /></div>
                            <div><p className="font-bold text-slate-900 dark:text-white">{m.car?.plate_number}</p><p className="text-xs text-slate-500">{m.car?.make} {m.car?.model}</p></div>
                          </div>
                        </td>
                        <td className="px-6 py-4"><p className="font-medium">{m.service_type}</p><p className="text-xs text-slate-500">{m.vendor}</p></td>
                        <td className="px-6 py-4 text-sm text-slate-600 dark:text-slate-400">{formatDate(m.service_date, lang === 'ar' ? 'ar-SA' : 'en-US')}</td>
                        <td className="px-6 py-4 font-bold text-rose-600 dark:text-rose-400">{formatCurrency(m.cost)}</td>
                        <td className="px-6 py-4">
                          <Badge className={(m.status as any) === 'completed' ? 'bg-emerald-100 text-emerald-800' : (m.status as any) === 'in_progress' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}>{m.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'oil' && (
          <div className="space-y-4">
            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 text-sm border-b border-slate-200 dark:border-slate-700">
                      <th className="px-6 py-4 font-bold text-start">{isRTL ? 'السيارة' : 'Car'}</th>
                      <th className="px-6 py-4 font-bold text-start">{isRTL ? 'تاريخ التغيير' : 'Change Date'}</th>
                      <th className="px-6 py-4 font-bold text-start">{isRTL ? 'الكيلومترات عند التغيير' : 'KM at Change'}</th>
                      <th className="px-6 py-4 font-bold text-start">{isRTL ? 'الكيلومترات الحالية' : 'Current KM'}</th>
                      <th className="px-6 py-4 font-bold text-start">{isRTL ? 'الحالة' : 'Status'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                    {oilRecords.length === 0 ? (
                      <tr><td colSpan={5} className="px-6 py-12 text-center text-slate-500"><Droplets className="w-12 h-12 mx-auto mb-3 opacity-20" />{isRTL ? 'لا توجد سجلات زيت بعد' : 'No oil records yet'}</td></tr>
                    ) : oilRecords.map((rec) => {
                      const currentKm = rec.car?.mileage || 0
                      const kmDone = currentKm - rec.mileage_at_change
                      const nextChangeKm = rec.next_change_km || 5000
                      const kmLeft = nextChangeKm - kmDone
                      const isOverdue = kmLeft < 0
                      const isWarning = kmLeft >= 0 && kmLeft < 500
                      return (
                        <tr key={rec.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/30">
                          <td className="px-6 py-4"><p className="font-bold">{rec.car?.plate_number}</p><p className="text-xs text-slate-500">{rec.car?.make} {rec.car?.model}</p></td>
                          <td className="px-6 py-4 text-sm">{rec.change_date}</td>
                          <td className="px-6 py-4 text-sm font-mono">{rec.mileage_at_change?.toLocaleString()} km</td>
                          <td className="px-6 py-4 text-sm font-mono">{currentKm?.toLocaleString()} km</td>
                          <td className="px-6 py-4">
                            <span className={`text-xs px-2 py-1 rounded-full font-bold ${isOverdue ? 'bg-red-100 text-red-700' : isWarning ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                              {isOverdue ? (isRTL ? `متأخر ${Math.abs(kmLeft)} كم` : `${Math.abs(kmLeft)} km overdue`) : (isRTL ? `${kmLeft} كم متبقي` : `${kmLeft} km left`)}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader><DialogTitle>{isRTL ? 'إضافة سجل صيانة' : 'Add Maintenance Record'}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>{isRTL ? 'السيارة' : 'Car'}</Label><Select value={formData.car_id} onValueChange={(v) => setFormData({...formData, car_id: v})}><SelectTrigger><SelectValue placeholder={isRTL ? 'اختر سيارة' : 'Select car'} /></SelectTrigger><SelectContent>{cars.map((car) => <SelectItem key={car.id} value={car.id}>{car.plate_number} - {car.make} {car.model}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>{isRTL ? 'نوع الصيانة' : 'Type'}</Label><Input value={formData.service_type} onChange={(e) => setFormData({...formData, service_type: e.target.value})} /></div>
            <div><Label>{isRTL ? 'تاريخ الخدمة' : 'Service Date'}</Label><Input type="date" value={formData.service_date} onChange={(e) => setFormData({...formData, service_date: e.target.value})} /></div>
            <div><Label>{isRTL ? 'موعد الخدمة القادم' : 'Next Service Date'}</Label><Input type="date" value={formData.next_service_date} onChange={(e) => setFormData({...formData, next_service_date: e.target.value})} /></div>
            <div><Label>{isRTL ? 'التكلفة' : 'Cost'}</Label><Input type="number" value={formData.cost} onChange={(e) => setFormData({...formData, cost: e.target.value})} /></div>
            <div><Label>{t.status}</Label><Select value={formData.status} onValueChange={(v) => setFormData({...formData, status: v})}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="scheduled">{isRTL ? 'مجدولة' : 'Scheduled'}</SelectItem><SelectItem value="in_progress">{isRTL ? 'قيد التنفيذ' : 'In Progress'}</SelectItem><SelectItem value="completed">{isRTL ? 'مكتملة' : 'Completed'}</SelectItem></SelectContent></Select></div>
            <div><Label>{isRTL ? 'المزوّد' : 'Vendor'}</Label><Input value={formData.vendor} onChange={(e) => setFormData({...formData, vendor: e.target.value})} /></div>
            <div><Label>{t.notes}</Label><Input value={formData.notes} onChange={(e) => setFormData({...formData, notes: e.target.value})} /></div>
          </div>
          <Button disabled={saving} onClick={handleCreateMaintenance} className="mt-2">{isRTL ? 'حفظ' : 'Save'}</Button>
        </DialogContent>
      </Dialog>

      <Dialog open={oilDialogOpen} onOpenChange={setOilDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{isRTL ? 'إضافة سجل تغيير زيت' : 'Add Oil Change Record'}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><Label>{isRTL ? 'السيارة' : 'Car'}</Label><Select value={oilForm.car_id} onValueChange={v => setOilForm({...oilForm, car_id: v})}><SelectTrigger><SelectValue placeholder={isRTL ? 'اختر سيارة' : 'Select car'} /></SelectTrigger><SelectContent>{cars.map(c => <SelectItem key={c.id} value={c.id}>{c.plate_number} — {c.make} {c.model}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>{isRTL ? 'تاريخ التغيير' : 'Change Date'}</Label><Input type="date" value={oilForm.change_date} onChange={e => setOilForm({...oilForm, change_date: e.target.value})} /></div>
            <div><Label>{isRTL ? 'الكيلومترات عند التغيير' : 'Mileage at Change (km)'}</Label><Input type="number" value={oilForm.mileage_at_change} onChange={e => setOilForm({...oilForm, mileage_at_change: e.target.value})} /></div>
            <div><Label>{isRTL ? 'الكيلومترات للتغيير القادم' : 'KM until Next Change'}</Label><Input type="number" placeholder="5000" value={oilForm.next_change_km} onChange={e => setOilForm({...oilForm, next_change_km: e.target.value})} /></div>
            <div><Label>{isRTL ? 'نوع الزيت' : 'Oil Type'}</Label><Input value={oilForm.oil_type} onChange={e => setOilForm({...oilForm, oil_type: e.target.value})} placeholder="5W-30" /></div>
            <div><Label>{t.notes}</Label><Input value={oilForm.notes} onChange={e => setOilForm({...oilForm, notes: e.target.value})} /></div>
          </div>
          <Button disabled={saving} onClick={handleCreateOilRecord} className="mt-2 bg-amber-600 hover:bg-amber-700 text-white">{isRTL ? 'حفظ' : 'Save'}</Button>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

export default function MaintenancePage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <MaintenancePageContent />
    </Suspense>
  )
}
