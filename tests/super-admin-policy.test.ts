import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_MODULES,
} from "../src/lib/auth/permissions.ts";
import { can, isAdminRole, isSuperAdmin, normaliseRole } from "../src/lib/auth/policy.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";

const ROOT = process.cwd();

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  const role = overrides.role ?? "staff";
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

describe("super_admin role identity", () => {
  test("normaliseRole recognises super_admin and never invents it", () => {
    assert.equal(normaliseRole("super_admin"), "super_admin");
    assert.equal(normaliseRole("admin"), "admin");
    // Anything unknown falls back to the least-privileged staff role.
    assert.equal(normaliseRole("root"), "staff");
    assert.equal(normaliseRole("owner"), "staff");
    assert.equal(normaliseRole(undefined), "staff");
  });

  test("isAdminRole covers both administrators, not staff/client", () => {
    assert.equal(isAdminRole("super_admin"), true);
    assert.equal(isAdminRole("admin"), true);
    assert.equal(isAdminRole("staff"), false);
    assert.equal(isAdminRole("client"), false);
  });

  test("isSuperAdmin is true only for the global role", () => {
    assert.equal(isSuperAdmin(context({ role: "super_admin" })), true);
    assert.equal(isSuperAdmin(context({ role: "admin" })), false);
    assert.equal(isSuperAdmin(context({ role: "staff" })), false);
  });

  test("a super admin can do everything, like any administrator", () => {
    const superAdmin = context({ role: "super_admin", permissions: {} });
    for (const module of PERMISSION_MODULES) {
      assert.equal(can(superAdmin, module, "view"), true, module);
      assert.equal(can(superAdmin, module, "delete"), true, module);
    }
  });

  test("super_admin default permissions exist for every module", () => {
    for (const module of PERMISSION_MODULES) {
      assert.deepEqual(
        DEFAULT_ROLE_PERMISSIONS.super_admin[module],
        { view: true, create: true, edit: true, delete: true },
        module,
      );
    }
  });
});

describe("global-only boundary is explicit in code", () => {
  test("the guard exposes a requireSuperAdmin option that rejects a company admin", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/lib/auth/api-guard.ts"), "utf8");
    assert.match(source, /requireSuperAdmin\?\: boolean/);
    assert.match(source, /options\.requireSuperAdmin && !context\.isSuperAdmin/);
  });

  test("the schema-migration endpoint is off unless opted in and super-admin only", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/app/api/migrate/route.ts"), "utf8");
    assert.match(source, /ENABLE_SCHEMA_MIGRATION_ENDPOINT !== "true"/);
    assert.match(source, /requireSuperAdmin: true/);
  });

  test("login resolves access server-side, never from browser-fetched role data", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/app/login/page.tsx"), "utf8");
    // The role gate must go through the server-resolved context endpoint.
    assert.match(source, /fetch\("\/api\/me"/);
    assert.doesNotMatch(source, /from\("users"\)\s*\.select\("role"\)/);
    assert.doesNotMatch(source, /appUser\.role/);
  });

  test("/api/me distinguishes a missing mapping from a missing session", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/app/api/me/route.ts"), "utf8");
    assert.match(source, /account_not_provisioned/);
    assert.match(source, /resolveAuthContext/);
    assert.match(source, /isSuperAdmin/);
  });
});

describe("migration 004 — global super admin", () => {
  const file = path.join(ROOT, "supabase/migrations/004_global_super_admin.sql");
  const sql = fs.readFileSync(file, "utf8");

  test("it exists and defines the global predicate", () => {
    assert.match(sql, /create or replace function public\.is_super_admin\(\)/);
    assert.match(sql, /role = 'super_admin'/);
  });

  test("is_admin() accepts super_admin without changing company semantics", () => {
    assert.match(sql, /role in \('admin', 'super_admin'\)/);
  });

  test("the isolation predicates are extended, so every policy inherits them", () => {
    assert.match(sql, /create or replace function public\.can_read_tenant/);
    assert.match(sql, /create or replace function public\.can_write_tenant/);
    // Super admin bypasses the strict write predicate; everyone else is unchanged.
    assert.match(sql, /when public\.is_super_admin\(\) then true/);
  });

  test("it is additive and non-destructive", () => {
    assert.doesNotMatch(sql, /drop\s+table/i);
    assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
    assert.doesNotMatch(sql, /\btruncate\b/i);
  });

  test("the anon role never gains the new functions", () => {
    assert.match(sql, /revoke all on function public\.is_super_admin\(\) from anon/);
  });

  test("it closes the privilege-escalation path a company admin had", () => {
    // A BEFORE trigger because RLS `with check` cannot see the OLD row.
    assert.match(sql, /create or replace function public\.prevent_role_escalation/);
    assert.match(sql, /create trigger users_prevent_role_escalation/);
    assert.match(sql, /raise exception 'Only a super administrator may grant or revoke the super_admin role'/);
  });

  test("it tightens the identity policies that were too broad for an admin", () => {
    assert.match(sql, /drop policy if exists tenants_read on public\.tenants/);
    assert.match(sql, /drop policy if exists users_admin_insert on public\.users/);
    // Cross-tenant INSERT is denied: the new WITH CHECK scopes to the caller's tenant.
    assert.match(sql, /tenant_id is not distinct from public\.current_tenant_id\(\)/);
  });
});
