"use client"
export const dynamic = "force-dynamic"

import { Suspense } from "react"
import DashboardLayout from '@/components/DashboardLayout'
import StructuredEmptyState from '@/components/StructuredEmptyState'
import { useLanguage } from '@/lib/LanguageContext'

function PageContent() {
  const { t } = useLanguage()

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <StructuredEmptyState title={t.activeVehiclesTrafficDepartment} />
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
