import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session middleware.
 *
 * Responsibilities:
 *  - refresh the Supabase session cookie on every request so server-side route
 *    handlers can authenticate the caller;
 *  - enforce a coarse authentication gate on the privileged API surface
 *    (`/api/*`), which is the only place authorization can be trusted.
 *
 * Fine-grained authorization (role, permission, tenant, branch) stays in the
 * route handlers, which have database access; this middleware is deliberately
 * limited to "is there a session at all" plus a small explicit allow-list of
 * genuinely public endpoints.
 */

const PUBLIC_API_PREFIXES = [
  "/api/customer-signup", // public customer self-registration (car-rental portal)
  "/api/public/", // public marketing reads (vehicles, company profile)
  "/api/saas/signup", // public free-account signup (creates a NEW tenant)
];

/**
 * ERP page prefixes that require a session. An anonymous caller is redirected
 * to `/login` instead of being served the page shell (which would otherwise
 * return 200 and rely on client-side gating). The list is deliberately explicit
 * so marketing and portal pages are never caught by accident.
 */
const PROTECTED_PAGE_PREFIXES = [
  "/dashboard",
  "/financial-dashboard",
  "/accounting",
  "/reports",
  "/sales",
  "/purchases",
  "/purchase-orders",
  "/rentals",
  "/cars",
  "/fleet",
  "/customers",
  "/suppliers",
  "/supplier-payments",
  "/supplier-statements",
  "/invoices",
  "/payments",
  "/expenses",
  "/quotations",
  "/loans",
  "/credits",
  "/maintenance",
  "/bookings",
  "/hr",
  "/settings",
  "/employee-portal",
  "/customer-dashboard",
  "/booking",
  "/onboarding",
  // Global operator console. `/super-admin-login` is deliberately NOT here -
  // it is the public door an unauthenticated operator must be able to reach.
  "/super-admin",
];

/** True when a page path must have a session (else redirect to /login). */
export function isProtectedPage(pathname: string): boolean {
  return PROTECTED_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** True when an `/api/*` path is intentionally public. */
export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const { pathname } = request.nextUrl;
  const isPublicApi = isPublicApiPath(pathname);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Fail safe if the deployment is misconfigured. Without this the middleware
  // throws for every matched route (including public pages) and the app returns
  // 500. Deny protected APIs rather than risk an unauthenticated pass-through;
  // genuinely public routes and pages are untouched.
  if (!supabaseUrl || !supabaseAnonKey) {
    if (pathname.startsWith("/api/") && !isPublicApi) {
      return NextResponse.json(
        { error: "Authentication required", code: "unauthenticated" },
        { status: 401 },
      );
    }
    return response;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (pathname.startsWith("/api/") && !isPublicApi && !user) {
    return NextResponse.json(
      { error: "Authentication required", code: "unauthenticated" },
      { status: 401 },
    );
  }

  if (isProtectedPage(pathname) && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // Session refresh for the privileged API surface (and the hard gate above).
    "/api/:path*",
    // Session refresh for pages so server components can read the session.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
