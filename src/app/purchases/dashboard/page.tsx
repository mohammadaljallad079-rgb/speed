"use client"
export const dynamic = "force-dynamic"
import { Suspense, useState, useEffect } from "react"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { supabase, PurchaseInvoice, SupplierPayment, DebitNote } from "@/lib/supabase"
import { formatCurrency, formatDate } from "@/lib/utils"
import {
  ShoppingCart, TrendingUp, DollarSign, Users, FileText,
  ArrowUpRight, ArrowDownRight, Calendar, Search, Truck,
  Package, CreditCard, AlertCircle, Wallet, RotateCcw
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import Link from "next/link"

function StatCard({ title, value, icon: Icon, trend, trendUp, color, subtitle }: any) {
  return (
    <Card className="border-0 shadow-sm hover:shadow-md transition-all">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-slate-500 mb-1">{title}</p>
            <h3 className="text-2xl font-bold text-slate-900 dark:text-white">{value}</h3>
            {subtitle && <p className="text-xs text-slate-400 mt-1">{subtitle}</p>}
            {trend && (
              <div className={`flex items-center gap-1 mt-2 text-sm ${trendUp ? 'text-emerald-600' : 'text-red-600'}`}>
                {trendUp ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
                <span>{trend}%</span>
                <span className="text-slate-400 text-xs">vs last month</span>
              </div>
            )}
          </div>
          <div className={`p-3 rounded-xl ${color}`}>
            <Icon className="w-5 h-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function SimpleBarChart({ data }: { data: any[] }) {
  const max = Math.max(...data.map(d => d.amount))
  if (max === 0) return <div className="h-48 flex items-center justify-center text-slate-400 text-sm">No data</div>
  return (
    <div className="flex items-end gap-2 h-48 mt-4">
      {data.map((item, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-2">
          <div
            className="w-full bg-emerald-500 rounded-t-lg transition-all hover:bg-emerald-600 relative group"
            style={{ height: `${(item.amount / max) * 100}%` }}
          >
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
              {formatCurrency(item.amount)}
            </div>
          </div>
          <span className="text-xs text-slate-500">{item.month}</span>
        </div>
      ))}
    </div>
  )
}

function PurchasesDashboardContent() {
  const { t, isRTL } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [bills, setBills] = useState<PurchaseInvoice[]>([])
  const [payments, setPayments] = useState<SupplierPayment[]>([])
  const [debitNotes, setDebitNotes] = useState<DebitNote[]>([])
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    setMounted(true)
    fetchData()
  }, [])

  async function fetchData() {
    setLoading(true)
    try {
      const [{ data: billsData }, { data: paymentsData }, { data: debitData }, { data: suppliersData }] = await Promise.all([
        supabase.from('purchase_invoices').select('*, suppliers(name)').order('bill_date', { ascending: false }).limit(50),
        supabase.from('supplier_payments').select('*').order('payment_date', { ascending: false }).limit(50),
        supabase.from('debit_notes').select('*').order('note_date', { ascending: false }).limit(50),
        supabase.from('suppliers').select('*'),
      ])

      if (billsData) setBills(billsData as any)
      if (paymentsData) setPayments(paymentsData as any)
      if (debitData) setDebitNotes(debitData as any)
      if (suppliersData) setSuppliers(suppliersData)
    } catch (error) {
      console.error('Error fetching dashboard data:', error)
    }
    setLoading(false)
  }

  // Stats
  const totalPurchases = bills.reduce((s, b) => s + (parseFloat(b.total_amount as any) || 0), 0)
  const totalPaid = bills.reduce((s, b) => s + (parseFloat(b.paid_amount as any) || 0), 0)
  const totalOutstanding = totalPurchases - totalPaid
  const totalSuppliers = suppliers.length
  const pendingBills = bills.filter(b => b.status === 'pending').length
  const overdueBills = bills.filter(b => b.status === 'pending' && b.due_date && new Date(b.due_date) < new Date()).length

  // Top suppliers by total
  const supplierTotals: Record<string, number> = {}
  bills.forEach(b => {
    const sid = b.supplier_id || 'unknown'
    supplierTotals[sid] = (supplierTotals[sid] || 0) + (parseFloat(b.total_amount as any) || 0)
  })
  const topSuppliers = Object.entries(supplierTotals)
    .map(([id, total]) => ({
      name: suppliers.find(s => s.id === id)?.name || 'Unknown',
      total,
      orders: bills.filter(b => b.supplier_id === id).length,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)

  // Monthly data (last 7 months)
  const monthlyData = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    const monthKey = d.toISOString().slice(0, 7)
    const monthName = d.toLocaleString('en', { month: 'short' })
    const amount = bills
      .filter(b => b.bill_date && b.bill_date.startsWith(monthKey))
      .reduce((s, b) => s + (parseFloat(b.total_amount as any) || 0), 0)
    monthlyData.push({ month: monthName, amount })
  }

  // Recent bills
  const recentBills = bills.slice(0, 5)

  if (!mounted) return null

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto p-6 space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{isRTL ? "لوحة المشتريات" : "Purchases Dashboard"}</h1>
            <p className="text-slate-500 text-sm mt-1">{isRTL ? "نظرة عامة على المشتريات والموردين" : "Overview of purchases and suppliers"}</p>
          </div>
          <div className="flex gap-3">
            <Link href="/purchases/new">
              <Button className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl gap-2">
                <ShoppingCart className="w-4 h-4" />
                {isRTL ? "فاتورة جديدة" : "New Bill"}
              </Button>
            </Link>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title={isRTL ? "إجمالي المشتريات" : "Total Purchases"}
            value={formatCurrency(totalPurchases)}
            icon={DollarSign}
            color="bg-emerald-500"
            subtitle={`${bills.length} ${isRTL ? 'فاتورة' : 'bills'}`}
          />
          <StatCard
            title={isRTL ? "المدفوع" : "Total Paid"}
            value={formatCurrency(totalPaid)}
            icon={Wallet}
            color="bg-blue-500"
            subtitle={`${payments.length} ${isRTL ? 'عملية دفع' : 'payments'}`}
          />
          <StatCard
            title={isRTL ? "المستحق" : "Outstanding"}
            value={formatCurrency(totalOutstanding)}
            icon={AlertCircle}
            color="bg-amber-500"
            subtitle={`${pendingBills} ${isRTL ? 'معلقة' : 'pending'}`}
          />
          <StatCard
            title={isRTL ? "الموردين" : "Suppliers"}
            value={totalSuppliers}
            icon={Users}
            color="bg-violet-500"
            subtitle={`${overdueBills} ${isRTL ? 'متأخرة' : 'overdue'}`}
          />
        </div>

        {/* Charts & Top Suppliers */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Monthly Chart */}
          <Card className="lg:col-span-2 border-0 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-500" />
                {isRTL ? "المشتريات الشهرية" : "Monthly Purchases"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SimpleBarChart data={monthlyData} />
            </CardContent>
          </Card>

          {/* Top Suppliers */}
          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <Truck className="w-4 h-4 text-blue-500" />
                {isRTL ? "أفضل الموردين" : "Top Suppliers"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {topSuppliers.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4">{isRTL ? 'لا يوجد بيانات' : 'No data'}</p>
              ) : (
                topSuppliers.map((supplier, i) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-700/50 rounded-xl">
                    <div>
                      <p className="font-semibold text-sm text-slate-900 dark:text-white">{supplier.name}</p>
                      <p className="text-xs text-slate-500">{supplier.orders} {isRTL ? "فاتورة" : "bills"}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-sm text-slate-900 dark:text-white">{formatCurrency(supplier.total)}</p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* Recent Bills */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <FileText className="w-4 h-4 text-violet-500" />
                {isRTL ? "آخر فواتير الموردين" : "Recent Supplier Bills"}
              </CardTitle>
              <Link href="/purchases">
                <Button variant="outline" size="sm" className="rounded-lg">{isRTL ? 'عرض الكل' : 'View All'}</Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentBills.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4">{isRTL ? 'لا توجد فواتير' : 'No bills yet'}</p>
              ) : (
                recentBills.map((bill) => {
                  const supplier = (bill as any).suppliers
                  const balance = (parseFloat(bill.total_amount as any) || 0) - (parseFloat(bill.paid_amount as any) || 0)
                  return (
                    <div key={bill.id} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
                      <div className="flex items-center gap-4">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                          bill.status === 'paid' ? 'bg-emerald-100 text-emerald-600' :
                          bill.status === 'partial' ? 'bg-blue-100 text-blue-600' :
                          'bg-amber-100 text-amber-600'
                        }`}>
                          <Package className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="font-semibold text-sm text-slate-900 dark:text-white">{bill.invoice_number}</p>
                          <p className="text-xs text-slate-500">{supplier?.name || '-'}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="text-center">
                          <p className="text-xs text-slate-400">{isRTL ? "التاريخ" : "Date"}</p>
                          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">{formatDate(bill.bill_date)}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-slate-400">{isRTL ? "المبلغ" : "Amount"}</p>
                          <p className="text-sm font-bold text-slate-900 dark:text-white">{formatCurrency(parseFloat(bill.total_amount as any) || 0)}</p>
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-slate-400">{isRTL ? "المتبقي" : "Balance"}</p>
                          <p className="text-sm font-bold text-amber-600">{formatCurrency(balance)}</p>
                        </div>
                        <Badge className={
                          bill.status === 'paid' ? 'bg-emerald-100 text-emerald-700' :
                          bill.status === 'partial' ? 'bg-blue-100 text-blue-700' :
                          'bg-amber-100 text-amber-700'
                        }>
                          {bill.status === 'paid' ? (isRTL ? 'مدفوعة' : 'Paid') :
                           bill.status === 'partial' ? (isRTL ? 'جزئية' : 'Partial') :
                           (isRTL ? 'معلقة' : 'Pending')}
                        </Badge>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <PurchasesDashboardContent />
    </Suspense>
  )
}
