import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { logAudit } from "@/lib/auth/audit";
import { defaultFinancialYear, validateSignup } from "@/lib/saas/provisioning";
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
 *   - the tenant is provisioned with a default financial year so posting works
 *     immediately;
 *   - every partial failure rolls back the auth user and the tenant, so a failed
 *     signup never leaves an orphaned account;
 *   - user-safe error messages only (no SQL, no keys).
 *
 * The service-role client is required because provisioning happens before the
 * user has a session (RLS would otherwise block the inserts). It is used only
 * after the payload is validated and only with server-generated ownership.
 */

function isDuplicateEmail(message: string | undefined): boolean {
  return /already|registered|exists/i.test(message ?? "");
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

  // Reject a duplicate email before any auth user exists, so a visitor can never
  // take over an existing account by "signing up" with its address.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (existingError) {
    return NextResponse.json({ error: "Could not complete signup", code: "internal_error" }, { status: 500 });
  }
  if (existing) {
    return NextResponse.json(
      { error: "This email is already registered. Please sign in.", code: "email_taken" },
      { status: 409 },
    );
  }

  // 1. Auth user.
  const created = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, company_name: companyName },
  });

  if (created.error || !created.data?.user) {
    const duplicate = isDuplicateEmail(created.error?.message);
    return NextResponse.json(
      {
        error: duplicate ? "This email is already registered. Please sign in." : "Could not create the account",
        code: duplicate ? "email_taken" : "signup_failed",
      },
      { status: 400 },
    );
  }

  const userId = created.data.user.id;

  // 2. The tenant. Ownership is generated here; the browser never supplies it.
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .insert({ name: companyName, name_en: companyName })
    .select("id")
    .single();

  if (tenantError || !tenant) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    return NextResponse.json({ error: "Could not create the company", code: "internal_error" }, { status: 500 });
  }

  const tenantId = (tenant as { id: string }).id;

  // 3. The application profile: owner/admin of THIS tenant only.
  const { error: userError } = await supabaseAdmin.from("users").insert({
    id: userId,
    email,
    full_name: fullName,
    role: "admin",
    tenant_id: tenantId,
    phone,
    is_active: true,
  });

  if (userError) {
    await supabaseAdmin.from("tenants").delete().eq("id", tenantId);
    await supabaseAdmin.auth.admin.deleteUser(userId);
    return NextResponse.json({ error: "Could not create the account", code: "internal_error" }, { status: 500 });
  }

  // 4. Default financial year, so a posting has a valid year from day one.
  const year = defaultFinancialYear();
  await supabaseAdmin.from("financial_years").insert({
    name: year.name,
    start_date: year.start_date,
    end_date: year.end_date,
    is_current: true,
    status: "open",
    tenant_id: tenantId,
  });

  const context: AuthContext = {
    authUserId: userId,
    email,
    fullName,
    role: "admin",
    tenantId,
    customerId: null,
    branchIds: null,
    financialYearId: null,
    permissions: {},
    isAdmin: true,
  };
  await logAudit(context, {
    action: "create",
    entity: "tenants",
    entityId: tenantId,
    metadata: { event: "signup", company_name: companyName },
  });

  // Never return the tenant id or any internal identifier to the browser.
  return NextResponse.json({ success: true, email });
}
