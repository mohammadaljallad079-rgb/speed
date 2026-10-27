/**
 * Exec 72 - "Start Free" trial flow.
 *
 * The brief's item 2: a visitor can start a free trial, and the trial is a real,
 * server-enforced window rather than marketing copy. Before this execution the
 * repository had signup, onboarding, a tenant plan and capability sets, but NO
 * trial at all: nothing stored an end date and nothing expired, so any
 * "trial" would have been open-ended.
 *
 * These tests pin the policy (pure) and the composition (plan x trial), and they
 * guard the route wiring so a future change cannot quietly drop the grant or the
 * expiry check.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  TENANT_TRIAL_KEY,
  TRIAL_DAYS,
  isTrialActive,
  readTrial,
  trialAllowsPaidCapability,
  trialState,
  trialWindow,
} from "../src/lib/saas/trial.ts";
import {
  grantTenantTrial,
  loadTenantTrial,
  loadTrialState,
} from "../src/lib/saas/trial-store.ts";
import { effectivePlanId, resolveEntitlements } from "../src/lib/saas/effective-plan.ts";

const ROOT = new URL("..", import.meta.url).pathname;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const START = new Date("2026-01-01T00:00:00.000Z");
const day = (n: number) => new Date(START.getTime() + n * 86_400_000);

/**
 * A PostgREST-like recording stub. It applies the filters it is given and returns
 * only the matching rows, so a missing tenant filter is observable rather than
 * silently ignored - the same discipline the other service tests use.
 */
function stubDb(rows: Array<Record<string, unknown>> = []) {
  const store = [...rows];
  const calls: Array<{ op: string; table: string; filters: Record<string, unknown>; row?: unknown }> = [];
  return {
    store,
    calls,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let op = "select";
      const builder = {
        select() {
          op = "select";
          return builder;
        },
        eq(column: string, value: string) {
          filters[column] = value;
          return builder;
        },
        is(column: string, value: null) {
          filters[column] = value;
          return builder;
        },
        maybeSingle() {
          calls.push({ op, table, filters });
          const match = store.find((r) =>
            Object.entries(filters).every(([k, v]) => (r[k] ?? null) === v),
          );
          return Promise.resolve({ data: match ?? null, error: null });
        },
        upsert(row: Record<string, unknown>) {
          calls.push({ op: "upsert", table, filters, row });
          const key = row.key;
          const tenant = row.tenant_id ?? null;
          const existing = store.find((r) => r.key === key && (r.tenant_id ?? null) === tenant);
          if (existing) Object.assign(existing, row);
          else store.push({ ...row });
          return Promise.resolve({ error: null });
        },
      };
      return builder as never;
    },
  };
}

test("the trial window is exactly TRIAL_DAYS long", () => {
  const w = trialWindow(START);
  assert.equal(w.startedAt, START.toISOString());
  assert.equal(w.endsAt, day(TRIAL_DAYS).toISOString());
  assert.equal(TRIAL_DAYS, 7);
});

test("a fresh trial is active with the full window left", () => {
  const state = trialState(trialWindow(START), START);
  assert.equal(state.status, "active");
  assert.equal(state.daysLeft, TRIAL_DAYS);
  assert.equal(isTrialActive(trialWindow(START), START), true);
});

test("the trial expires at the boundary, exclusively", () => {
  const w = trialWindow(START);
  // One millisecond before the end: still active.
  assert.equal(trialState(w, new Date(day(TRIAL_DAYS).getTime() - 1)).status, "active");
  // Exactly at the end and after: expired. A clock behind the server cannot
  // buy an extra request.
  assert.equal(trialState(w, day(TRIAL_DAYS)).status, "expired");
  assert.equal(trialState(w, day(TRIAL_DAYS + 1)).status, "expired");
  assert.equal(isTrialActive(w, day(TRIAL_DAYS + 1)), false);
});

test("an expired trial reports zero days left, never negative", () => {
  const state = trialState(trialWindow(START), day(TRIAL_DAYS + 30));
  assert.equal(state.status, "expired");
  assert.equal(state.daysLeft, 0);
});

