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

/**
 * The coarse surfaces of the application.
 *
 * `unknown` is not a surface: it is the answer for a path that is neither
 * explicitly public nor covered by a known prefix. It exists so the decision can
 * FAIL CLOSED - a page nobody classified is refused rather than served, because
 * "not classified" must never be read as "public".
 */
export type AccessArea = "customer" | "erp" | "platform" | "public" | "unknown";

/** The areas that a real prefix owns (everything except the two sentinels). */
type GatedArea = "customer" | "erp" | "platform";

/**
 * Area -> URL prefixes. Longest match wins, so a nested exception can be carved
 * out of a broader prefix (e.g. the public vehicle detail page inside `/cars`).
 */
const AREA_PREFIXES: Record<GatedArea, readonly string[]> = {
  // The customer portal. `/booking` is the vehicle booking form the marketing
  // site links to; it is a customer surface, not an ERP one. The sign-in pages
  // (`/customer-login`, `/customer-signup`) are PUBLIC doors, listed in
  // PUBLIC_PATH_PREFIXES instead, so that an anonymous visitor can reach them.
  customer: ["/customer-dashboard", "/booking"],
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
 * The vehicles public detail API. `/cars/[id]` reads this, never `cars`.
 */
export const PUBLIC_VEHICLE_API_PREFIX = "/api/public/vehicles";

/**
 * Public doorways and marketing pages. These are reachable by anyone (including
 * an anonymous visitor) and are therefore NOT gated by an area. This list is the
 * COMPLETE public surface: anything absent from it - and absent from
 * `AREA_PREFIXES` - is `unknown`, which fails closed.
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
 * Public pages that are NOT `.../[id]` ERP documents.
 *
 * This is the security-critical distinction. `/cars/<id>` is the public vehicle
 * detail page a visitor reaches from the marketing site; `/cars/new` is the ERP
 * "add vehicle" form. A blanket `startsWith("/cars/")` rule would make the ERP
 * form public, so the public case is stated positively instead: the LAST segment
 * must look like an identifier (a uuid or a slug), never a reserved ERP action
 * (`new`, `edit`, `create`, `import`, `export`, `settings`, ...).
 */
const RESERVED_DOCUMENT_SEGMENTS = new Set([
  "new",
  "create",
  "add",
  "edit",
  "update",
  "delete",
  "import",
  "export",
  "settings",
  "print",
  "duplicate",
  "bulk",
]);

/** A uuid, or a slug that is not a reserved action word. */
function looksLikeDocumentId(segment: string): boolean {
  if (!segment) return false;
  const lower = segment.toLowerCase();
  if (RESERVED_DOCUMENT_SEGMENTS.has(lower)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  // A slug: alphanumerics with optional single separators, not a bare action word.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,}$/.test(segment);
}

/** True for `/cars/<id>` (the public detail page) but never `/cars/<action>`. */
export function isPublicVehicleDetailPath(pathname: string): boolean {
  const match = /^\/cars\/([^/]+)\/?$/.exec(pathname);
  return match ? looksLikeDocumentId(match[1]) : false;
}

const PUBLIC_EXACT = new Set([
  "/", // marketing home
  "/fleet", // public fleet browse
  "/erp", // product-overview page (NOT the ERP surface)
]);

/** True when a path is deliberately public (and so is not area-gated). */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  // The public vehicle detail page, but never the ERP fleet register or an ERP
  // action route (`/cars/new`).
  if (isPublicVehicleDetailPath(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * The area a path belongs to.
 *
 * Order matters: the explicit public surface is checked first so `/cars/abc` is
 * public while `/cars/new` falls through to the ERP.
 *
 * A path that is neither public nor covered by a known prefix returns `unknown`.
 * That is the secure default: an unclassified page is refused, never served. The
 * drift test in `tests/exec69-*` asserts that every route on disk is classified,
 * so this branch should never be reached by a real page - it exists so that a
 * page added without a classification decision fails closed instead of open.
 */
export function areaForPath(pathname: string): AccessArea {
  if (isPublicPath(pathname)) return "public";

  let best: { area: GatedArea; len: number } | null = null;
  for (const [area, prefixes] of Object.entries(AREA_PREFIXES) as [GatedArea, readonly string[]][]) {
    for (const prefix of prefixes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        if (!best || prefix.length > best.len) best = { area, len: prefix.length };
      }
    }
  }
  return best?.area ?? "unknown";
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
  if (area === "public") return true;
  // An unclassified path is reachable by nobody. See `areaForPath`.
  if (area === "unknown") return false;
  if (!role) return false;
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
  // `public` is a safe page, `customer` is the portal itself. An ERP, platform
  // or unclassified target is refused so a customer cannot be bounced at the ERP.
  if (area !== "public" && area !== "customer") return fallback;
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
 *   - unclassified path        -> deny  (secure default; never "allow")
 *   - unauthenticated          -> redirect to the matching sign-in door
 *   - wrong area for the role  -> deny (403 / access-denied)
 *   - right area               -> allow
 */
export function decidePathAccess(pathname: string, role: AppRole | null | undefined): AccessDecision {
  const area = areaForPath(pathname);
  if (area === "public") return { kind: "allow" };
  if (area === "unknown") return { kind: "deny" };
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
