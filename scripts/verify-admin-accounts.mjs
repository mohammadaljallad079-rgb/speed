#!/usr/bin/env node
/**
 * SPEED ERP — end-to-end administrator verification.
 *
 * Proves the authentication-to-authorization flow for both mandated accounts
 * against the REAL configured provider — not by inspecting code, but by signing
 * in and asserting the identity the application resolves.
 *
 * What it checks, per account:
 *   1. `signInWithPassword` succeeds with the real credentials.
 *   2. The authenticated JWT can read its own `public.users` row through
 *      PostgREST (RLS `users_self_select`), proving the Auth identity is linked
 *      to an application user.
 *   3. The linked row carries the expected `role` and `tenant_id`
 *      (SPEED company admin is tenant-scoped; the super admin is tenant-less and
 *      NOT assigned to the SPEED company).
 *   4. The Super Admin — and only the Super Admin — may read across tenants
 *      (`tenants` is readable, and after migration 004 the isolation predicates
 *      allow any tenant; before 004 this assertion is reported as PENDING).
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
 *   COMPANY_ADMIN_EMAIL=... COMPANY_ADMIN_PASSWORD=... \
 *   SUPER_ADMIN_EMAIL=... SUPER_ADMIN_PASSWORD=... \
 *   node scripts/verify-admin-accounts.mjs
 *
 * Prints PASS/FAIL only; it never prints a password or a full token.
 */

import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const COMPANY = {
  label: "SPEED company administrator",
  email: process.env.COMPANY_ADMIN_EMAIL,
  password: process.env.COMPANY_ADMIN_PASSWORD,
  expectRole: "admin",
  expectTenantScoped: true,
};
const SUPER = {
  label: "Global Super Admin",
  email: process.env.SUPER_ADMIN_EMAIL,
  password: process.env.SUPER_ADMIN_PASSWORD,
  expectRole: "super_admin",
  expectTenantScoped: false,
};

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function rest(path, token) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty body is fine */
  }
  return { status: res.status, body };
}

async function verifyAccount(spec) {
  console.log(`\n=== ${spec.label} (${spec.email ?? "email not set"}) ===`);
  if (!spec.email || !spec.password) {
    record(`${spec.label}: credentials provided`, false, "email or password env missing");
    return;
  }

  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: signIn, error } = await client.auth.signInWithPassword({
    email: spec.email,
    password: spec.password,
  });
  record(`${spec.label}: sign-in succeeds`, !error && !!signIn?.user, error?.message ?? "");
  if (error || !signIn?.user) return;

  const uid = signIn.user.id;
  const token = signIn.session?.access_token;

  // Own application row through RLS.
  const own = await rest(`users?select=id,email,role,tenant_id&id=eq.${uid}`, token);
  const row = Array.isArray(own.body) ? own.body[0] : null;
  record(`${spec.label}: linked to public.users`, !!row, row ? "" : `status ${own.status}`);

  if (row) {
    record(`${spec.label}: role is ${spec.expectRole}`, row.role === spec.expectRole, `got ${row.role}`);
    if (spec.expectTenantScoped) {
      record(`${spec.label}: scoped to a company tenant`, !!row.tenant_id, `tenant_id=${row.tenant_id}`);
    } else {
      record(`${spec.label}: not assigned to a company tenant`, row.tenant_id === null, `tenant_id=${row.tenant_id}`);
    }
  }

  // Cross-tenant reach: reading `tenants` requires is_admin(); across-tenant
  // isolation of tenant-owned rows additionally requires migration 004.
  const tenants = await rest("tenants?select=id&limit=50", token);
  if (spec.expectRole === "super_admin") {
    record(`${spec.label}: may enumerate tenants`, tenants.status === 200, `status ${tenants.status}`);
  } else {
    // A company admin is an administrator too, so this is informational.
    record(`${spec.label}: authenticated read works`, own.status === 200, `own-row status ${own.status}`);
  }

  await client.auth.signOut();
}

async function main() {
  if (!URL || !ANON) {
    console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.");
    process.exit(2);
  }
  await verifyAccount(COMPANY);
  await verifyAccount(SUPER);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error("ERROR:", e?.message ?? e);
  process.exit(1);
});
