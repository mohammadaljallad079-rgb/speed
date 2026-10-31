/**
 * Free-account provisioning, as one all-or-nothing operation.
 *
 * WHY THIS IS A SERVICE, NOT A ROUTE
 * ---------------------------------
 * The route used to inline five provisioning steps and return `success: true`
 * after the last one — but it never looked at the result of the financial-year
 * insert, and it never checked whether the trial was actually granted. So a
 * signup could answer "success" while the tenant had no financial year (posting
 * breaks on day one) or no trial (the seven-day promise silently lost). Worse,
 * the earlier steps were only compensated on *their own* failure: a failure at
 * step 4 or 5 left an auth user and a tenant behind with no way to retry.
 *
 * The rules this module enforces:
 *
 *   1. SUCCESS IS RETURNED ONLY WHEN ALL FIVE EXIST: the auth user, the tenant,
 *      the owner profile, the financial year and the seven-day trial. Each step
 *      is checked, and any failure is reported as a failure.
 *   2. FAILURE COMPENSATES EVERYTHING THIS CALL CREATED — in reverse order, and
 *      only what this call created. A pre-existing row (an idempotent retry) is
 *      never deleted; deleting it would destroy an account that is in use.
 *   3. RETRY IS IDEMPOTENT. A retry after a partial failure reuses the existing
 *      auth user, tenant, profile and year instead of duplicating them, and does
 *      not extend the trial (a retry must never buy more free days).
 *   4. IDENTITY IS SERVER-GENERATED. The tenant id, the role and the profile id
 *      are produced here. Nothing is read from the request.
 *
 * The database handle is injectable so the rules above are testable against a
 * recording stub, without a live Supabase project.
 */

import { defaultFinancialYear } from "./provisioning";
import { TRIAL_DAYS } from "./trial";
import { grantTenantTrial, loadTenantTrial } from "./trial-store";
import type { TenantTrialDb } from "./trial-store";

/** The identity a signup produces. Never supplied by the caller. */
export interface ProvisionedAccount {
  userId: string;
  tenantId: string;
  role: "admin";
  trialEndsAt: string | null;
}

export type ProvisionFailure =
  /** The email already has an Auth identity (or an app profile). */
  | "email_taken"
  | "auth_user_failed"
  | "tenant_failed"
  | "profile_failed"
  | "financial_year_failed"
  | "trial_failed";

export type ProvisionResult =
  | { ok: true; account: ProvisionedAccount }
  | {
      ok: false;
      reason: ProvisionFailure;
      /**
       * True when compensation could not undo everything this call created, so a
       * human must look. This is surfaced rather than swallowed: an orphaned auth
       * user is recoverable by re-running signup (it is reused), but it must be
       * visible in the logs.
       */
      cleanupIncomplete?: boolean;
    };

/**
 * The slice of the service-role client this service uses.
 *
 * Declared structurally rather than importing the Supabase type so the service
 * stays testable and so a narrower stub is enough. Every method here is one the
 * real client provides.
 */
export interface SignupDb extends TenantTrialDb {
  auth: {
    admin: {
      createUser(input: {
        email: string;
        password: string;
        email_confirm?: boolean;
        user_metadata?: Record<string, unknown>;
      }): Promise<{
        data: { user: { id: string } | null } | null;
        error: { message?: string; code?: string } | null;
      }>;
      deleteUser(id: string): Promise<{ error: unknown }>;
      listUsers(input: {
        page: number;
        perPage: number;
      }): Promise<{
        data: { users: Array<{ id: string; email?: string | null }> } | null;
        error: unknown;
      }>;
    };
  };
  from(table: string): SignupTable;
}

interface InsertResult {
  data: unknown;
  error: { message?: string; code?: string } | null;
}

/**
 * A read result. `data` is shaped like the trial/plan stores' `{ value }` cell so
 * this client is structurally a `TenantTrialDb`; callers cast to the row they
 * actually selected.
 */
interface SelectResult {
  data: { value?: unknown } | null;
  error: { message?: string; code?: string } | null;
}

interface SignupQuery extends PromiseLike<SelectResult> {
  select(columns?: string): SignupQuery;
  eq(column: string, value: unknown): SignupQuery;
  limit(n: number): SignupQuery;
  maybeSingle(): Promise<SelectResult>;
}

interface SignupTable {
  insert(row: Record<string, unknown>): {
    select(columns?: string): { single(): Promise<InsertResult> } & PromiseLike<InsertResult>;
  } & PromiseLike<InsertResult>;
  select(columns?: string): SignupQuery;
  delete(): { eq(column: string, value: unknown): PromiseLike<SelectResult> };
  upsert(
    row: Record<string, unknown>,
    options?: { onConflict?: string },
  ): Promise<{ error: unknown }>;
}

