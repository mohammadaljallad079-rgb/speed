import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import {
  apiAccessForPath,
  areaForPath,
  loginPathForArea,
  roleMayReachArea,
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
  return areaForPath(pathname) !== null;
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

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const apiAccess = isApi ? apiAccessForPath(pathname) : null;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Fail safe if the deployment is misconfigured. Without this the middleware
  // throws for every matched route (including public pages) and the app returns
  // 500. Deny protected APIs rather than risk an unauthenticated pass-through;
  // genuinely public routes and pages are untouched.
  if (!supabaseUrl || !supabaseAnonKey) {
    if (isApi && apiAccess?.kind !== "public") {
      return NextResponse.json(
        { error: "Authentication required", code: "unauthenticated" },
        { status: 401 },
      );
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
    if (!user) {
      return NextResponse.json(
        { error: "Authentication required", code: "unauthenticated" },
        { status: 401 },
      );
    }
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
  const area = areaForPath(pathname);
  if (area === null) return response;

  if (!user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = loginPathForArea(area);
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  const role = await readSessionRole(supabase as unknown as RoleReaderClient, user.id);
  if (!role) {
    // Authenticated but unprovisioned: send to the matching sign-in door so the
    // user gets an actionable message instead of a blank ERP shell.
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = loginPathForArea(area);
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  if (!roleMayReachArea(role, area)) {
    const deniedUrl = request.nextUrl.clone();
    deniedUrl.pathname = "/access-denied";
    deniedUrl.search = "";
    return NextResponse.redirect(deniedUrl);
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
