"use client"
import { Suspense } from 'react'
import { } from 'react'
export const dynamic = "force-dynamic"

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { 
  BarChart3, 
  Car, 
  FileText, 
  Users, 
  TrendingUp, 
  Settings,
  ArrowRight,
  PieChart,
  ClipboardList,
  Wrench,
  Receipt
} from 'lucide-react'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'

function ReportsHubContent() {
  const { isRTL, t } = useLanguage()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null

  const reportCategories = [
    {
      title: isRTL ? 'تقارير المركبات' : 'Vehicle Reports',
      description: isRTL ? 'تحليل مالي وفني لكل سيارة في الأسطول' : 'Financial and technical analysis for each vehicle',
      icon: <Car className="w-8 h-8 text-cyan-500" />,
      link: '/reports/cars',
      color: 'bg-cyan-500'
    },
    {
      title: isRTL ? 'تقرير أرقام الاتفاقيات' : 'Agreement Numbers',
      description: isRTL ? 'سجل تتبع أرقام الاتفاقيات والفواتير' : 'Tracking log for agreement and invoice numbers',
      icon: <ClipboardList className="w-8 h-8 text-violet-500" />,
      link: '/reports/numbers',
      color: 'bg-violet-500'
    },
    {
      title: isRTL ? 'سجل الصيانة' : 'Maintenance Log',
      description: isRTL ? 'تاريخ العمليات والمصروفات الفنية' : 'History of technical operations and expenses',
      icon: <Wrench className="w-8 h-8 text-rose-500" />,
      link: '/maintenance',
      color: 'bg-rose-500'
    },
    {
      title: isRTL ? 'تقارير المبيعات' : 'Sales Reports',
      description: isRTL ? 'تحليل عمليات البيع والأرباح المحققة' : 'Analysis of sales operations and realized profits',
      icon: <TrendingUp className="w-8 h-8 text-emerald-500" />,
      link: '/cars?status=sold',
      color: 'bg-emerald-500'
    },
    {
      title: isRTL ? 'كشوفات الحسابات' : 'Statements of Account',
      description: isRTL ? 'المبالغ المستحقة والمدفوعة لكل عميل' : 'Outstanding and paid amounts per client',
      icon: <Receipt className="w-8 h-8 text-amber-500" />,
      link: '/invoices',
      color: 'bg-amber-500'
    },
    {
      title: isRTL ? 'ربط المشتريات بالمبيعات الآجلة' : 'Purchase ↔ Credit-Sale Links',
      description: isRTL ? 'علاقات تحليلية بين المشتريات والمبيعات الآجلة (بدون مخزون)' : 'Analytical purchase/sale relationships (no inventory)',
      icon: <ClipboardList className="w-8 h-8 text-teal-500" />,
      link: '/reports/purchase-sale-links',
      color: 'bg-teal-500'
    },
    {
      title: isRTL ? 'تحليل الأداء العام' : 'Performance Analytics',
      description: isRTL ? 'نظرة عامة على إشغال الأسطول والنمو' : 'Overview of fleet occupancy and growth',
      icon: <PieChart className="w-8 h-8 text-blue-500" />,
      link: '/dashboard',
      color: 'bg-blue-500'
    }
  ]

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <header>
          <h1 className="text-4xl font-black text-slate-900 dark:text-white flex items-center gap-4">
            <BarChart3 className="w-10 h-10 text-cyan-500" />
            {isRTL ? 'مركز التقارير التحليلي' : 'Analytical Reports Hub'}
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-2 text-lg">
            {isRTL ? 'اختر التقرير المطلوب للحصول على بيانات دقيقة ومحدثة' : 'Select a report to get accurate and up-to-date data'}
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {reportCategories.map((report, idx) => (
            <Link 
              key={idx} 
              href={report.link}
              className="group relative bg-white dark:bg-slate-800 rounded-[32px] p-8 shadow-sm border border-slate-200 dark:border-slate-700 hover:shadow-2xl hover:-translate-y-2 transition-all duration-300 overflow-hidden"
            >
              <div className={`absolute top-0 ${isRTL ? 'left-0' : 'right-0'} w-32 h-32 ${report.color} opacity-5 rounded-full -mr-16 -mt-16 group-hover:scale-150 transition-transform duration-500`}></div>
              
              <div className="relative z-10">
                <div className="mb-6 p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/50 w-fit group-hover:scale-110 transition-transform duration-300">
                  {report.icon}
                </div>
                <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">{report.title}</h3>
                <p className="text-slate-500 dark:text-slate-400 leading-relaxed mb-6">
                  {report.description}
                </p>
                <div className="flex items-center gap-2 text-cyan-600 dark:text-cyan-400 font-bold">
                  <span>{isRTL ? 'عرض التقرير' : 'View Report'}</span>
                  <ArrowRight className={`w-5 h-5 transition-transform group-hover:translate-x-1 ${isRTL ? 'rotate-180 group-hover:-translate-x-1' : ''}`} />
                </div>
              </div>
            </Link>
          ))}
        </div>

        <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-[40px] p-12 text-white relative overflow-hidden">
           <div className="absolute bottom-0 right-0 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl -mb-48 -mr-48"></div>
           <div className="relative z-10 flex flex-col lg:flex-row items-center justify-between gap-12">
              <div className="max-w-xl">
                 <h2 className="text-3xl font-black mb-4">{isRTL ? 'تقارير مخصصة؟' : 'Need Custom Reports?'}</h2>
                 <p className="text-slate-400 text-lg leading-relaxed">
                   {isRTL ? 'إذا كنت بحاجة إلى تقارير إضافية أو تعديلات على التقارير الحالية، يمكنك التواصل مع فريق الدعم التقني لتخصيص النظام حسب احتياجاتك.' : 'If you need additional reports or modifications to existing ones, you can contact the technical support team to customize the system to your needs.'}
                 </p>
              </div>
              <Button size="lg" className="bg-cyan-500 hover:bg-cyan-600 text-white font-black px-12 py-8 rounded-2xl text-xl h-auto shadow-xl shadow-cyan-500/20">
                {isRTL ? 'طلب ميزة جديدة' : 'Request New Feature'}
              </Button>
           </div>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function ReportsHub() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ReportsHubContent />
    </Suspense>
  )
}
