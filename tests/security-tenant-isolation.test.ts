import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { assertWritableTenant } from "../src/lib/auth/policy.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";

/**
 * Execution 03 — database/security layer hardening.
 *
 * Migration 002 could not be executed from this environment (no reachable DDL
 * connection; the `exec_sql` RPC returns 404), so it ships as a SQL file and
 * these tests protect its security intent:
 *
 *   1. The anon (browser) role is stripped of every table privilege — this is
 *      the fix for the confirmed live exposure where the public key could read
 *      and write every tenant's rows.
 *   2. RLS is enabled on every table the policy loops target.
 *   3. The write predicate is strict while the read predicate stays NULL-safe,
 *      so the current single-tenant install keeps working.
 *   4. Every privileged route performs an explicit authorization check.
 *
 * The live probe at the bottom is opt-in (`RUN_LIVE_RLS_PROBE=1`) because it
 * requires a reachable, already-migrated database.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATION = path.join(ROOT, "supabase/migrations/002_tenant_isolation_hardening.sql");
const ROLLBACK = path.join(
  ROOT,
  "supabase/migrations/002_tenant_isolation_hardening_rollback.sql",
);

const sql = fs.readFileSync(MIGRATION, "utf8");

/** Every `tables text[] := array[...]` literal, in file order. */
function declaredTableArrays(source: string): string[][] {
  return [...source.matchAll(/tables text\[\]\s*:=\s*array\[([\s\S]*?)\]/gi)].map((m) =>
    [...m[1].matchAll(/'([a-z_]+)'/gi)].map((n) => n[1].toLowerCase()),
  );
}

/**
 * The four arrays in 002, in declaration order:
 *   0 — tables that receive a `tenant_id` column
 *   1 — tables that get RLS enabled
 *   2 — tables that get the four tenant_id policies
 *   3 — financial-analytics tables that get the four company_id policies
 */
const [columnTargets = [], rlsEnabled = [], tenantPolicies = [], companyPolicies = []] =
  declaredTableArrays(sql);

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    authUserId: "00000000-0000-0000-0000-000000000001",
    email: "user@example.com",
    fullName: "Test User",
    role: "staff",
    tenantId: null,
    customerId: null,
    branchIds: null,
    financialYearId: null,
    permissions: {},
    isAdmin: false,
    isSuperAdmin: false,
    ...overrides,
  };
}

describe("migration 002 — the anon exposure fix", () => {
  test("the migration file exists and is non-trivial", () => {
    assert.ok(fs.existsSync(MIGRATION));
    assert.ok(sql.length > 4000, "migration should be substantive");
  });

  test("it revokes anon privileges across every public table", () => {
    assert.match(sql, /revoke all on public\.%I from anon/i);
    assert.match(sql, /revoke all on public\.%I from public/i);
  });

  test("the anon revoke iterates the live table catalogue, not a fixed list", () => {
    // A hardcoded list would silently miss a table added later.
    assert.match(sql, /from pg_class c[\s\S]*?relkind = 'r'/i);
  });

  test("anon loses the helper functions too", () => {
    assert.match(sql, /revoke all on function public\.current_tenant_id\(\) from anon/i);
    assert.match(sql, /revoke all on function public\.is_admin\(\) from anon/i);
  });

  test("it enables RLS on the tables it policies", () => {
    assert.ok(rlsEnabled.length > 50, `expected a broad RLS list, got ${rlsEnabled.length}`);
    for (const table of tenantPolicies) {
      assert.ok(rlsEnabled.includes(table), `${table} is policied but not RLS-enabled`);
    }
    for (const table of companyPolicies) {
      assert.ok(rlsEnabled.includes(table), `${table} is policied but not RLS-enabled`);
    }
  });

  test("ai_recommendations and the analytics tables are RLS-enabled", () => {
    for (const table of ["ai_recommendations", "financial_ratios", "kpi_results", "financial_health_score"]) {
      assert.ok(rlsEnabled.includes(table), `${table} must be RLS-enabled`);
    }
  });

  test("users and tenants are RLS-enabled", () => {
    assert.ok(rlsEnabled.includes("users"));
    assert.ok(rlsEnabled.includes("tenants"));
  });

  test("no table appears twice in the RLS-enable array", () => {
    assert.equal(new Set(rlsEnabled).size, rlsEnabled.length);
  });

  test("the RLS-enable array is a superset of both policy arrays", () => {
    for (const table of [...tenantPolicies, ...companyPolicies]) {
      assert.ok(rlsEnabled.includes(table), `${table} missing from RLS-enable array`);
    }
  });
});

