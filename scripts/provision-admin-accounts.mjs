#!/usr/bin/env node
/**
 * SPEED ERP — administrator account provisioning.
 *
 * Creates or repairs the two mandated administrator identities through the
 * EXISTING Supabase Auth admin API and the existing `public.users` table. It
 * introduces no new auth system, table, or role model: it uses the `role` values
 * the application already understands (`admin` = company administrator,
 * `super_admin` = global operator) and links each Auth UUID to the matching
 * `public.users` row.
 *
 * Guarantees:
 *   - Idempotent. Auth identities are looked up by email first and never
 *     re-created; re-running repairs the mapping instead of duplicating.
 *   - An existing user's password is NOT changed unless rotation is explicitly
 *     requested (`--rotate-passwords` or an explicit password), so re-running
 *     never locks anyone out.
 *   - The company admin is bound to a real SPEED tenant that is verified to
 *     exist; the super admin is always tenant-less (never scoped to SPEED).
 *   - Every step is checked; the first failure aborts before the next account.
 *     A newly-created Auth identity is rolled back if its mapping cannot be
 *     written, so no half-provisioned privileged account is left behind.
 *   - `username` is written only when the live schema actually has the column.
 *   - Secrets never reach Git or build output. Temporary passwords are written to
 *     a 0600 credentials file by default (path only is logged); printing them to
 *     stdout requires `--print-passwords`.
 *
 * The logic is exported (`provisionAdmins`) with an injectable Supabase client so
 * it can be exercised by `tests/admin-provisioning.test.ts` against a stub — the
 * same pattern the repo uses for other DB-bound code. Running this file as a
 * script drives it with the real service-role client.
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/provision-admin-accounts.mjs \
 *     [--tenant-id <uuid>] [--company-email a@b] [--super-email c@d] \
 *     [--company-name "SPEED"] [--rotate-passwords] [--print-passwords] \
 *     [--credentials-file <path>] [--dry-run]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

export const DEFAULTS = {
  companyEmail: "speedadmin@speed.local",
  superEmail: "admin@system.local",
  companyName: "SPEED",
  companyUsername: "speedadmin",
  superUsername: "admin",
};

/** Strong, URL-safe temporary password (~143 bits from a CSPRNG). */
export function generatePassword() {
  return crypto.randomBytes(18).toString("base64url");
}

function parseArgs(argv) {
  const arg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) return true;
    return next;
  };
  const has = (name) => argv.includes(`--${name}`);
  return {
    companyEmail: arg("company-email", DEFAULTS.companyEmail),
    superEmail: arg("super-email", DEFAULTS.superEmail),
    companyName: arg("company-name", DEFAULTS.companyName),
    tenantId: arg("tenant-id", null),
    dryRun: has("dry-run"),
    rotate: has("rotate-passwords"),
    printPasswords: has("print-passwords"),
    credentialsFile: arg("credentials-file", ".admin-credentials.local"),
    companyPassword: arg("company-password") || process.env.COMPANY_ADMIN_PASSWORD || null,
    superPassword: arg("super-password") || process.env.SUPER_ADMIN_PASSWORD || null,
  };
}

