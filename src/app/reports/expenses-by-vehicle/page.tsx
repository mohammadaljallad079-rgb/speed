"use client"
export const dynamic = "force-dynamic"

import PurchasingReportPage from '@/components/reports/PurchasingReportPage'

export default function Page() {
  return (
    <PurchasingReportPage
      kind="expenses_by_vehicle"
      titleAr="المصروفات حسب المركبة"
      titleEn="Expenses By Vehicle"
    />
  )
}