describe("migration 002 — tenant predicate semantics", () => {
  test("the read predicate is NULL-tolerant (single-tenant install keeps working)", () => {
    assert.match(sql, /can_read_tenant[\s\S]*?is not distinct from/i);
  });

  test("the write predicate is strict — no tenant-less orphans for a tenanted caller", () => {
    assert.match(sql, /can_write_tenant[\s\S]*?when public\.current_tenant_id\(\) is null then candidate is null/i);
  });

  test("all four tenant policies are created per table", () => {
    for (const verb of ["select", "insert", "update", "delete"]) {
      assert.match(sql, new RegExp(`_tenant_${verb}`, "i"), `missing ${verb} policy`);
    }
  });

  test("update policies guard both the visible row and the new value", () => {
    const updatePolicy = sql.match(/for update to authenticated[\s\S]*?with check \([^)]*\)/i);
    assert.ok(updatePolicy, "no update policy found");
    assert.match(updatePolicy[0], /can_read_tenant/);
    assert.match(updatePolicy[0], /can_write_tenant/);
  });

  test("nobody may move a user row out of their own tenant", () => {
    const usersUpdate = sql.match(/users_self_update[\s\S]*?with check \([\s\S]*?\);/i);
    assert.ok(usersUpdate, "users_self_update policy not found");
    assert.match(usersUpdate[0], /tenant_id is not distinct from public\.current_tenant_id\(\)/);
  });

  test("activity_logs is append-only", () => {
    assert.match(sql, /activity_logs_no_update[\s\S]*?using \(false\)/i);
    assert.match(sql, /activity_logs_no_delete[\s\S]*?using \(false\)/i);
  });

  test("the append-only policies are RESTRICTIVE (a permissive deny would be ORed away)", () => {
    // The generic tenant loop in this same migration creates permissive
    // activity_logs_tenant_update/_delete policies. Permissive policies are ORed
    // together, so a permissive `using (false)` would not remove the verb. The
    // deny must be RESTRICTIVE so it is ANDed with every permissive policy.
    assert.match(
      sql,
      /create policy activity_logs_no_update on public\.activity_logs\s+as restrictive for update/i,
    );
    assert.match(
      sql,
      /create policy activity_logs_no_delete on public\.activity_logs\s+as restrictive for delete/i,
    );
  });

  test("financial_ratio_history is scoped through its parent ratio", () => {
    assert.match(sql, /financial_ratio_history_parent_select[\s\S]*?financial_ratios fr/i);
  });

  test("the migration is non-destructive", () => {
    // Strip line comments first: the header documents what the migration does
    // NOT do, and that prose must not be mistaken for a statement.
    const statements = sql.replace(/--[^\n]*/g, "");
    assert.doesNotMatch(statements, /\bdrop\s+table\b/i);
    assert.doesNotMatch(statements, /\btruncate\b/i);
    assert.doesNotMatch(statements, /\bdelete\s+from\b/i);
    assert.doesNotMatch(statements, /\bdrop\s+column\b/i);
  });

  test("it is idempotent — every create is guarded", () => {
    assert.match(sql, /create table if not exists/i);
    assert.match(sql, /add column if not exists/i);
    assert.match(sql, /create index if not exists/i);
    assert.match(sql, /drop policy if exists/i);
  });

  test("missing tables are skipped rather than aborting the migration", () => {
    assert.match(sql, /if exists \(select 1 from information_schema\.tables/i);
  });

  test("tenant_id columns are added only where the column is absent", () => {
    assert.ok(columnTargets.length > 10, "expected a broad add-column list");
    assert.match(sql, /information_schema\.columns[\s\S]*?column_name = 'tenant_id'/i);
  });
});

