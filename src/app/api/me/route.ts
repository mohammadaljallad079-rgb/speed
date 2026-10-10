import { NextResponse } from "next/server";

import { resolveAuthContext } from "@/lib/auth/context";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * The caller's own authorization context.
 *
 * The login page must not decide a user's role from data it fetches with the
 * browser client, because that data is not the authority on access. This route
 * resolves the context server-side (session + application tables) and returns
 * only safe presentation fields.
 *
 * It also distinguishes the two failure modes a login flow must not conflate:
 *   - no valid session            -> 401 `unauthenticated`
 *   - session but no app mapping  -> 403 `account_not_provisioned`
 * so a user whose Auth identity exists but has no `users`/`profiles` row gets an
 * actionable message instead of a silent failure.
 */
export async function GET(request: Request) {
  // 1. Is there a valid session at all?
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: "Authentication required", code: "unauthenticated" },
      { status: 401 },
    );
  }

  // 2. Can the session be resolved to an application identity?
  const context = await resolveAuthContext(request);
  if (!context) {
    return NextResponse.json(
      {
        error:
          "Your sign-in succeeded but your account is not linked to the ERP. Contact an administrator.",
        code: "account_not_provisioned",
      },
      { status: 403 },
    );
  }

  return NextResponse.json({
    authUserId: context.authUserId,
    email: context.email,
    fullName: context.fullName,
    role: context.role,
    tenantId: context.tenantId,
    isAdmin: context.isAdmin,
    isSuperAdmin: context.isSuperAdmin,
  });
}
