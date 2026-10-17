"use client"

import { Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import DashboardLayout from '@/components/DashboardLayout'
import ExcelImportPanel from '@/components/import/ExcelImportPanel'
import { useLanguage } from '@/lib/LanguageContext'

export const dynamic = 'force-dynamic'

function ImportContent() {
  const { isRTL } = useLanguage()
  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto p-4 space-y-6" dir={isRTL ? 'rtl' : 'ltr'}>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            {isRTL ? 'استيراد بيانات Excel' : 'Excel Data Import'}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {isRTL
              ? 'نزّل القالب، املأه، ثم اعرض المعاينة قبل الحفظ. يتم التحقق من الصلاحيات والعزل والمراجع تلقائيًا.'
              : 'Download the template, fill it, then preview before saving. Permissions, isolation and references are validated automatically.'}
          </p>
        </div>
        <ExcelImportPanel />
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>}>
      <ImportContent />
    </Suspense>
  )
}
