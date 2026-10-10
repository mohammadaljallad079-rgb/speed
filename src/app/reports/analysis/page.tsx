"use client"
import { Suspense } from 'react'
import { } from 'react'
export const dynamic = "force-dynamic"

import { useEffect, useMemo, useState } from 'react'
import { supabase, Car, Sale } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TrendingUp, TrendingDown, CalendarClock } from 'lucide-react'

const dayMs = 24 * 60 * 60 * 1000
const formatDateInput = (date: Date) => date.toISOString().split('T')[0]

function SalesPurchaseAnalysisPageContent() {
  const { lang, t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [cars, setCars] = useState<Car[]>([])
  const [selectedCarId, setSelectedCarId] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [startDate, setStartDate] = useState(formatDateInput(new Date(Date.now() - 30 * dayMs)))
  const [endDate, setEndDate] = useState(formatDateInput(new Date()))
  const [sales, setSales] = useState<Sale[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setMounted(true)
    fetchCars()
  }, [])

  async function fetchCars() {
    const { data } = await supabase.from('cars').select('*').order('plate_number')
    if (data) setCars(data)
  }

  useEffect(() => {
    fetchSales()
  }, [selectedCarId, statusFilter, startDate, endDate])

  async function fetchSales() {
    setLoading(true)
    try {
      let query = supabase
        .from('sales')
        .select('*')
        .gte('sale_date', startDate)
        .lte('sale_date', endDate)
        .order('sale_date', { ascending: false })

      if (selectedCarId !== 'all') {
        query = query.eq('car_id', selectedCarId)
      }
      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter)
      }

      const { data } = await query
      setSales((data || []) as Sale[])
    } catch (error) {
      console.error('Error fetching sales analysis:', error)
    }
    setLoading(false)
  }

  const totals = useMemo(() => {
    const salesTotal = sales.reduce(
      (sum, sale) => sum + Number(sale.total_amount || sale.sale_price || 0),
      0
    )
    const purchaseTotal = sales.reduce(
      (sum, sale) => sum + Number(sale.purchase_price || 0),
      0
    )

    return {
      salesTotal,
      purchaseTotal,
      net: salesTotal - purchaseTotal,
    }
  }, [sales])

  const applyPreset = (days: number) => {
    const now = new Date()
    setEndDate(formatDateInput(now))
    setStartDate(formatDateInput(new Date(now.getTime() - days * dayMs)))
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
            <CalendarClock className="w-7 h-7 text-cyan-500" />
            {t.salesPurchaseAnalysis}
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-2">
            {isRTL ? 'مقارنة إجمالي المبيعات مقابل إجمالي الشراء' : 'Compare total sales against purchase costs'}
          </p>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 space-y-4">
          <div className="grid lg:grid-cols-[2fr,1fr,1fr] gap-4">
            <Select value={selectedCarId} onValueChange={setSelectedCarId}>
              <SelectTrigger className="h-12 rounded-xl">
                <SelectValue placeholder={t.selectCar} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{isRTL ? 'كل السيارات' : 'All Cars'}</SelectItem>
                {cars.map((car) => (
                  <SelectItem key={car.id} value={car.id}>
                    {car.plate_number} - {car.make} {car.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="h-12 rounded-xl" />
            <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="h-12 rounded-xl" />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-12 rounded-xl">
                <SelectValue placeholder={t.status} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{isRTL ? 'كل الحالات' : 'All Statuses'}</SelectItem>
                <SelectItem value="completed">{t.completed}</SelectItem>
                <SelectItem value="pending">{t.pending}</SelectItem>
                <SelectItem value="cancelled">{t.cancelled}</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => applyPreset(30)}>
                {t.last30Days}
              </Button>
              <Button type="button" variant="outline" onClick={() => applyPreset(60)}>
                {t.last60Days}
              </Button>
              <Button type="button" variant="outline" onClick={() => applyPreset(365)}>
                {t.lastYear}
              </Button>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid md:grid-cols-3 gap-4">
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl p-5 border border-emerald-100 dark:border-emerald-800/40">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-emerald-700 dark:text-emerald-300">{t.salesTotal}</p>
                  <TrendingUp className="w-5 h-5 text-emerald-500" />
                </div>
                <p className="text-2xl font-bold text-slate-900 dark:text-white mt-2">{formatCurrency(totals.salesTotal)}</p>
              </div>
              <div className="bg-amber-50 dark:bg-amber-900/20 rounded-2xl p-5 border border-amber-100 dark:border-amber-800/40">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-amber-700 dark:text-amber-300">{t.purchaseTotal}</p>
                  <TrendingDown className="w-5 h-5 text-amber-500" />
                </div>
                <p className="text-2xl font-bold text-slate-900 dark:text-white mt-2">{formatCurrency(totals.purchaseTotal)}</p>
              </div>
              <div className="bg-slate-50 dark:bg-slate-800/60 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-600 dark:text-slate-300">{t.netProfit}</p>
                  <Badge variant="outline">{sales.length}</Badge>
                </div>
                <p className="text-2xl font-bold text-slate-900 dark:text-white mt-2">{formatCurrency(totals.net)}</p>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">{t.salesHistory}</h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-700">
                      <th className={`py-3 ${isRTL ? 'text-right' : 'text-left'}`}>{t.date}</th>
                      <th className={`py-3 ${isRTL ? 'text-right' : 'text-left'}`}>{t.amount}</th>
                      <th className={`py-3 ${isRTL ? 'text-right' : 'text-left'}`}>{t.purchaseTotal}</th>
                      <th className={`py-3 ${isRTL ? 'text-right' : 'text-left'}`}>{t.status}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-slate-500">
                          {t.noData}
                        </td>
                      </tr>
                    ) : (
                      sales.map((sale) => (
                        <tr key={sale.id} className="border-b border-slate-100 dark:border-slate-700/50">
                          <td className="py-3 text-slate-700 dark:text-slate-300">
                            {formatDate(sale.sale_date, lang === 'ar' ? 'ar-SA' : 'en-US')}
                          </td>
                          <td className="py-3 font-semibold text-slate-900 dark:text-white">
                            {formatCurrency(sale.total_amount || sale.sale_price)}
                          </td>
                          <td className="py-3 text-slate-700 dark:text-slate-300">
                            {formatCurrency(sale.purchase_price || 0)}
                          </td>
                          <td className="py-3">
                            <Badge variant="outline">{sale.status || 'completed'}</Badge>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function SalesPurchaseAnalysisPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SalesPurchaseAnalysisPageContent />
    </Suspense>
  )
}
