"use client"
import { Suspense } from 'react'
import { } from 'react'
export const dynamic = "force-dynamic"

import DashboardLayout from '@/components/DashboardLayout'
import StructuredEmptyState from '@/components/StructuredEmptyState'
import { useLanguage } from '@/lib/LanguageContext'

function PageContent() {
  const { t } = useLanguage()

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <StructuredEmptyState title={t.testSimon} />
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PageContent />
    </Suspense>
  )
}
