"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";

import { useLanguage } from "@/lib/LanguageContext";

/**
 * Access denied.
 *
 * Reached when an authenticated identity asks for an area its role does not
 * own - a rental customer opening an ERP page, an ERP user opening the platform
 * console. The decision is made in the middleware (server-side); this page only
 * explains it and offers the destination the visitor IS entitled to.
 *
 * The link target is resolved from the caller's own server-side context
 * (`/api/me`), never from a URL parameter, so this page cannot be used to
 * bounce a visitor somewhere they should not be.
 */
export default function AccessDeniedPage() {
  const { isRTL } = useLanguage();
  const [home, setHome] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        if (!res.ok) return;
        const me = await res.json();
        if (cancelled) return;
        const role = me?.role;
        setHome(
          role === "client"
            ? "/customer-dashboard"
            : role === "super_admin"
              ? "/super-admin"
              : role === "admin" || role === "staff"
                ? "/dashboard"
                : null,
        );
      } catch {
        // Leave `home` null: the visitor gets the explanation without a link
        // rather than a link we could not verify.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50">
          <ShieldAlert className="h-7 w-7 text-red-600" />
        </div>
        <h1 className="text-xl font-bold text-slate-900">
          {isRTL ? "غير مصرح لك بالوصول" : "Access denied"}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          {isRTL
            ? "حسابك لا يملك صلاحية الدخول إلى هذه الصفحة. إذا كنت تعتقد أن هذا خطأ، تواصل مع مسؤول النظام."
            : "Your account is not authorized to open this page. If you believe this is a mistake, contact your administrator."}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          {home && (
            <Link
              href={home}
              className="rounded-lg bg-red-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-red-700"
            >
              {isRTL ? "الذهاب إلى صفحتي" : "Go to my dashboard"}
            </Link>
          )}
          <Link
            href="/"
            className="rounded-lg border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            {isRTL ? "الصفحة الرئيسية" : "Home"}
          </Link>
        </div>
      </div>
    </div>
  );
}
