"use client"

import Link from "next/link"
import { useLanguage } from "@/lib/LanguageContext"
import MarketingNavbar from "@/components/MarketingNavbar"
import MarketingFooter from "@/components/MarketingFooter"
import { Check } from "lucide-react"

/**
 * Pricing page.
 *
 * Only the FREE plan is real and is shown as $0. No paid price is invented and no
 * payment flow is faked — paid plans are explicitly marked as not yet available.
 */
export default function PricingPage() {
  const { isRTL } = useLanguage()

  const freeFeatures = [
    isRTL ? "المحاسبة والقيود" : "Accounting & journal entries",
    isRTL ? "المبيعات والفواتير" : "Sales & invoices",
    isRTL ? "المدفوعات والمرتجعات" : "Payments & returns",
    isRTL ? "العملاء والموردون" : "Customers & suppliers",
    isRTL ? "المصروفات" : "Expenses",
    isRTL ? "التقارير المالية" : "Financial reports",
    isRTL ? "السنوات المالية والفروع" : "Financial years & branches",
    isRTL ? "استيراد/تصدير Excel" : "Excel import / export",
    isRTL ? "الأدوار والصلاحيات" : "Roles & permissions",
    isRTL ? "سجلات التدقيق" : "Audit logs",
  ]

  return (
    <div className="min-h-screen bg-white" dir={isRTL ? "rtl" : "ltr"}>
      <MarketingNavbar />
      <main className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-black tracking-tight text-slate-900">
          {isRTL ? "الأسعار" : "Pricing"}
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          {isRTL
            ? "ابدأ مجانًا. لا حاجة لبطاقة دفع."
            : "Start for free. No payment method required."}
        </p>

        <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* FREE */}
          <div className="rounded-2xl border-2 border-red-600 p-8">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-black text-slate-900">{isRTL ? "مجاني" : "Free"}</h2>
              <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-bold uppercase tracking-wide text-red-600">
                {isRTL ? "متاح الآن" : "Available now"}
              </span>
            </div>
            <div className="mt-6 flex items-baseline gap-2">
              <span className="text-5xl font-black text-slate-900">$0</span>
              <span className="text-slate-400">/ {isRTL ? "مجانًا" : "free"}</span>
            </div>
            <p className="mt-3 text-sm text-slate-500">
              {isRTL ? "لا حاجة لبطاقة دفع." : "No payment method required."}
            </p>
            <ul className="mt-6 space-y-3">
              {freeFeatures.map((f, i) => (
                <li key={i} className="flex items-start gap-3 text-sm text-slate-700">
                  <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href="/signup"
              className="mt-8 block rounded-xl bg-red-600 px-6 py-3.5 text-center text-base font-bold text-white transition hover:bg-red-700"
            >
              {isRTL ? "ابدأ مجانًا" : "Start Free"}
            </Link>
          </div>

          {/* PLACEHOLDERS — no invented prices */}
          {[0, 1].map((i) => (
            <div key={i} className="rounded-2xl border border-dashed border-slate-300 p-8">
              <h2 className="text-xl font-black text-slate-400">
                {isRTL ? "خطط مدفوعة" : "Paid plans"}
              </h2>
              <p className="mt-4 text-sm text-slate-500">
                {isRTL
                  ? "خطط مدفوعة قادمة قريبًا."
                  : "Paid plans coming soon."}
              </p>
              <Link
                href="/contact"
                className="mt-6 inline-block rounded-xl border border-slate-300 px-6 py-3 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
              >
                {isRTL ? "تواصل معنا" : "Contact us"}
              </Link>
            </div>
          ))}
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}