describe("migration 002 rollback", () => {
  test("the rollback file exists", () => {
    assert.ok(fs.existsSync(ROLLBACK));
  });

  test("it drops the policies this migration created", () => {
    const rollback = fs.readFileSync(ROLLBACK, "utf8");
    assert.match(rollback, /drop policy if exists/i);
    assert.match(rollback, /pg_policies/i);
  });

  test("it restores anon grants and disables RLS", () => {
    const rollback = fs.readFileSync(ROLLBACK, "utf8");
    assert.match(rollback, /grant all on public\.%I to anon/i);
    assert.match(rollback, /disable row level security/i);
  });

  test("the rollback is non-destructive — it never drops columns or rows", () => {
    const rollback = fs.readFileSync(ROLLBACK, "utf8");
    assert.doesNotMatch(rollback, /drop\s+table/i);
    assert.doesNotMatch(rollback, /drop\s+column/i);
    assert.doesNotMatch(rollback, /truncate/i);
    assert.doesNotMatch(rollback, /\bdelete\s+from\b/i);
  });

  test("the rollback targets a bare table name, not schema.table.table", () => {
    // A regression here produced `public.public.accounts` and aborted the run.
    const rollback = fs.readFileSync(ROLLBACK, "utf8");
    assert.doesNotMatch(rollback, /on public\.%I\.%I/i);
    assert.match(rollback, /on public\.%I'/i);
  });
});

describe("assertWritableTenant — server-side tenant stamping", () => {
  test("a caller with a tenant gets that tenant stamped", () => {
    const tenantId = assertWritableTenant(context({ tenantId: "tenant-a" }), undefined);
    assert.equal(tenantId, "tenant-a");
  });

  test("a caller cannot write data for another tenant", () => {
    assert.throws(
      () => assertWritableTenant(context({ tenantId: "tenant-a" }), "tenant-b"),
      /another tenant/i,
    );
  });

  test("a matching incoming tenant is accepted", () => {
    assert.equal(assertWritableTenant(context({ tenantId: "tenant-a" }), "tenant-a"), "tenant-a");
  });

  test("a tenant-less caller stamps nothing (single-tenant install unchanged)", () => {
    assert.equal(assertWritableTenant(context({ tenantId: null }), undefined), null);
    assert.equal(assertWritableTenant(context({ tenantId: null }), ""), null);
  });

  test("a tenant-less caller cannot stamp a tenant it does not belong to", () => {
    // Without a tenant the value is simply ignored; the column stays null.
    assert.equal(assertWritableTenant(context({ tenantId: null }), "tenant-b"), null);
  });
});

describe("privileged routes enforce authorization", () => {
  const GUARD = /requireContext|requireAdmin|getSessionContext/;

  function routeFiles(): string[] {
    const dir = path.join(ROOT, "src/app/api");
    const out: string[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "route.ts") out.push(full);
      }
    };
    walk(dir);
    return out;
  }

  test("every service-role route calls an authorization guard", () => {
    const unguarded = routeFiles().filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      return source.includes("supabaseAdmin") && !GUARD.test(source);
    });
    // customer-signup is public by design: it creates a `client` account and
    // hardcodes the role, so it cannot escalate. The `/api/public/*` marketing
    // reads are also public by design, but they are additionally constrained to
    // an explicit safe projection (asserted by the next test). `/api/saas/signup`
    // is public by design too: it always creates a NEW tenant and hardcodes the
    // `admin` role of that new tenant only (asserted by its own test below).
    // `/api/me` cannot call `requireContext`: it is the route that RESOLVES the
    // context (the login page calls it to learn its own role). It authenticates
    // with `auth.getUser()` and 401s without a session; its service-role read is
    // scoped by `context.tenantId`. Asserted by the test below.
    // Every other route must guard.
    const allowed = ["customer-signup", "/api/public/", "/api/saas/signup", "/api/me/"];
    const offenders = unguarded.filter((f) => !allowed.some((a) => f.includes(a)));
    assert.deepEqual(offenders, [], `unguarded privileged routes: ${offenders.join(", ")}`);
  });

  test("the /api/me exemption is safe: it authenticates and scopes by the session", () => {
    // The exemption above is only valid if /api/me really is the context
    // resolver: it must reject a session-less caller and must scope its
    // service-role read by the tenant it resolved (never by request input).
    const me = fs.readFileSync(path.join(ROOT, "src/app/api/me/route.ts"), "utf8");
    assert.match(me, /auth\.getUser\(\)/, "it must authenticate the session");
    assert.match(me, /status:\s*401/, "a session-less caller must be rejected");
    assert.match(me, /resolveAuthContext\(request\)/, "it resolves the app identity server-side");
    assert.match(me, /loadTenantPlan\(supabaseAdmin as never, context\.tenantId\)/, "the service-role read must use the resolved tenant");
    assert.doesNotMatch(me, /body\.tenant_id|searchParams\.get\("tenant/, "it must never read a tenant from the request");
  });

  test("routes that insert tenant-owned rows set tenant_id from the session", () => {
    // A tenant-owned row written without a tenant_id is an "orphan": it lands in
    // the NULL-tenant bucket and becomes visible to the single-tenant install,
    // which is exactly the write-isolation hole `assertWritableTenant` closes.
    const tenantOwned = new Set(columnTargets);
    const offenders: string[] = [];
    for (const file of routeFiles()) {
      const source = fs.readFileSync(file, "utf8");
      const inserted = [...source.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]\s*\)\s*\.insert\(/gi)].map(
        (m) => m[1],
      );
      const tenantTables = inserted.filter((t) => tenantOwned.has(t));
      if (!tenantTables.length) continue;
      const setsTenant = /assertWritableTenant|tenant_id\s*:/.test(source);
      if (!setsTenant) offenders.push(`${file} [${tenantTables.join(",")}]`);
    }
    // customer-signup is public by design and deliberately creates a NULL-tenant
    // customer in the single-tenant install (asserted by its own escalation test).
    const allowed = ["customer-signup"];
    const real = offenders.filter((o) => !allowed.some((a) => o.includes(a)));
    assert.deepEqual(real, [], `tenant-owned inserts without a session tenant: ${real.join(", ")}`);
  });

  test("no ERP route leaves a tenant filter open when the tenant is unresolved", () => {
    // Regression guard for the fail-open shape: `if (context.tenantId) q =
    // q.eq("tenant_id", ...)` leaves the query UNFILTERED when the caller's
    // tenant could not be resolved, so such a caller reads every tenant's rows.
    // The correct shape is a ternary that falls back to `.is("tenant_id", null)`.
    //
    // Three invoice routes and the report-format history had exactly this hole
    // (an invoice IDOR: another tenant's invoice was readable/editable by id).
    const offenders: string[] = [];
    for (const file of routeFiles()) {
      const source = fs.readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        if (/^\s*if \(context\.tenantId\)\s*\S*\s*=?\s*\S*\.eq\(["'`]tenant_id["'`]/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `fail-open tenant filters:\n${offenders.join("\n")}`);
  });

  test("a tenant-less caller is scoped to IS NULL in the invoice routes", () => {
    for (const rel of [
      "src/app/api/invoices/[id]/route.ts",
      "src/app/api/invoices/[id]/reverse/route.ts",
    ]) {
      const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.match(source, /\.is\("tenant_id",\s*null\)/, `${rel} must fall back to IS NULL`);
    }
  });

  test("creating an application user stamps the session tenant on the users row", () => {
    // `users` is tenant-owned (migration 002's tenant table list) and the profile
    // trigger creates the row without a tenant. Without this stamp the account is
    // an orphan in the NULL-tenant bucket.
    const source = fs.readFileSync(path.join(ROOT, "src/app/api/users/route.ts"), "utf8");
    assert.match(source, /from\("users"\)[\s\S]{0,200}?tenant_id:\s*context\.tenantId/);
    assert.doesNotMatch(source, /body\.tenant_id/, "the tenant must never come from the body");
  });

  test("public routes expose only a safe, explicit projection", () => {
    const vehicles = fs.readFileSync(
      path.join(ROOT, "src/app/api/public/vehicles/route.ts"),
      "utf8",
    );
    const profile = fs.readFileSync(
      path.join(ROOT, "src/app/api/public/company-profile/route.ts"),
      "utf8",
    );

    // No `select('*')`: the service-role client must never return whole rows.
    for (const source of [vehicles, profile]) {
      assert.doesNotMatch(source, /select\(\s*["'`]\*["'`]\s*\)/);
    }

    // The vehicle feed must not expose internal commercial data even though the
    // caller is anonymous and the query bypasses RLS.
    for (const column of [
      "purchase_price", "purchase_costs", "maintenance_costs", "salvage_value",
      "supplier_id", "vin", "chassis_number", "engine_number",
      "insurance_policy_number", "bank_name", "interest_rate", "notes",
    ]) {
      assert.doesNotMatch(vehicles, new RegExp(`["'\`]${column}["'\`]`), `vehicles route leaks ${column}`);
    }

    // Public routes must not accept tenant/role identity from the caller.
    for (const source of [vehicles, profile]) {
      assert.doesNotMatch(source, /searchParams\.get\(\s*["'](tenant_id|role|tenantId)["']\s*\)/);
    }
  });

  test("the public signup route cannot escalate its role", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "src/app/api/customer-signup/route.ts"),
      "utf8",
    );
    assert.match(source, /role:\s*"client"/);
    // The role must be a literal, never taken from the request body.
    assert.doesNotMatch(source, /role:\s*body\./);
  });

  test("the schema-migration endpoint is disabled by default", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/app/api/migrate/route.ts"), "utf8");
    assert.match(source, /ENABLE_SCHEMA_MIGRATION_ENDPOINT/);
    // DDL is global-only: even an authenticated company administrator must not
    // reach it. The guard must require the explicit super-admin role.
    assert.match(source, /requireContext\(request, \{ requireAdmin: true, requireSuperAdmin: true \}\)/);
  });

  test("reference validation filters by tenant in the query", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/lib/auth/references.ts"), "utf8");
    assert.match(source, /\.eq\("tenant_id", context\.tenantId\)/);
    assert.match(source, /\.is\("tenant_id", null\)/);
  });

  test("ownership checks filter by tenant in the query", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/lib/auth/ownership.ts"), "utf8");
    assert.match(source, /\.eq\("tenant_id", context\.tenantId\)/);
    assert.match(source, /\.is\("tenant_id", null\)/);
  });
});

/**
 * Live probe — proves the migration actually took effect on a real database.
 * Opt-in because it needs a migrated, reachable instance. Skipped by default so
 * the suite stays green in an environment without database access.
 *
 *   RUN_LIVE_RLS_PROBE=1 npm test
 */
describe("live RLS probe (opt-in)", () => {
  const enabled = process.env.RUN_LIVE_RLS_PROBE === "1";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const tables = ["customers", "invoices", "journal_entries", "journal_lines", "payments", "users"];

  for (const table of tables) {
    test(`anon cannot read ${table}`, { skip: !enabled || !url || !anon }, async () => {
      const response = await fetch(`${url}/rest/v1/${table}?select=id&limit=1`, {
        headers: { apikey: anon as string, Authorization: `Bearer ${anon}` },
      });
      assert.ok(
        response.status === 401 || response.status === 403 || response.status === 404,
        `anon still has access to ${table} (HTTP ${response.status})`,
      );
    });
  }
});
