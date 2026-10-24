"use client"
export const dynamic = "force-dynamic"
import { Suspense, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { 
  TrendingUp, 
  DollarSign, 
  Receipt, 
  FileText, 
  Users, 
  Car, 
  ArrowUpRight, 
  ArrowDownRight,
  Calendar,
  CreditCard,
  BarChart3,
  Link as LinkIcon
} from "lucide-react"
import Link from "next/link"

function SalesDashboardContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalType, setModalType] = useState<string | null>(null)
  const [modalTitle, setModalTitle] = useState('')
  const [modalLoading, setModalLoading] = useState(false)
  const [modalInvoices, setModalInvoices] = useState<any[]>([])

  const [stats, setStats] = useState({
    totalContracts: 0,
    totalInvoices: 0,
    totalPaid: 0,
    totalOutstanding: 0,
    totalRevenue: 0,
    activeContracts: 0,
    pendingContracts: 0,
    completedContracts: 0,
    monthlyRevenue: [] as any[],
    recentInvoices: [] as any[],
    topCustomers: [] as any[],
  })

  useEffect(() => {
    fetchStats()
  }, [])

  async function fetchStats() {
    try {
      // Contracts stats
      const { data: contracts } = await supabase
        .from('rental_contracts')
        .select('status, total_amount')
      
      const activeContracts = contracts?.filter(c => c.status === 'active').length || 0
      const pendingContracts = contracts?.filter(c => c.status === 'pending').length || 0
      const completedContracts = contracts?.filter(c => c.status === 'completed').length || 0
      const totalContracts = contracts?.length || 0
      const totalRevenue = contracts?.reduce((sum, c) => sum + (parseFloat(c.total_amount) || 0), 0) || 0

      // Invoices stats
      const { data: invoices } = await supabase
        .from('invoices')
        .select('total_amount, paid_amount, status, invoice_number, invoice_date, customers(full_name)')
        .order('created_at', { ascending: false })
        .limit(10)

      const totalInvoices = invoices?.reduce((sum, inv) => sum + (parseFloat(inv.total_amount) || 0), 0) || 0
      const totalPaid = invoices?.reduce((sum, inv) => sum + (parseFloat(inv.paid_amount) || 0), 0) || 0
      const totalOutstanding = totalInvoices - totalPaid

      // Monthly revenue (last 6 months)
      const { data: monthlyData } = await supabase
        .from('payments')
        .select('amount, payment_date')
        .gte('payment_date', new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])

      const monthlyMap = new Map()
      monthlyData?.forEach(p => {
        const month = p.payment_date.substring(0, 7) // YYYY-MM
        monthlyMap.set(month, (monthlyMap.get(month) || 0) + (parseFloat(p.amount) || 0))
      })
      const monthlyRevenue = Array.from(monthlyMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-6)
        .map(([month, amount]) => ({
          month: month.substring(5) + '/' + month.substring(0, 4),
          amount
        }))

      // Top customers
      const { data: customerRevenue } = await supabase
        .from('rental_contracts')
        .select('customer_id, total_amount, customers(full_name)')
        .order('total_amount', { ascending: false })
        .limit(5)

      const topCustomers = customerRevenue?.map(c => ({
        id: c.customer_id,
        name: (Array.isArray(c.customers) ? c.customers[0] : c.customers)?.full_name || 'Unknown',
        amount: parseFloat(String(c.total_amount)) || 0
      })) || []

      setStats({
        totalContracts,
        totalInvoices,
        totalPaid,
        totalOutstanding,
        totalRevenue,
        activeContracts,
        pendingContracts,
        completedContracts,
        monthlyRevenue,
        recentInvoices: invoices || [],
        topCustomers,
      })
    } catch (error) {
      console.error('Error fetching stats:', error)
    } finally {
      setLoading(false)
    }
  }

  function formatCurrency(amount: number) {
    return amount.toFixed(3) + ' BHD'
  }

  async function openReportModal(type: string) {
    setModalType(type)
    setModalOpen(true)
    setModalLoading(true)
    setModalInvoices([])

    const titles: Record<string, string> = {
      revenue: isRTL ? 'تفاصيل إجمالي الإيرادات' : 'Total Revenue Details',
      paid: isRTL ? 'تفاصيل المدفوعات' : 'Total Paid Details',
      outstanding: isRTL ? 'تفاصيل المبالغ المستحقة' : 'Outstanding Details',
      contracts: isRTL ? 'تفاصيل العقود' : 'Contracts Details',
    }
    setModalTitle(titles[type] || '')

    try {
      if (type === 'contracts') {
        const { data } = await supabase
          .from('rental_contracts')
          .select('id, status, total_amount, created_at, customers(full_name)')
          .order('created_at', { ascending: false })
        setModalInvoices(data || [])
      } else {
        const { data } = await supabase
          .from('invoices')
          .select('id, invoice_number, invoice_date, total_amount, paid_amount, status, customers(full_name)')
          .order('invoice_date', { ascending: false })

        let rows = data || []

        if (type === 'outstanding') {
          rows = rows.filter((inv: any) => (parseFloat(inv.total_amount) || 0) - (parseFloat(inv.paid_amount) || 0) > 0)
        }
        if (type === 'paid') {
          rows = rows.filter((inv: any) => (parseFloat(inv.paid_amount) || 0) > 0)
        }

        setModalInvoices(rows)
      }
    } catch (err) {
      console.error('Modal fetch error:', err)
    } finally {
      setModalLoading(false)
    }
  }

  async function openCustomerModal(customer: { id?: string; name: string; amount: number }) {
    setModalType('customer')
    setModalOpen(true)
    setModalLoading(true)
    setModalInvoices([])
    setModalTitle(isRTL ? `فواتير العميل: ${customer.name}` : `Invoices for: ${customer.name}`)

    try {
      if (!customer.id) {
        setModalInvoices([])
        return
      }
      const { data } = await supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, total_amount, paid_amount, status, customers(full_name)')
        .eq('customer_id', customer.id)
        .order('invoice_date', { ascending: false })
      setModalInvoices(data || [])
    } catch (err) {
      console.error('Customer modal fetch error:', err)
    } finally {
      setModalLoading(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
              {isRTL ? 'لوحة تحكم المبيعات' : 'Sales Dashboard'}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">
              {isRTL ? 'نظرة عامة على أداء المبيعات' : 'Overview of sales performance'}
            </p>
          </div>
          <Link href="/dashboard">
            <Button variant="outline" className="gap-2">
              <LinkIcon className="w-4 h-4" />
              {isRTL ? 'لوحة التحكم الرئيسية' : 'Main Dashboard'}
            </Button>
          </Link>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card onClick={() => openReportModal('revenue')} className="border-0 shadow-md bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 cursor-pointer hover:shadow-lg transition-shadow">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{isRTL ? 'إجمالي الإيرادات' : 'Total Revenue'}</p>
                  <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{formatCurrency(stats.totalRevenue)}</p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                  <TrendingUp className="w-6 h-6 text-blue-500" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card onClick={() => openReportModal('paid')} className="border-0 shadow-md bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-900/20 dark:to-emerald-800/20 cursor-pointer hover:shadow-lg transition-shadow">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{isRTL ? 'المدفوعات' : 'Total Paid'}</p>
                  <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{formatCurrency(stats.totalPaid)}</p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                  <DollarSign className="w-6 h-6 text-emerald-500" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card onClick={() => openReportModal('outstanding')} className="border-0 shadow-md bg-gradient-to-br from-amber-50 to-amber-100 dark:from-amber-900/20 dark:to-amber-800/20 cursor-pointer hover:shadow-lg transition-shadow">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{isRTL ? 'المبالغ المستحقة' : 'Outstanding'}</p>
                  <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{formatCurrency(stats.totalOutstanding)}</p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                  <Receipt className="w-6 h-6 text-amber-500" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card onClick={() => openReportModal('contracts')} className="border-0 shadow-md bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 cursor-pointer hover:shadow-lg transition-shadow">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{isRTL ? 'عدد العقود' : 'Total Contracts'}</p>
                  <p className="text-2xl font-bold text-purple-600 dark:text-purple-400">{stats.totalContracts}</p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center">
                  <FileText className="w-6 h-6 text-purple-500" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Contract Status */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-0 shadow-md">
            <CardContent className="pt-6 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <Car className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-slate-500">{isRTL ? 'نشطة' : 'Active'}</p>
                <p className="text-2xl font-bold text-green-600">{stats.activeContracts}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-md">
            <CardContent className="pt-6 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center">
                <Calendar className="w-6 h-6 text-yellow-600" />
              </div>
              <div>
                <p className="text-sm text-slate-500">{isRTL ? 'معلقة' : 'Pending'}</p>
                <p className="text-2xl font-bold text-yellow-600">{stats.pendingContracts}</p>
              </div>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-md">
            <CardContent className="pt-6 flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                <CreditCard className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-slate-500">{isRTL ? 'مكتملة' : 'Completed'}</p>
                <p className="text-2xl font-bold text-blue-600">{stats.completedContracts}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Monthly Revenue Chart */}
        <Card className="border-0 shadow-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-cyan-500" />
              {isRTL ? 'الإيرادات الشهرية' : 'Monthly Revenue'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats.monthlyRevenue.length > 0 ? (
              <div className="space-y-3">
                {stats.monthlyRevenue.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-4">
                    <span className="w-16 text-sm text-slate-500">{item.month}</span>
                    <div className="flex-1 h-8 bg-slate-100 dark:bg-slate-700 rounded-lg overflow-hidden">
                      <div 
                        className="h-full bg-cyan-500 rounded-lg transition-all"
                        style={{ 
                          width: `${Math.min(100, (item.amount / Math.max(...stats.monthlyRevenue.map(m => m.amount))) * 100)}%` 
                        }}
                      />
                    </div>
                    <span className="w-24 text-sm font-medium text-right">{formatCurrency(item.amount)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-slate-400 text-center py-8">{isRTL ? 'لا توجد بيانات' : 'No data available'}</p>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Recent Invoices */}
          <Card className="border-0 shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Receipt className="w-5 h-5 text-cyan-500" />
                {isRTL ? 'أحدث الفواتير' : 'Recent Invoices'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {stats.recentInvoices.length > 0 ? (
                <div className="space-y-2">
                  {stats.recentInvoices.map((inv) => (
                    <div key={inv.id} onClick={() => router.push(`/invoices/${inv.id}`)} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
                      <div>
                        <p className="font-medium text-sm">{inv.invoice_number}</p>
                        <p className="text-xs text-slate-500">{inv.customers?.full_name}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-sm">{formatCurrency(inv.total_amount)}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          inv.status === 'paid' ? 'bg-green-100 text-green-700' :
                          inv.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-slate-100 text-slate-700'
                        }`}>{inv.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-slate-400 text-center py-8">{isRTL ? 'لا توجد فواتير' : 'No invoices'}</p>
              )}
            </CardContent>
          </Card>

          {/* Top Customers */}
          <Card className="border-0 shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5 text-cyan-500" />
                {isRTL ? 'أفضل العملاء' : 'Top Customers'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {stats.topCustomers.length > 0 ? (
                <div className="space-y-2">
                  {stats.topCustomers.map((customer, idx) => (
                    <div key={idx} onClick={() => openCustomerModal(customer)} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-cyan-100 dark:bg-cyan-900/30 flex items-center justify-center text-cyan-600 font-bold text-sm">
                          {idx + 1}
                        </div>
                        <p className="font-medium text-sm">{customer.name}</p>
                      </div>
                      <p className="font-bold text-sm text-cyan-600">{formatCurrency(customer.amount)}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-slate-400 text-center py-8">{isRTL ? 'لا توجد بيانات' : 'No data'}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{modalTitle}</DialogTitle>
          </DialogHeader>
          {modalLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-8 h-8 border-4 border-cyan-500 border-t-transparent rounded-full"></div>
            </div>
          ) : modalInvoices.length === 0 ? (
            <p className="text-slate-400 text-center py-8">{isRTL ? 'لا توجد بيانات' : 'No data'}</p>
          ) : (
            <div className="space-y-2">
              {modalInvoices.map((row: any) => (
                <div key={row.id} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                  <div>
                    <p className="font-medium text-sm">{row.invoice_number || row.customers?.full_name || row.id}</p>
                    <p className="text-xs text-slate-500">{row.customers?.full_name} · {(row.invoice_date || row.created_at || '').toString().slice(0, 10)}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-sm">{formatCurrency(parseFloat(row.total_amount) || 0)}</p>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">{row.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SalesDashboardContent />
    </Suspense>
  )
}
