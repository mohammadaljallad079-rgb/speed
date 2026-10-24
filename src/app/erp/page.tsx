"use client"

import Link from "next/link"
import { useLanguage } from "@/lib/LanguageContext"
import MarketingNavbar from "@/components/MarketingNavbar"
import MarketingFooter from "@/components/MarketingFooter"
import {
  BookOpen,
  Receipt,
  Users,
  BarChart3,
  CalendarRange,
  GitBranch,
  FileSpreadsheet,
  ShieldCheck,
  ScrollText,
  Building2,
  Lock,
  UserCheck,
  Database,
  Sparkles,
  Check,
  ArrowRight,
} from "lucide-react"

/**
 * SPEED ERP — public product page.
 *
 * This is an ADDITION to the car-rental website, not a replacement. Every claim
 * maps to a module that actually exists in the codebase; there is no invented
 * statistic, logo, testimonial or capability, and inventory is deliberately NOT
 * advertised because SPEED ERP does not have it. The page reads no ERP data.
 */

const FEATURES = [
  {
    icon: BookOpen,
    ar: "المحاسبة",
    en: "Accounting",
    dAr: "قيود اليومية، دفتر الأستاذ، ميزان المراجعة وتقارير مالية مترابطة.",
    dEn: "Journal entries, general ledger, trial balance and linked financial reports.",
  },
  {
    icon: Receipt,
    ar: "المبيعات والفواتير",
    en: "Sales & invoices",
    dAr: "دورة مبيعات كاملة: عروض أسعار، فواتير، مدفوعات ومرتجعات.",
    dEn: "A complete sales cycle: quotations, invoices, payments and returns.",
  },
  {
    icon: Users,
    ar: "العملاء والموردون",
    en: "Customers & suppliers",
    dAr: "سجل العملاء والموردين مع بيانات التواصل وأرصدة الحسابات.",
    dEn: "Customer and supplier records with contact details and account balances.",
  },
  {
    icon: BarChart3,
    ar: "التقارير المالية",
    en: "Financial reports",
    dAr: "تقارير الأرباح والخسائر والميزانية وحركة الحسابات.",
    dEn: "Profit & loss, balance sheet and account movement reports.",
  },
  {
    icon: FileSpreadsheet,
    ar: "استيراد وتصدير Excel",
    en: "Excel import / export",
    dAr: "استيراد وتصدير البيانات عبر Excel مع تحقق وحماية من التكرار.",
    dEn: "Import and export data through Excel with validation and duplicate protection.",
  },
  {
    icon: Building2,
    ar: "إدارة متعددة الشركات",
    en: "Multi-tenant management",
    dAr: "نظام سحابي متعدد الشركات مع عزل كامل لبيانات كل شركة.",
    dEn: "A multi-company cloud system with full isolation of each company's data.",
  },
  {
    icon: GitBranch,
    ar: "إدارة الفروع والسنوات المالية",
    en: "Branch & fiscal-year management",
    dAr: "فروع متعددة وسنوات مالية مع احترام سياق كل عملية.",
    dEn: "Multiple branches and financial years, each respected per transaction.",
  },
  {
    icon: UserCheck,
    ar: "أدوار المستخدمين والصلاحيات",
    en: "User roles & permissions",
    dAr: "أدوار وصلاحيات دقيقة تُطبَّق على الخادم لا في الواجهة فقط.",
    dEn: "Fine-grained roles and permissions enforced server-side, not just in the UI.",
  },
  {
    icon: Sparkles,
    ar: "قدرات الذكاء الاصطناعي",
    en: "AI capabilities",
    dAr: "تحليل ملفات Excel بالذكاء الاصطناعي لمساعدة الفرق المالية.",
    dEn: "AI-assisted Excel analysis to help finance teams work faster.",
  },
  {
    icon: ShieldCheck,
    ar: "الأمان وعزل البيانات",
    en: "Security & tenant isolation",
    dAr: "عزل بيانات الشركات، صلاحيات حسب الدور، سجلات تدقيق ومصادقة آمنة.",
    dEn: "Tenant isolation, role-based access, audit logs and secure authentication.",
  },
]

