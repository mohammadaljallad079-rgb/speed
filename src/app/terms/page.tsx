"use client"

import { useLanguage } from "@/lib/LanguageContext"
import MarketingNavbar from "@/components/MarketingNavbar"
import MarketingFooter from "@/components/MarketingFooter"

export default function TermsPage() {
  const { isRTL } = useLanguage()
  return (
    <div className="min-h-screen bg-white" dir={isRTL ? "rtl" : "ltr"}>
      <MarketingNavbar />
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-black tracking-tight text-slate-900">
          {isRTL ? "شروط الاستخدام" : "Terms of Service"}
        </h1>
        <div className="mt-8 space-y-6 text-sm leading-relaxed text-slate-600">
          <p>
            {isRTL
              ? "باستخدامك SPEED ERP فإنك توافق على استخدام النظام لأغراض مشروعة فقط، وعلى مسؤوليتك عن دقة البيانات التي تدخلها."
              : "By using SPEED ERP you agree to use the system only for lawful purposes and to be responsible for the accuracy of the data you enter."}
          </p>
          <p>
            {isRTL
              ? "أنت مسؤول عن الحفاظ على سرية بيانات الدخول الخاصة بحسابك."
              : "You are responsible for keeping your account credentials confidential."}
          </p>
          <p>
            {isRTL
              ? "الخطة المجانية متاحة كما هي، وقد تتغير الميزات المتاحة بمرور الوقت."
              : "The free plan is provided as-is, and available features may change over time."}
          </p>
          <p>
            {isRTL
              ? "لا يتضمن النظام إدارة مخزون."
              : "The system does not include inventory management."}
          </p>
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}
