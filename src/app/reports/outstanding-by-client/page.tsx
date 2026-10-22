"use client"
export const dynamic = "force-dynamic"

import OperationsReportPage from '@/components/reports/OperationsReportPage'

export default function Page() {
  return (
    <OperationsReportPage
      kind="outstanding_by_client"
      titleAr="الفواتير / الخصومات المستحقة حسب العميل"
      titleEn="Outstanding Invoices / Credits by Client"
    />
  )
}
