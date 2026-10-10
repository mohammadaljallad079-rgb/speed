"use client"

import Link from "next/link"
import { useLanguage } from "@/lib/LanguageContext"
import MarketingNavbar from "@/components/MarketingNavbar"
import MarketingFooter from "@/components/MarketingFooter"

const SOLUTIONS = [
  { ar: "التجارة والتجزئة", en: "Retail & Trading", dAr: "فواتير ومبيعات ومخزون مالي (بدون تتبع مخزون).", dEn: "Invoices, sales and financial tracking (no stock tracking)." },
  { ar: "الخدمات", en: "Services", dAr: "عروض أسعار وفواتير ومتابعة العملاء.", dEn: "Quotations, invoices and customer follow-up." },
  { ar: "الشركات الصغيرة", en: "Small Businesses", dAr: "محاسبة ومصروفات وتقارير بسيطة.", dEn: "Accounting, expenses and simple reporting." },
  { ar: "الشركات متعددة الفروع", en: "Multi-Branch Companies", dAr: "فروع متعددة مع عزل بيانات كل شركة.", dEn: "Multiple branches with per-company isolation." },
]

export default function SolutionsPage() {
  const { isRTL } = useLanguage()
  return (
    <div className="min-h-screen bg-white" dir={isRTL ? "rtl" : "ltr"}>
      <MarketingNavbar />
      <main className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-black tracking-tight text-slate-900">
          {isRTL ? "الحلول" : "Solutions"}
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          {isRTL
            ? "SPEED ERP يناسب أنواعًا مختلفة من الأعمال."
            : "SPEED ERP fits different kinds of businesses."}
        </p>
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
          {SOLUTIONS.map((s, i) => (
            <div key={i} className="rounded-2xl border border-slate-200 p-6">
              <h2 className="font-bold text-slate-900">{isRTL ? s.ar : s.en}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{isRTL ? s.dAr : s.dEn}</p>
            </div>
          ))}
        </div>
        <div className="mt-12 rounded-2xl bg-slate-900 p-8 text-center">
          <p className="text-lg font-bold text-white">
            {isRTL ? "جاهز للبدء؟" : "Ready to get started?"}
          </p>
          <Link
            href="/signup"
            className="mt-5 inline-block rounded-xl bg-red-600 px-7 py-3.5 text-base font-bold text-white transition hover:bg-red-700"
          >
            {isRTL ? "ابدأ مجانًا" : "Start Free"}
          </Link>
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}
