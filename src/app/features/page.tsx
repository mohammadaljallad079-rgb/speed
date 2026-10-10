"use client"

import { useLanguage } from "@/lib/LanguageContext"
import MarketingNavbar from "@/components/MarketingNavbar"
import MarketingFooter from "@/components/MarketingFooter"
import { Check } from "lucide-react"

const FEATURES = [
  { ar: "المحاسبة", en: "Accounting", dAr: "شجرة حسابات، قيود يومية، وترحيل مزدوج متوازن.", dEn: "Chart of accounts, journal entries and balanced double-entry posting." },
  { ar: "المبيعات والفواتير", en: "Sales & Invoices", dAr: "إصدار فواتير المبيعات مع ضريبة القيمة المضافة.", dEn: "Issue sales invoices with VAT." },
  { ar: "المدفوعات", en: "Payments", dAr: "تسجيل المقبوضات وتسوية الذمم المدينة.", dEn: "Record receipts and settle receivables." },
  { ar: "المرتجعات", en: "Returns", dAr: "مرتجعات المبيعات مع عكس الإيراد والضريبة.", dEn: "Sales returns that reverse revenue and VAT." },
  { ar: "العملاء", en: "Customers", dAr: "سجل العملاء وبياناتهم.", dEn: "Customer records and details." },
  { ar: "الموردون", en: "Suppliers", dAr: "سجل الموردين والمشتريات.", dEn: "Supplier records and purchases." },
  { ar: "المصروفات", en: "Expenses", dAr: "تسجيل المصروفات وربطها بحساباتها.", dEn: "Record expenses linked to their accounts." },
  { ar: "التقارير المالية", en: "Financial Reports", dAr: "ميزان المراجعة والميزانية والأرباح والخسائر.", dEn: "Trial balance, balance sheet and profit & loss." },
  { ar: "السنوات المالية", en: "Financial Years", dAr: "سنة مالية فعّالة مع منع الترحيل خارجها.", dEn: "Active financial year with posting guardrails." },
  { ar: "إدارة الفروع", en: "Branch Management", dAr: "فروع متعددة وربط العمليات بها.", dEn: "Multiple branches with transactions tied to them." },
  { ar: "استيراد/تصدير Excel", en: "Excel Import / Export", dAr: "استيراد بمعاينة قبل الحفظ وتصدير البيانات.", dEn: "Import with preview-before-save and data export." },
  { ar: "الأدوار والصلاحيات", en: "Roles & Permissions", dAr: "صلاحيات دقيقة تُفرض على الخادم.", dEn: "Fine-grained permissions enforced server-side." },
  { ar: "سجلات التدقيق", en: "Audit Logs", dAr: "تتبّع العمليات المهمة.", dEn: "Traceability for important operations." },
  { ar: "نظام متعدد الشركات", en: "Multi-Tenant", dAr: "كل شركة ببيانات معزولة تمامًا.", dEn: "Each company fully isolated." },
]

export default function FeaturesPage() {
  const { isRTL } = useLanguage()
  return (
    <div className="min-h-screen bg-white" dir={isRTL ? "rtl" : "ltr"}>
      <MarketingNavbar />
      <main className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-black tracking-tight text-slate-900">
          {isRTL ? "المميزات" : "Features"}
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          {isRTL
            ? "كل ما تحتاجه لإدارة المحاسبة والمبيعات والعملاء والتقارير في مكان واحد."
            : "Everything you need to manage accounting, sales, customers and reporting in one place."}
        </p>
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div key={i} className="rounded-2xl border border-slate-200 p-6">
              <div className="flex items-center gap-2">
                <Check className="h-5 w-5 text-red-600" />
                <h2 className="font-bold text-slate-900">{isRTL ? f.ar : f.en}</h2>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{isRTL ? f.dAr : f.dEn}</p>
            </div>
          ))}
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}
