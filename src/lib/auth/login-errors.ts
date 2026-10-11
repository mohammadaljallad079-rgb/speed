/**
 * Pure mapping from a Supabase auth error to a safe, localized, actionable
 * message.
 *
 * Kept free of React so the login UI and its tests share one source of truth.
 * Raw provider strings are never surfaced: they are unstable across
 * `@supabase/supabase-js` versions and can leak internal detail. The login page
 * decides *what* to show; this decides *how* to describe a failure.
 */

export type AuthErrorLike =
  | { message?: string; status?: number; code?: string }
  | null
  | undefined;

export function loginErrorMessage(error: AuthErrorLike, isRTL: boolean): string {
  const code = error?.code ?? "";
  const status = error?.status;
  const message = (error?.message ?? "").toLowerCase();

  const invalidCredentials =
    code === "invalid_credentials" ||
    status === 400 ||
    message.includes("invalid login credentials") ||
    message.includes("invalid credential");

  if (invalidCredentials) {
    return isRTL
      ? "البريد الإلكتروني أو كلمة المرور غير صحيحة."
      : "Incorrect email or password.";
  }

  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return isRTL ? "بريدك الإلكتروني غير مؤكد بعد." : "Your email is not confirmed yet.";
  }

  if (
    status === 429 ||
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit"
  ) {
    return isRTL ? "محاولات كثيرة جدًا. حاول لاحقًا." : "Too many attempts. Try again later.";
  }

  return isRTL ? "تعذر تسجيل الدخول. حاول مرة أخرى." : "Could not sign in. Please try again.";
}

/** Message shown when the session exists but has no ERP application mapping. */
export function notProvisionedMessage(isRTL: boolean): string {
  return isRTL
    ? "تم إنشاء الجلسة لكن الحساب غير مرتبط بالنظام. تواصل مع المسؤول."
    : "Sign-in succeeded but your account is not linked to the ERP. Contact an administrator.";
}

/** Message shown when the resolved role may not use the admin panel. */
export function unauthorizedRoleMessage(isRTL: boolean): string {
  return isRTL
    ? "هذا الحساب غير مخوّل لدخول لوحة الإدارة."
    : "This account is not authorized to access the admin panel.";
}
