"use client"
export const dynamic = "force-dynamic"

import { Suspense } from "react"
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'
import { BarChart3, TrendingUp, TrendingDown, DollarSign, FileText } from 'lucide-react'

type Summary = {
  totalRevenue: number
  totalExpenses: number
  netProfit: number
  totalAssets: number
  totalLiabilities: number
  totalEquity: number
}

function PageContent() {
  const { isRTL } = useLanguage()
  const [summary, setSummary] = useState<Summary>({ totalRevenue: 0, totalExpenses: 0, netProfit: 0, totalAssets: 0, totalLiabilities: 0, totalEquity: 0 })
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'income' | 'balance' | 'cashflow'>('income')

  const fetchData = async () => {
    setLoading(true)
    const [rentalsRes, expensesRes, paymentsRes] = await Promise.all([
      supabase.from('rental_contracts').select('total_amount').eq('status', 'completed'),
      supabase.from('expenses').select('amount'),
      supabase.from('payments').select('amount'),
    ])
    const totalRevenue = (rentalsRes.data || []).reduce((s: number, r: any) => s + (r.total_amount || 0), 0)
    const totalExpenses = (expensesRes.data || []).reduce((s: number, e: any) => s + (e.amount || 0), 0)
    const netProfit = totalRevenue - totalExpenses
    setSummary({ totalRevenue, totalExpenses, netProfit, totalAssets: totalRevenue, totalLiabilities: totalExpenses, totalEquity: netProfit })
    setLoading(false)
  }

  useEffect(() => { fetchData() }, [])

  const tabs = [
    { key: 'income', ar: 'قائمة الدخل', en: 'Income Statement' },
    { key: 'balance', ar: 'الميزانية العمومية', en: 'Balance Sheet' },
    { key: 'cashflow', ar: 'التدفقات النقدية', en: 'Cash Flow' },
  ]

  const cards = [
    { label: isRTL ? 'إجمالي الإيرادات' : 'Total Revenue', value: summary.totalRevenue, icon: TrendingUp, color: 'from-emerald-500 to-green-600', textColor: 'text-emerald-600' },
    { label: isRTL ? 'إجمالي المصروفات' : 'Total Expenses', value: summary.totalExpenses, icon: TrendingDown, color: 'from-red-500 to-rose-600', textColor: 'text-red-600' },
    { label: isRTL ? 'صافي الربح' : 'Net Profit', value: summary.netProfit, icon: DollarSign, color: 'from-blue-500 to-indigo-600', textColor: summary.netProfit >= 0 ? 'text-emerald-600' : 'text-red-600' },
  ]

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-lg">
            <BarChart3 className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
              {isRTL ? 'التقارير المالية' : 'Financial Reports'}
            </h1>
            <p className="text-sm text-slate-500">{isRTL ? 'نظرة شاملة على الوضع المالي' : 'Comprehensive financial overview'}</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {cards.map((card) => (
                <div key={card.label} className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm text-slate-500 dark:text-slate-400">{card.label}</p>
                    <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${card.color} flex items-center justify-center text-white`}>
                      <card.icon className="w-5 h-5" />
                    </div>
                  </div>
                  <p className={`text-2xl font-bold ${card.textColor}`}>
                    {card.value.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}
                  </p>
                </div>
              ))}
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700">
              <div className="flex border-b border-slate-200 dark:border-slate-700">
                {tabs.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key as any)}
                    className={`flex-1 py-4 text-sm font-medium transition-colors ${activeTab === tab.key ? 'text-blue-600 border-b-2 border-blue-600' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    {isRTL ? tab.ar : tab.en}
                  </button>
                ))}
              </div>

              <div className="p-6">
                {activeTab === 'income' && (
                  <div className="space-y-4">
                    <h3 className="font-bold text-slate-900 dark:text-white text-lg">{isRTL ? 'قائمة الدخل' : 'Income Statement'}</h3>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center py-3 border-b border-slate-100 dark:border-slate-700">
                        <span className="text-slate-600 dark:text-slate-300">{isRTL ? 'إيرادات التأجير' : 'Rental Revenue'}</span>
                        <span className="font-semibold text-emerald-600">{summary.totalRevenue.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}</span>
                      </div>
                      <div className="flex justify-between items-center py-3 border-b border-slate-100 dark:border-slate-700">
                        <span className="text-slate-600 dark:text-slate-300">{isRTL ? 'المصروفات التشغيلية' : 'Operating Expenses'}</span>
                        <span className="font-semibold text-red-600">({summary.totalExpenses.toFixed(3)}) {isRTL ? 'د.ب' : 'BHD'}</span>
                      </div>
                      <div className="flex justify-between items-center py-3 bg-slate-50 dark:bg-slate-700/50 rounded-xl px-3">
                        <span className="font-bold text-slate-900 dark:text-white">{isRTL ? 'صافي الربح' : 'Net Profit'}</span>
                        <span className={`font-bold text-lg ${summary.netProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {summary.netProfit.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'balance' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <h3 className="font-bold text-slate-900 dark:text-white mb-4">{isRTL ? 'الأصول' : 'Assets'}</h3>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center py-3 border-b border-slate-100 dark:border-slate-700">
                          <span className="text-slate-600 dark:text-slate-300">{isRTL ? 'أصول متداولة' : 'Current Assets'}</span>
                          <span className="font-semibold">{summary.totalRevenue.toFixed(3)}</span>
                        </div>
                        <div className="flex justify-between items-center py-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl px-3">
                          <span className="font-bold text-slate-900 dark:text-white">{isRTL ? 'إجمالي الأصول' : 'Total Assets'}</span>
                          <span className="font-bold text-blue-600">{summary.totalAssets.toFixed(3)}</span>
                        </div>
                      </div>
                    </div>
                    <div>
                      <h3 className="font-bold text-slate-900 dark:text-white mb-4">{isRTL ? 'الالتزامات وحقوق الملكية' : 'Liabilities & Equity'}</h3>
                      <div className="space-y-2">
                        <div className="flex justify-between items-center py-3 border-b border-slate-100 dark:border-slate-700">
                          <span className="text-slate-600 dark:text-slate-300">{isRTL ? 'الالتزامات' : 'Liabilities'}</span>
                          <span className="font-semibold text-red-600">{summary.totalLiabilities.toFixed(3)}</span>
                        </div>
                        <div className="flex justify-between items-center py-3 border-b border-slate-100 dark:border-slate-700">
                          <span className="text-slate-600 dark:text-slate-300">{isRTL ? 'حقوق الملكية' : 'Equity'}</span>
                          <span className="font-semibold text-emerald-600">{summary.totalEquity.toFixed(3)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'cashflow' && (
                  <div className="space-y-4">
                    <h3 className="font-bold text-slate-900 dark:text-white text-lg">{isRTL ? 'التدفقات النقدية' : 'Cash Flow Statement'}</h3>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center py-3 border-b border-slate-100 dark:border-slate-700">
                        <span className="text-slate-600 dark:text-slate-300">{isRTL ? 'تدفقات من العمليات' : 'Cash from Operations'}</span>
                        <span className="font-semibold text-emerald-600">+{summary.totalRevenue.toFixed(3)}</span>
                      </div>
                      <div className="flex justify-between items-center py-3 border-b border-slate-100 dark:border-slate-700">
                        <span className="text-slate-600 dark:text-slate-300">{isRTL ? 'مدفوعات للموردين' : 'Payments to Suppliers'}</span>
                        <span className="font-semibold text-red-600">-{summary.totalExpenses.toFixed(3)}</span>
                      </div>
                      <div className="flex justify-between items-center py-3 bg-slate-50 dark:bg-slate-700/50 rounded-xl px-3">
                        <span className="font-bold text-slate-900 dark:text-white">{isRTL ? 'صافي التدفق النقدي' : 'Net Cash Flow'}</span>
                        <span className={`font-bold text-lg ${summary.netProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {summary.netProfit.toFixed(3)} {isRTL ? 'د.ب' : 'BHD'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end">
              <button className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm font-medium transition-colors">
                <FileText className="w-4 h-4" />
                {isRTL ? 'تصدير PDF' : 'Export PDF'}
              </button>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageContent />
    </Suspense>
  )
}
