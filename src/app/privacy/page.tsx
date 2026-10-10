"use client"

import { useLanguage } from "@/lib/LanguageContext"
import MarketingNavbar from "@/components/MarketingNavbar"
import MarketingFooter from "@/components/MarketingFooter"

export default function PrivacyPage() {
  const { isRTL } = useLanguage()
  return (
    <div className="min-h-screen bg-white" dir={isRTL ? "rtl" : "ltr"}>
      <MarketingNavbar />
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-black tracking-tight text-slate-900">
          {isRTL ? "سياسة الخصوصية" : "Privacy Policy"}
        </h1>
        <div className="mt-8 space-y-6 text-sm leading-relaxed text-slate-600">
          <p>
            {isRTL
              ? "نحن نجمع الحد الأدنى من البيانات اللازمة لتشغيل حسابك: الاسم والبريد الإلكتروني واسم الشركة، إضافة إلى البيانات التي تدخلها في النظام."
              : "We collect the minimum data needed to operate your account: your name, email address and company name, plus the data you enter into the system."}
          </p>
          <p>
            {isRTL
              ? "تُعزل بيانات كل شركة عن غيرها، ولا يمكن لمستخدم شركة الوصول إلى بيانات شركة أخرى."
              : "Each company's data is isolated from every other company, and a user of one company cannot access another company's data."}
          </p>
          <p>
            {isRTL
              ? "نستخدم بياناتك فقط لتقديم الخدمة. لا نبيع بياناتك."
              : "We use your data only to provide the service. We do not sell your data."}
          </p>
          <p>
            {isRTL
              ? "يمكنك التواصل معنا لأي استفسار متعلق بالخصوصية."
              : "You can contact us for any privacy-related question."}
          </p>
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}
