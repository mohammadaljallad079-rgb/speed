import { NextResponse } from "next/server";

import { resolveAuthContext } from "@/lib/auth/context";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { resolveEntitlements } from "@/lib/saas/effective-plan";

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

  // The capabilities IN FORCE right now, so a client surface can hide a control
  // the server would refuse (exports, imports, the AI agent). Resolving the plan
  // and the trial together is what lets a seven-day trial actually end: a route
  // that read the package alone would keep granting it forever. This is
  // presentation only - every route re-checks server-side, so a tampered
  // response cannot grant anything. A super admin operates the platform and
  // holds every capability.
  const entitlements = await resolveEntitlements(supabaseAdmin as never, context.tenantId, {
    isSuperAdmin: context.isSuperAdmin,
  });

  return NextResponse.json({
    authUserId: context.authUserId,
    email: context.email,
    fullName: context.fullName,
    role: context.role,
    tenantId: context.tenantId,
    isAdmin: context.isAdmin,
    isSuperAdmin: context.isSuperAdmin,
    plan: entitlements.plan,
    capabilities: entitlements.capabilities,
    // The trial's own state, so the UI can show "4 days left" or an upgrade
    // prompt. `status` is derived server-side from the stored end timestamp.
    trial: entitlements.trial,
    onTrial: entitlements.onTrial,
  });
}
