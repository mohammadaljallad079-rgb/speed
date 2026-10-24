import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  assertSuperAdmin,
  assertRoleChangeAllowed,
  tenantStatus,
  isAssignableRole,
} from "../src/lib/super-admin/policy.ts";
import { buildOverview, listTenantUsers, setUserRole, type AdminDb, type AdminQuery } from "../src/lib/super-admin/service.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";
import { DEFAULT_ROLE_PERMISSIONS } from "../src/lib/auth/permissions.ts";
import { isAdminRole } from "../src/lib/auth/policy.ts";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Execution 41 — global Super Admin console.
 *
 * The console is the only cross-tenant surface, so these tests lock in the two
 * properties that make it safe: (1) only a `super_admin` may reach it, and
 * (2) the console may never be used to grant the `super_admin` role. The service
 * is exercised against a PostgREST-like recording stub, not a mock of the code
 * under test.
 */

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  const role = overrides.role ?? "admin";
  return {
    authUserId: "00000000-0000-0000-0000-000000000001",
    email: "user@example.com",
    fullName: "Test User",
    role,
    tenantId: null,
    customerId: null,
    branchIds: null,
    financialYearId: null,
    permissions: DEFAULT_ROLE_PERMISSIONS[role] ?? {},
    isAdmin: isAdminRole(role),
    isSuperAdmin: role === "super_admin",
    ...overrides,
  };
}

// --- A recording PostgREST-like stub that applies the filters it is given. ----
type Row = Record<string, unknown>;
class FakeQuery implements AdminQuery {
  private rows: Row[];
  private filters: { col: string; val: unknown }[] = [];
  private op: "select" | "update" = "select";
  private updateValues: Row = {};
  constructor(rows: Row[]) {
    this.rows = rows;
  }
  select() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, val });
    return this;
  }
  is(col: string, val: null) {
    this.filters.push({ col, val });
    return this;
  }
  in(col: string, values: readonly string[]) {
    this.filters.push({ col, val: values.join(",") });
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    return Promise.resolve(this.apply());
  }
  single() {
    return Promise.resolve(this.apply());
  }
  update(values: Row) {
    this.op = "update";
    this.updateValues = values;
    return this;
  }
  insert(values: Row | Row[]) {
    const rows = Array.isArray(values) ? values : [values];
    this.rows.push(...rows);
    return this;
  }
  delete() {
    this.op = "update";
    return this;
  }
  private apply() {
    const match = this.rows.filter((r) => this.filters.every((f) => String(r[f.col]) === String(f.val)));
    if (this.op === "update") {
      for (const r of match) Object.assign(r, this.updateValues);
      return { data: match, error: null };
    }
    return { data: match, error: null };
  }
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.apply()).then(onfulfilled, onrejected);
  }
}

class FakeDb implements AdminDb {
  tables: Record<string, Row[]>;
  constructor(tables: Record<string, Row[]>) {
    this.tables = tables;
  }
  from(table: string) {
    return new FakeQuery(this.tables[table] ?? []);
  }
}

describe("super_admin is the only role admitted to the global console", () => {
  test("a company admin is rejected, a super admin is admitted", () => {
    assert.throws(() => assertSuperAdmin(context({ role: "admin" })), /Global administrator/);
    assert.throws(() => assertSuperAdmin(context({ role: "staff" })), /Global administrator/);
    assert.throws(() => assertSuperAdmin(context({ role: "client" })), /Global administrator/);
    assert.doesNotThrow(() => assertSuperAdmin(context({ role: "super_admin" })));
  });

  test("the console can never grant or revoke the super_admin role", () => {
    assert.throws(() => assertRoleChangeAllowed("super_admin"), /not managed/);
    assert.equal(assertRoleChangeAllowed("admin"), undefined);
    assert.equal(isAssignableRole("staff"), true);
    assert.equal(isAssignableRole("super_admin"), false);
    assert.equal(isAssignableRole("root"), false);
  });
});

