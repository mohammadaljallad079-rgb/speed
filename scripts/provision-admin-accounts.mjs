#!/usr/bin/env node
/**
 * SPEED ERP — administrator account provisioning.
 *
 * Creates or repairs the two mandated administrator identities through the
 * EXISTING Supabase Auth admin API and the existing `public.users` profile
 * table. It does not introduce a new auth system, a new table, or a new role
 * model: it uses `role` values the application already understands
 * (`admin` = company administrator, `super_admin` = global operator).
 *
 * Design rules:
 *   - Idempotent. Re-running repairs instead of duplicating. Auth identities are
 *     looked up by email first; an existing identity is never re-created.
 *   - Identity and ownership are produced HERE, never read from a web request.
 *   - The domain is overridable because a `.local` address may be rejected by the
 *     project's email configuration; the caller must decide, not the script.
 *   - Passwords are generated when not supplied, printed ONCE to stdout so the
 *     operator can record them, and never written to a file.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/provision-admin-accounts.mjs [--company-email a@b] \
 *     [--super-email c@d] [--company-name "SPEED ..."] \
 *     [--no-generate] [--dry-run]
 *
 * Requires a service-role key. It never runs in the browser and is not imported
 * by application code.
 */

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}
const has = (name) => process.argv.includes(`--${name}`);

const COMPANY_EMAIL = arg("company-email", "speedadmin@speed.local");
const SUPER_EMAIL = arg("super-email", "admin@system.local");
const COMPANY_NAME = arg("company-name", "SPEED");
const DRY_RUN = has("dry-run");

// A caller may supply the temporary password (env or flag) so the operator can
// record it in advance; otherwise one is generated and printed once.
const COMPANY_PASSWORD =
  arg("company-password") || process.env.COMPANY_ADMIN_PASSWORD || null;
const SUPER_PASSWORD = arg("super-password") || process.env.SUPER_ADMIN_PASSWORD || null;

/** Strong, URL-safe temporary password. */
function generatePassword() {
  // 24 URL-safe chars from a CSPRNG (~143 bits). Satisfies Supabase defaults.
  return crypto.randomBytes(18).toString("base64url");
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!SUPABASE_URL || !SERVICE_ROLE) {
  fail(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. " +
      "Run this on the server / with the production credentials.",
  );
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function findAuthUserByEmail(email) {
  // Paginate defensively; installations here are small but this must be correct.
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

/**
 * Resolve the SPEED company tenant. Prefers an already-owned tenant (one the
 * company admin belongs to), then a name match, then creates exactly one.
 * Never creates a duplicate when a tenant already exists.
 */
async function resolveCompanyTenant(companyAdminId) {
  if (companyAdminId) {
    const { data: owner } = await admin
      .from("users")
      .select("tenant_id")
      .eq("id", companyAdminId)
      .maybeSingle();
    if (owner?.tenant_id) {
      const { data: t } = await admin.from("tenants").select("id, name").eq("id", owner.tenant_id).maybeSingle();
      if (t) return { tenant: t, created: false, reason: "existing owner tenant" };
    }
  }

  const { data: match } = await admin
    .from("tenants")
    .select("id, name")
    .ilike("name", `%${COMPANY_NAME}%`)
    .limit(1)
    .maybeSingle();
  if (match) return { tenant: match, created: false, reason: "name match" };

  const { data: only } = await admin.from("tenants").select("id, name").limit(2);
  if (only?.length === 1) return { tenant: only[0], created: false, reason: "single existing tenant" };

  if (DRY_RUN) return { tenant: { id: "(would create)", name: COMPANY_NAME }, created: false, reason: "dry-run" };

  const { data: createdTenant, error } = await admin
    .from("tenants")
    .insert({ name: COMPANY_NAME, name_en: COMPANY_NAME })
    .select("id, name")
    .single();
  if (error) throw error;
  return { tenant: createdTenant, created: true, reason: "created" };
}

async function upsertAppUser({ id, email, fullName, role, tenantId }) {
  if (DRY_RUN) return { id, email, role, tenant_id: tenantId, skipped: true };
  const { error } = await admin.from("users").upsert(
    {
      id,
      email,
      full_name: fullName,
      role,
      tenant_id: tenantId,
      is_active: true,
    },
    { onConflict: "id" },
  );
  if (error) throw error;
  return { id, email, role, tenant_id: tenantId };
}

async function ensureAccount({ email, role, fullName, tenantId, password }) {
  let authUser = await findAuthUserByEmail(email);
  let authCreated = false;

  if (!authUser) {
    if (DRY_RUN) {
      return { email, role, tenantId, auth: "would-create", repaired: true };
    }
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role },
    });
    if (error) throw error;
    authUser = data.user;
    authCreated = true;
  } else if (password) {
    // Repair the credential so the operator can actually sign in.
    const { error } = await admin.auth.admin.updateUserById(authUser.id, {
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role },
    });
    if (error) throw error;
  }

  const appUser = await upsertAppUser({
    id: authUser.id,
    email,
    fullName,
    role,
    tenantId,
  });

  return { email, role, tenantId, authUserId: authUser.id, authCreated, appUser };
}