test("no trial record means no trial (fail closed)", () => {
  assert.deepEqual(trialState(null), { status: "none", daysLeft: null, endsAt: null });
  assert.equal(isTrialActive(null), false);
  assert.equal(trialAllowsPaidCapability(null, false), false);
});

test("a malformed trial record is treated as no trial, not an active one", () => {
  assert.equal(readTrial(null), null);
  assert.equal(readTrial({}), null);
  assert.equal(readTrial({ startedAt: "not-a-date", endsAt: "also-not" }), null);
  assert.equal(readTrial({ endsAt: day(3).toISOString() }), null, "a missing start is malformed");
  assert.equal(trialState(readTrial({ endsAt: "nope" })).status, "none");
});

test("a capability the free plan grants is not held hostage by trial expiry", () => {
  const expired = trialWindow(START);
  // exports: free grants them, so they survive expiry.
  assert.equal(trialAllowsPaidCapability(expired, true, day(TRIAL_DAYS + 1)), true);
  // imports: free does not, so they end with the trial.
  assert.equal(trialAllowsPaidCapability(expired, false, day(TRIAL_DAYS + 1)), false);
  assert.equal(trialAllowsPaidCapability(expired, false, START), true);
});

test("the trial is stored per tenant under its own settings key", async () => {
  const db = stubDb();
  const granted = await grantTenantTrial(db, "tenant-a", { now: START });
  assert.equal(granted.ok, true);
  // The grant first reads the existing trial (the idempotency guard), then writes.
  const upsert = db.calls.find((c) => c.op === "upsert");
  assert.ok(upsert, "the trial is written");
  assert.equal(upsert.table, "settings");
  assert.equal((upsert.row as Record<string, unknown>).key, TENANT_TRIAL_KEY);
  assert.equal((upsert.row as Record<string, unknown>).tenant_id, "tenant-a");

  const loaded = await loadTenantTrial(db, "tenant-a");
  assert.equal(loaded?.endsAt, day(TRIAL_DAYS).toISOString());
});

test("reading a trial scopes by tenant, so one tenant cannot see another's", async () => {
  const db = stubDb([
    { key: TENANT_TRIAL_KEY, tenant_id: "tenant-a", value: trialWindow(START) },
  ]);
  const loaded = await loadTenantTrial(db, "tenant-a");
  assert.ok(loaded, "the owning tenant reads its trial");
  // The filter the store applied must include tenant_id; a bare `key` filter
  // would let the second tenant read the first tenant's trial.
  assert.equal(db.calls[0].filters.tenant_id, "tenant-a");

  const other = await loadTenantTrial(db, "tenant-b");
  assert.equal(other, null, "another tenant does not see it");
});

test("a tenant-less install reads the null-tenant trial, not every trial", async () => {
  const db = stubDb([
    { key: TENANT_TRIAL_KEY, tenant_id: null, value: trialWindow(START) },
    { key: TENANT_TRIAL_KEY, tenant_id: "tenant-a", value: trialWindow(START) },
  ]);
  await loadTenantTrial(db, null);
  assert.equal(db.calls[0].filters.tenant_id, null);
});

test("granting a trial twice does not extend it (idempotent by default)", async () => {
  const db = stubDb();
  await grantTenantTrial(db, "tenant-a", { now: START });
  const first = await loadTenantTrial(db, "tenant-a");
  const second = await grantTenantTrial(db, "tenant-a", { now: day(5) });
  assert.equal(second.record?.endsAt, first?.endsAt, "the original end date stands");
  assert.equal(db.store.length, 1, "no second row");
});

test("an explicit restart DOES extend the trial (operator action)", async () => {
  const db = stubDb();
  await grantTenantTrial(db, "tenant-a", { now: START });
  const restarted = await grantTenantTrial(db, "tenant-a", { now: day(5), restart: true });
  assert.equal(restarted.record?.endsAt, day(5 + TRIAL_DAYS).toISOString());
});