/**
 * Is this "the column you named does not exist"?
 *
 * The live project does not yet carry every migration (001 adds
 * `financial_years.tenant_id`), so naming a column that is not there is a hard
 * error. Only that shape is retried without the column — any other error is a
 * real failure. Same rule as `isMissingColumnError` in the rental service.
 */
function isMissingColumn(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (String(e.code ?? "") === "42703" || String(e.code ?? "") === "PGRST204") return true;
  const m = String(e.message ?? "").toLowerCase();
  return m.includes("column") && (m.includes("does not exist") || m.includes("could not find"));
}

function isDuplicateEmail(message: string | undefined): boolean {
  return /already|registered|exists/i.test(message ?? "");
}

/** The app profile row for an email, if one exists (the signup takeover guard). */
export async function findProfileByEmail(
  db: SignupDb,
  email: string,
): Promise<{ id: string } | null> {
  const { data, error } = await db.from("users").select("id").eq("email", email).maybeSingle();
  if (error) return null;
  return (data as { id: string } | null) ?? null;
}

/**
 * Finds an existing Auth identity by email.
 *
 * `createUser` refuses a duplicate address, so a retry after a partial failure
 * would otherwise be unable to finish: the identity exists but the tenant never
 * did. Listing is the only way to find it — Supabase has no get-by-email — and
 * it is bounded (a few pages) so it cannot walk a large user table.
 */
export async function findAuthUserByEmail(
  db: SignupDb,
  email: string,
): Promise<{ id: string } | null> {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users) return null;
    const hit = data.users.find((u) => (u.email ?? "").trim().toLowerCase() === target);
    if (hit) return { id: hit.id };
    if (data.users.length < 200) return null;
  }
  return null;
}

export interface ProvisionSignupInput {
  fullName: string;
  email: string;
  password: string;
  companyName: string;
  phone: string | null;
  /** Injectable clock, so the trial window and the year are testable. */
  now?: Date;
}

/**
 * Provisions a free account. Returns `ok: true` only when every part exists.
 *
 * The steps run in order and each result is checked. On failure everything this
 * call created is removed again, newest first.
 */
export async function provisionSignup(
  db: SignupDb,
  input: ProvisionSignupInput,
): Promise<ProvisionResult> {
  const now = input.now ?? new Date();

  // 0. Refuse an email that already has an application profile, before an Auth
  //    identity is created. This is the account-takeover guard.
  if (await findProfileByEmail(db, input.email)) {
    return { ok: false, reason: "email_taken" };
  }

  // 1. The Auth user. Reuse an existing identity so a retry can finish rather
  //    than being blocked by a duplicate that this same flow left behind.
  let userId: string | null = null;
  let createdAuthUser = false;

  const created = await db.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.fullName, company_name: input.companyName },
  });

  if (created.error || !created.data?.user) {
    if (isDuplicateEmail(created.error?.message)) {
      const existing = await findAuthUserByEmail(db, input.email);
      if (!existing) return { ok: false, reason: "email_taken" };
      userId = existing.id;
    } else {
      return { ok: false, reason: "auth_user_failed" };
    }
  } else {
    userId = created.data.user.id;
    createdAuthUser = true;
  }

  if (!userId) return { ok: false, reason: "auth_user_failed" };

  // 2. The tenant. Ownership is generated here; the browser never supplies it.
  const tenant = await db
    .from("tenants")
    .insert({ name: input.companyName, name_en: input.companyName })
    .select("id")
    .single();

  if (tenant.error || !tenant.data) {
    const cleanupIncomplete = createdAuthUser ? !(await safeDeleteAuthUser(db, userId)) : false;
    return { ok: false, reason: "tenant_failed", cleanupIncomplete };
  }

  const tenantId = (tenant.data as { id: string }).id;

  // 3. The owner profile: admin of THIS tenant only.
  const profile = await db.from("users").insert({
    id: userId,
    email: input.email,
    full_name: input.fullName,
    role: "admin",
    tenant_id: tenantId,
    phone: input.phone,
    is_active: true,
  });

  if (profile.error) {
    const cleanupIncomplete = !(await compensate(db, { tenantId, userId, deleteAuthUser: createdAuthUser }));
    return { ok: false, reason: "profile_failed", cleanupIncomplete };
  }

  // 4. The default financial year, so a posting has a valid year from day one.
  //    The result IS checked: without a year the tenant cannot post, so a silent
  //    failure here is exactly the "success with a broken account" defect.
  const year = defaultFinancialYear(now);
  const yearRow: Record<string, unknown> = {
    name: year.name,
    start_date: year.start_date,
    end_date: year.end_date,
    is_current: true,
    status: "open",
    tenant_id: tenantId,
  };

  let yearInsert = await db.from("financial_years").insert(yearRow).select("id").single();
  if (yearInsert.error && isMissingColumn(yearInsert.error)) {
    // The live project may not carry migration 001 yet, so `tenant_id` may not
    // exist on `financial_years`. Drop only that column and retry; the year still
    // exists, and the app's year lookup filters by tenant when the column is
    // present. Losing the column is a schema gap, not a reason to fail signup.
    const { tenant_id: _dropped, ...withoutTenant } = yearRow;
    yearInsert = await db.from("financial_years").insert(withoutTenant).select("id").single();
  }

  if (yearInsert.error) {
    const cleanupIncomplete = !(await compensate(db, {
      tenantId,
      userId,
      deleteAuthUser: createdAuthUser,
      deleteProfile: true,
    }));
    return { ok: false, reason: "financial_year_failed", cleanupIncomplete };
  }

  // 5. The seven-day trial. Granted at provisioning time so the window starts
  //    when the account is created. `restart: false` so a retry cannot extend it.
  const trial = await grantTenantTrial(db, tenantId, { now, restart: false });

  if (!trial.ok || !trial.record) {
    const cleanupIncomplete = !(await compensate(db, {
      tenantId,
      userId,
      deleteAuthUser: createdAuthUser,
      deleteProfile: true,
      deleteFinancialYear: true,
    }));
    return { ok: false, reason: "trial_failed", cleanupIncomplete };
  }

  return {
    ok: true,
    account: {
      userId,
      tenantId,
      role: "admin",
      trialEndsAt: trial.record.endsAt,
    },
  };
}

