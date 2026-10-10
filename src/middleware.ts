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

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

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

  const { pathname } = request.nextUrl;
  const isPublicApi = PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (pathname.startsWith("/api/") && !isPublicApi && !user) {
    return NextResponse.json(
      { error: "Authentication required", code: "unauthenticated" },
      { status: 401 },
    );
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
