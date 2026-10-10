"use client"
export const dynamic = "force-dynamic"
import { Suspense, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  TrendingUp,
  DollarSign,
  Receipt,
  Users,
  CheckCircle,
  Clock,
  BarChart3
} from "lucide-react"

function SalesAnalysisContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [sales, setSales] = useState<any[]>([])
  const [stats, setStats] = useState({
    totalSales: 0,
    totalAmount: 0,
    totalPaid: 0,
    totalOutstanding: 0,
    paidCount: 0,
    unpaidCount: 0,
  })
  const [monthlyRevenue, setMonthlyRevenue] = useState<any[]>([])
  const [topCustomers, setTopCustomers] = useState<any[]>([])

  useEffect(() => {
    fetchSalesData()
  }, [])

  async function fetchSalesData() {
    try {
      const { data: invoices, error } = await supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, status, total_amount, paid_amount, customer_id, customers(full_name)')
        .eq('invoice_type', 'sale')
        .order('invoice_date', { ascending: false })

      if (error) throw error

      const all = invoices || []
      setSales(all)

      const totalAmount = all.reduce((sum, inv) => sum + (parseFloat(inv.total_amount) || 0), 0)
      const totalPaid = all.reduce((sum, inv) => sum + (parseFloat(inv.paid_amount) || 0), 0)
      const paidCount = all.filter(inv => (parseFloat(inv.paid_amount) || 0) >= (parseFloat(inv.total_amount) || 0)).length
      const unpaidCount = all.length - paidCount

      setStats({
        totalSales: all.length,
        totalAmount,
        totalPaid,
        totalOutstanding: totalAmount - totalPaid,
        paidCount,
        unpaidCount,
      })

      // Monthly trend (last 6 months)
      const monthlyMap = new Map<string, number>()
      all.forEach((inv: any) => {
        if (!inv.invoice_date) return
        const month = inv.invoice_date.substring(0, 7)
        monthlyMap.set(month, (monthlyMap.get(month) || 0) + (parseFloat(inv.total_amount) || 0))
      })
      const monthly = Array.from(monthlyMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-6)
        .map(([month, amount]) => ({
          month: month.substring(5) + '/' + month.substring(0, 4),
          amount
        }))
      setMonthlyRevenue(monthly)

      // Top customers by sale total
      const customerMap = new Map<string, { name: string; amount: number }>()
      all.forEach((inv: any) => {
        const name = inv.customers?.full_name || (isRTL ? 'غير معروف' : 'Unknown')
        const key = inv.customer_id || name
        const existing = customerMap.get(key)
        const amt = parseFloat(inv.total_amount) || 0
        if (existing) {
          existing.amount += amt
        } else {
          customerMap.set(key, { name, amount: amt })
        }
      })
      const top = Array.from(customerMap.values())
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5)
      setTopCustomers(top)

    } catch (err) {
      console.error('Sales analysis fetch error:', err)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-96">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-600"></div>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto space-y-6 p-6" dir={isRTL ? "rtl" : "ltr"}>
        <div>
          <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
            <BarChart3 className="w-7 h-7 text-cyan-600" />
            {isRTL ? 'تحليل المبيعات' : 'Sales Analysis'}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {isRTL ? 'كل فواتير البيع (بدون استثناء)' : 'All sale invoices, without exception'}
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: isRTL ? 'عدد فواتير البيع' : 'Total Sales', value: stats.totalSales, icon: Receipt, color: 'text-blue-600', bg: 'bg-blue-50' },
            { label: isRTL ? 'إجمالي المبيعات' : 'Total Amount', value: `${stats.totalAmount.toFixed(2)} BHD`, icon: DollarSign, color: 'text-emerald-600', bg: 'bg-emerald-50' },
            { label: isRTL ? 'المدفوع' : 'Paid', value: `${stats.totalPaid.toFixed(2)} BHD`, icon: CheckCircle, color: 'text-cyan-600', bg: 'bg-cyan-50' },
            { label: isRTL ? 'المتبقي' : 'Outstanding', value: `${stats.totalOutstanding.toFixed(2)} BHD`, icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
          ].map((stat, idx) => (
            <Card key={idx} className="border-0 shadow-md">
              <CardContent className="p-5">
                <div className={`w-10 h-10 rounded-xl ${stat.bg} flex items-center justify-center mb-3`}>
                  <stat.icon className={`w-5 h-5 ${stat.color}`} />
                </div>
                <p className="text-xl font-black text-slate-900">{stat.value}</p>
                <p className="text-xs text-slate-500 font-semibold mt-1">{stat.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="border-0 shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <TrendingUp className="w-5 h-5 text-cyan-600" />
                {isRTL ? 'اتجاه المبيعات الشهري' : 'Monthly Sales Trend'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {monthlyRevenue.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-8">{isRTL ? 'لا توجد بيانات كافية' : 'Not enough data'}</p>
              ) : (
                <div className="space-y-2">
                  {monthlyRevenue.map((m, idx) => (
                    <div key={idx} className="flex items-center justify-between text-sm">
                      <span className="text-slate-500">{m.month}</span>
                      <span className="font-bold text-slate-900">{m.amount.toFixed(2)} BHD</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-0 shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Users className="w-5 h-5 text-cyan-600" />
                {isRTL ? 'أعلى العملاء' : 'Top Customers'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {topCustomers.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-8">{isRTL ? 'لا توجد بيانات' : 'No data'}</p>
              ) : (
                <div className="space-y-2">
                  {topCustomers.map((c, idx) => (
                    <div key={idx} className="flex items-center justify-between text-sm">
                      <span className="text-slate-700">{c.name}</span>
                      <span className="font-bold text-slate-900">{c.amount.toFixed(2)} BHD</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="border-0 shadow-md">
          <CardHeader>
            <CardTitle className="text-lg">{isRTL ? 'كل فواتير البيع' : 'All Sale Invoices'}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-400 border-b">
                    <th className="py-2 pr-4">{isRTL ? 'رقم الفاتورة' : 'Invoice #'}</th>
                    <th className="py-2 pr-4">{isRTL ? 'التاريخ' : 'Date'}</th>
                    <th className="py-2 pr-4">{isRTL ? 'العميل' : 'Customer'}</th>
                    <th className="py-2 pr-4">{isRTL ? 'الحالة' : 'Status'}</th>
                    <th className="py-2 pr-4 text-right">{isRTL ? 'المبلغ' : 'Amount'}</th>
                    <th className="py-2 pr-4 text-right">{isRTL ? 'المدفوع' : 'Paid'}</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((inv: any) => (
                    <tr key={inv.id} className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer" onClick={() => router.push(`/invoices/${inv.id}`)}>
                      <td className="py-2 pr-4 font-semibold text-slate-900">{inv.invoice_number}</td>
                      <td className="py-2 pr-4 text-slate-500">{inv.invoice_date}</td>
                      <td className="py-2 pr-4 text-slate-700">{inv.customers?.full_name || '-'}</td>
                      <td className="py-2 pr-4 text-slate-500 capitalize">{inv.status}</td>
                      <td className="py-2 pr-4 text-right font-bold text-slate-900">{parseFloat(inv.total_amount || 0).toFixed(2)}</td>
                      <td className="py-2 pr-4 text-right text-emerald-600">{parseFloat(inv.paid_amount || 0).toFixed(2)}</td>
                    </tr>
                  ))}
                  {sales.length === 0 && (
                    <tr><td colSpan={6} className="py-8 text-center text-slate-400">{isRTL ? 'لا توجد فواتير بيع' : 'No sale invoices found'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}

export default function SalesAnalysisPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-96"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-600"></div></div>}>
      <SalesAnalysisContent />
    </Suspense>
  )
}
