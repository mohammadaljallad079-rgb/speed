"use client"

import { Suspense, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { supabase } from "@/lib/supabase"
import { loginErrorMessage } from "@/lib/auth/login-errors"
import { useLanguage } from "@/lib/LanguageContext"
import { ShieldCheck, Loader2, ArrowLeft } from "lucide-react"

/**
 * Global Super Admin sign-in.
 *
 * Deliberately separate from `/login` so the company/ERP sign-in stays for
 * administrators and staff while this door is for the platform operator. The
 * role decision is made by the SERVER (`/api/me`), never from an email or a
 * browser-fetched role: after a valid Supabase session the page asks the server
 * who the caller is and only lets a genuine `super_admin` through. Everyone else
 * is signed out and told this door is not for them.
 */
function SuperAdminLoginContent() {
  const router = useRouter()
  const { lang } = useLanguage()
  const isRTL = lang === "ar"
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoading(true)
    setError(null)

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: password.trim(),
    })

    if (signInError || !data.user) {
      setError(loginErrorMessage(signInError, isRTL))
      setLoading(false)
      return
    }

    let res: Response
    try {
      res = await fetch("/api/me", { cache: "no-store" })
    } catch {
      await supabase.auth.signOut()
      setError(isRTL ? "تعذر الاتصال بالخادم. حاول مرة أخرى." : "Could not reach the server. Please try again.")
      setLoading(false)
      return
    }

    const me = await res.json().catch(() => null)

    if (!res.ok || me?.isSuperAdmin !== true) {
      await supabase.auth.signOut()
      setError(
        isRTL
          ? "هذا الحساب ليس حساب مدير عام للنظام."
          : "This account is not a global system administrator.",
      )
      setLoading(false)
      return
    }

    router.replace("/super-admin")
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6" dir={isRTL ? "rtl" : "ltr"}>
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-8 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-600">
            <ShieldCheck className="h-6 w-6 text-white" />
          </span>
          <div>
            <h1 className="text-xl font-black text-white">{isRTL ? "دخول المدير العام" : "Global Admin"}</h1>
            <p className="text-xs font-semibold uppercase tracking-widest text-red-400">
              {isRTL ? "إدارة النظام" : "System Administration"}
            </p>
          </div>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-300" htmlFor="email">
              {isRTL ? "البريد الإلكتروني" : "Email"}
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-red-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-300" htmlFor="password">
              {isRTL ? "كلمة المرور" : "Password"}
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-red-500"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-70"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {loading ? (isRTL ? "جاري التحقق..." : "Verifying...") : isRTL ? "تسجيل الدخول" : "Sign In"}
          </button>
        </form>

        <div className="mt-6 border-t border-white/10 pt-4 text-center">
          <Link href="/login" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-400 hover:text-white">
            <ArrowLeft className={`h-4 w-4 ${isRTL ? "rotate-180" : ""}`} />
            {isRTL ? "دخول الشركات والموظفين" : "Company / staff sign-in"}
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function SuperAdminLoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">Loading...</div>}>
      <SuperAdminLoginContent />
    </Suspense>
  )
}
