"use client"
export const dynamic = "force-dynamic"

import OperationsReportPage from '@/components/reports/OperationsReportPage'

export default function Page() {
  return (
    <OperationsReportPage
      kind="monthly_receipts"
      titleAr="الإيصالات حسب الشهر"
      titleEn="Receipts By Month"
    />
  )
}
