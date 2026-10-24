"use client"
import { Suspense } from 'react'
export const dynamic = "force-dynamic"
import { useRouter } from 'next/navigation'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Scale, TrendingUp, Building2, Banknote, ArrowRight, FileSpreadsheet, BarChart3, BookOpen } from 'lucide-react'

const reports = [
  { key: 'generalLedger', titleAr: 'دفتر الأستاذ العام', titleEn: 'General Ledger', descAr: 'حركة كل حساب مع الرصيد الجاري', descEn: 'Every account movement with a running balance', icon: BookOpen, href: '/reports/general-ledger', color: 'from-indigo-500 to-indigo-600', bgColor: 'bg-indigo-50', iconColor: 'text-indigo-600' },
  { key: 'trialBalance', titleAr: 'ميزان المراجعة', titleEn: 'Trial Balance', descAr: 'عرض جميع الحسابات مع الأرصدة المدينة والدائنة', descEn: 'View all accounts with debit and credit balances', icon: Scale, href: '/reports/trial-balance', color: 'from-blue-500 to-blue-600', bgColor: 'bg-blue-50', iconColor: 'text-blue-600' },
  { key: 'profitLoss', titleAr: 'قائمة الدخل', titleEn: 'Profit & Loss', descAr: 'الإيرادات والمصروفات وصافي الربح', descEn: 'Revenues, expenses and net profit', icon: TrendingUp, href: '/reports/profit-loss', color: 'from-emerald-500 to-emerald-600', bgColor: 'bg-emerald-50', iconColor: 'text-emerald-600' },
  { key: 'balanceSheet', titleAr: 'الميزانية العمومية', titleEn: 'Balance Sheet', descAr: 'الأصول والخصوم وحقوق الملكية', descEn: 'Assets, liabilities and equity', icon: Building2, href: '/reports/balance-sheet', color: 'from-violet-500 to-violet-600', bgColor: 'bg-violet-50', iconColor: 'text-violet-600' },
  { key: 'cashFlow', titleAr: 'التدفقات النقدية', titleEn: 'Cash Flow', descAr: 'الحركات النقدية الداخلة والخارجة', descEn: 'Cash inflows and outflows', icon: Banknote, href: '/reports/cash-flow', color: 'from-amber-500 to-amber-600', bgColor: 'bg-amber-50', iconColor: 'text-amber-600' }
]

function FinancialReportsContent() {
  const { isRTL } = useLanguage()
  const router = useRouter()
  return (
    <DashboardLayout>
      <div className="min-h-screen bg-[#f0f2f5]" dir={isRTL ? "rtl" : "ltr"}>
        <div className="p-6 max-w-6xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-black text-slate-900">{isRTL ? 'التقارير المالية' : 'Financial Reports'}</h1>
              <p className="text-sm text-slate-500 mt-1">{isRTL ? 'تقارير مالية احترافية مع تصدير Excel' : 'Professional financial reports with Excel export'}</p>
            </div>
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center shadow-lg">
              <BarChart3 className="w-6 h-6 text-white" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {reports.map((report) => {
              const Icon = report.icon
              return (
                <Card key={report.key} className="border-0 shadow-md hover:shadow-xl transition-all cursor-pointer group overflow-hidden" onClick={() => router.push(report.href)}>
                  <CardContent className="p-0">
                    <div className="flex">
                      <div className={`w-2 bg-gradient-to-b ${report.color}`} />
                      <div className="flex-1 p-6">
                        <div className="flex items-start justify-between">
                          <div className={`w-14 h-14 rounded-2xl ${report.bgColor} flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform`}>
                            <Icon className={`w-7 h-7 ${report.iconColor}`} />
                          </div>
                          <Button variant="ghost" size="icon" className="rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                            <ArrowRight className={`w-5 h-5 text-slate-400 ${isRTL ? 'rotate-180' : ''}`} />
                          </Button>
                        </div>
                        <div className="mt-4">
                          <h3 className="text-lg font-bold text-slate-900">{isRTL ? report.titleAr : report.titleEn}</h3>
                          <p className="text-sm text-slate-500 mt-1">{isRTL ? report.descAr : report.descEn}</p>
                        </div>
                        <div className="mt-4 flex items-center gap-2">
                          <FileSpreadsheet className="w-4 h-4 text-slate-400" />
                          <span className="text-xs text-slate-400">{isRTL ? 'تصدير Excel متاح' : 'Excel export available'}</span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function FinancialReportsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f0f2f5] flex items-center justify-center"><div className="w-10 h-10 bg-slate-800 rounded-xl animate-pulse" /></div>}>
      <FinancialReportsContent />
    </Suspense>
  )
}
