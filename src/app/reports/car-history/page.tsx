"use client"
import { Suspense } from 'react'
import { useReportRefresh } from '@/lib/hooks/use-report-refresh'
import { } from 'react'
export const dynamic = "force-dynamic"

import { useEffect, useMemo, useState } from 'react'
import { supabase, Car, Sale, Maintenance, Expense } from '@/lib/supabase'
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
import { Calendar, DollarSign, History, AlertTriangle } from 'lucide-react'

const dayMs = 24 * 60 * 60 * 1000

const formatDateInput = (date: Date) => date.toISOString().split('T')[0]

function CarHistoryReportPageContent() {
  const { lang, t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [cars, setCars] = useState<Car[]>([])
  const [selectedCarId, setSelectedCarId] = useState('')
  const [startDate, setStartDate] = useState(formatDateInput(new Date(Date.now() - 30 * dayMs)))
  const [endDate, setEndDate] = useState(formatDateInput(new Date()))
  const [startDraft, setStartDraft] = useState(formatDateInput(new Date(Date.now() - 30 * dayMs)))
  const [endDraft, setEndDraft] = useState(formatDateInput(new Date()))
  const [loading, setLoading] = useState(false)
  const [sales, setSales] = useState<Sale[]>([])
  const [maintenance, setMaintenance] = useState<Maintenance[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])

  useEffect(() => {
    setMounted(true)
    fetchCars()
  }, [])

  async function fetchCars() {
    const { data } = await supabase.from('cars').select('*').order('plate_number')
    if (data) setCars(data)
  }

  const selectedCar = useMemo(
    () => cars.find((car) => car.id === selectedCarId) || null,
    [cars, selectedCarId]
  )

    useReportRefresh(fetchReport)

useEffect(() => {
    if (!selectedCarId || !startDate || !endDate) return
    fetchReport()
  }, [selectedCarId, startDate, endDate])

  function applyDates() { setStartDate(startDraft); setEndDate(endDraft) }

  async function fetchReport() {
    setLoading(true)
    try {
      const [salesRes, maintenanceRes, expensesRes] = await Promise.all([
        supabase
          .from('sales')
          .select('*')
          .eq('car_id', selectedCarId)
          .gte('sale_date', startDate)
          .lte('sale_date', endDate)
          .order('sale_date', { ascending: false }),
        supabase
          .from('maintenance')
          .select('*')
          .eq('car_id', selectedCarId)
          .gte('service_date', startDate)
          .lte('service_date', endDate)
          .order('service_date', { ascending: false }),
        supabase
          .from('expenses')
          .select('*, supplier:suppliers(name)')
          .eq('car_id', selectedCarId)
          .gte('expense_date', startDate)
          .lte('expense_date', endDate)
          .order('expense_date', { ascending: false }),
      ])

      setSales((salesRes.data || []) as Sale[])
      setMaintenance((maintenanceRes.data || []) as Maintenance[])
      setExpenses((expensesRes.data || []) as Expense[])
    } catch (error) {
      console.error('Error fetching car history report:', error)
    }
    setLoading(false)
  }

  const combinedExpenses = useMemo(() => {
    const maintenanceExpenses = maintenance.map((item) => ({
      id: `maintenance-${item.id}`,
      expense_date: item.service_date,
      amount: item.cost || 0,
      category: 'maintenance',
      description: item.maintenance_type,
      vendor: item.vendor,
      source: 'maintenance',
    }))

    const extraExpenses = expenses.map((item) => ({
      id: `expense-${item.id}`,
      expense_date: item.expense_date,
      amount: item.amount || 0,
      category: item.category || 'general',
      description: item.description,
      vendor: item.supplier?.name || null,
      source: 'expense',
    }))

    return [...maintenanceExpenses, ...extraExpenses].sort((a, b) =>
      (b.expense_date || '').localeCompare(a.expense_date || '')
    )
  }, [maintenance, expenses])

  const totals = useMemo(() => {
    const salesTotal = sales.reduce(
      (sum, sale) => sum + Number(sale.total_amount || sale.sale_price || 0),
      0
    )
    const expenseTotal = combinedExpenses.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    )
    const trafficFinesTotal = combinedExpenses
      .filter((item) => item.category === 'traffic_fine')
      .reduce((sum, item) => sum + Number(item.amount || 0), 0)

    return {
      salesTotal,
      expenseTotal,
      netProfit: salesTotal - expenseTotal,
      trafficFinesTotal,
    }
  }, [sales, combinedExpenses])

  const applyPreset = (days: number) => {
    const now = new Date()
    setEndDate(formatDateInput(now))
    setStartDate(formatDateInput(new Date(now.getTime() - days * dayMs)))
  }

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
            <History className="w-7 h-7 text-cyan-500" />
            {t.carHistoryReport}
          </h1>
          <p className="text-slate-500 dark:text-slate-400">
            {isRTL ? 'عرض المبيعات والمصروفات ومخالفات المرور للمركبة' : 'View sales, expenses, and traffic fines for the vehicle'}
          </p>
        </header>

        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-200 dark:border-slate-700 space-y-4">
          <div className="grid lg:grid-cols-[2fr,1fr,1fr] gap-4">
            <Select value={selectedCarId} onValueChange={setSelectedCarId}>
              <SelectTrigger className="h-12 rounded-xl">
                <SelectValue placeholder={t.selectCar} />
              </SelectTrigger>
              <SelectContent>
                {cars.map((car) => (
                  <SelectItem key={car.id} value={car.id}>
                    {car.plate_number} - {car.make} {car.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Input
              type="date"
              value={startDraft}
              onChange={(event) => setStartDraft(event.target.value)}
              className="h-12 rounded-xl"
            />
            <Input
              type="date"
              value={endDraft}
              onChange={(event) => setEndDraft(event.target.value)}
              className="h-12 rounded-xl"
            />
          </div>
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
            <Button type="button" onClick={applyDates} className="bg-indigo-500 hover:bg-indigo-600 text-white">
              {isRTL ? 'عرض' : 'GO'}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
          </div>
        ) : !selectedCar ? (
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-10 border border-dashed border-slate-200 dark:border-slate-700 text-center text-slate-500">
            {isRTL ? 'اختر السيارة أولاً لعرض التقرير.' : 'Select a car to view the report.'}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid md:grid-cols-3 gap-4">
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl p-5 border border-emerald-100 dark:border-emerald-800/40">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-emerald-700 dark:text-emerald-300">{t.salesTotal}</p>
                  <DollarSign className="w-5 h-5 text-emerald-500" />
                </div>
                <p className="text-2xl font-bold text-slate-900 dark:text-white mt-2">{formatCurrency(totals.salesTotal)}</p>
              </div>
              <div className="bg-rose-50 dark:bg-rose-900/20 rounded-2xl p-5 border border-rose-100 dark:border-rose-800/40">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-rose-700 dark:text-rose-300">{t.expenses}</p>
                  <AlertTriangle className="w-5 h-5 text-rose-500" />
                </div>
                <p className="text-2xl font-bold text-slate-900 dark:text-white mt-2">{formatCurrency(totals.expenseTotal)}</p>
                {totals.trafficFinesTotal > 0 && (
                  <p className="text-xs text-rose-500 mt-2">
                    {isRTL ? 'مخالفات مرور: ' : 'Traffic fines: '} {formatCurrency(totals.trafficFinesTotal)}
                  </p>
                )}
              </div>
              <div className="bg-slate-50 dark:bg-slate-800/60 rounded-2xl p-5 border border-slate-200 dark:border-slate-700">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-600 dark:text-slate-300">{t.netProfit}</p>
                  <Calendar className="w-5 h-5 text-slate-500" />
                </div>
                <p className="text-2xl font-bold text-slate-900 dark:text-white mt-2">{formatCurrency(totals.netProfit)}</p>
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
                      <th className={`py-3 ${isRTL ? 'text-right' : 'text-left'}`}>{t.status}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="py-6 text-center text-slate-500">
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

            <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">{t.expenses}</h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-slate-500 dark:text-slate-400 text-sm border-b border-slate-200 dark:border-slate-700">
                      <th className={`py-3 ${isRTL ? 'text-right' : 'text-left'}`}>{t.expenseDate}</th>
                      <th className={`py-3 ${isRTL ? 'text-right' : 'text-left'}`}>{t.category}</th>
                      <th className={`py-3 ${isRTL ? 'text-right' : 'text-left'}`}>{t.supplier}</th>
                      <th className={`py-3 ${isRTL ? 'text-right' : 'text-left'}`}>{t.amount}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {combinedExpenses.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-slate-500">
                          {t.noData}
                        </td>
                      </tr>
                    ) : (
                      combinedExpenses.map((item) => (
                        <tr key={item.id} className="border-b border-slate-100 dark:border-slate-700/50">
                          <td className="py-3 text-slate-700 dark:text-slate-300">
                            {formatDate(item.expense_date, lang === 'ar' ? 'ar-SA' : 'en-US')}
                          </td>
                          <td className="py-3 text-slate-700 dark:text-slate-300">
                            <Badge variant="outline">{item.category}</Badge>
                          </td>
                          <td className="py-3 text-slate-700 dark:text-slate-300">{item.vendor || '-'}</td>
                          <td className="py-3 font-semibold text-rose-600 dark:text-rose-400">
                            {formatCurrency(item.amount)}
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

export default function CarHistoryReportPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CarHistoryReportPageContent />
    </Suspense>
  )
}
