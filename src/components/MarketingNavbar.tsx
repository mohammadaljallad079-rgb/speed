"use client"

import Link from "next/link"
import { useState } from "react"
import { useLanguage } from "@/lib/LanguageContext"
import { Globe, Menu, X } from "lucide-react"

/**
 * Marketing navbar for the public SPEED ERP SaaS pages.
 *
 * Kept separate from `PublicNavbar` (the car-rental site chrome) so the SaaS
 * product pages can present their own navigation without altering the existing
 * rental site. It carries no ERP data and performs no privileged requests.
 */

const LINKS = [
  { href: "/features", ar: "المميزات", en: "Features" },
  { href: "/solutions", ar: "الحلول", en: "Solutions" },
  { href: "/pricing", ar: "الأسعار", en: "Pricing" },
  { href: "/faq", ar: "الأسئلة الشائعة", en: "FAQ" },
  { href: "/contact", ar: "تواصل معنا", en: "Contact" },
]

export default function MarketingNavbar() {
  const { lang, setLang, isRTL } = useLanguage()
  const [open, setOpen] = useState(false)

  return (
    <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-600 text-sm font-black text-white">
            S
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-lg font-black tracking-tight text-slate-900">SPEED ERP</span>
            <span className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-red-600">
              {isRTL ? "نظام إدارة الأعمال" : "Business Suite"}
            </span>
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3.5 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
            >
              {isRTL ? item.ar : item.en}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLang(lang === "ar" ? "en" : "ar")}
            className="hidden items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-100 sm:flex"
          >
            <Globe className="h-3.5 w-3.5" />
            {lang === "ar" ? "EN" : "عربي"}
          </button>
          <Link
            href="/login"
            className="hidden rounded-lg px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 sm:block"
          >
            {isRTL ? "تسجيل الدخول" : "Login"}
          </Link>
          <Link
            href="/signup"
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-red-700"
          >
            {isRTL ? "ابدأ مجانًا" : "Start Free"}
          </Link>
          <button
            type="button"
            aria-label={isRTL ? "القائمة" : "Menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg p-2 text-slate-700 transition hover:bg-slate-100 md:hidden"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-200 bg-white px-4 py-3 md:hidden">
          <div className="flex flex-col gap-1">
            {LINKS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
              >
                {isRTL ? item.ar : item.en}
              </Link>
            ))}
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
            >
              {isRTL ? "تسجيل الدخول" : "Login"}
            </Link>
            <button
              type="button"
              onClick={() => {
                setLang(lang === "ar" ? "en" : "ar")
                setOpen(false)
              }}
              className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-start text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
            >
              <Globe className="h-4 w-4" />
              {lang === "ar" ? "Switch to English" : "التبديل إلى العربية"}
            </button>
          </div>
        </div>
      )}
    </header>
  )
}
