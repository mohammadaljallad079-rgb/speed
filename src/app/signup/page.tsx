"use client"

import { Suspense, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useLanguage } from "@/lib/LanguageContext"
import { supabase } from "@/lib/supabase"
import MarketingNavbar from "@/components/MarketingNavbar"
import MarketingFooter from "@/components/MarketingFooter"
import { Check } from "lucide-react"

export const dynamic = "force-dynamic"

type FormState = {
  fullName: string
  email: string
  password: string
  confirmPassword: string
  companyName: string
  phone: string
}

const EMPTY: FormState = {
  fullName: "",
  email: "",
  password: "",
  confirmPassword: "",
  companyName: "",
  phone: "",
}

function SignupContent() {
  const router = useRouter()
  const { isRTL } = useLanguage()
  const [form, setForm] = useState<FormState>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const set = (key: keyof FormState) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }))

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)

    if (form.password !== form.confirmPassword) {
      setError(isRTL ? "كلمتا المرور غير متطابقتين." : "Passwords do not match.")
      return
    }
    if (form.password.length < 8) {
      setError(isRTL ? "كلمة المرور يجب أن تكون 8 أحرف على الأقل." : "Password must be at least 8 characters.")
      return
    }

    setLoading(true)
    try {
      const res = await fetch("/api/saas/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const payload = await res.json().catch(() => ({}))

      if (!res.ok) {
        // Server messages are already user-safe; fall back to a generic one.
        setError(payload.error ?? (isRTL ? "تعذر إنشاء الحساب." : "Could not create the account."))
        setLoading(false)
        return
      }

      // Establish a session so onboarding (an authenticated step) can run.
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: form.email,
        password: form.password,
      })

      if (signInError) {
        // Account exists; the visitor can simply log in.
        setDone(true)
        setLoading(false)
        return
      }

      router.replace("/onboarding")
    } catch {
      setError(isRTL ? "حدث خطأ. حاول مرة أخرى." : "Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  const field = (
    key: keyof FormState,
    labelAr: string,
    labelEn: string,
    type = "text",
    required = true,
  ) => (
    <div>
      <label htmlFor={key} className="mb-1.5 block text-sm font-semibold text-slate-700">
        {isRTL ? labelAr : labelEn}
        {!required && <span className="ms-1 text-xs font-normal text-slate-400">{isRTL ? "(اختياري)" : "(optional)"}</span>}
      </label>
      <input
        id={key}
        type={type}
        required={required}
        autoComplete={type === "password" ? "new-password" : key === "email" ? "email" : "off"}
        value={form[key]}
        onChange={set(key)}
        className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-100"
      />
    </div>
  )

  return (
    <div className="flex min-h-screen flex-col bg-slate-50" dir={isRTL ? "rtl" : "ltr"}>
      <MarketingNavbar />
      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-lg">
          {done ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                <Check className="h-6 w-6 text-green-600" />
              </div>
              <h1 className="mb-2 text-xl font-black text-slate-900">
                {isRTL ? "تم إنشاء حسابك" : "Your account is ready"}
              </h1>
              <p className="mb-6 text-sm text-slate-500">
                {isRTL ? "يمكنك الآن تسجيل الدخول والبدء." : "You can now sign in and get started."}
              </p>
              <Link
                href="/login"
                className="inline-block rounded-lg bg-red-600 px-6 py-2.5 text-sm font-bold text-white transition hover:bg-red-700"
              >
                {isRTL ? "تسجيل الدخول" : "Sign in"}
              </Link>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
              <h1 className="text-2xl font-black tracking-tight text-slate-900">
                {isRTL ? "أنشئ حسابك المجاني" : "Create your free account"}
              </h1>
              <p className="mt-1.5 text-sm text-slate-500">
                {isRTL ? "ابدأ إدارة أعمالك خلال دقائق. لا حاجة لبطاقة دفع." : "Start managing your business in minutes. No payment method required."}
              </p>

              <form className="mt-6 space-y-4" onSubmit={submit}>
                {field("fullName", "الاسم الكامل", "Full name")}
                {field("email", "البريد الإلكتروني", "Email", "email")}
                {field("companyName", "اسم الشركة", "Company name")}
                {field("phone", "رقم الهاتف", "Phone", "tel", false)}
                {field("password", "كلمة المرور", "Password", "password")}
                {field("confirmPassword", "تأكيد كلمة المرور", "Confirm password", "password")}

                {error && (
                  <p role="alert" className="rounded-lg bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {loading
                    ? isRTL
                      ? "جاري إنشاء الحساب..."
                      : "Creating account..."
                    : isRTL
                      ? "إنشاء حساب مجاني"
                      : "Create Free Account"}
                </button>
              </form>

              <p className="mt-5 text-center text-sm text-slate-500">
                {isRTL ? "لديك حساب بالفعل؟ " : "Already have an account? "}
                <Link href="/login" className="font-bold text-red-600 hover:underline">
                  {isRTL ? "تسجيل الدخول" : "Sign in"}
                </Link>
              </p>
            </div>
          )}
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-slate-500">Loading...</div>}>
      <SignupContent />
    </Suspense>
  )
}
