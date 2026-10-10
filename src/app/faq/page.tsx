"use client"

import Link from "next/link"
import { useLanguage } from "@/lib/LanguageContext"
import MarketingNavbar from "@/components/MarketingNavbar"
import MarketingFooter from "@/components/MarketingFooter"

const FAQS = [
  { ar: "هل الخطة المجانية فعلًا مجانية؟", en: "Is the free plan really free?", aAr: "نعم، لا تحتاج بطاقة دفع للبدء.", aEn: "Yes, no payment method is required to start." },
  { ar: "كيف أنشئ حسابًا؟", en: "How do I create an account?", aAr: "اضغط على «ابدأ مجانًا»، أدخل بياناتك واسم شركتك، ثم ابدأ.", aEn: "Click “Start Free”, enter your details and company name, then begin." },
  { ar: "هل بياناتي معزولة؟", en: "Is my data isolated?", aAr: "نعم، كل شركة معزولة على مستوى التطبيق وقاعدة البيانات (RLS).", aEn: "Yes — each company is isolated at the application and database (RLS) level." },
  { ar: "هل يدعم العربية؟", en: "Does it support Arabic?", aAr: "نعم، الواجهة تدعم العربية (RTL) والإنجليزية (LTR).", aEn: "Yes, the interface supports Arabic (RTL) and English (LTR)." },
  { ar: "هل يوجد تتبع مخزون؟", en: "Is there inventory tracking?", aAr: "لا. SPEED ERP نظام مالي/إداري ولا يتضمن إدارة مخزون حاليًا.", aEn: "No. SPEED ERP is a financial/management system and does not include inventory management." },
  { ar: "هل يمكنني إضافة فروع؟", en: "Can I add branches?", aAr: "نعم، يمكنك إعداد فرع واحد على الأقل أثناء التهيئة أو لاحقًا.", aEn: "Yes, you can set up at least one branch during onboarding or later." },
]

export default function FaqPage() {
  const { isRTL } = useLanguage()
  return (
    <div className="min-h-screen bg-white" dir={isRTL ? "rtl" : "ltr"}>
      <MarketingNavbar />
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-black tracking-tight text-slate-900">
          {isRTL ? "الأسئلة الشائعة" : "FAQ"}
        </h1>
        <div className="mt-10 space-y-3">
          {FAQS.map((f, i) => (
            <details key={i} className="rounded-xl border border-slate-200 p-5">
              <summary className="cursor-pointer list-none font-bold text-slate-900">
                {isRTL ? f.ar : f.en}
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">{isRTL ? f.aAr : f.aEn}</p>
            </details>
          ))}
        </div>
        <div className="mt-10 rounded-2xl bg-slate-50 p-6 text-center">
          <p className="text-slate-700">{isRTL ? "لم تجد إجابتك؟" : "Didn't find your answer?"}</p>
          <Link href="/contact" className="mt-3 inline-block font-bold text-red-600 hover:underline">
            {isRTL ? "تواصل معنا" : "Contact us"}
          </Link>
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}
