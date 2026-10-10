"use client"
export const dynamic = "force-dynamic"

import { Suspense } from 'react'
import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { BarChart3, PieChart as PieChartIcon, MapPin, CheckCircle2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

function VehiclesSummaryContent() {
  const { isRTL } = useLanguage()
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchSummary()
  }, [])

  async function fetchSummary() {
    try {
      const { data: cars } = await supabase.from('cars').select('status, location')
      if (cars) {
        const statusCounts = cars.reduce((acc: any, car) => {
          acc[car.status] = (acc[car.status] || 0) + 1
          return acc
        }, {})
        const chartData = Object.entries(statusCounts).map(([name, value]) => ({ name, value }))
        setData(chartData)
      }
    } catch (error) {
      console.error('Error fetching summary:', error)
    }
    setLoading(false)
  }

  const COLORS = ['#10b981', '#f43f5e', '#f59e0b', '#3b82f6', '#8b5cf6']

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <BarChart3 className="w-8 h-8 text-cyan-500" />
            {isRTL ? 'ملخص المركبات حسب الحالة' : 'Vehicles Summary by Status'}
          </h1>
        </header>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="rounded-[30px] shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <PieChartIcon className="w-5 h-5 text-cyan-500" />
                  {isRTL ? 'توزيع المركبات' : 'Vehicle Distribution'}
                </CardTitle>
              </CardHeader>
              <CardContent className="h-[400px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                      outerRadius={120}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {data.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="rounded-[30px] shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                  {isRTL ? 'إحصائيات بالأرقام' : 'Stats by Numbers'}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {data.map((item, index) => (
                    <div key={item.name} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-900/50 rounded-2xl">
                      <div className="flex items-center gap-3">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }}></div>
                        <span className="font-bold uppercase text-slate-700 dark:text-slate-300">{item.name}</span>
                      </div>
                      <span className="text-2xl font-black">{item.value}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function VehiclesSummaryReport() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <VehiclesSummaryContent />
    </Suspense>
  )
}
