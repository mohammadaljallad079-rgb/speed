"use client"
export const dynamic = "force-dynamic"

import PurchasingReportPage from '@/components/reports/PurchasingReportPage'

export default function Page() {
  return (
    <PurchasingReportPage
      kind="purchase_register"
      titleAr="سجل المشتريات"
      titleEn="Purchase Register"
    />
  )
}
