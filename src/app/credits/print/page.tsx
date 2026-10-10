"use client"
export const dynamic = "force-dynamic"
import { Suspense } from 'react'
import DashboardLayout from '@/components/DashboardLayout'
import StructuredEmptyState from '@/components/StructuredEmptyState'
import { useLanguage } from '@/lib/LanguageContext'
function Content() {
  const { t } = useLanguage()
  return <DashboardLayout><div className="space-y-6"><StructuredEmptyState title={t.printCreditNotes} /></div></DashboardLayout>
}
export default function Page() {
  return <Suspense fallback={<div>Loading...</div>}><Content /></Suspense>
}
