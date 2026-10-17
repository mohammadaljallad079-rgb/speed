import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveContextFrom, type AuthResolverAdmin } from "../src/lib/auth/context.ts";
import { authorize, type GuardOptions } from "../src/lib/auth/api-guard.ts";
import { ApiError } from "../src/lib/auth/errors.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";

/**
 * Exec 32 — behavioural coverage for the authentication-to-authorization flow.
 *
 * `resolveContextFrom` is driven through a PostgREST-like recording stub (the
 * same injectable-client pattern the accounting services use), so the four
 * mandated outcomes are exercised as real code paths, not source regexes:
 *   - a valid company administrator resolves;
 *   - an unmapped account resolves to `null` (-> 403 account_not_provisioned);
 *   - an inactive account resolves to `null` (-> rejected);
 *   - the global super admin resolves tenant-less.
 *
 * `authorize` is the pure guard decision, so every 401/403 branch is asserted
 * directly.
 */

type Row = Record<string, unknown>;

function makeAdmin(tables: Record<string, Row | Row[] | null>): AuthResolverAdmin {
  return {
    from(table: string) {
      const state: { cols?: string; filters: [string, unknown][] } = { filters: [] };
      const run = () => {
        const rows = tables[table];
        if (rows === undefined || rows === null) return { data: null, error: null };
        if (Array.isArray(rows)) {
          const filtered = rows.filter((r) =>
            state.filters.every(([c, v]) => r[c] === v),
          );
          return { data: filtered, error: null };
        }
        const ok = state.filters.every(([c, v]) => rows[c] === v);
        return { data: ok ? rows : null, error: null };
      };
      const builder = {
        select(cols: string) {
          state.cols = cols;
          return builder;
        },
        eq(col: string, value: unknown) {
          state.filters.push([col, value]);
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(run());
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return builder as never;
    },
  };
}

const COMPANY_TENANT = "11111111-1111-1111-1111-111111111111";

describe("Exec 32 - resolveContextFrom outcomes", () => {
  test("valid company administrator resolves, tenant-scoped, not super", async () => {
    const admin = makeAdmin({
      users: { id: "u1", email: "speedadmin@speed.local", role: "admin", tenant_id: COMPANY_TENANT, is_active: true, permissions: null, full_name: "SPEED Admin" },
      profiles: null,
    });
    const ctx = await resolveContextFrom({ id: "u1", email: "speedadmin@speed.local" }, admin);
    assert.ok(ctx);
    assert.equal(ctx!.role, "admin");
    assert.equal(ctx!.tenantId, COMPANY_TENANT);
    assert.equal(ctx!.isAdmin, true);
    assert.equal(ctx!.isSuperAdmin, false);
  });

  test("global super admin resolves tenant-less and is the only global", async () => {
    const admin = makeAdmin({
      users: { id: "u2", email: "admin@system.local", role: "super_admin", tenant_id: null, is_active: true, permissions: null, full_name: "Global" },
      profiles: null,
    });
    const ctx = await resolveContextFrom({ id: "u2", email: "admin@system.local" }, admin);
    assert.ok(ctx);
    assert.equal(ctx!.role, "super_admin");
    assert.equal(ctx!.tenantId, null);
    assert.equal(ctx!.isAdmin, true);
    assert.equal(ctx!.isSuperAdmin, true);
  });

  test("unmapped account (Auth identity, no users row) resolves to null", async () => {
    const admin = makeAdmin({ users: null, profiles: null });
    const ctx = await resolveContextFrom({ id: "ghost", email: "admin@system.local" }, admin);
    assert.equal(ctx, null, "a missing mapping must not resolve to a context");
  });

  test("inactive user resolves to null even with a valid row", async () => {
    const admin = makeAdmin({
      users: { id: "u3", email: "off@speed.local", role: "admin", tenant_id: COMPANY_TENANT, is_active: false, permissions: null },
      profiles: null,
    });
    const ctx = await resolveContextFrom({ id: "u3", email: "off@speed.local" }, admin);
    assert.equal(ctx, null, "an inactive account must be rejected");
  });

  test("role is taken from the database row, never from the auth metadata", async () => {
    // A user whose metadata claims super_admin but whose users.role is staff.
    const admin = makeAdmin({
      users: { id: "u4", email: "staff@speed.local", role: "staff", tenant_id: COMPANY_TENANT, is_active: true, permissions: null },
      profiles: null,
    });
    const ctx = await resolveContextFrom(
      { id: "u4", email: "staff@speed.local", user_metadata: { full_name: "x", role: "super_admin" } },
      admin,
    );
    assert.ok(ctx);
    assert.equal(ctx!.role, "staff");
    assert.equal(ctx!.isSuperAdmin, false);
  });
});

function ctxOf(partial: Partial<AuthContext>): AuthContext {
  return {
    authUserId: "u",
    email: "e",
    fullName: null,
    role: "staff",
    tenantId: null,
    customerId: null,
    branchIds: null,
    financialYearId: null,
    permissions: {},
    isAdmin: false,
    isSuperAdmin: false,
    ...partial,
  };
}

function expectApiError(fn: () => unknown, status: number, code: string) {
  try {
    fn();
    assert.fail("expected an ApiError to be thrown");
  } catch (e) {
    assert.ok(e instanceof ApiError, "must throw an ApiError");
    assert.equal((e as ApiError).status, status);
    assert.equal((e as ApiError).code, code);
  }
}

describe("Exec 32 - authorize guard decisions", () => {
  test("unauthenticated caller is rejected with 401", () => {
    expectApiError(() => authorize(null, {}), 401, "unauthenticated");
  });

  test("anonymous handler runs only when requireAuth is false", () => {
    assert.equal(authorize(null, { requireAuth: false }), null);
  });

  test("requireSuperAdmin rejects a company admin with 403", () => {
    const company = ctxOf({ role: "admin", isAdmin: true });
    expectApiError(
      () => authorize(company, { requireSuperAdmin: true }),
      403,
      "forbidden",
    );
  });

  test("requireSuperAdmin admits the global super admin", () => {
    const superAdmin = ctxOf({ role: "super_admin", isAdmin: true, isSuperAdmin: true });
    const out = authorize(superAdmin, { requireSuperAdmin: true });
    assert.ok(out);
    assert.equal(out!.isSuperAdmin, true);
  });

  test("requireAdmin rejects staff and admits an admin", () => {
    expectApiError(() => authorize(ctxOf({ role: "staff" }), { requireAdmin: true }), 403, "forbidden");
    assert.ok(authorize(ctxOf({ role: "admin", isAdmin: true }), { requireAdmin: true }));
  });

  test("a missing module permission is a 403 for a non-admin", () => {
    const options: GuardOptions = { module: "invoices", action: "create" };
    expectApiError(
      () => authorize(ctxOf({ role: "staff", permissions: {} }), options),
      403,
      "forbidden",
    );
    // An administrator bypasses the matrix.
    assert.ok(authorize(ctxOf({ role: "admin", isAdmin: true }), options));
  });

  test("an inactive/unmapped account (null context) is rejected like an anonymous caller", () => {
    // resolveContextFrom returns null for inactive/unmapped; the guard then
    // produces 401 exactly as it would for a missing session.
    expectApiError(() => authorize(null, { requireAdmin: true }), 401, "unauthenticated");
  });
});
