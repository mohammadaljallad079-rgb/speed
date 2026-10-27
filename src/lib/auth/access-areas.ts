/**
 * Access areas: which part of SPEED an authenticated identity may reach.
 *
 * SPEED has THREE distinct access contexts, and they must never be conflated:
 *
 *   1. RENTAL CUSTOMER (`role: "client"`) - a person renting a vehicle. They get
 *      the customer portal (`/customer-dashboard`, `/booking`) and their own
 *      records only. They must never reach the ERP.
 *   2. ERP USER (`admin` | `staff`) - a company owner or employee. They get the
 *      ERP surface, scoped to their own tenant by RLS and the route guards.
 *   3. PLATFORM OPERATOR (`super_admin`) - the global operator. They get the
 *      platform console, not a company workspace.
 *
 * This module is PURE: it maps an already-resolved role to the areas it may
 * reach and to the single destination it belongs at. It is deliberately free of
 * infrastructure so the decision can be unit-tested directly, and so it can run
 * in the Edge middleware (no database, no Node APIs).
 *
 * The role it consumes comes from the authenticated session and the application
 * `users` row - never from a client-supplied value, a URL parameter, a cookie
 * the caller can write, or a frontend label. Authorization is decided here and
 * enforced in `middleware.ts` and in every route guard; hiding a navigation link
 * is presentation, not security.
 */

import type { AppRole } from "./permissions";

/** The coarse surfaces of the application. */
export type AccessArea = "customer" | "erp" | "platform" | "public";

/**
 * Area -> URL prefixes. Longest match wins, so a nested exception can be carved
 * out of a broader prefix (e.g. the public vehicle detail page inside `/cars`).
 */
const AREA_PREFIXES: Record<Exclude<AccessArea, "public">, readonly string[]> = {
  // The customer portal. `/booking` is the vehicle booking form the marketing
  // site links to; it is a customer surface, not an ERP one.
  customer: ["/customer-dashboard", "/booking", "/customer-login", "/customer-signup"],
  // The platform operator console. `/super-admin-login` is the public door.
  platform: ["/super-admin"],
  // The ERP. Every prefix here is a company workspace; reaching it requires an
  // ERP role, and the tenant scope is applied by RLS and the route guards.
  erp: [
    "/dashboard",
    "/financial-dashboard",
    "/accounting",
    "/accounts",
    "/reports",
    "/sales",
    "/purchases",
    "/purchase-orders",
    "/rentals",
    "/bookings",
    "/cars",
    "/customers",
    "/suppliers",
    "/supplier-payments",
    "/supplier-statements",
    "/invoices",
    "/payments",
    "/receipts",
    "/expenses",
    "/quotations",
    "/loans",
    "/credits",
    "/maintenance",
    "/debit-notes",
    "/hr",
    "/payroll",
    "/settings",
    "/employee-portal",
    "/onboarding",
    "/import",
    "/notifications",
    "/branding",
  ],
};

/**
 * Public doorways and exceptions. These are reachable by anyone (including an
 * anonymous visitor) and are therefore NOT gated by an area. This list is
 * exported so a test can assert that every route on disk is either gated or
 * explicitly public - a new page nobody classified must fail that test rather
 * than default to a decision.
 */
export const PUBLIC_PATH_PREFIXES: readonly string[] = [
  "/login",
  "/signup",
  "/super-admin-login",
  "/customer-login",
  "/customer-signup",
  "/features",
  "/solutions",
  "/pricing",
  "/faq",
  "/privacy",
  "/terms",
  "/contact",
  "/services",
  "/test",
  "/access-denied",
];

/**
 * `/cars/[id]` is the PUBLIC vehicle detail page an anonymous visitor reaches
 * from the marketing site. The ERP fleet register (`/cars`, `/cars/new`) is not.
 * `/fleet` renders the public marketing chrome, so it is public too, as does
 * `/erp` (the product-overview page).
 */
const PUBLIC_EXACT = new Set(["/", "/fleet", "/erp"]);

/** True when a path is deliberately public (and so is not area-gated). */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  // The public vehicle detail page, but never the ERP fleet register.
  if (pathname.startsWith("/cars/") && pathname !== "/cars/new") return true;
  return PUBLIC_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * The area a path belongs to, or `null` when the path is public.
 *
 * Order matters: the public exceptions are checked first so `/cars/abc` is
 * public while `/cars/new` falls through to the ERP.
 */
export function areaForPath(pathname: string): AccessArea | null {
  if (isPublicPath(pathname)) return null;

  let best: { area: Exclude<AccessArea, "public">; len: number } | null = null;
  for (const [area, prefixes] of Object.entries(AREA_PREFIXES) as [
    Exclude<AccessArea, "public">,
    readonly string[],
  ][]) {
    for (const prefix of prefixes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        if (!best || prefix.length > best.len) best = { area, len: prefix.length };
      }
    }
  }
  return best?.area ?? null;
}

/**
 * May an identity with `role` reach `area`?
 *
 * A `client` is confined to the customer portal. `admin`/`staff` reach the ERP.
 * `super_admin` reaches the platform console. A `null` role is an unauthenticated
 * or unresolvable identity and reaches nothing.
 *
 * Note what is deliberately NOT true: `client` does not reach the ERP, and
 * `admin`/`staff` do not reach the platform console. A user who is both a
 * customer and a company user must have an ERP role on their single application
 * row; the role decides the area, and the context switch is a role question, not
 * a client-side toggle.
 */
