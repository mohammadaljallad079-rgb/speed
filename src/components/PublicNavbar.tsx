"use client"
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useLanguage } from '@/lib/LanguageContext'
import { getAppUser } from '@/lib/supabase'
import type { AppUser } from '@/lib/supabase-server'
import { Car as CarIcon, Globe, User, LogIn, Menu, X, Phone, Mail, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PLATFORM_BRANDING } from '@/lib/branding/platform'

interface CompanyData {
  name: string
  phone: string
  email: string
  address: string
}

/**
 * The SPEED platform identity.
 *
 * The public marketing chrome belongs to the SaaS provider, so its brand is the
 * platform constant — never a subscriber's `company_profile`. It used to fetch
 * `/api/public/company-profile` with no tenant, which returned whichever company
 * row came back first and rendered that customer's name as the SPEED brand.
 * Tenant branding is resolved only where a tenant has been authoritatively
 * established (its own dashboard or verified public route).
 */
const PLATFORM_PHONE = PLATFORM_BRANDING.phone ?? ''
const PLATFORM_EMAIL = PLATFORM_BRANDING.email ?? ''

export default function PublicNavbar() {
  const { lang, setLang, isRTL } = useLanguage()
  const pathname = usePathname()
  const [appUser, setAppUser] = useState<AppUser | null>(null)
  const [scrolled, setScrolled] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  // The platform identity is a constant; only its address is localized, which is
  // a display choice, not an identity choice.
  const company: CompanyData = {
    name: PLATFORM_BRANDING.name,
    phone: PLATFORM_PHONE,
    email: PLATFORM_EMAIL,
    address: isRTL ? 'المنامة، مملكة البحرين' : (PLATFORM_BRANDING.address ?? ''),
  }

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    getAppUser().then(setAppUser)
  }, [])

  // Where "My Dashboard" points depends on the caller's role. The role comes
  // from the caller's own `users` row (readable under `users_self_select`); the
  // server still decides whether the destination is actually served, so a
  // tampered value here cannot grant access. A rental customer must never be
  // sent to the ERP shell - that was the reported defect.
  const dashboardHref = useMemo(() => {
    const role = (appUser as { role?: string | null } | null)?.role ?? null
    if (role === 'client') return '/customer-dashboard'
    if (role === 'super_admin') return '/super-admin'
    if (role === 'admin' || role === 'staff') return '/dashboard'
    return '/customer-dashboard'
  }, [appUser])

  const navLinks = [
    { href: '/', ar: 'الرئيسية', en: 'Home' },
    { href: '/fleet', ar: 'الأسطول', en: 'Fleet' },
    { href: '/services', ar: 'الخدمات', en: 'Services' },
    { href: '/contact', ar: 'اتصل بنا', en: 'Contact' },
    { href: '/erp', ar: 'نظام SPEED ERP', en: 'SPEED ERP' },
  ]

  const isHome = pathname === '/'
  const transparent = isHome && !scrolled

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${transparent ? 'bg-transparent' : 'bg-black shadow-2xl shadow-black/50'}`}>
      {/* Top bar - only on home when not scrolled */}
      {transparent && (
        <div className="border-b border-white/10 py-2">
          <div className="container mx-auto px-4 lg:px-8 flex items-center justify-between text-xs text-white/60">
            <div className="flex items-center gap-6">
              <span className="flex items-center gap-1.5"><Phone className="w-3 h-3 text-red-400" />{company.phone}</span>
              <span className="hidden sm:flex items-center gap-1.5"><Mail className="w-3 h-3 text-red-400" />{company.email}</span>
            </div>
            <span className="flex items-center gap-1.5"><MapPin className="w-3 h-3 text-red-400" />{company.address}</span>
          </div>
        </div>
      )}
      {/* Main nav */}
      <div className="container mx-auto px-4 lg:px-8">
        <div className="flex items-center justify-between py-3">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-3 group">
            <div className="w-11 h-11 bg-red-600 rounded-xl flex items-center justify-center shadow-lg shadow-red-600/40 group-hover:shadow-red-600/60 transition-all group-hover:scale-105">
              <CarIcon className="w-6 h-6 text-white" />
            </div>
            <div className="flex flex-col">
              <span className="font-black text-2xl tracking-tighter text-white leading-none">{company.name || 'SPEED'}</span>
              <span className="text-[10px] font-bold tracking-[0.2em] text-red-400 uppercase leading-none mt-0.5">{isRTL ? 'تأجير السيارات' : 'Car Rental'}</span>
            </div>
          </Link>

          {/* Desktop nav links */}
          <div className="hidden md:flex items-center gap-1">
            {navLinks.map(item => (
              <Link
                key={item.en}
                href={item.href}
                className={`px-4 py-2 text-sm font-semibold rounded-lg transition-all ${pathname === item.href ? 'text-white bg-white/15' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
              >
                {isRTL ? item.ar : item.en}
              </Link>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
              className="hidden sm:flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg border border-white/20 text-white/80 hover:text-white hover:bg-white/10 transition-all"
            >
              <Globe className="w-3.5 h-3.5" />
              {lang === 'ar' ? 'EN' : 'عربي'}
            </button>
            {appUser ? (
              <Link href={dashboardHref}>
                <Button className="rounded-xl bg-red-600 hover:bg-red-700 text-white px-5 h-10 text-sm font-bold shadow-lg shadow-red-600/30">
                  <User className="w-4 h-4 me-1.5" />
                  {isRTL ? 'لوحتي' : 'My Dashboard'}
                </Button>
              </Link>
            ) : (
              <Link href="/customer-login">
                <Button className="rounded-xl bg-red-600 hover:bg-red-700 text-white px-5 h-10 text-sm font-bold shadow-lg shadow-red-600/30">
                  <LogIn className="w-4 h-4 me-1.5" />
                  {isRTL ? 'تسجيل الدخول' : 'Sign In'}
                </Button>
              </Link>
            )}
            <button onClick={() => setMobileMenu(!mobileMenu)} className="md:hidden p-2 text-white rounded-lg hover:bg-white/10 transition-all">
              {mobileMenu ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileMenu && (
        <div className="md:hidden bg-black border-t border-white/10 px-4 py-4 space-y-1">
          {navLinks.map(item => (
            <Link
              key={item.en}
              href={item.href}
              onClick={() => setMobileMenu(false)}
              className={`block px-4 py-3 text-sm font-semibold rounded-lg transition-all ${pathname === item.href ? 'text-white bg-white/15' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
            >
              {isRTL ? item.ar : item.en}
            </Link>
          ))}
          <div className="pt-2 border-t border-white/10">
            <button onClick={() => { setLang(lang === 'ar' ? 'en' : 'ar'); setMobileMenu(false) }} className="flex items-center gap-2 px-4 py-3 text-sm font-bold text-white/70 hover:text-white">
              <Globe className="w-4 h-4" />
              {lang === 'ar' ? 'Switch to English' : 'التبديل إلى العربية'}
            </button>
          </div>
        </div>
      )}
    </nav>
  )
}
