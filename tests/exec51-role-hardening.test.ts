import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Execution 51 — remaining `public.users` privilege-escalation paths.
 *
 * Migration 004 introduced `prevent_role_escalation()`, but two defects remained
 * (both proven by execution on a real PostgreSQL 17, see
 * `supabase/tests/008_harness/`):
 *
 *   1. It treated `auth.uid() is null` as proof of the service role. An
 *      `authenticated` session whose JWT carries no `sub` claim is
 *      indistinguishable from a direct/service connection by uid alone, so the
 *      decision must come from the signed JWT role claim instead.
 *   2. It only guarded `super_admin`, so a `staff`/`client` row could still set
 *      its own role to `admin`, and any caller could change `tenant_id`.
 *
 * Migration 008 closes both. These tests protect its security intent; the
 * executable harness proves the behaviour.
 */

const ROOT = process.cwd();
const MIGRATION = path.join(ROOT, "supabase/migrations/008_user_role_hardening.sql");
const HARNESS = path.join(ROOT, "supabase/tests/008_harness");
const sql = fs.readFileSync(MIGRATION, "utf8");

describe("migration 008 — user role hardening", () => {
  test("the migration file exists and is substantive", () => {
    assert.ok(fs.existsSync(MIGRATION));
    assert.ok(sql.length > 2000);
  });

  test("it is ordered after 007 and depends on 004", () => {
    const files = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => !f.includes("rollback"));
    assert.ok(files.includes("007_purchase_sale_links.sql"));
    assert.ok(files.includes("008_user_role_hardening.sql"));
    assert.ok(files.indexOf("008_user_role_hardening.sql") > files.indexOf("007_purchase_sale_links.sql"));
  });

  test("it replaces prevent_role_escalation without renaming the trigger target", () => {
    assert.match(sql, /create or replace function public\.prevent_role_escalation\(\)/);
    assert.match(sql, /drop trigger if exists users_prevent_role_escalation on public\.users/);
    assert.match(sql, /create trigger users_prevent_role_escalation/);
  });

  test("it does NOT trust a null uid as proof of the service role", () => {
    // The new predicate must key off the signed JWT role claim, and must refuse
    // `authenticated`/`anon` explicitly.
    assert.match(sql, /create or replace function public\.is_trusted_service_context\(\)/);
    assert.match(sql, /request\.jwt\.claim\.role/);
    assert.match(sql, /jwt_role is null or jwt_role = 'service_role'/);
    // A null uid must return false (never true) on its own.
    assert.match(sql, /if auth\.uid\(\) is not null then\s*return false;/);
  });

  test("it blocks self-promotion to a company admin", () => {
    assert.match(sql, /A user may not promote themselves to an administrator/);
    assert.match(sql, /old\.role not in \('admin', 'super_admin'\)/);
    assert.match(sql, /new\.role in \('admin', 'super_admin'\)/);
  });

  test("it blocks cross-user role edits without an administrator", () => {
    assert.match(sql, /Only an administrator may change another user role/);
    assert.match(sql, /new\.id is distinct from actor_uid and not actor_is_admin/);
  });

  test("it keeps super_admin grant/revoke super-admin only", () => {
    assert.match(sql, /Only a super administrator may grant or revoke the super_admin role/);
  });

  test("it blocks tenant reassignment except by a super admin", () => {
    assert.match(sql, /Only a super administrator may change a user tenant/);
    assert.match(sql, /new\.tenant_id is distinct from old\.tenant_id and not actor_is_super/);
  });

  test("it still allows the trusted provisioning path", () => {
    assert.match(sql, /if trusted_service then\s*return new;/);
  });

  test("it is additive and non-destructive", () => {
    const statements = sql.replace(/--[^\n]*/g, "");
    assert.doesNotMatch(statements, /drop\s+table/i);
    assert.doesNotMatch(statements, /\bdelete\s+from\b/i);
    assert.doesNotMatch(statements, /\btruncate\b/i);
    assert.doesNotMatch(statements, /drop\s+column/i);
  });

  test("it is idempotent — create or replace / drop if exists", () => {
    assert.match(sql, /create or replace function/i);
    assert.match(sql, /drop trigger if exists/i);
  });

  test("the browser roles never gain the new predicate", () => {
    assert.match(sql, /revoke all on function public\.is_trusted_service_context\(\) from anon/);
    assert.match(sql, /revoke all on function public\.is_trusted_service_context\(\) from authenticated/);
  });
});

describe("migration 008 — executable harness is present", () => {
  test("the harness runner and assertions exist", () => {
    assert.ok(fs.existsSync(path.join(HARNESS, "run.sh")));
    assert.ok(fs.existsSync(path.join(HARNESS, "assertions.sql")));
  });

  test("the assertions cover the core cases", () => {
    const assertions = fs.readFileSync(path.join(HARNESS, "assertions.sql"), "utf8");
    // staff self-promotion, tenant move, null-uid trust, service path.
    assert.match(assertions, /staff self-promotion to admin blocked/);
    assert.match(assertions, /staff tenant move blocked/);
    assert.match(assertions, /null-uid authenticated session is not trusted|authenticated session granted nothing/);
    assert.match(assertions, /service_role claim is trusted/);
  });
});
