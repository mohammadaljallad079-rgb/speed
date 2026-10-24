"use client"
export const dynamic = "force-dynamic"

import PurchasingReportPage from '@/components/reports/PurchasingReportPage'

export default function Page() {
  return (
    <PurchasingReportPage
      kind="vehicle_profitability"
      titleAr="ربحية المركبات"
      titleEn="Vehicle Profitability"
    />
  )
}