describe("tenant lifecycle is derived, never stored", () => {
  test("no users -> suspended, only inactive -> dormant, else active", () => {
    assert.equal(tenantStatus({ userCount: 0, activeUserCount: 0 }), "suspended");
    assert.equal(tenantStatus({ userCount: 2, activeUserCount: 0 }), "dormant");
    assert.equal(tenantStatus({ userCount: 2, activeUserCount: 1 }), "active");
  });
});

describe("overview isolates each company's counts", () => {
  test("users are tallied per tenant and never leak across", async () => {
    const db = new FakeDb({
      tenants: [
        { id: "t-a", name: "SPEED", name_en: "SPEED", created_at: "2026-01-01" },
        { id: "t-b", name: "Other", name_en: "Other", created_at: "2026-02-01" },
      ],
      users: [
        { id: "u1", tenant_id: "t-a", role: "admin", is_active: true },
        { id: "u2", tenant_id: "t-a", role: "staff", is_active: false },
        { id: "u3", tenant_id: "t-b", role: "admin", is_active: true },
        { id: "u4", tenant_id: null, role: "client", is_active: true },
      ],
      branches: [{ id: "b1", tenant_id: "t-a" }],
      activity_logs: [],
    });

    const overview = await buildOverview(db);
    const a = overview.tenants.find((t) => t.id === "t-a")!;
    const b = overview.tenants.find((t) => t.id === "t-b")!;

    assert.equal(a.userCount, 2);
    assert.equal(a.adminCount, 1);
    assert.equal(a.branches, 1);
    assert.equal(a.status, "active");

    assert.equal(b.userCount, 1);
    assert.equal(b.branches, 0);

    // The NULL-tenant user is counted globally but belongs to no company list.
    assert.equal(overview.totals.users, 4);
    assert.equal(overview.totals.superAdmins, 0);
  });

  test("listing a company's users scopes to that tenant only", async () => {
    const db = new FakeDb({
      users: [
        { id: "u1", tenant_id: "t-a", role: "admin", is_active: true, email: "a@x" },
        { id: "u3", tenant_id: "t-b", role: "admin", is_active: true, email: "b@x" },
      ],
    });
    const users = await listTenantUsers(db, "t-a");
    assert.deepEqual(users.map((u) => u.id), ["u1"]);
  });

  test("setting a role writes only users.role and refuses super_admin", async () => {
    const db = new FakeDb({
      users: [{ id: "u1", tenant_id: "t-a", role: "staff", is_active: true }],
    });
    await setUserRole(db, "u1", "admin");
    assert.equal(db.tables.users[0].role, "admin");
    assert.equal(db.tables.users[0].tenant_id, "t-a");
    await assert.rejects(() => setUserRole(db, "u1", "super_admin"), /not managed/);
    assert.equal(db.tables.users[0].role, "admin");
  });
});

describe("the console UI reads server-resolved data, never the browser client", () => {
  const page = read("src/app/super-admin/page.tsx");
  const login = read("src/app/super-admin-login/page.tsx");

  test("the console fetches its data from the guarded super-admin API", () => {
    assert.match(page, /\/api\/super-admin\/overview/);
    assert.match(page, /\/api\/super-admin\/ai/);
  });

  test("the console never queries the database directly from the browser", () => {
    // The shared browser client is only used to sign out; every read goes through
    // the guarded super-admin API, so no ERP table is queried client-side.
    assert.doesNotMatch(page, /\.from\(['"](users|tenants|activity_logs)['"]\)/);
    assert.doesNotMatch(page, /supabase-admin/);
    assert.doesNotMatch(page, /SERVICE_ROLE/);
  });

  test("the global sign-in resolves the role server-side and refuses non super admins", () => {
    assert.match(login, /\/api\/me/);
    assert.match(login, /isSuperAdmin/);
    assert.doesNotMatch(login, /user_metadata|app_metadata/);
    assert.doesNotMatch(login, /SERVICE_ROLE/);
  });
});
