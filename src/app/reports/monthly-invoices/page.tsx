"use client"
export const dynamic = "force-dynamic"

import OperationsReportPage from '@/components/reports/OperationsReportPage'

export default function Page() {
  return (
    <OperationsReportPage
      kind="monthly_invoices"
      titleAr="الفواتير / الخصومات حسب الشهر"
      titleEn="Invoice / Credit by Month"
    />
  )
}
