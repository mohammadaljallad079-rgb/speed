"use client"
export const dynamic = "force-dynamic"

import PurchasingReportPage from '@/components/reports/PurchasingReportPage'

export default function Page() {
  return (
    <PurchasingReportPage
      kind="monthly_expenses"
      titleAr="المصروفات الشهرية"
      titleEn="Monthly Expenses"
    />
  )
}
