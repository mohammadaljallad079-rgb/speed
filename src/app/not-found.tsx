"use client"
import { Suspense } from 'react'
import Link from 'next/link'
import { Home, ArrowLeft, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import DashboardLayout from '@/components/DashboardLayout'
import { useLanguage } from '@/lib/LanguageContext'

function NotFoundContent() {
  const { t, isRTL } = useLanguage()
  return (
    <DashboardLayout>
      <div className="flex flex-col items-center justify-center min-h-[70vh] text-center space-y-6 animate-in fade-in zoom-in duration-500">
        <div className="w-24 h-24 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-full flex items-center justify-center mb-4">
          <AlertTriangle className="w-12 h-12" />
        </div>
        <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
          {isRTL ? 'الصفحة غير موجودة' : 'Page Not Found'}
        </h1>
        <p className="text-slate-500 dark:text-slate-400 max-w-md mx-auto">
          {isRTL
            ? 'عذراً، هذه الصفحة قيد التطوير حالياً أو تم نقلها. نرجو منك العودة لاحقاً.'
            : 'Sorry, this page is either under development or has been moved. Please try again later.'}
        </p>
        <div className="flex items-center gap-4 mt-8">
          <Button
            asChild
            variant="outline"
            className="rounded-xl px-6"
            onClick={() => window.history.back()}
          >
            <div className="flex items-center gap-2 cursor-pointer">
              <ArrowLeft className={`w-4 h-4 ${isRTL ? 'rotate-180' : ''}`} />
              {isRTL ? 'الرجوع' : 'Go Back'}
            </div>
          </Button>
          <Button asChild className="bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl px-6">
            <Link href="/" className="flex items-center gap-2">
              <Home className="w-4 h-4" />
              {isRTL ? 'الرئيسية' : 'Dashboard'}
            </Link>
          </Button>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function NotFound() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <NotFoundContent />
    </Suspense>
  )
}
