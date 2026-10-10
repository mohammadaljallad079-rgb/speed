import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_MODULES,
  isPermissionAction,
  isPermissionModule,
  parsePermissionKey,
} from "../src/lib/auth/permissions.ts";
import { can } from "../src/lib/auth/policy.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";

function context(role: AuthContext["role"], overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    authUserId: "00000000-0000-0000-0000-000000000001",
    email: "user@example.com",
    fullName: "Test User",
    role,
    tenantId: null,
    customerId: null,
    branchIds: null,
    financialYearId: null,
    permissions: DEFAULT_ROLE_PERMISSIONS[role],
    isAdmin: role === "admin",
    ...overrides,
  };
}

describe("permission catalogue", () => {
  test("every declared module is recognised", () => {
    for (const module of PERMISSION_MODULES) {
      assert.equal(isPermissionModule(module), true);
    }
  });

  test("unknown modules and actions are rejected", () => {
    assert.equal(isPermissionModule("nope"), false);
    assert.equal(isPermissionModule(""), false);
    assert.equal(isPermissionAction("publish"), false);
    assert.equal(isPermissionAction("delete"), true);
  });

  test("parsePermissionKey only accepts module.action pairs", () => {
    assert.deepEqual(parsePermissionKey("customers.view"), {
      module: "customers",
      action: "view",
    });
    assert.equal(parsePermissionKey("customers"), null);
    assert.equal(parsePermissionKey("customers.publish"), null);
    assert.equal(parsePermissionKey("nope.view"), null);
    assert.equal(parsePermissionKey(""), null);
  });
});

describe("role defaults", () => {
  test("admin has every module and every action", () => {
    for (const module of PERMISSION_MODULES) {
      assert.deepEqual(
        DEFAULT_ROLE_PERMISSIONS.admin[module],
        { view: true, create: true, edit: true, delete: true },
        `admin.${module}`,
      );
    }
  });

  test("staff cannot manage users or settings", () => {
    assert.equal(DEFAULT_ROLE_PERMISSIONS.staff.users, undefined);
    assert.equal(DEFAULT_ROLE_PERMISSIONS.staff.settings, undefined);
    assert.equal(DEFAULT_ROLE_PERMISSIONS.staff.customers?.create, true);
  });

  test("client has no admin/ERP permissions", () => {
    assert.deepEqual(DEFAULT_ROLE_PERMISSIONS.client, {});
  });
});

describe("can()", () => {
  test("admin is allowed everything, including modules absent from its map", () => {
    const admin = context("admin", { permissions: {} });
    assert.equal(can(admin, "users", "delete"), true);
    assert.equal(can(admin, "settings", "edit"), true);
    assert.equal(can(admin, "anything-not-declared", "view"), true);
  });

  test("staff is denied users and settings", () => {
    const staff = context("staff");
    assert.equal(can(staff, "users", "view"), false);
    assert.equal(can(staff, "users", "create"), false);
    assert.equal(can(staff, "settings", "edit"), false);
    assert.equal(can(staff, "customers", "view"), true);
    assert.equal(can(staff, "customers", "create"), true);
    assert.equal(can(staff, "customers", "delete"), true);
  });

  test("staff reports are read-only", () => {
    const staff = context("staff");
    assert.equal(can(staff, "reports", "view"), true);
    assert.equal(can(staff, "reports", "create"), false);
    assert.equal(can(staff, "reports", "delete"), false);
  });

  test("client is denied every admin module", () => {
    const client = context("client");
    for (const module of PERMISSION_MODULES) {
      assert.equal(can(client, module, "view"), false, `client.${module}.view`);
      assert.equal(can(client, module, "create"), false, `client.${module}.create`);
    }
  });

  test("a DB-configured permission map overrides the built-in defaults", () => {
    // Simulates a role whose `permissions` rows grant only customers.view.
    const staff = context("staff", {
      permissions: { customers: { view: true, create: false, edit: false, delete: false } },
    });
    assert.equal(can(staff, "customers", "view"), true);
    assert.equal(can(staff, "customers", "create"), false);
    assert.equal(can(staff, "customers", "delete"), false);
    // Modules not present in the override map fall back to nothing here.
    assert.equal(can(staff, "invoices", "view"), false);
  });

  test("an undeclared module is always denied for non-admins", () => {
    const staff = context("staff");
    assert.equal(can(staff, "not_a_module", "view"), false);
    assert.equal(can(staff, "", "view"), false);
  });
});
