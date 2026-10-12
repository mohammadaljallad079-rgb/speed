import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ApiError,
  badRequest,
  forbidden,
  invalidReference,
  notFound,
  toErrorResponse,
  unauthorized,
} from "../src/lib/auth/errors.ts";
import {
  assertBranchAccess,
  assertDateInOpenFinancialYear,
  assertWritableTenant,
  canAccessBranch,
  sanitizeMetadata,
  scopeToCompany,
} from "../src/lib/auth/policy.ts";
import { nextDocumentNumber } from "../src/lib/numbering.ts";
import type { AuthContext, FinancialYear } from "../src/lib/auth/types.ts";

const ROOT = path.join(import.meta.dirname, "..");

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

const TENANT_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const TENANT_B = "bbbbbbbb-0000-0000-0000-00000000000b";
const BRANCH_1 = "11111111-0000-0000-0000-000000000001";
const BRANCH_2 = "22222222-0000-0000-0000-000000000002";

describe("error contract", () => {
  test("each error carries a status and a stable code", () => {
    assert.equal(unauthorized().status, 401);
    assert.equal(unauthorized().code, "unauthenticated");
    assert.equal(forbidden().status, 403);
    assert.equal(forbidden().code, "forbidden");
    assert.equal(notFound().status, 404);
    assert.equal(badRequest("x").status, 400);
    assert.equal(invalidReference("customer_id").status, 422);
    assert.equal(invalidReference("customer_id").code, "invalid_reference");
  });

  test("toErrorResponse never leaks internal error detail", () => {
    const leaky = new Error("duplicate key value violates unique constraint \"customers_pkey\"");
    const { status, body } = toErrorResponse(leaky);
    assert.equal(status, 500);
    assert.equal(body.code, "internal_error");
    assert.equal(body.error, "Internal server error");
    assert.equal(JSON.stringify(body).includes("customers_pkey"), false);
  });

  test("toErrorResponse passes ApiError through untouched", () => {
    const { status, body } = toErrorResponse(forbidden("nope"));
    assert.equal(status, 403);
    assert.equal(body.error, "nope");
    assert.equal(body.code, "forbidden");
  });

  test("ApiError is an Error subclass", () => {
    assert.ok(unauthorized() instanceof ApiError);
    assert.ok(unauthorized() instanceof Error);
  });
});

describe("tenant write isolation", () => {
  test("a tenant-less caller keeps writing tenant-less rows", () => {
    assert.equal(assertWritableTenant(context(), undefined), null);
    assert.equal(assertWritableTenant(context(), null), null);
  });

  test("a caller cannot plant a row in another tenant", () => {
    const ctx = context({ tenantId: TENANT_A });
    assert.throws(() => assertWritableTenant(ctx, TENANT_B), (e: ApiError) => {
      assert.equal(e.status, 403);
      return true;
    });
  });

  test("a caller may write into its own tenant", () => {
    const ctx = context({ tenantId: TENANT_A });
    assert.equal(assertWritableTenant(ctx, TENANT_A), TENANT_A);
    // Omitting the value defaults to the caller's tenant.
    assert.equal(assertWritableTenant(ctx, undefined), TENANT_A);
  });
});

describe("branch isolation", () => {
  test("multi-branch administrators (branchIds = null) reach every branch", () => {
    const ctx = context({ branchIds: null });
    assert.equal(canAccessBranch(ctx, BRANCH_1), true);
    assert.equal(canAccessBranch(ctx, BRANCH_2), true);
    assert.equal(canAccessBranch(ctx, null), true);
    assert.doesNotThrow(() => assertBranchAccess(ctx, BRANCH_2));
  });

  test("a branch-restricted user only reaches its own branch", () => {
    const ctx = context({ branchIds: [BRANCH_1] });
    assert.equal(canAccessBranch(ctx, BRANCH_1), true);
    assert.equal(canAccessBranch(ctx, BRANCH_2), false);
    assert.doesNotThrow(() => assertBranchAccess(ctx, BRANCH_1));
    assert.throws(() => assertBranchAccess(ctx, BRANCH_2), (e: ApiError) => {
      assert.equal(e.status, 403);
      return true;
    });
  });

  test("an unrestricted field value is always accepted", () => {
    const ctx = context({ branchIds: [BRANCH_1] });
    assert.equal(canAccessBranch(ctx, null), true);
    assert.equal(canAccessBranch(ctx, undefined), true);
    assert.equal(canAccessBranch(ctx, ""), true);
  });
});

