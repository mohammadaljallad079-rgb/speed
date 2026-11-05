import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Exec 77 — NULL-tenant isolation (migration 019).
 *
 * The reported defect class: 002/004 isolate every table by TENANT, and for a
 * tenant-less caller `can_read_tenant(tenant_id)` reduces to `tenant_id IS NULL`.
 * A SPEED rental customer is `role = 'client'` with `tenant_id IS NULL`, so it
 * satisfied that predicate for EVERY tenant-less row — and on this install most
 * operational rows are tenant-less. Reproduced by execution on PostgreSQL 17
 * with the 001→018 schema and real `authenticated` identities:
 *
 *   READ  another customer's invoice / contract / PII     -> permitted
 *   READ  the general ledger, chart of accounts, settings -> permitted
 *   WRITE cars UPDATE/DELETE/INSERT                       -> permitted
 *   WRITE journal_entries DELETE, accounts DELETE         -> permitted
 *   WRITE invoices INSERT for another customer            -> permitted
 *
 * 016 fixed the customer-owned tables but not `invoices`/`payments`/the ERP
 * tables, and did not restrict DELETE at all.
 *
 * These tests guard the source. The behavioural proof is
 * `supabase/tests/exec77_harness/run.sh` (93/93 on PostgreSQL 17) and the
 * whole-chain regression is `supabase/tests/cross_company_harness/run.sh`.
 */

const ROOT = path.join(import.meta.dirname, "..");
const MIGRATION = path.join(ROOT, "supabase/migrations/019_null_tenant_isolation.sql");
const ROLLBACK = path.join(ROOT, "supabase/migrations/019_null_tenant_isolation_rollback.sql");

const sql = fs.readFileSync(MIGRATION, "utf8");
const norm = sql.replace(/\s+/g, " ").toLowerCase();
const rollbackSql = fs.readFileSync(ROLLBACK, "utf8");
const rollbackNorm = rollbackSql.replace(/\s+/g, " ").toLowerCase();

