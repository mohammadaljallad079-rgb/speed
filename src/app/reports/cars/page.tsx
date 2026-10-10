"use client"
import { Suspense } from 'react'
import { } from 'react'
export const dynamic = "force-dynamic"

import { useState, useEffect, useMemo } from 'react'
import { supabase, Car, RentalContract, Maintenance, Sale } from '@/lib/supabase'
import { formatCurrency, formatNumber } from '@/lib/utils'
import { 
  BarChart3,
  Car as CarIcon, 
  TrendingUp, 
  TrendingDown, 
  DollarSign,
  FileText,
  Wrench,
  Search,
  Printer,
  Calendar,
  User,
  Hash,
  ArrowRightLeft
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie
} from 'recharts'

function CarReportsPageContent() {
  const { lang, t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [cars, setCars] = useState<Car[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCarId, setSelectedCarId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [reportData, setReportData] = useState<{
    car: Car | null,
    rentals: any[],
    sales: Sale[],
    maintenance: Maintenance[],
    totalRevenue: number,
    totalExpenses: number,
    netProfit: number,
    utilizationRate: number
  }>({
    car: null,
    rentals: [],
    sales: [],
    maintenance: [],
    totalRevenue: 0,
    totalExpenses: 0,
    netProfit: 0,
    utilizationRate: 0
  })

  useEffect(() => {
    setMounted(true)
    fetchCars()
  }, [])

  async function fetchCars() {
    try {
      const { data } = await supabase.from('cars').select('*').order('plate_number')
      if (data) setCars(data)
    } catch (error) {
      console.error('Error fetching cars:', error)
    }
    setLoading(false)
  }

  const filteredCars = useMemo(() => {
    if (!searchQuery) return []
    return cars.filter(car => 
      car.plate_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      car.make.toLowerCase().includes(searchQuery.toLowerCase()) ||
      car.model.toLowerCase().includes(searchQuery.toLowerCase())
    ).slice(0, 5)
  }, [cars, searchQuery])

  async function fetchReport(carId: string) {
    if (!carId) return
    setLoading(true)
    try {
      const [carRes, rentalsRes, salesRes, maintenanceRes] = await Promise.all([
        supabase.from('cars').select('*').eq('id', carId).maybeSingle(),
        supabase.from('rental_contracts').select('*, customers(full_name)').eq('car_id', carId).order('start_date', { ascending: false }),
        supabase.from('sales').select('*').eq('car_id', carId).order('sale_date', { ascending: false }),
        supabase.from('maintenance').select('*').eq('car_id', carId).order('service_date', { ascending: false })
      ])

      const car = carRes.data as Car | null
      const rentals = (rentalsRes.data || []) as any[]
      const sales = (salesRes.data || []) as Sale[]
      const maintenance = (maintenanceRes.data || []) as Maintenance[]
      
      const totalRevenue = rentals.reduce((sum, r) => sum + (r.paid_amount || 0), 0) + 
                           sales.reduce((sum, s) => sum + (s.paid_amount || 0), 0)
      
      const totalExpenses = maintenance.reduce((sum, m) => sum + (m.cost || 0), 0) + 
                            (car?.purchase_price || 0)

      // Calculate utilization (simple version: days rented / total days since first rental)
      let utilizationRate = 0
      if (rentals.length > 0) {
        const totalRentalDays = rentals.reduce((sum, r) => sum + (r.total_days || 0), 0)
        const firstRentalDate = new Date(rentals[rentals.length - 1].start_date)
        const totalDaysActive = Math.ceil((new Date().getTime() - firstRentalDate.getTime()) / (1000 * 60 * 60 * 24))
        utilizationRate = Math.min(100, Math.round((totalRentalDays / (totalDaysActive || 1)) * 100))
      }

      setReportData({
        car,
        rentals,
        sales,
        maintenance,
        totalRevenue,
        totalExpenses,
        netProfit: totalRevenue - totalExpenses,
        utilizationRate
      })
    } catch (error) {
      console.error('Error fetching report:', error)
    }
    setLoading(false)
  }

  useEffect(() => {
    if (selectedCarId) {
      fetchReport(selectedCarId)
      setSearchQuery('')
    }
  }, [selectedCarId])

  const chartData = [
    { name: isRTL ? 'الإيرادات' : 'Revenue', value: reportData.totalRevenue, color: '#10b981' },
    { name: isRTL ? 'المصروفات' : 'Expenses', value: reportData.totalExpenses, color: '#f43f5e' }
  ]

  const COLORS = ['#10b981', '#f43f5e']

  const handlePrint = () => {
    window.print()
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6 print:m-0 print:p-0">
        <header className="flex items-center justify-between no-print">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
              <BarChart3 className="w-8 h-8 text-cyan-500" />
              {isRTL ? 'كشف تفصيلي للمركبة' : 'Detailed Vehicle Statement'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">{isRTL ? 'تقرير مالي وتاريخي متكامل' : 'Integrated financial and historical report'}</p>
          </div>
          <div className="flex gap-2">
            {reportData.car && (
              <Button onClick={handlePrint} variant="outline" className="flex items-center gap-2">
                <Printer className="w-4 h-4" />
                {isRTL ? 'طباعة الكشف' : 'Print Statement'}
              </Button>
            )}
          </div>
        </header>

        {/* Search & Select Box */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700 no-print">
          <div className="max-w-4xl mx-auto flex flex-col md:flex-row gap-4">
            <div className="flex-1">
              <Select onValueChange={(value) => setSelectedCarId(value)} value={selectedCarId}>
                <SelectTrigger className="h-14 text-lg rounded-xl border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-cyan-500 w-full">
                  <SelectValue placeholder={isRTL ? 'اختر السيارة برقم اللوحة...' : 'Select vehicle by plate...'} />
                </SelectTrigger>
                <SelectContent>
                  {cars.map(car => (
                    <SelectItem key={car.id} value={car.id}>
                      {car.plate_number} - {car.make} {car.model} ({car.year})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <Input 
                placeholder={isRTL ? 'أو ابحث هنا...' : 'Or search here...'} 
                className={`pl-10 h-14 text-lg rounded-xl border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-cyan-500 transition-all ${isRTL ? 'text-right pr-4' : ''}`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {filteredCars.length > 0 && (
                <div className="absolute z-50 w-full mt-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl overflow-hidden">
                  {filteredCars.map(car => (
                    <button
                      key={car.id}
                      onClick={() => setSelectedCarId(car.id)}
                      className="w-full flex items-center justify-between p-4 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors border-b last:border-0 border-slate-100 dark:border-slate-700"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-lg bg-cyan-100 dark:bg-cyan-900/30 flex items-center justify-center">
                          <CarIcon className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
                        </div>
                        <div className="text-left">
                          <p className="font-bold text-slate-900 dark:text-white">{car.plate_number}</p>
                          <p className="text-sm text-slate-500">{car.make} {car.model} ({car.year})</p>
                        </div>
                      </div>
                      <Badge variant="outline">{car.status}</Badge>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {selectedCarId && (
          loading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
              <div className="animate-spin w-12 h-12 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
              <p className="text-slate-500 font-medium animate-pulse">{isRTL ? 'جاري استدعاء البيانات...' : 'Fetching data...'}</p>
            </div>
          ) : reportData.car && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {/* Car Identity Section */}
              <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-3xl p-8 text-white shadow-xl relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl -mr-32 -mt-32"></div>
                <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div className="flex items-center gap-6">
                    <div className="w-20 h-20 rounded-2xl bg-white/10 backdrop-blur-md flex items-center justify-center border border-white/20">
                      <CarIcon className="w-10 h-10 text-cyan-400" />
                    </div>
                    <div>
                      <h2 className="text-4xl font-black tracking-tight">{reportData.car.plate_number}</h2>
                      <p className="text-slate-400 text-lg mt-1 font-medium">{reportData.car.make} {reportData.car.model} • {reportData.car.year}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-4">
                    <div className="bg-white/5 backdrop-blur-md px-6 py-3 rounded-2xl border border-white/10">
                      <p className="text-slate-400 text-xs uppercase tracking-wider mb-1 font-bold">{isRTL ? 'الحالة الحالية' : 'Current Status'}</p>
                      <Badge className="bg-cyan-500 hover:bg-cyan-600 border-none text-white px-3">{reportData.car.status}</Badge>
                    </div>
                    <div className="bg-white/5 backdrop-blur-md px-6 py-3 rounded-2xl border border-white/10">
                      <p className="text-slate-400 text-xs uppercase tracking-wider mb-1 font-bold">{isRTL ? 'سعر الشراء' : 'Purchase Price'}</p>
                      <p className="text-xl font-bold">{formatCurrency(reportData.car.purchase_price || 0)}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Financial Dashboard */}
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                <div className="lg:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="bg-emerald-50 dark:bg-emerald-900/10 p-6 rounded-3xl border border-emerald-100 dark:border-emerald-800/50 shadow-sm transition-all hover:shadow-md">
                    <div className="flex items-center justify-between mb-4">
                      <div className="w-10 h-10 rounded-xl bg-emerald-500 text-white flex items-center justify-center shadow-lg shadow-emerald-500/20">
                        <TrendingUp className="w-5 h-5" />
                      </div>
                      <span className="text-emerald-600 dark:text-emerald-400 font-bold text-sm uppercase">{t.revenue}</span>
                    </div>
                    <p className="text-3xl font-black text-slate-900 dark:text-white">{formatCurrency(reportData.totalRevenue)}</p>
                    <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
                      <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-200">{reportData.rentals.length} {isRTL ? 'عقد' : 'Contracts'}</Badge>
                    </div>
                  </div>

                  <div className="bg-rose-50 dark:bg-rose-900/10 p-6 rounded-3xl border border-rose-100 dark:border-rose-800/50 shadow-sm transition-all hover:shadow-md">
                    <div className="flex items-center justify-between mb-4">
                      <div className="w-10 h-10 rounded-xl bg-rose-500 text-white flex items-center justify-center shadow-lg shadow-rose-500/20">
                        <TrendingDown className="w-5 h-5" />
                      </div>
                      <span className="text-rose-600 dark:text-rose-400 font-bold text-sm uppercase">{t.expenses}</span>
                    </div>
                    <p className="text-3xl font-black text-slate-900 dark:text-white">{formatCurrency(reportData.totalExpenses)}</p>
                    <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
                      <Badge variant="outline" className="bg-rose-500/10 text-rose-600 border-rose-200">{reportData.maintenance.length} {isRTL ? 'عملية صيانة' : 'Services'}</Badge>
                    </div>
                  </div>

                  <div className={`${reportData.netProfit >= 0 ? 'bg-cyan-50 dark:bg-cyan-900/10 border-cyan-100 dark:border-cyan-800/50' : 'bg-amber-50 dark:bg-amber-900/10 border-amber-100 dark:border-amber-800/50'} p-6 rounded-3xl border shadow-sm transition-all hover:shadow-md`}>
                    <div className="flex items-center justify-between mb-4">
                      <div className={`w-10 h-10 rounded-xl ${reportData.netProfit >= 0 ? 'bg-cyan-500 shadow-cyan-500/20' : 'bg-amber-500 shadow-amber-500/20'} text-white flex items-center justify-center shadow-lg`}>
                        <DollarSign className="w-5 h-5" />
                      </div>
                      <span className={`${reportData.netProfit >= 0 ? 'text-cyan-600 dark:text-cyan-400' : 'text-amber-600 dark:text-amber-400'} font-bold text-sm uppercase`}>{t.profit} / {isRTL ? 'الخسارة' : 'Loss'}</span>
                    </div>
                    <p className="text-3xl font-black text-slate-900 dark:text-white">{formatCurrency(reportData.netProfit)}</p>
                    <div className="mt-4 flex items-center gap-2">
                       <div className="w-full bg-slate-200 dark:bg-slate-700 h-1.5 rounded-full overflow-hidden">
                          <div 
                            className={`h-full rounded-full ${reportData.netProfit >= 0 ? 'bg-cyan-500' : 'bg-amber-500'}`} 
                            style={{ width: `${Math.min(100, (reportData.totalRevenue / (reportData.totalExpenses || 1)) * 100)}%` }}
                          ></div>
                       </div>
                    </div>
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col items-center justify-center">
                  <p className="text-slate-500 text-sm font-bold uppercase mb-4">{isRTL ? 'نسبة الاستخدام' : 'Utilization'}</p>
                  <div className="relative w-32 h-32">
                    <svg className="w-full h-full" viewBox="0 0 36 36">
                      <path className="text-slate-100 dark:text-slate-700 stroke-current" strokeWidth="3" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                      <path className="text-cyan-500 stroke-current" strokeWidth="3" strokeDasharray={`${reportData.utilizationRate}, 100`} strokeLinecap="round" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center flex-col">
                      <span className="text-2xl font-black text-slate-900 dark:text-white">{reportData.utilizationRate}%</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid lg:grid-cols-2 gap-6">
                {/* Visual Analysis */}
                <div className="bg-white dark:bg-slate-800 rounded-3xl p-8 shadow-sm border border-slate-200 dark:border-slate-700 h-[400px]">
                  <h3 className="font-bold text-xl text-slate-900 dark:text-white mb-6 flex items-center gap-2">
                    <TrendingUp className="w-6 h-6 text-cyan-500" />
                    {isRTL ? 'التحليل المالي البصري' : 'Financial Visual Analysis'}
                  </h3>
                  <ResponsiveContainer width="100%" height="80%">
                    <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontWeight: 'bold' }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b' }} />
                      <Tooltip 
                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}
                        formatter={(value: number) => formatCurrency(value)}
                      />
                      <Bar dataKey="value" radius={[10, 10, 0, 0]} barSize={60}>
                        {chartData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Info Card */}
                <div className="bg-white dark:bg-slate-800 rounded-3xl p-8 shadow-sm border border-slate-200 dark:border-slate-700">
                  <h3 className="font-bold text-xl text-slate-900 dark:text-white mb-6 flex items-center gap-2">
                    <FileText className="w-6 h-6 text-violet-500" />
                    {isRTL ? 'المواصفات الفنية' : 'Technical Specifications'}
                  </h3>
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-1">
                      <p className="text-slate-400 text-sm">{isRTL ? 'الشركة والموديل' : 'Make & Model'}</p>
                      <p className="font-bold text-slate-900 dark:text-white">{reportData.car.make} {reportData.car.model}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-slate-400 text-sm">{isRTL ? 'رقم اللوحة' : 'Plate Number'}</p>
                      <p className="font-bold text-slate-900 dark:text-white font-mono">{reportData.car.plate_number}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-slate-400 text-sm">{isRTL ? 'سنة الصنع' : 'Year'}</p>
                      <p className="font-bold text-slate-900 dark:text-white">{reportData.car.year}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-slate-400 text-sm">{isRTL ? 'اللون' : 'Color'}</p>
                      <p className="font-bold text-slate-900 dark:text-white">{reportData.car.color}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-slate-400 text-sm">{isRTL ? 'ناقل الحركة' : 'Transmission'}</p>
                      <p className="font-bold text-slate-900 dark:text-white">{reportData.car.transmission}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-slate-400 text-sm">{isRTL ? 'نوع الوقود' : 'Fuel Type'}</p>
                      <p className="font-bold text-slate-900 dark:text-white">{reportData.car.fuel_type}</p>
                    </div>
                    <div className="space-y-1">
                        <p className="text-slate-400 text-sm">{t.mileage}</p>
                      <p className="font-bold text-slate-900 dark:text-white">{formatNumber(reportData.car.mileage)} {t.km}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-slate-400 text-sm">{isRTL ? 'رقم الشاصي (VIN)' : 'VIN Number'}</p>
                      <p className="font-bold text-slate-900 dark:text-white text-xs">{reportData.car.vin || '-'}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Lists Sections */}
              <div className="grid lg:grid-cols-2 gap-6">
                {/* Rentals Section */}
                <div className="bg-white dark:bg-slate-800 rounded-3xl p-8 shadow-sm border border-slate-200 dark:border-slate-700">
                  <div className="flex items-center justify-between mb-8">
                    <h3 className="font-black text-2xl flex items-center gap-3">
                      <ArrowRightLeft className="w-7 h-7 text-cyan-500" />
                      {isRTL ? 'سجل التأجير' : 'Rental History'}
                    </h3>
                    <Badge className="bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100 px-4 py-1 rounded-full text-sm font-bold">{reportData.rentals.length}</Badge>
                  </div>
                  <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                    {reportData.rentals.length === 0 ? (
                      <div className="text-center py-20 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                        <FileText className="w-16 h-16 text-slate-300 dark:text-slate-700 mx-auto mb-4" />
                        <p className="text-slate-500 text-lg">{isRTL ? 'لا توجد عمليات تأجير مسجلة' : 'No rental history found'}</p>
                      </div>
                    ) : reportData.rentals.map((rental, idx) => (
                      <div key={rental.id} className="group p-5 rounded-2xl bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 hover:border-cyan-500 transition-all duration-300">
                        <div className="flex justify-between items-start mb-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-cyan-500 text-white flex items-center justify-center font-bold">
                              {(idx + 1).toString().padStart(2, '0')}
                            </div>
                            <div>
                              <p className="font-black text-slate-900 dark:text-white text-lg">{rental.contract_number}</p>
                              <div className="flex items-center gap-2 text-slate-500 text-sm font-medium">
                                <User className="w-3.5 h-3.5" />
                                {rental.customers?.full_name}
                              </div>
                            </div>
                          </div>
                          <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-none px-3 font-bold">{formatCurrency(rental.paid_amount || 0)}</Badge>
                        </div>
                        <div className="flex items-center justify-between pt-4 border-t border-slate-100 dark:border-slate-800">
                          <div className="flex items-center gap-4">
                             <div className="flex flex-col">
                               <span className="text-[10px] text-slate-400 uppercase font-bold">{isRTL ? 'من' : 'From'}</span>
                               <span className="text-sm font-bold text-slate-700 dark:text-slate-300">{rental.start_date}</span>
                             </div>
                             <div className="w-6 h-px bg-slate-200"></div>
                             <div className="flex flex-col">
                               <span className="text-[10px] text-slate-400 uppercase font-bold">{isRTL ? 'إلى' : 'To'}</span>
                               <span className="text-sm font-bold text-slate-700 dark:text-slate-300">{rental.end_date}</span>
                             </div>
                          </div>
                          <Badge variant="outline" className="text-[10px] h-6 px-2">{rental.status}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Maintenance Section */}
                <div className="bg-white dark:bg-slate-800 rounded-3xl p-8 shadow-sm border border-slate-200 dark:border-slate-700">
                  <div className="flex items-center justify-between mb-8">
                    <h3 className="font-black text-2xl flex items-center gap-3">
                      <Wrench className="w-7 h-7 text-rose-500" />
                      {isRTL ? 'سجل الصيانة والمصروفات' : 'Maintenance & Expenses'}
                    </h3>
                    <Badge className="bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100 px-4 py-1 rounded-full text-sm font-bold">{reportData.maintenance.length + (reportData.car.purchase_price ? 1 : 0)}</Badge>
                  </div>
                  <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                    {reportData.car.purchase_price && (
                      <div className="p-5 rounded-2xl bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/50 flex justify-between items-center">
                        <div className="flex items-center gap-4">
                           <div className="w-12 h-12 rounded-xl bg-rose-500 text-white flex items-center justify-center shadow-lg shadow-rose-500/20">
                              <DollarSign className="w-6 h-6" />
                           </div>
                           <div>
                            <p className="font-black text-rose-900 dark:text-rose-100 text-lg">{isRTL ? 'قيمة الشراء' : 'Purchase Price'}</p>
                            <p className="text-sm text-rose-600 dark:text-rose-400 font-medium">{isRTL ? 'التكلفة الاستثمارية الأساسية' : 'Initial Investment Cost'}</p>
                           </div>
                        </div>
                        <p className="text-xl font-black text-rose-600 dark:text-rose-400">{formatCurrency(reportData.car.purchase_price)}</p>
                      </div>
                    )}
                    {reportData.maintenance.length === 0 && !reportData.car.purchase_price ? (
                      <div className="text-center py-20 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                        <Wrench className="w-16 h-16 text-slate-300 dark:text-slate-700 mx-auto mb-4" />
                        <p className="text-slate-500 text-lg">{isRTL ? 'لا توجد عمليات صيانة مسجلة' : 'No maintenance history found'}</p>
                      </div>
                    ) : reportData.maintenance.map(m => (
                      <div key={m.id} className="p-5 rounded-2xl bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 hover:border-rose-500 transition-all duration-300">
                        <div className="flex justify-between items-center">
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-full bg-rose-100 dark:bg-rose-900/30 text-rose-600 flex items-center justify-center">
                              <Wrench className="w-5 h-5" />
                            </div>
                            <div>
                              <p className="font-black text-slate-900 dark:text-white text-lg">{m.maintenance_type}</p>
                              <div className="flex items-center gap-2 text-slate-500 text-sm font-medium">
                                <Calendar className="w-3.5 h-3.5" />
                                {m.service_date}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                             <p className="text-lg font-black text-rose-600 dark:text-rose-400">{formatCurrency(m.cost || 0)}</p>
                             <p className="text-[10px] text-slate-400 font-bold uppercase">{m.vendor || '-'}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )
        )}

        {!selectedCarId && !searchQuery && (
          <div className="flex flex-col items-center justify-center h-[500px] bg-white dark:bg-slate-900/20 rounded-[40px] border-4 border-dashed border-slate-200 dark:border-slate-800">
            <div className="w-32 h-32 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-8">
              <Search className="w-16 h-16 text-slate-300 dark:text-slate-700" />
            </div>
            <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-2">{isRTL ? 'جاهز لتحليل البيانات؟' : 'Ready to analyze data?'}</h3>
            <p className="text-slate-500 dark:text-slate-400 text-lg text-center max-w-md">{isRTL ? 'أدخل رقم اللوحة في مربع البحث أعلاه للحصول على تقرير مالي وتاريخي شامل للمركبة' : 'Enter a plate number in the search box above to get a comprehensive financial and historical report for the vehicle'}</p>
          </div>
        )}
      </div>

      <style jsx global>{`
        @media print {
          .no-print {
            display: none !important;
          }
          body {
            background: white !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          .print\:m-0 {
            margin: 0 !important;
          }
          .print\:p-0 {
            padding: 0 !important;
          }
          .custom-scrollbar {
            overflow: visible !important;
            max-height: none !important;
          }
        }
      `}</style>
    </DashboardLayout>
  )
}

export default function CarReportsPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CarReportsPageContent />
    </Suspense>
  )
}