describe("financial year context", () => {
  const year: FinancialYear = {
    id: "year-2026",
    name: "2026",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    is_current: true,
    status: "active",
  };

  test("no financial year configured means no restriction", () => {
    assert.doesNotThrow(() => assertDateInOpenFinancialYear(null, "1999-01-01"));
    assert.doesNotThrow(() => assertDateInOpenFinancialYear(null, null));
  });

  test("dates inside the active year are accepted", () => {
    assert.doesNotThrow(() => assertDateInOpenFinancialYear(year, "2026-01-01"));
    assert.doesNotThrow(() => assertDateInOpenFinancialYear(year, "2026-12-31"));
  });

  test("dates outside the active year are rejected", () => {
    assert.throws(() => assertDateInOpenFinancialYear(year, "2025-12-31"), (e: ApiError) => {
      assert.equal(e.status, 403);
      return true;
    });
    assert.throws(() => assertDateInOpenFinancialYear(year, "2027-01-01"));
  });

  test("posting into a closed year is rejected", () => {
    const closed: FinancialYear = { ...year, status: "closed" };
    assert.throws(() => assertDateInOpenFinancialYear(closed, "2026-06-01"), (e: ApiError) => {
      assert.equal(e.status, 403);
      assert.match(e.message, /closed/i);
      return true;
    });
  });
});

describe("audit metadata sanitisation", () => {
  test("credentials are stripped before an audit row is written", () => {
    const clean = sanitizeMetadata({
      email: "user@example.com",
      password: "hunter2",
      apiKey: "sk-live-xxx",
      api_key: "sk-live-yyy",
      access_token: "tok",
      authorization: "Bearer abc",
      nested: { secret: "s", invoice_number: "INV-1" },
    });
    assert.deepEqual(clean, {
      email: "user@example.com",
      nested: { invoice_number: "INV-1" },
    });
  });

  test("non-scalar values are reduced to safe placeholders", () => {
    const clean = sanitizeMetadata({ rows: [{ a: 1 }, "ok", 3] });
    assert.deepEqual(clean, { rows: ["[object]", "ok", 3] });
  });

  test("undefined values are dropped", () => {
    assert.deepEqual(sanitizeMetadata({ a: undefined, b: 1 }), { b: 1 });
  });
});

// A recording stub mirroring the PostgREST builder subset these helpers touch.
function recordingQuery() {
  const calls: Array<[string, string, unknown]> = [];
  const q = {
    eq(column: string, value: unknown) {
      calls.push(["eq", column, value]);
      return q;
    },
    is(column: string, value: unknown) {
      calls.push(["is", column, value]);
      return q;
    },
    calls,
  };
  return q;
}

describe("company scope is fail-closed", () => {
  test("a tenant-less caller is scoped to IS NULL, never unfiltered", () => {
    const q = recordingQuery();
    scopeToCompany(q, context({ tenantId: null }));
    assert.deepEqual(q.calls, [["is", "company_id", null]]);
  });

  test("a tenanted caller is scoped to its own tenant", () => {
    const q = recordingQuery();
    scopeToCompany(q, context({ tenantId: TENANT_A }));
    assert.deepEqual(q.calls, [["eq", "company_id", TENANT_A]]);
  });

  test("only a super admin reads across tenants (no filter)", () => {
    const q = recordingQuery();
    scopeToCompany(q, context({ tenantId: null, isSuperAdmin: true }));
    assert.equal(q.calls.length, 0);
  });
});

describe("financial routes scope fail-closed (no unfiltered read for a tenant-less caller)", () => {
  // Regression guard: an earlier fix migrated kpis/health-score/ratios/
  // recommendations to `scopeToCompany` but left reports/calculate on a local
  // helper that returned the query unfiltered when the caller had no tenant,
  // which let an unresolved-tenant caller read every tenant's financial rows.
  const ROUTES = [
    "reports",
    "calculate",
    "kpis",
    "health-score",
    "ratios",
    "recommendations",
  ];

  for (const name of ROUTES) {
    const file = path.join(ROOT, "src/app/api/financial", name, "route.ts");
    const source = fs.readFileSync(file, "utf8");

    test(`${name}: uses the fail-closed scopeToCompany helper`, () => {
      assert.match(source, /scopeToCompany/, `${name} must use scopeToCompany`);
    });

    test(`${name}: never returns an unfiltered query for a tenant-less caller`, () => {
      // The exact fail-open shape that caused the leak: a falsy tenant check
      // that returns the query untouched instead of confining it.
      assert.doesNotMatch(
        source,
        /if\s*\(\s*!+\s*(?:context\.)?(tenantId|companyId)\s*\)\s*\{?\s*return\s+query/,
        `${name} still returns the query unfiltered when the tenant is missing`,
      );
    });
  }
});

describe("document numbering is idempotent-safe", () => {
  test("uses the row-locked RPC value when available", async () => {
    const client = { rpc: async () => ({ data: "REC-2026-0001", error: null }) };
    assert.equal(await nextDocumentNumber(client, "receipt", "REC"), "REC-2026-0001");
  });

  test("falls back without throwing when the sequence is unavailable", async () => {
    const client = { rpc: async () => ({ data: null, error: { message: "function not found" } }) };
    const value = await nextDocumentNumber(client, "receipt", "REC");
    assert.match(value, /^REC-\d{8}$/);
  });

  test("an empty RPC result also falls back", async () => {
    const client = { rpc: async () => ({ data: "", error: null }) };
    assert.match(await nextDocumentNumber(client, "receipt", "REC"), /^REC-\d{8}$/);
  });
});
