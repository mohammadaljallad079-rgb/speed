"use client"
import { Suspense } from 'react'
export const dynamic = "force-dynamic"
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '@/lib/LanguageContext'
import { supabase } from '@/lib/supabase'
import { safeCustomerRedirect } from '@/lib/auth/access-areas'
import { Car as CarIcon, Mail, Lock, LogIn, Eye, EyeOff, ArrowRight } from 'lucide-react'

function CustomerLoginContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { lang } = useLanguage()
  const isRTL = lang === 'ar'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPass, setShowPass] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError || !data.user) {
      setError(signInError?.message ?? (isRTL ? 'تعذر تسجيل الدخول.' : 'Login failed.'))
      setLoading(false)
      return
    }

    const { data: appUser } = await supabase.from('users').select('role').eq('id', data.user.id).maybeSingle()
    if (!appUser || appUser.role !== 'client') {
      await supabase.auth.signOut()
      setError(isRTL ? 'هذا الحساب غير مخصص للعملاء.' : 'This is not a customer account.')
      setLoading(false)
      return
    }

    // The redirect target is caller input, so it is sanitised before use: only
    // a same-origin customer/public path is honoured (no open redirect).
    const redirectTo = safeCustomerRedirect(searchParams.get('redirect'))
    router.replace(redirectTo)
  }

  return (
    <div className="min-h-screen bg-black flex" dir={isRTL ? 'rtl' : 'ltr'} style={{fontFamily: 'var(--font-tajawal), sans-serif'}}>
      {/* Left - Branding */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden">
        <img src="https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&q=90&w=1200" className="w-full h-full object-cover opacity-50" alt="" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/60 to-transparent" />
        <div className="absolute top-0 left-0 right-0 h-1 bg-red-600" />
        <div className="absolute inset-0 flex flex-col justify-between p-12">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-11 h-11 bg-red-600 rounded-xl flex items-center justify-center shadow-lg shadow-red-600/40">
              <CarIcon className="w-6 h-6 text-white" />
            </div>
            <div>
              <span className="font-black text-2xl text-white">SPEED</span>
              <p className="text-red-400 text-[10px] font-bold tracking-widest uppercase">{isRTL ? 'تأجير السيارات' : 'Car Rental'}</p>
            </div>
          </Link>
          <div>
            <h2 className="text-4xl font-black text-white mb-4 leading-tight">
              {isRTL ? 'مرحباً بعودتك إلى SPEED' : 'Welcome Back to SPEED'}
            </h2>
            <p className="text-gray-400 text-lg">{isRTL ? 'سجّل دخولك لإدارة حجوزاتك والاستمتاع بتجربة قيادة استثنائية' : 'Sign in to manage your bookings and enjoy an exceptional driving experience'}</p>
            <div className="flex items-center gap-6 mt-8 pt-8 border-t border-white/10">
              {[
                { num: '500+', label: isRTL ? 'عميل راضٍ' : 'Happy Clients' },
                { num: '100+', label: isRTL ? 'سيارة' : 'Cars' },
                { num: '15+', label: isRTL ? 'سنة خبرة' : 'Years' },
              ].map((s, i) => (
                <div key={i}>
                  <p className="text-2xl font-black text-white">{s.num}</p>
                  <p className="text-gray-400 text-sm">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Right - Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-md">
          {/* Mobile logo */}
          <div className="flex lg:hidden items-center gap-3 mb-10">
            <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center">
              <CarIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <span className="font-black text-xl text-white">SPEED</span>
              <p className="text-red-400 text-[9px] font-bold tracking-widest uppercase">{isRTL ? 'تأجير السيارات' : 'Car Rental'}</p>
            </div>
          </div>

          <div className="mb-8">
            <h1 className="text-3xl font-black text-white mb-2">{isRTL ? 'تسجيل الدخول' : 'Sign In'}</h1>
            <p className="text-gray-400">{isRTL ? 'أدخل بياناتك للوصول إلى حسابك' : 'Enter your credentials to access your account'}</p>
          </div>

          {error && (
            <div className="mb-6 bg-red-600/10 border border-red-600/30 text-red-400 text-sm font-semibold px-4 py-3 rounded-xl">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-bold text-gray-300 mb-2">{isRTL ? 'البريد الإلكتروني' : 'Email Address'}</label>
              <div className="relative">
                <Mail className={'absolute top-1/2 -translate-y-1/2 text-gray-500 w-4 h-4 ' + (isRTL ? 'right-4' : 'left-4')} />
                <input
                  type="email" required value={email} onChange={e => setEmail(e.target.value)}
                  placeholder={isRTL ? 'example@email.com' : 'example@email.com'}
                  className={'w-full h-13 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-600 focus:border-red-500 focus:ring-1 focus:ring-red-500 outline-none text-sm transition-all ' + (isRTL ? 'pr-11 pl-4' : 'pl-11 pr-4')}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-bold text-gray-300 mb-2">{isRTL ? 'كلمة المرور' : 'Password'}</label>
              <div className="relative">
                <Lock className={'absolute top-1/2 -translate-y-1/2 text-gray-500 w-4 h-4 ' + (isRTL ? 'right-4' : 'left-4')} />
                <input
                  type={showPass ? 'text' : 'password'} required value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className={'w-full h-13 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-600 focus:border-red-500 focus:ring-1 focus:ring-red-500 outline-none text-sm transition-all ' + (isRTL ? 'pr-11 pl-11' : 'pl-11 pr-11')}
                />
                <button type="button" onClick={() => setShowPass(!showPass)} className={'absolute top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 ' + (isRTL ? 'left-4' : 'right-4')}>
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit" disabled={loading}
              className="w-full h-13 bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white font-black rounded-xl shadow-xl shadow-red-600/30 hover:scale-[1.02] transition-all flex items-center justify-center gap-2 text-base mt-2"
            >
              {loading ? (
                <><div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />{isRTL ? 'جاري التحقق...' : 'Verifying...'}</>
              ) : (
                <><LogIn className="w-5 h-5" />{isRTL ? 'تسجيل الدخول' : 'Sign In'}</>
              )}
            </button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-gray-500 text-sm">
              {isRTL ? 'ليس لديك حساب؟' : "Don't have an account?"}{' '}
              <Link href="/customer-signup" className="text-red-400 hover:text-red-300 font-bold transition-colors">
                {isRTL ? 'إنشاء حساب جديد' : 'Create Account'}
              </Link>
            </p>
          </div>

          <div className="mt-8 pt-6 border-t border-white/5 text-center">
            <Link href="/" className="text-gray-600 hover:text-gray-400 text-xs transition-colors flex items-center justify-center gap-1">
              <ArrowRight className={'w-3 h-3 ' + (isRTL ? '' : 'rotate-180')} />
              {isRTL ? 'العودة للموقع الرئيسي' : 'Back to main site'}
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function CustomerLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><div className="animate-spin w-10 h-10 border-4 border-red-600 border-t-transparent rounded-full" /></div>}>
      <CustomerLoginContent />
    </Suspense>
  )
}
