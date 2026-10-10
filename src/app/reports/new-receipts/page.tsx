"use client"
export const dynamic = "force-dynamic"

import { Suspense } from 'react'
import DashboardLayout from '@/components/DashboardLayout'
import StructuredEmptyState from '@/components/StructuredEmptyState'
import { useLanguage } from '@/lib/LanguageContext'

function NewReceiptsContent() {
  const { t } = useLanguage()
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <StructuredEmptyState title={t.newReceiptsByMonth} />
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <NewReceiptsContent />
    </Suspense>
  )
}