test("a store failure is reported, never swallowed into a fake grant", async () => {
  const failing = {
    from: () => ({
      select: () => ({ eq: () => ({ is: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
      upsert: () => Promise.resolve({ error: { message: "permission denied" } }),
    }),
  };
  const result = await grantTenantTrial(failing as never, "tenant-a", { now: START });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /permission denied/);
});

test("entitlements: an active trial grants the trial package", async () => {
  const db = stubDb([
    { key: TENANT_TRIAL_KEY, tenant_id: "tenant-a", value: trialWindow(START) },
  ]);
  const e = await resolveEntitlements(db, "tenant-a", { now: START });
  assert.equal(e.onTrial, true);
  assert.equal(e.plan, "free", "the assigned package is still reported");
  assert.equal(e.capabilities.imports, true, "the trial grants what free does not");
  assert.equal(effectivePlanId(e), "standard");
});

test("entitlements: an expired trial falls back to the assigned package", async () => {
  const db = stubDb([
    { key: TENANT_TRIAL_KEY, tenant_id: "tenant-a", value: trialWindow(START) },
  ]);
  const e = await resolveEntitlements(db, "tenant-a", { now: day(TRIAL_DAYS + 1) });
  assert.equal(e.onTrial, false);
  assert.equal(e.trial.status, "expired");
  assert.equal(e.capabilities.imports, false, "the paid capability ended");
  assert.equal(e.capabilities.exports, true, "the free capability remains");
  assert.equal(effectivePlanId(e), "free");
});

test("entitlements: a tenant with no trial row gets its assigned package", async () => {
  const db = stubDb();
  const e = await resolveEntitlements(db, "tenant-a", { now: START });
  assert.equal(e.trial.status, "none");
  assert.equal(e.onTrial, false);
  assert.equal(e.capabilities.exports, true);
});

test("entitlements: a global super admin is never gated", async () => {
  const db = stubDb();
  const e = await resolveEntitlements(db, null, { isSuperAdmin: true, now: START });
  assert.equal(e.plan, "enterprise");
  assert.equal(e.capabilities.aiFinancialWrites, true);
  assert.equal(e.onTrial, false);
});

test("loadTrialState resolves the stored end date against the clock", async () => {
  const db = stubDb([
    { key: TENANT_TRIAL_KEY, tenant_id: "tenant-a", value: trialWindow(START) },
  ]);
  assert.equal((await loadTrialState(db, "tenant-a", START)).status, "active");
  assert.equal((await loadTrialState(db, "tenant-a", day(TRIAL_DAYS))).status, "expired");
});

// --- route wiring ------------------------------------------------------------

test("signup grants the trial, at provisioning time, without restarting it", () => {
  const src = read("src/app/api/saas/signup/route.ts");
  assert.match(src, /grantTenantTrial\(/);
  assert.match(src, /restart:\s*false/, "a retried signup must not extend the trial");
  assert.match(src, /TRIAL_DAYS/);
  // The window starts when the account is created, not on first sign-in.
  assert.match(src, /trial_ends_at/);
});

test("signup never returns an internal identifier alongside the trial", () => {
  const src = read("src/app/api/saas/signup/route.ts");
  const response = src.slice(src.indexOf("return NextResponse.json({\n    success: true"));
  assert.ok(!/tenantId|tenant_id\s*[,:]/.test(response), "no tenant id in the response");
  assert.match(response, /trial:/);
});

test("/api/me reports the trial state and the in-force capabilities", () => {
  const src = read("src/app/api/me/route.ts");
  assert.match(src, /resolveEntitlements\(/);
  assert.match(src, /trial:\s*entitlements\.trial/);
  assert.match(src, /onTrial:\s*entitlements\.onTrial/);
  // The old shape read the package alone, which could never expire.
  assert.ok(!/loadTenantPlan/.test(src), "/api/me must not bypass the trial");
});

test("the capability routes resolve entitlements instead of the bare package", () => {
  for (const route of ["src/app/api/import/route.ts", "src/app/api/ai/repairs/route.ts"]) {
    const src = read(route);
    assert.match(src, /resolveEntitlements\(/, `${route} must resolve the trial`);
    assert.ok(!/loadTenantPlan/.test(src), `${route} must not read the package alone`);
  }
});

test("the trial length is never hardcoded in the signup UI", () => {
  const src = read("src/app/signup/page.tsx");
  assert.match(src, /payload\?\.trial\?\.days/, "the copy uses the server's value");
  assert.match(src, /setTrialDays/);
});
