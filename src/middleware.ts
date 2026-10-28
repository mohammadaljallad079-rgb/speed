import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import {
  apiAccessForPath,
  areaForPath,
  loginPathForArea,
  roleMayReachArea,
  type AccessArea,
} from "@/lib/auth/access-areas";
import { readSessionRole, type RoleReaderClient } from "@/lib/auth/session-role";

/**
 * Session + AREA middleware.
 *
 * Responsibilities:
 *  - refresh the Supabase session cookie on every request so server-side route
 *    handlers can authenticate the caller;
 *  - enforce a coarse authentication gate on the privileged API surface
 *    (`/api/*`);
 *  - enforce the AREA boundary: a rental customer is confined to the customer
 *    portal and can never reach an ERP page or ERP API, and an ERP user can
 *    never reach the platform console.
 *
 * The area decision lives in `access-areas.ts` (pure) and is applied here to
 * pages AND to the privileged API surface. This closes the reported defect: a
 * `client` who signed in and clicked "Dashboard" was served the ERP shell,
 * because the middleware only ever asked "is there a session?" and never "is
 * this identity allowed here?".
 *
 * Hiding a navigation link is not a security control. The gate below runs on the
 * server for every matched request, so a customer who types an ERP URL or calls
 * an ERP API directly is refused regardless of what the UI renders.
 *
 * Fine-grained authorization (permission module/action, branch, financial year)
 * still lives in the route handlers, which have database access; the middleware
 * decides only the AREA, which is a role question and needs one indexed read.
 */

/** True when a page path belongs to a gated area (and so needs a session). */
export function isProtectedPage(pathname: string): boolean {
  // Anything that is not explicitly public needs a session. An unclassified
  // path is protected, which is the fail-closed direction.
  return areaForPath(pathname) !== "public";
}

/**
 * The global operator console. It has its own sign-in page, so an anonymous
 * visitor is sent there rather than to the ERP login.
 */
export function isSuperAdminPage(pathname: string): boolean {
  return pathname === "/super-admin" || pathname.startsWith("/super-admin/");
}

/** True when an `/api/*` path is intentionally public (no session required). */
export function isPublicApiPath(pathname: string): boolean {
  return apiAccessForPath(pathname).kind === "public";
}

function forbiddenJson(message: string, code: string) {
  return NextResponse.json({ error: message, code }, { status: 403 });
}

function unauthenticatedJson() {
  return NextResponse.json(
    { error: "Authentication required", code: "unauthenticated" },
    { status: 401 },
  );
}

/** Redirect a page request to a sign-in door, dropping the query string. */
function redirectTo(request: NextRequest, pathname: string) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const apiAccess = isApi ? apiAccessForPath(pathname) : null;
  // For a page, the area is always defined (never `null`): an unclassified page
  // is `unknown`, which the decision below denies.
  const pageArea: AccessArea | null = isApi ? null : areaForPath(pathname);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Fail CLOSED if the deployment is misconfigured.
  //
  // Without this the middleware throws for every matched route (including public
  // pages) and the app returns 500. The safe response is to deny everything that
  // is not explicitly public: a protected API gets 401 and a protected PAGE is
  // redirected to its sign-in door. Returning `next()` for a protected page here
  // would serve the ERP shell to an unauthenticated caller whenever the auth
  // configuration is absent - an availability problem must never become an
  // authorization one.
  if (!supabaseUrl || !supabaseAnonKey) {
    if (isApi && apiAccess?.kind !== "public") return unauthenticatedJson();
    if (!isApi && pageArea !== "public") {
      return redirectTo(request, isSuperAdminPage(pathname) ? "/super-admin-login" : loginPathForArea(pageArea));
    }
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
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
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // --- API surface ---------------------------------------------------------
  if (isApi && apiAccess) {
    if (apiAccess.kind === "public") return response;
    if (!user) return unauthenticatedJson();
    // `/api/me` is the caller's own context and is valid in any area.
    if (apiAccess.kind === "any-authenticated") return response;

    // Resolve the role from the caller's OWN row and enforce the AREA. The role
    // read is RLS-scoped to `id = auth.uid()`; a failure yields no role, which
    // denies an ERP API rather than serving it.
    const role = await readSessionRole(supabase as unknown as RoleReaderClient, user.id);
    if (!role) {
      return forbiddenJson("Your account is not linked to the ERP", "account_not_provisioned");
    }
    if (!roleMayReachArea(role, apiAccess.area)) {
      return forbiddenJson("Your account is not authorized for this area", "forbidden");
    }
    return response;
  }

  // --- Pages ---------------------------------------------------------------
  // A page path always resolves to a concrete area: an unclassified page is
  // `unknown`, which the decision below denies. (`pageArea` is non-null here
  // because the API branch above returns for every `/api/*` request.)
  const area: AccessArea = pageArea ?? "unknown";

  // An explicitly public page is served to everyone, signed in or not.
  if (area === "public") return response;

  if (!user) return redirectTo(request, loginPathForArea(area));

  const role = await readSessionRole(supabase as unknown as RoleReaderClient, user.id);
  if (!role) {
    // Authenticated but unprovisioned: send to the matching sign-in door so the
    // user gets an actionable message instead of a blank ERP shell.
    return redirectTo(request, loginPathForArea(area));
  }

  if (!roleMayReachArea(role, area)) return redirectTo(request, "/access-denied");

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
