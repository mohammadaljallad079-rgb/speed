import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { logAudit } from "@/lib/auth/audit";
import { validateSignup } from "@/lib/saas/provisioning";
import {
  provisionSignup,
  verifyProvisionedAccount,
  type SignupDb,
} from "@/lib/saas/signup-service";
import { TRIAL_DAYS } from "@/lib/saas/trial";
import type { AuthContext } from "@/lib/auth/types";

/**
 * Public free-account signup.
 *
 * This is the ONLY public route that creates ERP accounts. It is deliberately
 * narrow and server-authoritative:
 *
 *   - the caller supplies only name/email/password/company/phone;
 *   - `tenant_id`, `role`, `company_id` and `user_id` are produced HERE and are
 *     never read from the request body, so a visitor cannot join an existing
 *     tenant or grant themselves a role;
 *   - the new user becomes `admin` of a brand-new, empty tenant only;
 *   - every partial failure compensates what it created, so a failed signup never
 *     leaves an orphaned account;
 *   - user-safe error messages only (no SQL, no keys).
 *
 * The provisioning rules live in `signup-service.ts`, not here, because they are
 * the part that must be tested: the auth user, the tenant, the owner profile, the
 * financial year AND the seven-day trial must all exist before this route answers
 * `success: true`. An earlier version of this route ignored the financial-year
 * error and never checked the trial, so it could report success for an account
 * that could not post and had no trial.
 *
 * The service-role client is required because provisioning happens before the
 * user has a session (RLS would otherwise block the inserts). It is used only
 * after the payload is validated and only with server-generated ownership.
 */

/** Maps a provisioning failure to a safe, user-facing response. */
function failureResponse(reason: string, cleanupIncomplete?: boolean): NextResponse {
  if (reason === "email_taken") {
    return NextResponse.json(
      { error: "This email is already registered. Please sign in.", code: "email_taken" },
      { status: 409 },
    );
  }
  if (reason === "auth_user_failed") {
    return NextResponse.json(
      { error: "Could not create the account", code: "signup_failed" },
      { status: 400 },
    );
  }
  // The remaining reasons are infrastructure failures. `cleanupIncomplete` means
  // compensation could not remove everything, so the operator should be able to
  // find it in the logs; the customer still gets a retryable message, because a
  // retry reuses whatever exists rather than duplicating it.
  if (cleanupIncomplete) {
    console.error("[signup] compensation incomplete; an orphaned row may remain for", reason);
  }
  return NextResponse.json(
    { error: "Could not complete signup. Please try again.", code: "internal_error" },
    { status: 500 },
  );
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) ?? {};
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "bad_request" }, { status: 400 });
  }

  const validation = validateSignup(body);
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.error, field: validation.field, code: "validation_error" },
      { status: 400 },
    );
  }

  const { fullName, email, companyName, phone, password } = validation.data;
  const db = supabaseAdmin as unknown as SignupDb;

  const result = await provisionSignup(db, { fullName, email, password, companyName, phone });

  if (!result.ok) {
    return failureResponse(result.reason, result.cleanupIncomplete);
  }

  const { account } = result;

  // Do not claim success on the strength of "no exception was thrown". Re-read
  // the rows the customer depends on; if any is missing, the signup did not
  // happen and the caller must be told so.
  const verified = await verifyProvisionedAccount(db, account);
  if (!verified.ok) {
    console.error("[signup] provisioning reported success but these rows are missing:", verified.missing);
    return NextResponse.json(
      { error: "Could not complete signup. Please try again.", code: "internal_error" },
      { status: 500 },
    );
  }

  const context: AuthContext = {
    authUserId: account.userId,
    email,
    fullName,
    role: "admin",
    tenantId: account.tenantId,
    customerId: null,
    branchIds: null,
    financialYearId: null,
    permissions: {},
    isAdmin: true,
    isSuperAdmin: false,
  };
  await logAudit(context, {
    action: "create",
    entity: "tenants",
    entityId: account.tenantId,
    metadata: {
      event: "signup",
      company_name: companyName,
      trial_days: TRIAL_DAYS,
      trial_ends_at: account.trialEndsAt,
      trial_granted: account.trialEndsAt !== null,
    },
  });

  // The trial length is safe to return (it is public marketing copy); the tenant
  // id and every internal identifier still are not.
  return NextResponse.json({
    success: true,
    email,
    trial: { days: TRIAL_DAYS, endsAt: account.trialEndsAt, granted: account.trialEndsAt !== null },
  });
}
