"use client"

import { FileSearch } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useLanguage } from '@/lib/LanguageContext'

type Props = {
  title: string
  description?: string
}

export default function StructuredEmptyState({ title, description }: Props) {
  const { isRTL } = useLanguage()

  return (
    <Card className="rounded-2xl border border-slate-200 dark:border-slate-700">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {description || (isRTL ? 'لا توجد بيانات حالياً لهذه الصفحة.' : 'No records available for this page yet.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="py-10">
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-600 p-8 text-center bg-slate-50/60 dark:bg-slate-900/40">
          <FileSearch className="mx-auto mb-3 h-10 w-10 text-slate-400" />
          <p className="font-medium text-slate-700 dark:text-slate-200">
            {isRTL ? 'يمكنك البدء بإضافة بيانات لعرض النتائج هنا.' : 'Add data to start seeing results here.'}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
