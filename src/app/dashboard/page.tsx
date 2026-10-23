"use client"
import { Suspense, useState, useEffect } from 'react'
export const dynamic = "force-dynamic"
import { supabase } from '@/lib/supabase'
import { summarizeRevenue } from '@/lib/reporting/revenue'
import { formatCurrency } from '@/lib/utils'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import {
  Car, DollarSign, TrendingUp, Users, MoreHorizontal,
  Plus, FileText, UserPlus, CreditCard, AlertTriangle,
  Clock, Calendar, Wrench, Bell, ArrowRight, Shield,
  Timer, Receipt, AlertCircle
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'

function DashboardContent() {
  const { isRTL } = useLanguage()
  const [stats, setStats] = useState({ revenue: 0, bookings: 0, rented: 0, available: 0 })
  const [revenueInfo, setRevenueInfo] = useState({ gross: 0, vat: 0, returns: 0, netAfterReturns: 0 })
  const [cars, setCars] = useState<any[]>([])
  const [earningsData, setEarningsData] = useState<{month:string,value:number}[]>([])
  const [rentStatus, setRentStatus] = useState([58, 24, 18])
  const [carTypes, setCarTypes] = useState<{name:string,pct:number}[]>([])
  const [recentActivity, setRecentActivity] = useState<any[]>([])
  const [alerts, setAlerts] = useState<any[]>([])
  const [expiringContracts, setExpiringContracts] = useState<any[]>([])
  const [maintenanceCars, setMaintenanceCars] = useState<any[]>([])
  const [overduePayments, setOverduePayments] = useState<any[]>([])
  const [expiringLicenses, setExpiringLicenses] = useState<any[]>([])

  useEffect(() => {
    async function load() {
      const [carsRes, invoicesRes, paymentsRes, contractsRes, allCarsRes, recentContracts, returnsRes] = await Promise.all([
        supabase.from("cars").select("*").order("created_at", { ascending: false }).limit(5),
        supabase.from("invoices").select("amount,discount_amount,vat_amount,total_amount,status,invoice_date"),
        supabase.from("payments").select("amount,payment_date,status"),
        supabase.from("rental_contracts").select("status,end_date"),
        supabase.from("cars").select("status,category,plate_number,make,model"),
        supabase.from("rental_contracts").select("*,customers(full_name),cars(make,model,plate_number)").order("created_at",{ascending:false}).limit(5),
        supabase.from("sales_returns").select("amount,status"),
      ])
      const all = allCarsRes.data || []
      // Revenue is recognised from issued sales/rental invoices (excluding VAT and
      // cancelled documents), never from customer receipts - a receipt only
      // settles a receivable and must not be counted as new revenue. Sales returns
      // reduce revenue; they are surfaced separately so the figure reconciles with
      // the sales documents the user sees.
      const invoices = invoicesRes.data || []
      const payments = paymentsRes.data || []
      const returns = returnsRes.data || []
      const revenueSummary = summarizeRevenue(invoices, returns)
      const invoiceRevenue = (i:any) => Number(i.total_amount || i.amount || 0) - Number(i.vat_amount || 0)
      const contracts = contractsRes.data || []
      setRevenueInfo({
        gross: revenueSummary.gross,
        vat: revenueSummary.vat,
        returns: revenueSummary.returns,
        netAfterReturns: revenueSummary.netAfterReturns,
      })
      setStats({
        revenue: revenueSummary.net,
        bookings: contracts.length,
        rented: all.filter((c:any) => c.status==="rented").length,
        available: all.filter((c:any) => c.status==="available").length,
      })
      setCars(carsRes.data || [])
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug"]
      setEarningsData(months.map((m, monthIdx) => ({
        month: m,
        value: invoices.filter((inv:any) => inv.status !== "cancelled" && inv.invoice_date && new Date(inv.invoice_date).getMonth()===monthIdx)
          .reduce((s:number,inv:any) => s + invoiceRevenue(inv), 0)
      })))
      const tot = contracts.length || 1
      setRentStatus([
        Math.round(contracts.filter((c:any)=>c.status==="active").length/tot*100),
        Math.round(contracts.filter((c:any)=>c.status==="pending").length/tot*100),
        Math.round(contracts.filter((c:any)=>c.status==="cancelled").length/tot*100),
      ])
      const cats:Record<string,number> = {}
      all.forEach((c:any)=>{ const k=c.category||"rental"; cats[k]=(cats[k]||0)+1 })
      const t2=all.length||1
      setCarTypes(Object.entries(cats).map(([name,count])=>({ name, pct: Math.round(Number(count)/t2*100) })))

      // Recent Activity
      setRecentActivity(recentContracts.data || [])

      // Alerts
      const today = new Date().toISOString().split('T')[0]
      const threeDaysLater = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0]
      const sevenDaysLater = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]
      const alertList = []

      // 1. Contracts near expiry (end_date within 7 days)
      const nearExpiryContracts = (contracts || []).filter((c:any) => c.end_date && c.end_date <= sevenDaysLater && c.end_date >= today && c.status === 'active')
      setExpiringContracts(nearExpiryContracts)
      if (nearExpiryContracts.length > 0) {
        alertList.push({ type: 'warning', message: isRTL ? `${nearExpiryContracts.length} عقد قرب ينتهي` : `${nearExpiryContracts.length} contract(s) expiring soon`, icon: Timer })
      }

      // 2. Cars needing maintenance
      const needMaintenance = all.filter((c:any) => c.status === 'maintenance' || c.status === 'service')
      setMaintenanceCars(needMaintenance)
      if (needMaintenance.length > 0) {
        alertList.push({ type: 'danger', message: isRTL ? `${needMaintenance.length} سيارة تحتاج صيانة` : `${needMaintenance.length} car(s) need maintenance`, icon: Wrench })
      }

      // 3. Overdue payments (payment_date passed and status not completed)
      const overdue = (payments || []).filter((p:any) => p.payment_date && p.payment_date < today && p.status !== 'completed')
      setOverduePayments(overdue)
      if (overdue.length > 0) {
        alertList.push({ type: 'danger', message: isRTL ? `${overdue.length} فاتورة مستحقة الدفع` : `${overdue.length} overdue payment(s)`, icon: Receipt })
      }

      // 4. License expiry alerts (within 3 days)
      const nearExpiryLicenses = all.filter((c:any) => c.license_expiry && c.license_expiry <= threeDaysLater && c.license_expiry >= today)
      setExpiringLicenses(nearExpiryLicenses)
      if (nearExpiryLicenses.length > 0) {
        alertList.push({ type: 'warning', message: isRTL ? `رخصة ${nearExpiryLicenses.length} سيارة قرب تنتهي` : `${nearExpiryLicenses.length} car license expiring soon`, icon: AlertCircle })
      }

      setAlerts(alertList)
    }
    load()
  }, [])

  const kpis = [
    { label: isRTL?"اجمالي الايرادات":"Total Revenue", value: stats.revenue.toFixed(3)+" BHD", icon: DollarSign, delta:"+2.86%", up:true, href:"/payments" },
    { label: isRTL?"الحجوزات":"Bookings", value: stats.bookings, icon: TrendingUp, delta:"+1.73%", up:true, href:"/rentals" },
    { label: isRTL?"سيارات مؤجرة":"Rented Cars", value: stats.rented, icon: Car, delta:"-2.86%", up:false, href:"/cars?status=rented" },
    { label: isRTL?"سيارات متاحة":"Available Cars", value: stats.available, icon: Users, delta:"+3.45%", up:true, href:"/cars?status=available" },
  ]

  const quickActions = [
    { label: isRTL?"عقد جديد":"New Contract", icon: FileText, href: "/rentals/new", color: "bg-blue-500 hover:bg-blue-600" },
    { label: isRTL?"عميل جديد":"New Customer", icon: UserPlus, href: "/customers/new", color: "bg-emerald-500 hover:bg-emerald-600" },
    { label: isRTL?"سيارة جديدة":"New Car", icon: Car, href: "/cars/new", color: "bg-violet-500 hover:bg-violet-600" },
    { label: isRTL?"دفعة جديدة":"New Payment", icon: CreditCard, href: "/payments/new", color: "bg-amber-500 hover:bg-amber-600" },
  ]

  const maxVal = Math.max(...earningsData.map(d=>d.value), 1)
  const donutColors = ["#18181b","#dc2626","#e4e4e7"]
  const donutLabels = isRTL?["مؤجرة","معلقة","ملغاة"]:["Hired","Pending","Cancelled"]

  return (
    <DashboardLayout>
      <div className="min-h-screen bg-[#f0f2f5]" dir={isRTL?"rtl":"ltr"}>
        <div className="p-6 space-y-5">

          {/* ═══════════════════════════════════════════════════════════════
              QUICK ACTIONS GRID
          ═══════════════════════════════════════════════════════════════ */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {quickActions.map((action, i) => (
              <Link key={i} href={action.href} className={`${action.color} text-white rounded-2xl p-4 shadow-lg transition-all hover:scale-[1.02] active:scale-[0.98] group`}>
                <div className="flex items-center justify-between mb-3">
                  <action.icon className="w-6 h-6 opacity-80" />
                  <Plus className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                <p className="text-sm font-bold">{action.label}</p>
              </Link>
            ))}
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {kpis.map((kpi,i)=>(
              <Link key={i} href={kpi.href} className="bg-white rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-xl bg-red-50 flex items-center justify-center">
                    <kpi.icon className="w-4 h-4 text-red-500" />
                  </div>
                  <span className="text-xs text-slate-400 font-semibold">{kpi.label}</span>
                </div>
                <div className="flex items-end justify-between">
                  <span className="text-xl font-black text-slate-800">{kpi.value}</span>
                  <span className={`text-xs font-bold px-2 py-1 rounded-lg ${kpi.up?"bg-green-50 text-green-600":"bg-red-50 text-red-500"}`}>{kpi.delta}</span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">{isRTL?"من الاسبوع الماضي":"from last week"}</p>
              </Link>
            ))}
          </div>

          {/* Revenue reconciliation: recognised revenue reconciles with the sales
              documents. Gross includes VAT; net excludes VAT; returns are contra. */}
          <div className="bg-white rounded-2xl p-4 shadow-sm flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <span className="font-bold text-slate-700">{isRTL?"مطابقة الإيرادات":"Revenue reconciliation"}</span>
            <span className="text-slate-500">{isRTL?"إجمالي الفواتير (مع الضريبة)":"Invoices gross (incl. VAT)"}: <span className="font-mono font-semibold text-slate-700">{formatCurrency(revenueInfo.gross)}</span></span>
            <span className="text-slate-500">{isRTL?"ضريبة القيمة المضافة":"VAT"}: <span className="font-mono font-semibold text-slate-700">{formatCurrency(revenueInfo.vat)}</span></span>
            <span className="text-slate-500">{isRTL?"الإيراد الصافي":"Net revenue"}: <span className="font-mono font-semibold text-emerald-600">{formatCurrency(stats.revenue)}</span></span>
            <span className="text-slate-500">{isRTL?"المرتجعات":"Returns"}: <span className="font-mono font-semibold text-red-500">{formatCurrency(revenueInfo.returns)}</span></span>
            <span className="text-slate-500">{isRTL?"الصافي بعد المرتجعات":"Net after returns"}: <span className="font-mono font-semibold text-slate-800">{formatCurrency(revenueInfo.netAfterReturns)}</span></span>
          </div>

          {/* ═══════════════════════════════════════════════════════════════
              ALERTS & RECENT ACTIVITY
          ═══════════════════════════════════════════════════════════════ */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Alerts */}
            <div className="bg-white rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-black text-slate-800 flex items-center gap-2">
                  <Bell className="w-5 h-5 text-amber-500" />
                  {isRTL?"تنبيهات":"Alerts"}
                </h3>
                {alerts.length > 0 && <Badge className="bg-red-100 text-red-600">{alerts.length}</Badge>}
              </div>
              {alerts.length === 0 ? (
                <div className="text-center py-6 text-slate-400 text-sm">
                  <Shield className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  {isRTL?"لا توجد تنبيهات":"No alerts"}
                </div>
              ) : (
                <div className="space-y-2">
                  {alerts.map((alert, i) => (
                    <div key={i} className={`flex items-center gap-3 p-3 rounded-xl ${alert.type === 'danger' ? 'bg-red-50 border border-red-100' : 'bg-amber-50 border border-amber-100'}`}>
                      <alert.icon className={`w-5 h-5 flex-shrink-0 ${alert.type === 'danger' ? 'text-red-500' : 'text-amber-500'}`} />
                      <p className={`text-sm font-medium ${alert.type === 'danger' ? 'text-red-700' : 'text-amber-700'}`}>{alert.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Activity */}
            <div className="lg:col-span-2 bg-white rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-black text-slate-800 flex items-center gap-2">
                  <Clock className="w-5 h-5 text-cyan-500" />
                  {isRTL?"آخر النشاطات":"Recent Activity"}
                </h3>
                <Link href="/rentals" className="text-xs text-red-500 font-bold hover:underline flex items-center gap-1">
                  {isRTL?"عرض الكل":"View All"} <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
              {recentActivity.length === 0 ? (
                <div className="text-center py-6 text-slate-400 text-sm">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  {isRTL?"لا توجد نشاطات حديثة":"No recent activity"}
                </div>
              ) : (
                <div className="space-y-2">
                  {recentActivity.slice(0, 5).map((activity: any, i: number) => (
                    <div key={i} className="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors border border-transparent hover:border-slate-100">
                      <div className="w-10 h-10 rounded-xl bg-cyan-50 flex items-center justify-center flex-shrink-0">
                        <FileText className="w-5 h-5 text-cyan-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate">
                          {isRTL ? `عقد جديد - ${activity.customers?.full_name || 'عميل'}` : `New Contract - ${activity.customers?.full_name || 'Customer'}`}
                        </p>
                        <p className="text-xs text-slate-400 flex items-center gap-1">
                          <Car className="w-3 h-3" />
                          {activity.cars?.make} {activity.cars?.model} - {activity.cars?.plate_number}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-xs text-slate-400">{new Date(activity.created_at).toLocaleDateString(isRTL ? 'ar-BH' : 'en-US')}</p>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${activity.status === 'active' ? 'bg-green-50 text-green-600' : activity.status === 'pending' ? 'bg-amber-50 text-amber-600' : 'bg-slate-50 text-slate-500'}`}>
                          {activity.status === 'active' ? (isRTL ? 'نشط' : 'Active') : activity.status === 'pending' ? (isRTL ? 'معلق' : 'Pending') : (isRTL ? 'منتهي' : 'Ended')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white rounded-2xl p-5 shadow-sm">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-base font-black text-slate-800">{isRTL?"ملخص الايرادات":"Earnings Summary"}</h3>
                <span className="text-xs text-slate-400 bg-slate-50 px-3 py-1 rounded-lg">{isRTL?"اخر 8 اشهر":"Last 8 Months"}</span>
              </div>
              <div className="flex items-end gap-2 h-48 px-2">
                {earningsData.map((d,i)=>(
                  <div key={i} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full rounded-t-lg bg-gradient-to-t from-red-600 to-red-400" style={{height:`${Math.max(4,(d.value/maxVal)*160)}px`}}></div>
                    <span className="text-[10px] text-slate-400 font-medium">{d.month}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-2xl p-5 shadow-sm">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-base font-black text-slate-800">{isRTL?"حالة التاجير":"Rent Status"}</h3>
                <span className="text-xs text-slate-400 bg-slate-50 px-3 py-1 rounded-lg">{isRTL?"هذا الاسبوع":"This Week"}</span>
              </div>
              <div className="flex justify-center my-3">
                <div className="w-36 h-36 rounded-full flex items-center justify-center" style={{background:`conic-gradient(#18181b 0% ${rentStatus[0]}%, #dc2626 ${rentStatus[0]}% ${rentStatus[0]+rentStatus[1]}%, #e4e4e7 ${rentStatus[0]+rentStatus[1]}% 100%)`}}>
                  <div className="w-20 h-20 bg-white rounded-full"></div>
                </div>
              </div>
              <div className="space-y-2 mt-2">
                {donutLabels.map((label,i)=>(
                  <div key={i} className="flex justify-between items-center text-sm">
                    <span className="flex items-center gap-2 text-slate-500">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{background:donutColors[i]}}></span>
                      {label}
                    </span>
                    <span className="font-black text-slate-700">{rentStatus[i]}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Cars Table + Side Panel */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm overflow-hidden">
              <div className="flex justify-between items-center p-5 pb-3">
                <h3 className="text-base font-black text-slate-800">{isRTL?"المركبات الحالية":"All Current Vehicles"}</h3>
                <Link href="/cars" className="text-xs text-red-500 font-bold hover:underline">{isRTL?"عرض الكل":"View All"}</Link>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-50">
                    {[isRTL?"المركبة":"Vehicle",isRTL?"اللوحة":"Plate",isRTL?"السعر اليومي":"Daily Rate",isRTL?"الحالة":"Status"].map((h,i)=>(
                      <th key={i} className="text-start px-5 py-2 text-[11px] text-slate-400 font-bold uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cars.length===0?(
                    <tr><td colSpan={4} className="text-center py-8 text-slate-400 text-sm">{isRTL?"لا توجد بيانات":"No data"}</td></tr>
                  ):cars.map((car:any)=>(
                    <tr key={car.id} className="border-b border-slate-50 hover:bg-slate-50/50">
                      <td className="px-5 py-3 text-sm font-semibold text-slate-700">{car.make} {car.model}</td>
                      <td className="px-5 py-3 text-sm text-slate-500">{car.plate_number}</td>
                      <td className="px-5 py-3 text-sm text-slate-500">{car.daily_rate?car.daily_rate+" BHD":"--"}</td>
                      <td className="px-5 py-3">
                        <span className={`text-[11px] font-bold px-3 py-1 rounded-full ${car.status==="available"?"bg-green-50 text-green-600":car.status==="rented"?"bg-red-50 text-red-500":"bg-amber-50 text-amber-600"}`}>
                          {car.status==="available"?(isRTL?"متاحة":"Available"):car.status==="rented"?(isRTL?"مؤجرة":"Rented"):(isRTL?"صيانة":"Maintenance")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-4">
              <div className="bg-slate-900 rounded-2xl p-5 text-white">
                <h3 className="text-base font-black mb-4">{isRTL?"توفر السيارات":"Car Availability"}</h3>
                <div className="space-y-3">
                  <div><label className="text-xs text-slate-400 block mb-1">{isRTL?"نوع السيارة":"Car Type"}</label><div className="bg-slate-800 rounded-xl px-3 py-2.5 text-sm text-slate-300">SUV</div></div>
                  <div><label className="text-xs text-slate-400 block mb-1">{isRTL?"التاريخ":"Date"}</label><div className="bg-slate-800 rounded-xl px-3 py-2.5 text-sm text-slate-300">{new Date().toLocaleDateString()}</div></div>
                  <div><label className="text-xs text-slate-400 block mb-1">{isRTL?"الوقت":"Time"}</label><div className="bg-slate-800 rounded-xl px-3 py-2.5 text-sm text-slate-300">10:00 AM</div></div>
                  <Link href="/cars?status=available" className="block w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-xl text-sm text-center transition-colors">{isRTL?"تحقق":"Check"}</Link>
                </div>
              </div>
              <div className="bg-white rounded-2xl p-5 shadow-sm">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-base font-black text-slate-800">{isRTL?"انواع السيارات":"Car Types"}</h3>
                  <MoreHorizontal className="w-5 h-5 text-slate-400" />
                </div>
                <div className="space-y-3">
                  {carTypes.length===0?(
                    <div className="text-sm text-slate-400 text-center py-4">{isRTL?"لا توجد بيانات":"No data"}</div>
                  ):carTypes.map((ct,i)=>(
                    <div key={i} className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center flex-shrink-0">
                        <Car className="w-5 h-5 text-slate-500" />
                      </div>
                      <div className="flex-1">
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-semibold text-slate-700 capitalize">{ct.name}</span>
                          <span className="font-black text-slate-600">{ct.pct}%</span>
                        </div>
                        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className={`h-1.5 rounded-full ${i%2===0?"bg-slate-800":"bg-red-500"}`} style={{width:ct.pct+"%"}}></div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f0f2f5] flex items-center justify-center"><div className="w-10 h-10 bg-red-600 rounded-xl animate-pulse"></div></div>}>
      <DashboardContent />
    </Suspense>
  )
}
