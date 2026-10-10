"use client"
export const dynamic = "force-dynamic"

import { Suspense } from "react"
import Link from "next/link"
import DashboardLayout from "@/components/DashboardLayout"
import { useLanguage } from "@/lib/LanguageContext"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Car, FileText } from "lucide-react"

function NewQuotationChoice() {
  const { isRTL } = useLanguage()

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto space-y-6" dir={isRTL ? "rtl" : "ltr"}>
        <div className="flex items-center gap-4">
          <Link href="/quotations">
            <Button variant="outline" size="icon">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          </Link>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            {isRTL ? "إنشاء عرض سعر جديد" : "Create New Quotation"}
          </h1>
        </div>

        <p className="text-slate-500 text-center">
          {isRTL ? "اختر نوع عرض السعر:" : "Select quotation type:"}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Link href="/quotations/new/rental">
            <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full">
              <CardContent className="p-8 flex flex-col items-center text-center gap-4">
                <div className="w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                  <Car className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {isRTL ? "عرض سعر تأجير سيارة" : "Car Rental Quotation"}
                  </h3>
                  <p className="text-sm text-slate-500 mt-1">
                    {isRTL ? "عرض سعر لتأجير سيارة لعميل" : "Quotation for car rental to a customer"}
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/quotations/new/general">
            <Card className="cursor-pointer hover:shadow-lg transition-shadow h-full">
              <CardContent className="p-8 flex flex-col items-center text-center gap-4">
                <div className="w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                  <FileText className="w-8 h-8 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {isRTL ? "عرض سعر عام" : "General Quotation"}
                  </h3>
                  <p className="text-sm text-slate-500 mt-1">
                    {isRTL ? "عرض سعر لأي خدمة أو منتج" : "Quotation for any service or product"}
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>
        </div>
      </div>
    </DashboardLayout>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-8 text-center">Loading...</div>}>
      <NewQuotationChoice />
    </Suspense>
  )
}