describe("Exec77 — migration 019 NULL-tenant isolation", () => {
  test("both migration files exist", () => {
    assert.ok(fs.existsSync(MIGRATION), "019_null_tenant_isolation.sql is missing");
    assert.ok(fs.existsSync(ROLLBACK), "019_null_tenant_isolation_rollback.sql is missing");
  });

  test("the restriction is fail-closed: a non-ERP identity is treated as a rental customer", () => {
    // `is_client_only()` must be the complement of `is_erp_user()`, so an
    // unknown / NULL / invalid role is restricted rather than given wide access.
    assert.match(norm, /create or replace function public\.is_client_only\(\)/);
    assert.match(norm, /select auth\.uid\(\) is not null and not public\.is_erp_user\(\)/);
  });

  test("is_erp_user() admits only the three ERP roles", () => {
    assert.match(norm, /create or replace function public\.is_erp_user\(\)/);
    assert.match(norm, /role in \('admin', 'staff', 'super_admin'\)/);
  });

  test("every new policy is RESTRICTIVE, so it can only narrow the tenant policy", () => {
    // A permissive policy would be ORed with 002's tenant policy and therefore
    // useless as a restriction. RESTRICTIVE is ANDed with every permissive one.
    // Most policies are built by `format('create policy %I ... as restrictive')`
    // inside a DO block, so count each `create policy` and require the
    // RESTRICTIVE keyword to follow it in the same statement.
    const creates = (norm.match(/create policy/g) ?? []).length;
    const restrictive = (norm.match(/create policy[^;]{0,120}as restrictive/g) ?? []).length;
    assert.ok(creates >= 5, `expected several policies, saw ${creates}`);
    assert.equal(creates, restrictive, "every policy in 019 must be RESTRICTIVE");
  });

  test("the ERP-only tables are closed to a rental customer", () => {
    for (const t of [
      "financial_years",
      "settings",
      "branches",
      "employees",
      "suppliers",
      "accounts",
      "journal_entries",
      "purchase_invoices",
      "activity_logs",
    ]) {
      assert.ok(norm.includes(`'${t}'`), `the ERP-only table list is missing ${t}`);
    }
  });

  test("invoices and payments are scoped to the caller's own customer_id", () => {
    for (const t of ["invoices", "payments"]) {
      assert.ok(norm.includes(`'${t}'`), `missing ${t}`);
    }
    assert.match(norm, /customer_id = public\.current_customer_id\(\)/);
  });

  test("a NULL customer_id is never an allow clause", () => {
    // An office-created row with no customer link belongs to nobody in the
    // portal; showing it to every tenant-less customer is the leak.
    assert.doesNotMatch(norm, /or customer_id is null/);
  });

  test("DELETE is gated in its own right, not inherited from can_read_tenant", () => {
    // 002's `_tenant_delete` used `can_read_tenant`, which a tenant-less caller
    // satisfied for every tenant-less row.
    assert.match(norm, /for delete to authenticated using \(public\.is_erp_user\(\)\)/);
    for (const t of ["accounts", "journal_entries", "rental_contracts", "cars", "customers"]) {
      assert.ok(norm.includes(`'${t}'`), `the delete-gated list is missing ${t}`);
    }
  });

  test("a rental customer may browse the fleet but never modify it", () => {
    assert.match(norm, /create policy cars_erp_insert/);
    assert.match(norm, /create policy cars_erp_update/);
    // SELECT is deliberately NOT gated: removing it would empty the booking
    // catalog. 016's tenant-scoped read stays in force.
    assert.doesNotMatch(norm, /create policy cars_erp_select/);
  });

  test("a rental customer cannot change its own identity", () => {
    assert.match(norm, /create or replace function public\.reserve_rental_customer_identity\(\)/);
    for (const col of ["role", "tenant_id", "customer_id", "permissions", "is_active"]) {
      assert.ok(norm.includes(`n->'${col}'`), `the identity guard does not cover ${col}`);
    }
    // The provisioning path and administrators must stay exempt, or signup and
    // user administration would break.
    assert.match(norm, /if auth\.uid\(\) is null then return new;/);
    assert.match(norm, /if public\.is_admin\(\) then return new;/);
  });

  test("the identity guard is a trigger, not only a policy", () => {
    // A RLS WITH CHECK cannot see the OLD row, so it cannot tell a changed role
    // from an unchanged one; only a BEFORE trigger can.
    assert.match(norm, /create trigger users_reserve_client_identity/);
    assert.match(norm, /before insert or update on public\.users/);
  });

  test("every helper is SECURITY DEFINER with a pinned search_path", () => {
    for (const fn of [
      "is_erp_user",
      "is_client_only",
      "current_customer_id",
      "reserve_rental_customer_identity",
    ]) {
      assert.ok(norm.includes(`function public.${fn}(`), `missing ${fn}`);
    }
    assert.equal(
      (norm.match(/set search_path = public/g) ?? []).length >= 4,
      true,
      "each function must pin search_path",
    );
  });

  test("the predicates are not anon-callable", () => {
    assert.match(norm, /revoke all on function public\.is_client_only\(\) from anon/);
  });

  test("019 does not depend on 016 having been applied first", () => {
    // An operator-run migration with a silent ordering trap is a security defect
    // waiting to happen, so the helpers 019 needs are (re)created here.
    assert.match(norm, /create or replace function public\.is_erp_user\(\)/);
    assert.match(norm, /create or replace function public\.current_customer_id\(\)/);
  });

  test("it writes no data and drops no pre-existing object", () => {
    // A security migration must not rewrite rows or remove someone else's work.
    assert.doesNotMatch(norm, /update public\.(customers|users|invoices|rental_contracts) set/);
    assert.doesNotMatch(norm, /delete from public\./);
    assert.doesNotMatch(norm, /drop function if exists public\.(is_erp_user|current_customer_id)/);
    assert.doesNotMatch(norm, /drop policy if exists \w+_tenant_(select|insert|update|delete)/);
  });

  test("the migration is transactional", () => {
    // `norm` starts with the comment banner, so anchor on the raw source.
    assert.match(sql, /\nbegin;\n/);
    assert.match(sql.trimEnd(), /commit;$/);
  });

  test("the rollback removes exactly what 019 created", () => {
    assert.match(rollbackNorm, /drop function if exists public\.reserve_rental_customer_identity\(\)/);
    assert.match(rollbackNorm, /drop function if exists public\.is_client_only\(\)/);
    assert.match(rollbackNorm, /drop trigger if exists users_reserve_client_identity/);
    assert.match(rollbackNorm, /drop policy if exists %i on public\.%i/);
    // It must not undo 016's helpers or 017/018's guards.
    assert.doesNotMatch(rollbackNorm, /drop function if exists public\.is_erp_user\(\)/);
    assert.doesNotMatch(rollbackNorm, /drop constraint/);
    // The rollback loops over policy suffixes, so the loop variable must be
    // declared; a missing declaration aborts the whole DO block silently.
    assert.match(rollbackNorm, /suffix text;/);
  });

  test("the rollback covers every table 019 gated", () => {
    for (const t of [
      "settings",
      "accounts",
      "journal_entries",
      "invoices",
      "payments",
      "cars",
      "rental_contracts",
    ]) {
      assert.ok(rollbackNorm.includes(`'${t}'`), `the rollback list is missing ${t}`);
    }
  });

  test("the behavioural harness exists and is registered in the chain harness", () => {
    const harness = path.join(ROOT, "supabase/tests/exec77_harness/run.sh");
    assert.ok(fs.existsSync(harness), "supabase/tests/exec77_harness/run.sh is missing");
    const chain = fs.readFileSync(
      path.join(ROOT, "supabase/tests/cross_company_harness/run.sh"),
      "utf8",
    );
    assert.ok(
      chain.includes("019_null_tenant_isolation"),
      "the whole-chain harness must apply 019",
    );
  });
});