export default function ErpPage() {
  const { isRTL } = useLanguage()

  const security = [
    { icon: Building2, ar: "عزل بيانات الشركات", en: "Tenant isolation" },
    { icon: UserCheck, ar: "صلاحيات حسب الدور", en: "Role-based access" },
    { icon: ScrollText, ar: "سجلات تدقيق", en: "Audit logs" },
    { icon: Lock, ar: "مصادقة آمنة", en: "Secure authentication" },
    { icon: Database, ar: "حماية على مستوى قاعدة البيانات (RLS)", en: "Database-level RLS" },
  ]

  return (
    <div className="min-h-screen bg-white" dir={isRTL ? "rtl" : "ltr"}>
      <MarketingNavbar />

      {/* HERO */}
      <section className="relative overflow-hidden bg-slate-900">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(220,38,38,0.25),transparent_60%)]" />
        <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
          <div className="max-w-3xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-red-300">
              {isRTL ? "نظام إدارة الموارد" : "ERP Management System"}
            </span>
            <h1 className="mt-6 text-4xl font-black leading-tight tracking-tight text-white sm:text-5xl lg:text-6xl">
              {isRTL ? (
                <>
                  <span className="text-red-500">SPEED ERP</span> — نظام إدارة الأعمال
                </>
              ) : (
                <>
                  <span className="text-red-500">SPEED ERP</span> — ERP Management System
                </>
              )}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-300">
              {isRTL
                ? "المحاسبة والمبيعات والعملاء والمصروفات والتقارير وإدارة الأعمال في نظام سحابي آمن وموحد."
                : "Accounting, sales, customers, expenses, reports and business management — all in one secure cloud ERP."}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-7 py-3.5 text-base font-bold text-white shadow-lg shadow-red-600/30 transition hover:bg-red-700"
              >
                {isRTL ? "جرّب مجانًا الآن" : "Try Free Now"}
                <ArrowRight className={`h-5 w-5 ${isRTL ? "rotate-180" : ""}`} />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center rounded-xl border border-white/20 px-7 py-3.5 text-base font-bold text-white transition hover:bg-white/10"
              >
                {isRTL ? "تسجيل الدخول" : "Login"}
              </Link>
              <Link
                href="/customer-login"
                className="inline-flex items-center rounded-xl border border-white/20 px-7 py-3.5 text-base font-bold text-white transition hover:bg-white/10"
              >
                {isRTL ? "دخول العملاء" : "Customer Login"}
              </Link>
            </div>
            <p className="mt-4 text-sm text-slate-400">
              {isRTL ? "لا حاجة لبطاقة دفع." : "No payment method required."}
            </p>
          </div>
        </div>
      </section>

      {/* OVERVIEW */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-black tracking-tight text-slate-900">
            {isRTL ? "نظرة عامة على النظام" : "System overview"}
          </h2>
          <p className="mt-4 text-lg text-slate-600">
            {isRTL
              ? "SPEED ERP نظام واحد يغطي المحاسبة والمبيعات والعملاء والمصروفات والتقارير، مع أمان على مستوى الشركة والدور."
              : "SPEED ERP is one system covering accounting, sales, customers, expenses and reporting, with company- and role-level security built in."}
          </p>
        </div>
      </section>

      {/* FEATURES */}
      <section className="bg-slate-50 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-black tracking-tight text-slate-900">
            {isRTL ? "قدرات النظام" : "What the system does"}
          </h2>
          <p className="mt-3 text-slate-600">
            {isRTL ? "وحدات مبنية وفعّالة داخل النظام." : "Modules that are built and working in the product."}
          </p>
          <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <div key={i} className="rounded-2xl border border-slate-200 bg-white p-6">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-50">
                  <f.icon className="h-5 w-5 text-red-600" />
                </span>
                <h3 className="mt-4 font-bold text-slate-900">{isRTL ? f.ar : f.en}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{isRTL ? f.dAr : f.dEn}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FREE PLAN */}
      <section className="bg-slate-900 py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-black tracking-tight text-white">
                {isRTL ? "ابدأ بالخطة المجانية" : "Start on the free plan"}
              </h2>
              <p className="mt-4 text-lg text-slate-300">
                {isRTL
                  ? "كل الوحدات الأساسية مجانًا. لا حاجة لبطاقة دفع."
                  : "All core modules, free. No payment method required."}
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-8">
              <div className="flex items-baseline gap-2">
                <span className="text-5xl font-black text-white">$0</span>
                <span className="text-slate-400">/ {isRTL ? "مجانًا" : "free"}</span>
              </div>
              <ul className="mt-6 space-y-3">
                {[
                  isRTL ? "المحاسبة والمبيعات والفواتير" : "Accounting, sales & invoices",
                  isRTL ? "العملاء والموردون والمصروفات" : "Customers, suppliers & expenses",
                  isRTL ? "التقارير المالية والسنوات المالية" : "Financial reports & financial years",
                  isRTL ? "استيراد/تصدير Excel" : "Excel import / export",
                ].map((f, i) => (
                  <li key={i} className="flex items-center gap-3 text-sm text-slate-200">
                    <Check className="h-4 w-4 flex-shrink-0 text-green-400" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="mt-8 block rounded-xl bg-red-600 px-6 py-3.5 text-center text-base font-bold text-white transition hover:bg-red-700"
              >
                {isRTL ? "جرّب مجانًا الآن" : "Try Free Now"}
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* SECURITY */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <h2 className="text-3xl font-black tracking-tight text-slate-900">
          {isRTL ? "الأمان وعزل البيانات" : "Security & tenant isolation"}
        </h2>
        <p className="mt-3 max-w-2xl text-slate-600">
          {isRTL
            ? "بُني النظام بحيث لا تستطيع شركة الوصول إلى بيانات شركة أخرى."
            : "The system is built so one company cannot reach another company's data."}
        </p>
        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {security.map((s, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-slate-200 p-5">
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100">
                <s.icon className="h-5 w-5 text-slate-700" />
              </span>
              <span className="text-sm font-semibold text-slate-800">{isRTL ? s.ar : s.en}</span>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="bg-red-600 py-16">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="text-3xl font-black tracking-tight text-white">
            {isRTL ? "ابدأ إدارة أعمالك اليوم" : "Start managing your business today"}
          </h2>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/signup"
              className="inline-block rounded-xl bg-white px-8 py-3.5 text-base font-bold text-red-600 transition hover:bg-slate-100"
            >
              {isRTL ? "جرّب مجانًا الآن" : "Try Free Now"}
            </Link>
            <Link
              href="/login"
              className="inline-block rounded-xl border border-white/40 px-8 py-3.5 text-base font-bold text-white transition hover:bg-white/10"
            >
              {isRTL ? "تسجيل الدخول" : "Login"}
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  )
}