export function roleMayReachArea(role: AppRole | null | undefined, area: AccessArea): boolean {
  if (!role) return false;
  if (area === "public") return true;
  switch (role) {
    case "client":
      return area === "customer";
    case "admin":
    case "staff":
      return area === "erp";
    case "super_admin":
      return area === "platform";
    default:
      return false;
  }
}

/** The single destination an identity belongs at. */
export function homePathForRole(role: AppRole | null | undefined): string {
  switch (role) {
    case "client":
      return "/customer-dashboard";
    case "admin":
    case "staff":
      return "/dashboard";
    case "super_admin":
      return "/super-admin";
    default:
      return "/login";
  }
}

/** The sign-in door an identity should be sent to when it has no session. */
export function loginPathForArea(area: AccessArea | null): string {
  if (area === "platform") return "/super-admin-login";
  // The customer portal has its own door, which refuses a non-customer account.
  // Sending a customer to the ERP `/login` would authenticate them as a company
  // identity and then bounce them; they must land on the portal sign-in.
  if (area === "customer") return "/customer-login";
  return "/login";
}

/**
 * Sanitise a post-sign-in redirect target.
 *
 * A `?redirect=` value is caller input, so it must never be trusted: an
 * absolute URL turns the portal into an open redirect (phishing), and a
 * protocol-relative `//evil.com` or a backslash `/\evil.com` slips past a naive
 * `startsWith("/")` check. Only a same-origin path that belongs to the CUSTOMER
 * area (or a public page) is allowed; anything else falls back to the portal.
 */
export function safeCustomerRedirect(
  value: string | null | undefined,
  fallback = "/customer-dashboard",
): string {
  if (!value || !value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.includes("\\")) return fallback;
  const path = value.split(/[?#]/)[0];
  if (path.includes("://")) return fallback;
  // An API endpoint is never a page navigation target.
  if (path === "/api" || path.startsWith("/api/")) return fallback;
  const area = areaForPath(path);
  // `null` is a public page (safe), `customer` is the portal itself. An ERP or
  // platform target is refused so a customer cannot be bounced at the ERP.
  if (area !== null && area !== "customer") return fallback;
  return value;
}

export type AccessDecision =
  | { kind: "allow" }
  | { kind: "redirect"; to: string }
  | { kind: "deny" };

/**
 * The single decision function used by the middleware and (in tests) by the
 * route-level guard. Given a path and the caller's resolved role it returns
 * exactly one outcome, so page and API behaviour can never drift apart.
 *
 *   - public path              -> allow
 *   - unauthenticated          -> redirect to the matching sign-in door
 *   - wrong area for the role  -> deny (403 / access-denied)
 *   - right area               -> allow
 */
export function decidePathAccess(pathname: string, role: AppRole | null | undefined): AccessDecision {
  const area = areaForPath(pathname);
  if (area === null) return { kind: "allow" };
  if (!role) return { kind: "redirect", to: loginPathForArea(area) };
  if (!roleMayReachArea(role, area)) return { kind: "deny" };
  return { kind: "allow" };
}

// --- API surface classification -------------------------------------------

/**
 * `/api/*` endpoints that are genuinely public (no session at all).
 * Adding a prefix here is a security decision: it is reachable anonymously.
 */
export const PUBLIC_API_PREFIXES: readonly string[] = [
  "/api/customer-signup", // public customer self-registration (car-rental portal)
  "/api/public/", // public marketing reads (vehicles, company profile)
  "/api/saas/signup", // public free-account signup (creates a NEW tenant)
];

/**
 * Endpoints any AUTHENTICATED identity may call, whatever its area. `/api/me`
 * is the caller's own authorization context: the login pages must be able to ask
 * "who am I and where do I belong?" before a role is known, and the client
 * helpers (`use-tenant-id`, `use-report-scope`) read it from the ERP shell. It
 * exposes only the caller's own record, so it is not an area-specific surface.
 */
export const ANY_AUTHENTICATED_API_PREFIXES: readonly string[] = ["/api/me"];

/**
 * API prefixes that are the CUSTOMER portal's own surface. Reachable only by a
 * `client` role; an ERP user is refused, and vice versa. Keeping the list
 * explicit means a new customer endpoint must be classified deliberately.
 */
export const CUSTOMER_API_PREFIXES: readonly string[] = ["/api/customer/"];

export type ApiAccess =
  | { kind: "public" }
  | { kind: "any-authenticated" }
  | { kind: "area"; area: AccessArea };

/** Classify an `/api/*` path. Anything unclassified is a company-ERP endpoint. */
export function apiAccessForPath(pathname: string): ApiAccess {
  if (PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return { kind: "public" };
  if (ANY_AUTHENTICATED_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return { kind: "any-authenticated" };
  }
  if (pathname.startsWith("/api/super-admin/")) return { kind: "area", area: "platform" };
  if (CUSTOMER_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return { kind: "area", area: "customer" };
  }
  return { kind: "area", area: "erp" };
}
