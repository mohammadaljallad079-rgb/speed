"use client"
export const dynamic = "force-dynamic"

import PurchasingReportPage from '@/components/reports/PurchasingReportPage'

export default function Page() {
  return (
    <PurchasingReportPage
      kind="vat_purchases"
      titleAr="ضريبة المدخلات"
      titleEn="Input VAT"
    />
  )
}
