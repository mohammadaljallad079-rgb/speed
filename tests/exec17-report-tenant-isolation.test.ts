import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  resolveReportScope,
  applyReportScope,
  isReportScopeAllowed,
} from "../src/lib/auth/scope.ts";

/**
 * Execution 17 - financial report tenant isolation.
 *
 * The four report pages (profit-loss, balance-sheet, trial-balance, cash-flow)
 * are client components that query Supabase directly. Before this execution they
 * read `journal_entries` / `journal_lines` with NO tenant filter, so a caller in
 * one tenant could sum another tenant's ledger into their report. The decision
 * of which tenant to read is made server-side (`/api/me`); these tests pin the
 * pure decision rules and assert the pages wire them in.
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const REPORTS = [
  "src/app/reports/profit-loss/page.tsx",
  "src/app/reports/balance-sheet/page.tsx",
  "src/app/reports/trial-balance/page.tsx",
  "src/app/reports/cash-flow/page.tsx",
];

/** Minimal recording stub that captures the filters a query builder receives. */
function recordingQuery() {
  const calls: Array<[string, unknown]> = [];
  const builder = {
    eq(column: string, value: unknown) {
      calls.push(["eq", [column, value]]);
      return builder;
    },
    is(column: string, value: unknown) {
      calls.push(["is", [column, value]]);
      return builder;
    },
    _calls: calls,
  };
  return builder;
}

describe("resolveReportScope - fail-closed decision rules", () => {
  test("no identity (no session / not provisioned) is denied", () => {
    assert.deepEqual(resolveReportScope(null), {
      kind: "denied",
      reason: "unauthenticated",
    });
  });

  test("super admin is the only cross-tenant reader", () => {
    assert.deepEqual(
      resolveReportScope({ role: "admin", tenantId: "t1", isSuperAdmin: true }),
      { kind: "all" },
    );
    assert.deepEqual(
      resolveReportScope({ role: "super_admin", tenantId: null, isSuperAdmin: true }),
      { kind: "all" },
    );
  });

  test("company admin with a tenant is scoped to exactly that tenant", () => {
    assert.deepEqual(
      resolveReportScope({ role: "admin", tenantId: "tenant-a" }),
      { kind: "tenant", tenantId: "tenant-a" },
    );
  });

  test("admin/staff without a tenant is scoped to the NULL (single-tenant) rows, never every tenant", () => {
    assert.deepEqual(resolveReportScope({ role: "admin", tenantId: null }), { kind: "null" });
    assert.deepEqual(resolveReportScope({ role: "staff", tenantId: "" }), { kind: "null" });
  });

  test("client and unknown roles are denied, even with a tenant", () => {
    assert.deepEqual(resolveReportScope({ role: "client", tenantId: "t1" }), {
      kind: "denied",
      reason: "forbidden_role",
    });
    assert.deepEqual(resolveReportScope({ role: "guest", tenantId: "t1" }), {
      kind: "denied",
      reason: "forbidden_role",
    });
  });

  test("a browser-supplied tenant is ignored unless the server already decided the role", () => {
    // A forged body would arrive as `role: undefined`; it can never widen scope.
    assert.deepEqual(resolveReportScope({ tenantId: "attacker-tenant" }), {
      kind: "denied",
      reason: "forbidden_role",
    });
  });

  test("isReportScopeAllowed is true for every non-denied scope", () => {
    assert.equal(isReportScopeAllowed({ kind: "all" }), true);
    assert.equal(isReportScopeAllowed({ kind: "tenant", tenantId: "t" }), true);
    assert.equal(isReportScopeAllowed({ kind: "null" }), true);
    assert.equal(
      isReportScopeAllowed({ kind: "denied", reason: "unauthenticated" }),
      false,
    );
  });
});

describe("applyReportScope - query filters", () => {
  test("super admin leaves the query unfiltered", () => {
    const q = recordingQuery();
    assert.equal(applyReportScope(q, { kind: "all" }), q);
    assert.equal(q._calls.length, 0);
  });

  test("tenant scope filters by tenant_id = the caller's tenant", () => {
    const q = recordingQuery();
    applyReportScope(q, { kind: "tenant", tenantId: "tenant-a" });
    assert.deepEqual(q._calls, [["eq", ["tenant_id", "tenant-a"]]]);
  });

  test("null scope filters by tenant_id IS NULL", () => {
    const q = recordingQuery();
    applyReportScope(q, { kind: "null" });
    assert.deepEqual(q._calls, [["is", ["tenant_id", null]]]);
  });

  test("a denied scope fails closed to a non-existent tenant, never unfiltered", () => {
    const q = recordingQuery();
    applyReportScope(q, { kind: "denied", reason: "unauthenticated" });
    assert.equal(q._calls.length, 1);
    const [method, args] = q._calls[0] as [string, unknown[]];
    assert.equal(method, "eq");
    assert.equal(args[0], "tenant_id");
    assert.notEqual(args[1], null);
    assert.match(String(args[1]), /^0{8}-0{4}-0{4}-0{4}-0{12}$/);
  });
});

describe("report pages wire in server-resolved, fail-closed scoping", () => {
  for (const p of REPORTS) {
    test(`${p} resolves scope server-side and applies it to journal reads`, () => {
      const src = read(p);
      assert.match(src, /useReportScope\(\)/, "must resolve scope via the shared hook");
      assert.match(src, /applyReportScope\(/, "journal queries must be scoped");
      assert.match(
        src,
        /scopeState\.status !== 'ready'/,
        "must not query before the scope is resolved",
      );
      // Every journal_entries read must go through applyReportScope.
      const unscopedJournalReads = src.match(
        /await supabase\s*\n?\s*\.from\('journal_entries'\)/g,
      );
      assert.equal(
        unscopedJournalReads,
        null,
        "no raw (unscoped) journal_entries read may remain",
      );
    });

    test(`${p} never reads a tenant id from the URL or a form field`, () => {
      const src = read(p);
      assert.doesNotMatch(src, /useSearchParams/, "report must not read tenant from the URL");
      assert.doesNotMatch(
        src,
        /searchParams\.get\(['"](tenant|tenant_id|company|company_id)['"]\)/,
        "tenant must never come from a query parameter",
      );
    });
  }
});