async function main() {
  console.log(`\nSPEED ERP administrator provisioning ${DRY_RUN ? "(dry-run)" : ""}`);
  console.log(`  Supabase: ${SUPABASE_URL}`);
  console.log("  Passwords are printed once below; record them now.\n");

  // ---- A. SPEED company administrator -------------------------------------
  const companyExisting = await findAuthUserByEmail(COMPANY_EMAIL);
  const companyPassword = COMPANY_PASSWORD || generatePassword();
  const { tenant, created, reason } = await resolveCompanyTenant(companyExisting?.id ?? null);
  console.log(`Company tenant: ${tenant.name} (${tenant.id}) — ${created ? "CREATED" : "reused"} [${reason}]`);

  const companyResult = await ensureAccount({
    email: COMPANY_EMAIL,
    role: "admin",
    fullName: "SPEED Administrator",
    tenantId: tenant.id,
    password: companyPassword,
  });

  // ---- B. Global super administrator --------------------------------------
  const superExisting = await findAuthUserByEmail(SUPER_EMAIL);
  const superPassword = SUPER_PASSWORD || generatePassword();
  // The global operator is deliberately tenant-less: it must not be scoped to
  // the SPEED company as a shortcut.
  const superResult = await ensureAccount({
    email: SUPER_EMAIL,
    role: "super_admin",
    fullName: "Global Super Administrator",
    tenantId: null,
    password: superPassword,
  });

  console.log("\n================ RESULTS ================");
  console.log(`Company admin  ${companyResult.email}`);
  console.log(`  authUserId : ${companyResult.authUserId ?? "(dry-run)"}`);
  console.log(`  role       : admin`);
  console.log(`  tenant_id  : ${companyResult.tenantId}`);
  console.log(`  auth       : ${companyResult.authCreated ? "created" : "existing identity repaired"}`);
  if (!DRY_RUN) console.log(`  TEMP PASSWORD: ${companyPassword}`);

  console.log(`\nSuper admin    ${superResult.email}`);
  console.log(`  authUserId : ${superResult.authUserId ?? "(dry-run)"}`);
  console.log(`  role       : super_admin`);
  console.log(`  tenant_id  : null (global, not tenant-scoped)`);
  console.log(`  auth       : ${superResult.authCreated ? "created" : "existing identity repaired"}`);
  if (!DRY_RUN) console.log(`  TEMP PASSWORD: ${superPassword}`);

  console.log(
    "\nNext: have each account change its password after first sign-in. " +
      "Do not commit these values.\n",
  );
}

main().catch((err) => {
  fail(err?.message ?? String(err));
});
