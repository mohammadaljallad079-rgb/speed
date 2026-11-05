import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Exec 70 — customer row isolation (migration 016).
 *
 * The reported defect class: migrations 001/002 isolate every table by TENANT.
 * That is the boundary between companies, but it is NOT a boundary inside one
 * company. A rental customer is an `authenticated` user of the tenant, so the
 * tenant predicate is satisfied by every row of that tenant, and the customer
 * portal reads with the browser client (RLS is the enforcement boundary there).
 *
 * Reproduced by execution on a real PostgreSQL 17 (001/002/004 schema):
 *   * customer A could read customer B's rental contract, support ticket and
 *     PII (`customers`), and every colleague's email/role (`users`);
 *   * a `client` could `update public.users set role='admin'` on its own row —
 *     a full privilege escalation into the company ERP (004's
 *     `prevent_role_escalation` blocks only the `super_admin` grant).
 *
 * These tests guard the source. The behavioural proof is
 * `supabase/tests/016_harness/run.sh` (39/39 on PostgreSQL 17).
 */

const ROOT = path.join(import.meta.dirname, "..");
const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations/016_customer_row_isolation.sql"), "utf8");
const norm = sql.replace(/\s+/g, " ").toLowerCase();
const rollback = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/016_customer_row_isolation_rollback.sql"),
  "utf8",
);

describe("Exec70 — migration 016 customer row isolation", () => {
  test("declares the two identity predicates as SECURITY DEFINER with a pinned search_path", () => {
    for (const fn of ["current_customer_id", "is_erp_user", "prevent_self_privilege_escalation"]) {
      assert.ok(norm.includes(`function public.${fn}(`), `missing ${fn}`);
    }
    assert.match(norm, /security definer/);
    assert.equal((norm.match(/set search_path = public/g) ?? []).length >= 3, true, "each function must pin search_path");
  });

  test("the customer-owned tables get a RESTRICTIVE policy", () => {
    // RESTRICTIVE is the whole point: it is ANDed with 002's permissive tenant
    // policy, so it can only narrow. A permissive policy would be ORed and
    // therefore useless as a restriction.
    for (const t of ["rental_contracts", "support_tickets", "documents"]) {
      assert.ok(norm.includes(`array['rental_contracts', 'support_tickets', 'documents']`) || norm.includes(t), `missing ${t}`);
    }
    assert.match(norm, /as restrictive/);
    assert.match(norm, /or customer_id = public\.current_customer_id\(\)/);
  });

  test("a null customer_id belongs to no portal customer", () => {
    // `customer_id is null` must NOT appear as an allow clause, or an
    // office-created (unlinked) row would be readable by every customer.
    assert.doesNotMatch(norm, /or customer_id is null/);
  });

  test("the office side is exempt so the ERP keeps working", () => {
    assert.match(norm, /public\.is_erp_user\(\)/);
    assert.match(norm, /role in \('admin', 'staff', 'super_admin'\)/);
  });

  test("customers and users are narrowed to the client's own row", () => {
    assert.match(norm, /customers_customer_own/);
    assert.match(norm, /or id = public\.current_customer_id\(\)/);
    assert.match(norm, /users_client_self_only/);
    assert.match(norm, /or id = auth\.uid\(\)/);
  });

  test("cars stays a company asset scoped by tenant, never by customer", () => {
    assert.match(norm, /create policy cars_tenant_select on public\.cars/);
    assert.match(norm, /using \(public\.can_read_tenant\(tenant_id\)\)/);
    assert.doesNotMatch(norm, /cars_customer_own/);
  });

  test("self-escalation is blocked by a BEFORE trigger, not a policy", () => {
    // A policy's `with check` sees only the NEW row, so it cannot distinguish
    // "changed role" from "already was admin" — 004 states this for the same
    // reason. The trigger compares OLD and NEW.
    assert.match(norm, /create trigger users_prevent_self_privilege_escalation/);
    assert.match(norm, /before insert or update on public\.users/);
    assert.match(norm, /n->'role' is distinct from o->'role'/);
    assert.match(norm, /n->'tenant_id' is distinct from o->'tenant_id'/);
    assert.match(norm, /n->'customer_id' is distinct from o->'customer_id'/);
    assert.match(norm, /n->'permissions' is distinct from o->'permissions'/);
    assert.match(norm, /n->'is_active' is distinct from o->'is_active'/);
    assert.match(norm, /errcode = '42501'/);
  });

  test("the service path and an administrator are allowed through", () => {
    assert.match(norm, /if auth\.uid\(\) is null then return new/);
    assert.match(norm, /if public\.is_admin\(\) then return new/);
  });

  test("a non-admin may still change its own non-privileged fields", () => {
    // `full_name`/`email` are deliberately absent from the protected set.
    for (const col of ["full_name", "email", "phone"]) {
      assert.ok(!norm.includes(`n->'${col}' is distinct from o->'${col}'`), `${col} must not be protected`);
    }
  });

  test("the predicate helpers are revoked from anon and granted to authenticated", () => {
    assert.match(norm, /revoke all on function public\.current_customer_id\(\) from anon/);
    assert.match(norm, /revoke all on function public\.is_erp_user\(\) from anon/);
    assert.match(norm, /grant execute on function public\.current_customer_id\(\) to authenticated/);
    assert.match(norm, /grant execute on function public\.is_erp_user\(\) to authenticated/);
  });

  test("it is guarded on columns so it is a no-op on an older schema", () => {
    // A table without `customer_id` must be skipped, not fail the migration.
    assert.match(norm, /from information_schema\.columns/);
    assert.match(norm, /column_name = 'customer_id'/);
    assert.match(norm, /to_regprocedure\('public\.current_customer_id\(\)'\) is not null/);
  });

  test("it is additive: no drop table/column, no delete, no row rewrite", () => {
    const nonComment = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const re of [/\bdrop\s+table\b/i, /\bdrop\s+column\b/i, /\btruncate\b/i, /\bdelete\s+from\b/i, /\bupdate\s+public\./i]) {
      assert.doesNotMatch(nonComment, re, `016 must not run: ${re}`);
    }
    assert.match(nonComment, /^\s*begin;/m);
    assert.match(nonComment, /commit;\s*$/);
  });

  test("the rollback drops exactly what 016 created and documents the trade-off", () => {
    assert.match(rollback, /drop trigger if exists users_prevent_self_privilege_escalation/);
    for (const p of [
      "rental_contracts_customer_own",
      "support_tickets_customer_own",
      "documents_customer_own",
      "customers_customer_own",
      "users_client_self_only",
    ]) {
      assert.ok(rollback.includes(`drop policy if exists ${p}`), `rollback must drop ${p}`);
    }
    assert.match(rollback, /drop function if exists public\.current_customer_id\(\)/);
    assert.match(rollback, /drop function if exists public\.is_erp_user\(\)/);
    assert.doesNotMatch(rollback, /drop table/i);
    // The rollback must state that it re-opens the leak, so applying it is a
    // deliberate decision rather than a surprise.
    assert.match(rollback, /NOT LOSSLESS/);
  });
});
