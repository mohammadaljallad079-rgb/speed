"use client"

import Link from "next/link"
import { useLanguage } from "@/lib/LanguageContext"

/**
 * Marketing footer for the public SPEED ERP pages. Links stay on public routes;
 * no internal admin/ERP route is ever exposed here.
 */
export default function MarketingFooter() {
  const { isRTL } = useLanguage()

  const product = [
    { href: "/features", ar: "المميزات", en: "Features" },
    { href: "/solutions", ar: "الحلول", en: "Solutions" },
    { href: "/pricing", ar: "الأسعار", en: "Pricing" },
    { href: "/faq", ar: "الأسئلة الشائعة", en: "FAQ" },
  ]
  const company = [
    { href: "/contact", ar: "تواصل معنا", en: "Contact" },
    { href: "/privacy", ar: "الخصوصية", en: "Privacy" },
    { href: "/terms", ar: "الشروط", en: "Terms" },
  ]
  const account = [
    { href: "/login", ar: "تسجيل الدخول", en: "Login" },
    { href: "/signup", ar: "ابدأ مجانًا", en: "Start Free" },
  ]

  const Column = ({ title, items }: { title: string; items: { href: string; ar: string; en: string }[] }) => (
    <div>
      <h3 className="mb-3 text-xs font-black uppercase tracking-widest text-slate-400">{title}</h3>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="text-sm text-slate-300 transition hover:text-white">
              {isRTL ? item.ar : item.en}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )

  return (
    <footer className="bg-slate-900 text-slate-300">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-600 text-sm font-black text-white">
                S
              </span>
              <span className="text-lg font-black tracking-tight text-white">SPEED ERP</span>
            </div>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-400">
              {isRTL
                ? "المحاسبة والمبيعات والعملاء والمصروفات والتقارير في نظام ERP سحابي آمن."
                : "Accounting, sales, customers, expenses and reports in one secure cloud ERP."}
            </p>
          </div>
          <Column title={isRTL ? "المنتج" : "Product"} items={product} />
          <Column title={isRTL ? "الشركة" : "Company"} items={company} />
          <Column title={isRTL ? "الحساب" : "Account"} items={account} />
        </div>
        <div className="mt-10 border-t border-slate-800 pt-6 text-xs text-slate-500">
          © {new Date().getFullYear()} SPEED ERP. {isRTL ? "جميع الحقوق محفوظة." : "All rights reserved."}
        </div>
      </div>
    </footer>
  )
}
