/**
 * Free-plan provisioning policy for the SPEED ERP SaaS signup.
 *
 * Everything here is pure and infrastructure-free so the signup/onboarding
 * rules can be unit tested directly, and so the *server* — never the browser —
 * is the authority on the values that decide ownership.
 *
 * Two rules matter most:
 *   1. A new public signup always becomes the `admin` of a brand-new tenant.
 *      The browser cannot pick its own `tenant_id`, `role` or `company_id`;
 *      those are produced here and stamped by the service-role route.
 *   2. The free plan is a foundation, not a billing system: it grants the
 *      modules that actually exist in SPEED ERP and nothing else.
 */

export type SignupInput = {
  fullName?: unknown;
  email?: unknown;
  password?: unknown;
  confirmPassword?: unknown;
  companyName?: unknown;
  phone?: unknown;
};

export type ValidatedSignup = {
  fullName: string;
  email: string;
  password: string;
  companyName: string;
  phone: string | null;
};

export type ValidationFailure = { ok: false; field: string; error: string };
export type ValidationSuccess = { ok: true; data: ValidatedSignup };
export type ValidationResult = ValidationSuccess | ValidationFailure;

/** Minimum password policy. Deliberately modest — Supabase enforces its own. */
export const MIN_PASSWORD_LENGTH = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validates a public signup payload. Returns the first problem in a stable,
 * user-safe form (no field echoes secrets, no internal detail).
 */
export function validateSignup(input: SignupInput): ValidationResult {
  const fullName = asString(input.fullName);
  const email = asString(input.email).toLowerCase();
  const password = typeof input.password === "string" ? input.password : "";
  const confirmPassword = typeof input.confirmPassword === "string" ? input.confirmPassword : "";
  const companyName = asString(input.companyName);
  const phone = asString(input.phone);

  if (!fullName) return { ok: false, field: "fullName", error: "Full name is required" };
  if (!email) return { ok: false, field: "email", error: "Email is required" };
  if (!EMAIL_RE.test(email)) return { ok: false, field: "email", error: "Enter a valid email address" };
  if (!companyName) return { ok: false, field: "companyName", error: "Company name is required" };
  if (!password) return { ok: false, field: "password", error: "Password is required" };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      field: "password",
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    };
  }
  if (password !== confirmPassword) {
    return { ok: false, field: "confirmPassword", error: "Passwords do not match" };
  }

  return {
    ok: true,
    data: { fullName, email, password, companyName, phone: phone || null },
  };
}

/**
 * The free plan. Only modules that genuinely exist in SPEED ERP are listed, and
 * no inventory feature is advertised (SPEED ERP has no inventory).
 */
export const FREE_PLAN = {
  id: "free",
  name: "Free",
  nameAr: "مجاني",
  price: 0,
  currency: "BHD",
  requiresPaymentMethod: false,
  features: [
    "accounting",
    "sales",
    "customers",
    "invoices",
    "payments",
    "returns",
    "expenses",
    "reports",
    "financial_years",
    "branches",
    "excel",
    "roles",
    "audit_logs",
    "multi_tenant",
  ],
} as const;

/**
 * The financial year a brand-new tenant starts with: the calendar year of the
 * moment they signed up. Provisioning is deterministic and timezone-free by
 * deriving it from the UTC date rather than a locale.
 */
export function defaultFinancialYear(now: Date = new Date()): {
  name: string;
  start_date: string;
  end_date: string;
} {
  const year = now.getUTCFullYear();
  return {
    name: String(year),
    start_date: `${year}-01-01`,
    end_date: `${year}-12-31`,
  };
}

/** Optional onboarding values a tenant may supply after signup. */
export type OnboardingInput = {
  companyName?: unknown;
  phone?: unknown;
  address?: unknown;
  financialYearName?: unknown;
  financialYearStart?: unknown;
  financialYearEnd?: unknown;
  branchName?: unknown;
};

export type ValidatedOnboarding = {
  companyName: string | null;
  phone: string | null;
  address: string | null;
  financialYear: { name: string; start_date: string; end_date: string } | null;
  branchName: string | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates onboarding. Every field is optional — the flow must never force
 * configuration the operator does not need — but a supplied value must be
 * well-formed (dates ordered, year name present when dates are given).
 */
export function validateOnboarding(
  input: OnboardingInput,
  now: Date = new Date(),
): { ok: true; data: ValidatedOnboarding } | ValidationFailure {
  const companyName = asString(input.companyName) || null;
  const phone = asString(input.phone) || null;
  const address = asString(input.address) || null;
  const branchName = asString(input.branchName) || null;

  const yearName = asString(input.financialYearName);
  const start = asString(input.financialYearStart);
  const end = asString(input.financialYearEnd);

  let financialYear: ValidatedOnboarding["financialYear"] = null;

  const anyYearField = Boolean(yearName || start || end);
  if (anyYearField) {
    if (!start || !DATE_RE.test(start)) {
      return { ok: false, field: "financialYearStart", error: "Financial year start date is required" };
    }
    if (!end || !DATE_RE.test(end)) {
      return { ok: false, field: "financialYearEnd", error: "Financial year end date is required" };
    }
    if (start > end) {
      return { ok: false, field: "financialYearEnd", error: "End date must be after the start date" };
    }
    financialYear = { name: yearName || start.slice(0, 4), start_date: start, end_date: end };
  } else {
    // No explicit year supplied: provision the default one so posting works.
    financialYear = defaultFinancialYear(now);
  }

  return { ok: true, data: { companyName, phone, address, financialYear, branchName } };
}
