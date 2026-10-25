import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { capabilitiesFor, planGrants } from "../src/lib/saas/entitlements.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Execution 60, Section 5 — a declared capability must also be ENFORCED.
 *
 * Execution 59 introduced the package model (`entitlements.ts`) and gated the AI
 * routes on it. `exports` and `imports` were declared in the capability set but
 * nothing consulted them: `/api/import` checked only the module permission, so a
 * free tenant could import. A capability that is advertised in the plan matrix
 * and never checked is worse than one that does not exist - the operator sells a
 * limit the software does not apply.
 *
 * These tests fail if the import surface stops consulting the package, or if the
 * capability is trusted from the client.
 */

describe("Exec 60 — the import capability is enforced server-side", () => {
  const route = read("src/app/api/import/route.ts");

  test("the route consults the tenant's package", () => {
    assert.match(route, /loadTenantPlan/, "the import route must read the package");
    assert.match(route, /planGrants\(plan, "imports"\)/, "the imports capability must be checked");
  });

  test("both the template download and the commit are gated", () => {
    // Two guards: the GET (template / module list) and the POST (preview+commit).
    const guards = route.match(/planGrants\(plan, "imports"\)/g) ?? [];
    assert.ok(guards.length >= 3, `expected a guard in GET(modules), GET(template) and POST (found ${guards.length})`);
  });

  test("a refusal is a 403 plan_upgrade_required, not a silent empty result", () => {
    assert.match(route, /plan_upgrade_required/);
    assert.match(route, /status: 403/);
  });

  test("a super admin is not gated by a tenant package", () => {
    assert.match(route, /isSuperAdmin \? "enterprise"/, "the platform operator must not be blocked");
  });

  test("the module list reports the capability so the UI can hide the control", () => {
    assert.match(route, /importsAllowed/, "the UI needs to know whether import is available");
  });
});

describe("Exec 60 — capabilities are exposed for presentation, never trusted", () => {
  const me = read("src/app/api/me/route.ts");

  test("/api/me reports the plan and its capabilities", () => {
    assert.match(me, /capabilities: capabilitiesFor\(plan\)/);
    assert.match(me, /loadTenantPlan/);
  });

  test("the plan comes from the session's tenant, never the request", () => {
    assert.match(me, /loadTenantPlan\(supabaseAdmin as never, context\.tenantId\)/);
    assert.doesNotMatch(me, /searchParams\.get\("plan"\)/);
  });

  test("a super admin holds the top package", () => {
    assert.match(me, /context\.isSuperAdmin \? "enterprise"/);
  });
});

describe("Exec 60 — the capability matrix stays monotonic and closed", () => {
  test("free grants export but never import or AI", () => {
    const free = capabilitiesFor("free");
    assert.equal(free.exports, true, "a free tenant may always take its own data out");
    assert.equal(free.imports, false);
    assert.equal(free.aiAssistant, false);
  });

  test("enterprise grants everything the matrix declares", () => {
    const ent = capabilitiesFor("enterprise");
    for (const key of ["aiAssistant", "aiAgent", "aiFinancialWrites", "exports", "imports"] as const) {
      assert.equal(ent[key], true, `enterprise must grant ${key}`);
    }
  });

  test("an unknown package falls back to free, never to a paid grant", () => {
    const unknown = capabilitiesFor("not-a-plan");
    assert.deepEqual(unknown, capabilitiesFor("free"), "an unknown package must resolve to the free one");
    // The point of the fallback: nothing a paid package grants is leaked.
    for (const key of ["aiAssistant", "aiAgent", "aiFinancialWrites", "imports"] as const) {
      assert.equal(planGrants("not-a-plan", key), false, `${key} must be denied for an unknown plan`);
    }
    assert.equal(planGrants(undefined, "aiFinancialWrites"), false);
  });
});
