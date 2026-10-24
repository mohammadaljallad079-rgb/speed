"use client"
export const dynamic = "force-dynamic"

import OperationsReportPage from '@/components/reports/OperationsReportPage'

export default function Page() {
  return (
    <OperationsReportPage
      kind="rented_vehicles"
      titleAr="المركبات في حالة الإيجار"
      titleEn="Vehicles in Rented Status"
    />
  )
}