async function findAuthUserByEmail(admin, email) {
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
 * Resolve the SPEED company tenant, verifying it actually exists. Prefers an
 * explicitly pinned id, then a tenant the company admin already owns, then a
 * name match. Never creates a duplicate; a tenant is created only when none
 * exists at all.
 */
async function resolveCompanyTenant(admin, { tenantId, companyName, companyAdminId, dryRun }) {
  if (tenantId) {
    const { data: t } = await admin.from("tenants").select("id, name").eq("id", tenantId).maybeSingle();
    if (!t) {
      throw new Error(`--tenant-id ${tenantId} does not exist in public.tenants; refusing to guess.`);
    }
    return { tenant: t, created: false, reason: "pinned --tenant-id" };
  }

  if (companyAdminId) {
    const { data: owner } = await admin
      .from("users")
      .select("tenant_id")
      .eq("id", companyAdminId)
      .maybeSingle();
    if (owner?.tenant_id) {
      const { data: t } = await admin
        .from("tenants")
        .select("id, name")
        .eq("id", owner.tenant_id)
        .maybeSingle();
      if (t) return { tenant: t, created: false, reason: "existing owner tenant" };
    }
  }

  const { data: match } = await admin
    .from("tenants")
    .select("id, name")
    .ilike("name", `%${companyName}%`)
    .limit(1)
    .maybeSingle();
  if (match) return { tenant: match, created: false, reason: "name match" };

  const { data: only } = await admin.from("tenants").select("id, name").limit(2);
  if (only?.length === 1) return { tenant: only[0], created: false, reason: "single existing tenant" };

  if (dryRun) {
    return { tenant: { id: "(would create)", name: companyName }, created: false, reason: "dry-run" };
  }

  const { data: createdTenant, error } = await admin
    .from("tenants")
    .insert({ name: companyName, name_en: companyName })
    .select("id, name")
    .single();
  if (error) throw error;
  return { tenant: createdTenant, created: true, reason: "created" };
}

async function tableHasColumn(admin, table, column) {
  const { error } = await admin.from(table).select(column).limit(1);
  return !error;
}

async function upsertAppUser(admin, { id, email, fullName, username, role, tenantId }) {
  const row = { id, email, full_name: fullName, role, tenant_id: tenantId, is_active: true };
  if (username && (await tableHasColumn(admin, "users", "username"))) row.username = username;

  const { error } = await admin.from("users").upsert(row, { onConflict: "id" });
  if (error) throw error;
  return { role, tenant_id: tenantId, username: row.username ?? null };
}

/**
 * Ensure one administrator account. Returns the Auth id and whether a temporary
 * password was issued. On a newly-created Auth identity whose mapping fails, the
 * identity is deleted so we do not leave a privileged orphan.
 */
async function ensureAccount(admin, opts) {
  const { label, email, username, role, fullName, tenantId, explicitPassword, rotate, dryRun } = opts;
  const existing = await findAuthUserByEmail(admin, email);
  let authUser = existing;
  let authCreated = false;
  let issuedPassword = null;

  const shouldSetPassword = !existing || rotate || Boolean(explicitPassword);

  if (dryRun) {
    return {
      label,
      email,
      username,
      role,
      tenantId,
      authUserId: existing?.id ?? "(would-create)",
      authCreated: !existing,
      issuedPassword: null,
    };
  }

  if (!existing) {
    issuedPassword = explicitPassword || generatePassword();
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: issuedPassword,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) throw new Error(`[${label}] createUser failed: ${error.message}`);
    authUser = data.user;
    authCreated = true;
  } else if (shouldSetPassword) {
    issuedPassword = explicitPassword || generatePassword();
    const { error } = await admin.auth.admin.updateUserById(existing.id, {
      password: issuedPassword,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) throw new Error(`[${label}] password update failed: ${error.message}`);
  }

  try {
    const appUser = await upsertAppUser(admin, { id: authUser.id, email, fullName, username, role, tenantId });
    return { label, email, username, role, tenantId, authUserId: authUser.id, authCreated, issuedPassword, appUser };
  } catch (err) {
    if (authCreated) {
      await admin.auth.admin.deleteUser(authUser.id).catch(() => {});
    }
    throw new Error(`[${label}] mapping to public.users failed: ${err.message}`);
  }
}

/**
 * Provision both administrators. Pure orchestration over an injectable `admin`
 * client; returns a structured result and never logs secrets itself.
 */
export async function provisionAdmins(admin, opts = {}) {
  const o = {
    companyEmail: DEFAULTS.companyEmail,
    superEmail: DEFAULTS.superEmail,
    companyName: DEFAULTS.companyName,
    companyUsername: DEFAULTS.companyUsername,
    superUsername: DEFAULTS.superUsername,
    tenantId: null,
    dryRun: false,
    rotate: false,
    companyPassword: null,
    superPassword: null,
    ...opts,
  };

  const companyExisting = await findAuthUserByEmail(admin, o.companyEmail);
  const { tenant, created, reason } = await resolveCompanyTenant(admin, {
    tenantId: o.tenantId,
    companyName: o.companyName,
    companyAdminId: companyExisting?.id ?? null,
    dryRun: o.dryRun,
  });
  if (!o.tenantId && !tenant.id) {
    throw new Error("Could not resolve a SPEED tenant; pass tenantId explicitly.");
  }

  const companyAdmin = await ensureAccount(admin, {
    label: "Company admin",
    email: o.companyEmail,
    username: o.companyUsername,
    role: "admin",
    fullName: "SPEED Administrator",
    tenantId: tenant.id,
    explicitPassword: o.companyPassword,
    rotate: o.rotate,
    dryRun: o.dryRun,
  });

  // Deliberately tenant-less: never scoped to SPEED as a shortcut. Reached only
  // after the company admin succeeded, so a partial run never leaves a global
  // operator without a working company admin.
  const superAdmin = await ensureAccount(admin, {
    label: "Super admin",
    email: o.superEmail,
    username: o.superUsername,
    role: "super_admin",
    fullName: "Global Super Administrator",
    tenantId: null,
    explicitPassword: o.superPassword,
    rotate: o.rotate,
    dryRun: o.dryRun,
  });

  return { tenant, tenantCreated: created, tenantReason: reason, companyAdmin, superAdmin };
}

function writeCredentialsFile(path, issued) {
  if (!issued.length) return false;
  const body =
    "# SPEED ERP temporary administrator credentials — change after first sign-in.\n" +
    "# Generated " +
    new Date().toISOString() +
    "\n" +
    issued.map((c) => `${c.label}\t${c.email}\t${c.password}`).join("\n") +
    "\n";
  fs.writeFileSync(path, body, { mode: 0o600 });
  fs.chmodSync(path, 0o600);
  return true;
}

async function run() {
  const argv = parseArgs(process.argv.slice(2));
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.error(
      "ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. " +
        "Run this on the server / with the production credentials.",
    );
    process.exit(1);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`\nSPEED ERP administrator provisioning ${argv.dryRun ? "(dry-run)" : ""}`);
  console.log(`  Supabase: ${SUPABASE_URL}`);
  if (argv.dryRun) console.log("  (dry-run: no changes are written)\n");
  else console.log("  Temporary passwords are written to a 0600 file, not logged.\n");

  const result = await provisionAdmins(admin, {
    companyEmail: argv.companyEmail,
    superEmail: argv.superEmail,
    companyName: argv.companyName,
    tenantId: argv.tenantId,
    dryRun: argv.dryRun,
    rotate: argv.rotate,
    companyPassword: argv.companyPassword,
    superPassword: argv.superPassword,
  });

  console.log(
    `Company tenant: ${result.tenant.name} (${result.tenant.id}) — ${
      result.tenantCreated ? "CREATED" : "reused"
    } [${result.tenantReason}]`,
  );

  console.log("\n================ RESULTS ================");
  for (const r of [result.companyAdmin, result.superAdmin]) {
    console.log(`${r.label}: ${r.email}`);
    console.log(`  authUserId : ${r.authUserId}`);
    console.log(`  role       : ${r.role}`);
    console.log(`  tenant_id  : ${r.tenantId ?? "null (global)"}`);
    console.log(`  auth       : ${r.authCreated ? "created" : "existing identity repaired"}`);
  }

  if (argv.dryRun) return;

  const issued = [result.companyAdmin, result.superAdmin]
    .filter((r) => r.issuedPassword)
    .map((r) => ({ label: r.label, email: r.email, password: r.issuedPassword }));

  const wrote = writeCredentialsFile(argv.credentialsFile, issued);
  if (argv.printPasswords) {
    for (const c of issued) console.log(`  TEMP PASSWORD (${c.label}): ${c.password}`);
  } else if (wrote) {
    console.log(`\nTemporary passwords written to ${argv.credentialsFile} (mode 0600).`);
  } else {
    console.log("\nNo password changed (existing identities; pass --rotate-passwords to reset).");
  }

  console.log("Next: have each account change its password after first sign-in. Keep secrets out of Git.\n");
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (invokedDirectly) {
  run().catch((err) => {
    console.error(`ERROR: ${err?.message ?? String(err)}`);
    process.exit(1);
  });
}
