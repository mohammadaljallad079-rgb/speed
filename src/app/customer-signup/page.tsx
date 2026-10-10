"use client"
import { Suspense } from 'react'
import { } from 'react'
export const dynamic = "force-dynamic"

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLanguage } from "@/lib/LanguageContext";

function CustomerSignupPageContent() {
  const router = useRouter();
  const { lang } = useLanguage();
  const isRTL = lang === "ar";
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch("/api/customer-signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fullName,
          email,
          phone,
          password,
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload.error ?? (isRTL ? "تعذر إنشاء الحساب." : "Failed to create account."));
        setLoading(false);
        return;
      }

      setSuccess(isRTL ? "تم إنشاء الحساب بنجاح. يمكنك تسجيل الدخول الآن." : "Account created successfully. You can now sign in.");
      setLoading(false);
      router.replace("/customer-login");
    } catch (requestError) {
      setError(isRTL ? "تعذر إنشاء الحساب." : "Failed to create account.");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100" dir={isRTL ? "rtl" : "ltr"}>
      <div className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
        <div className="w-full rounded-lg bg-white p-8 shadow">
          <h1 className="mb-2 text-2xl font-semibold text-gray-900">{isRTL ? "إنشاء حساب عميل" : "Create Customer Account"}</h1>
          <p className="mb-6 text-sm text-gray-500">{isRTL ? "أنشئ حسابك لحجز السيارات." : "Create your account to book cars."}</p>

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="fullName">
                {isRTL ? "الاسم الكامل" : "Full Name"}
              </label>
              <input
                id="fullName"
                type="text"
                required
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="email">
                {isRTL ? "البريد الإلكتروني" : "Email"}
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="phone">
                {isRTL ? "رقم الجوال" : "Phone Number"}
              </label>
              <input
                id="phone"
                type="tel"
                required
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="password">
                {isRTL ? "كلمة المرور" : "Password"}
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
            {success && <p className="text-sm text-emerald-600">{success}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {loading ? (isRTL ? "جاري إنشاء الحساب..." : "Creating account...") : (isRTL ? "إنشاء الحساب" : "Create Account")}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-gray-500">
            {isRTL ? "لديك حساب؟" : "Already have an account?"}{" "}
            <button
              type="button"
              onClick={() => router.push("/customer-login")}
              className="font-semibold text-gray-900"
            >
              {isRTL ? "تسجيل الدخول" : "Sign In"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CustomerSignupPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <CustomerSignupPageContent />
    </Suspense>
  )
}
