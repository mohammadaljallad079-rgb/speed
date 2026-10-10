"use client"
import { Suspense } from 'react'
import { } from 'react'
export const dynamic = "force-dynamic"

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLanguage } from "@/lib/LanguageContext";

import { supabase } from "@/lib/supabase";

function LoginPageContent() {
  const router = useRouter();
  const { lang } = useLanguage();
  const isRTL = lang === "ar";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError || !data.user) {
      setError(signInError?.message ?? (isRTL ? "تعذر تسجيل الدخول." : "Login failed."));
      setLoading(false);
      return;
    }

    // The session exists, but the role/tenant decision is NOT made here. It is
    // resolved server-side by /api/me from the session and the application
    // tables, so a forged client value can never grant a role.
    const res = await fetch("/api/me", { cache: "no-store" });
    const me = await res.json().catch(() => null);

    if (!res.ok) {
      await supabase.auth.signOut();
      if (me?.code === "account_not_provisioned") {
        setError(
          isRTL
            ? "تم إنشاء الجلسة لكن الحساب غير مرتبط بالنظام. تواصل مع المسؤول."
            : "Sign-in succeeded but your account is not linked to the ERP. Contact an administrator.",
        );
      } else {
        setError(isRTL ? "تعذر التحقق من صلاحيات الحساب." : "Could not verify your account permissions.");
      }
      setLoading(false);
      return;
    }

    // Customers belong in the customer portal; administrators and staff in the ERP.
    if (me?.role === "client") {
      router.replace("/customer-dashboard");
      return;
    }

    if (me?.role !== "admin" && me?.role !== "super_admin" && me?.role !== "staff") {
      await supabase.auth.signOut();
      setError(isRTL ? "هذا الحساب غير مخوّل لدخول لوحة الإدارة." : "This account is not authorized to access the admin panel.");
      setLoading(false);
      return;
    }

    router.replace("/dashboard");
  };

  const handleForgot = async () => {
    if (!email) {
      setError(isRTL ? "أدخل بريدك الإلكتروني أولاً." : "Enter your email first.");
      return;
    }
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email);
    setError(
      resetError
        ? isRTL ? "تعذر إرسال رابط الاستعادة." : "Could not send the reset link."
        : isRTL ? "تم إرسال رابط استعادة كلمة المرور إلى بريدك." : "A password reset link has been sent to your email.",
    );
  };

  return (
    <div className="min-h-screen bg-gray-100" dir={isRTL ? "rtl" : "ltr"}>
      <div className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
        <div className="w-full rounded-lg bg-white p-8 shadow">
          <h1 className="mb-2 text-2xl font-semibold text-gray-900">{isRTL ? "تسجيل دخول الإدارة" : "Admin Login"}</h1>
          <p className="mb-6 text-sm text-gray-500">{isRTL ? "تسجيل دخول المسؤولين والموظفين فقط." : "For administrators and staff only."}</p>

          <form className="space-y-4" onSubmit={handleSubmit}>
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

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {loading ? (isRTL ? "جاري التحقق..." : "Verifying...") : (isRTL ? "تسجيل الدخول" : "Sign In")}
            </button>
          </form>

            <div className="mt-5 space-y-2 text-center text-sm">
              <button
                type="button"
                onClick={handleForgot}
                className="block w-full font-semibold text-gray-500 hover:text-gray-900"
              >
                {isRTL ? "نسيت كلمة المرور؟" : "Forgot password?"}
              </button>
              <p className="text-gray-500">
                {isRTL ? "ليس لديك حساب؟ " : "Don't have an account? "}
                <Link href="/signup" className="font-bold text-red-600 hover:underline">
                  {isRTL ? "ابدأ مجانًا" : "Start Free"}
                </Link>
              </p>
            </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <LoginPageContent />
    </Suspense>
  )
}
