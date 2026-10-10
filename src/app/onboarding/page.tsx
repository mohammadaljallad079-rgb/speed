"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useLanguage } from "@/lib/LanguageContext"
import { supabase } from "@/lib/supabase"
import MarketingNavbar from "@/components/MarketingNavbar"
import { Check } from "lucide-react"

export const dynamic = "force-dynamic"

/**
 * Post-signup onboarding.
 *
 * All persistence happens through the authenticated `/api/saas/onboarding`
 * route, which scopes every write to the caller's own tenant — the browser never
 * sends a tenant id. Every step except the default financial year is optional, so
 * the operator can reach the dashboard immediately.
 */

type Step = 1 | 2 | 3 | 4

export default function OnboardingPage() {
  const router = useRouter()
  const { isRTL } = useLanguage()
  const [step, setStep] = useState<Step>(1)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const [companyName, setCompanyName] = useState("")
  const [phone, setPhone] = useState("")
  const [address, setAddress] = useState("")
  const [yearName, setYearName] = useState(String(new Date().getFullYear()))
  const [yearStart, setYearStart] = useState(`${new Date().getFullYear()}-01-01`)
  const [yearEnd, setYearEnd] = useState(`${new Date().getFullYear()}-12-31`)
  const [branchName, setBranchName] = useState("")

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data?.user) {
        router.replace("/login")
        return
      }
      setReady(true)
    })
  }, [router])

  const persist = async (extra: Record<string, unknown> = {}) => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/saas/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: companyName || undefined,
          phone: phone || undefined,
          address: address || undefined,
          financialYearName: yearName || undefined,
          financialYearStart: yearStart || undefined,
          financialYearEnd: yearEnd || undefined,
          branchName: branchName || undefined,
          ...extra,
        }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        setError(payload.error ?? (isRTL ? "تعذر الحفظ." : "Could not save."))
        setSaving(false)
        return false
      }
      setSaving(false)
      return true
    } catch {
      setError(isRTL ? "حدث خطأ أثناء الحفظ." : "Something went wrong while saving.")
      setSaving(false)
      return false
    }
  }

  const next = async () => {
    if (step === 4) {
      const ok = await persist()
      if (ok) router.replace("/dashboard")
      return
    }
    // Persist progress at each step; failures are shown but do not trap the user.
    await persist()
    setStep((s) => (s + 1) as Step)
  }

  const finish = async () => {
    const ok = await persist()
    if (ok) router.replace("/dashboard")
  }

  if (!ready) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-500">Loading...</div>
  }

  const stepTitle =
    step === 1
      ? isRTL
        ? "اسم الشركة"
        : "Company name"
      : step === 2
        ? isRTL
          ? "معلومات النشاط"
          : "Business information"
        : step === 3
          ? isRTL
            ? "السنة المالية"
            : "Financial year"
          : isRTL
            ? "فرع اختياري"
            : "Optional branch"

  return (
    <div className="flex min-h-screen flex-col bg-slate-50" dir={isRTL ? "rtl" : "ltr"}>
      <MarketingNavbar />
      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          {/* Progress */}
          <div className="mb-6 flex items-center gap-2">
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                className={`h-1.5 flex-1 rounded-full ${n <= step ? "bg-red-600" : "bg-slate-200"}`}
                aria-hidden
              />
            ))}
          </div>
          <p className="text-xs font-bold uppercase tracking-widest text-red-600">
            {isRTL ? `الخطوة ${step} من 4` : `Step ${step} of 4`}
          </p>
          <h1 className="mt-1 text-2xl font-black tracking-tight text-slate-900">{stepTitle}</h1>

          <div className="mt-6 space-y-4">
            {step === 1 && (
              <div>
                <label htmlFor="companyName" className="mb-1.5 block text-sm font-semibold text-slate-700">
                  {isRTL ? "اسم الشركة" : "Company name"}
                </label>
                <input
                  id="companyName"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                />
              </div>
            )}

            {step === 2 && (
              <>
                <div>
                  <label htmlFor="phone" className="mb-1.5 block text-sm font-semibold text-slate-700">
                    {isRTL ? "رقم الهاتف" : "Phone"}
                  </label>
                  <input
                    id="phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                  />
                </div>
                <div>
                  <label htmlFor="address" className="mb-1.5 block text-sm font-semibold text-slate-700">
                    {isRTL ? "العنوان" : "Address"}
                  </label>
                  <input
                    id="address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                  />
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div>
                  <label htmlFor="yearName" className="mb-1.5 block text-sm font-semibold text-slate-700">
                    {isRTL ? "اسم السنة المالية" : "Financial year name"}
                  </label>
                  <input
                    id="yearName"
                    value={yearName}
                    onChange={(e) => setYearName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="yearStart" className="mb-1.5 block text-sm font-semibold text-slate-700">
                      {isRTL ? "من" : "Start"}
                    </label>
                    <input
                      id="yearStart"
                      type="date"
                      value={yearStart}
                      onChange={(e) => setYearStart(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                    />
                  </div>
                  <div>
                    <label htmlFor="yearEnd" className="mb-1.5 block text-sm font-semibold text-slate-700">
                      {isRTL ? "إلى" : "End"}
                    </label>
                    <input
                      id="yearEnd"
                      type="date"
                      value={yearEnd}
                      onChange={(e) => setYearEnd(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                    />
                  </div>
                </div>
              </>
            )}

            {step === 4 && (
              <>
                <div>
                  <label htmlFor="branchName" className="mb-1.5 block text-sm font-semibold text-slate-700">
                    {isRTL ? "اسم الفرع" : "Branch name"}{" "}
                    <span className="text-xs font-normal text-slate-400">{isRTL ? "(اختياري)" : "(optional)"}</span>
                  </label>
                  <input
                    id="branchName"
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                  />
                </div>
                <div className="flex items-start gap-3 rounded-lg bg-green-50 p-3.5">
                  <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
                  <p className="text-sm text-green-800">
                    {isRTL
                      ? "سيتم تجهيز حسابك مع سنة مالية افتراضية. يمكنك تعديل كل شيء لاحقًا."
                      : "Your account will be provisioned with a default financial year. You can change everything later."}
                  </p>
                </div>
              </>
            )}

            {error && (
              <p role="alert" className="rounded-lg bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700">
                {error}
              </p>
            )}
          </div>

          <div className="mt-8 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => (step === 1 ? router.replace("/dashboard") : setStep((s) => (s - 1) as Step))}
              className="rounded-lg px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-100"
            >
              {step === 1 ? (isRTL ? "تخطي" : "Skip") : isRTL ? "السابق" : "Back"}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={finish}
                disabled={saving}
                className="rounded-lg px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
              >
                {isRTL ? "تخطي إلى لوحة التحكم" : "Skip to dashboard"}
              </button>
              <button
                type="button"
                onClick={next}
                disabled={saving}
                className="rounded-lg bg-red-600 px-6 py-2.5 text-sm font-bold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {saving ? (isRTL ? "جاري الحفظ..." : "Saving...") : step === 4 ? (isRTL ? "إنهاء" : "Finish") : isRTL ? "التالي" : "Next"}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