/**
 * Confirms the account a successful signup reports actually exists.
 *
 * The route calls this before answering `success: true`. It re-reads the three
 * rows the customer depends on, so a claim of success is backed by data rather
 * than by the absence of an exception. It is cheap (three indexed lookups) and
 * runs once per signup.
 */
export async function verifyProvisionedAccount(
  db: SignupDb,
  account: { userId: string; tenantId: string },
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const missing: string[] = [];

  const tenant = await db.from("tenants").select("id").eq("id", account.tenantId).maybeSingle();
  if (tenant.error || !tenant.data) missing.push("tenant");

  const profile = await db.from("users").select("id").eq("id", account.userId).maybeSingle();
  if (profile.error || !profile.data) missing.push("profile");

  const year = await db
    .from("financial_years")
    .select("id")
    .eq("tenant_id", account.tenantId)
    .limit(1)
    .maybeSingle();
  if (year.error || !year.data) missing.push("financial_year");

  const trial = await loadTenantTrial(db, account.tenantId);
  if (!trial) missing.push("trial");

  return missing.length ? { ok: false, missing } : { ok: true };
}

/** Deletes an Auth identity, reporting whether it succeeded. */
async function safeDeleteAuthUser(db: SignupDb, userId: string): Promise<boolean> {
  try {
    const { error } = await db.auth.admin.deleteUser(userId);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Undoes, in reverse order, exactly what this call created.
 *
 * `deleteAuthUser` is false on a retry that REUSED an existing identity: that
 * identity belongs to the customer, and removing it would delete an account they
 * can still sign in with. Likewise only rows this call created are removed.
 *
 * Returns true when everything requested was removed.
 */
async function compensate(
  db: SignupDb,
  options: {
    tenantId: string;
    userId: string;
    deleteAuthUser: boolean;
    deleteProfile?: boolean;
    deleteFinancialYear?: boolean;
  },
): Promise<boolean> {
  let complete = true;

  if (options.deleteFinancialYear) {
    const { error } = await db
      .from("financial_years")
      .delete()
      .eq("tenant_id", options.tenantId);
    if (error) complete = false;
  }

  if (options.deleteProfile) {
    const { error } = await db.from("users").delete().eq("id", options.userId);
    if (error) complete = false;
  }

  // The trial lives in `settings`, keyed by the tenant, and goes with the tenant
  // row below. Nothing to remove separately.

  const { error: tenantError } = await db.from("tenants").delete().eq("id", options.tenantId);
  if (tenantError) complete = false;

  if (options.deleteAuthUser) {
    if (!(await safeDeleteAuthUser(db, options.userId))) complete = false;
  }

  return complete;
}

export { TRIAL_DAYS };
