"use client"
export const dynamic = "force-dynamic"

import PurchasingReportPage from '@/components/reports/PurchasingReportPage'

export default function Page() {
  return (
    <PurchasingReportPage
      kind="supplier_aging"
      titleAr="أعمار أرصدة الموردين"
      titleEn="Supplier Aging"
    />
  )
}
