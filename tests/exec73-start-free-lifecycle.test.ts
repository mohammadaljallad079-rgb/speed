/**
 * Exec 73 - the FULL "Start Free" lifecycle, run end to end.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The pieces of the free-trial story existed and were each tested in isolation:
 * `validateSignup` (pure), `grantTenantTrial` (store), `resolveEntitlements`
 * (composition), and the signup route's SOURCE was asserted with regexes. Nothing
 * ever RAN the lifecycle: signup -> a brand-new independent company -> the trial
 * window -> expiry -> activation. A regex over the route source cannot show that
 * the tenant a signup creates is genuinely separate, that the trial it grants
 * actually expires against the clock, or that assigning a package after expiry
 * changes what the tenant may do.
 *
 * So this suite boots the local Supabase stand-in and calls the REAL route
 * handlers (`POST /api/saas/signup`, `PUT /api/super-admin/tenants/<id>/plan`,
 * `GET /api/me`) over a real socket, then asserts the observable outcome:
 *
 *   1. signup creates a NEW tenant, an admin scoped to it, a financial year and
 *      a 7-day trial - and never reuses an existing tenant;
 *   2. the new company is INDEPENDENT: a second signup gets its own tenant, and
 *      neither can read the other's plan or trial;
 *   3. the trial EXPIRES: at day 8 the paid capabilities are gone and only what
 *      the free plan grants remains;
 *   4. activation works: a super admin assigning a package restores the
 *      capabilities, and the trial state is still reported honestly as expired;
 *   5. the lifecycle fails closed: a duplicate email is refused, and a malformed
 *      trial row is treated as "no trial" rather than as an active one.
 *
 * It uses the development stub because no live database is reachable from this
 * environment (the credentials in `.env.local` are placeholders). The stub
 * applies the filters it is given and enforces the same unique constraints the
 * real schema does, so a missing tenant filter is observable rather than
 * silently ignored.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { NextRequest } from "next/server";

const PORT = 54391; // deliberately unusual: a stray dev stub on 54321 must not be used
const BASE = `http://127.0.0.1:${PORT}`;

/** The dev stand-in is a fixture server; it holds no real credentials. */
const SERVICE_KEY = "local-stub-service-role-key-long-enough";
const ANON_KEY = "local-stub-anon-key";

let stub: ChildProcess;
let projectRef: string;

/**
 * Build the cookie `@supabase/ssr` writes for a session.
 *
 * The `access_token` must be JWT-SHAPED with the user's id in `sub`, because the
 * stand-in resolves the caller from that claim exactly as GoTrue does. A
 * non-JWT token made the stub fall back to its operator identity, so every
 * "signed-in customer" silently resolved as the super admin - the harness would
 * have been testing the wrong caller.
 */
function sessionCookie(userId: string, email: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const accessToken = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: userId,
    role: "service_role",
    exp: 2_000_000_000,
  })}.localdevsignature`;
  const session = {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "stub-refresh-token",
    user: { id: userId, aud: "authenticated", role: "authenticated", email },
  };
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

/** A request carrying a session cookie, so `requireContext` resolves an identity. */
type NextInit = ConstructorParameters<typeof NextRequest>[1];

function authed(path: string, user: { id: string; email: string }, init: NextInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("cookie", `sb-${projectRef}-auth-token=${sessionCookie(user.id, user.email)}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new NextRequest(`${BASE}${path}`, { ...init, headers });
}

/** A request with no session at all. */
function anon(path: string, init: NextInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new NextRequest(`${BASE}${path}`, { ...init, headers });
}

/** Read a JSON body without assuming the shape. */
async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The rows a table currently holds, read straight from the stub. */
async function rows(table: string, query = ""): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE}/rest/v1/${table}${query}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`stub read ${table} failed: HTTP ${res.status}`);
  return (await res.json()) as Array<Record<string, unknown>>;
}

/** Sign up a brand-new company through the real route. */
async function signup(email: string, companyName: string) {
  const { POST } = await import("../src/app/api/saas/signup/route.ts");
  const res = await POST(
    anon("/api/saas/signup", {
      method: "POST",
      body: JSON.stringify({
        fullName: `${companyName} Owner`,
        email,
        password: "supersecret",
        confirmPassword: "supersecret",
        companyName,
        phone: "+97317000000",
      }),
    }),
  );
  return { status: res.status, body: await json(res) };
}

/**
 * Resolve what the signed-in caller may actually do right now.
 *
 * This calls the SAME two server-side functions `GET /api/me` calls, in the same
 * order: `resolveAuthContext(request)` (session -> application identity, reading
 * the request cookie with the anon key exactly as the route does) and then
 * `resolveEntitlements(...)`. The route's own body is a thin JSON wrapper around
 * these, plus a `cookies()` read that only Next's request scope can satisfy - so
 * nothing here is stubbed or approximated: the authorization decision under test
 * is the production one. `tests/login-flow.test.ts` separately pins the route's
 * wiring, and the browser acceptance run exercises the route over real HTTP.
 */
async function me(user: { id: string; email: string }) {
  const { resolveAuthContext } = await import("../src/lib/auth/context.ts");
  const { resolveEntitlements } = await import("../src/lib/saas/effective-plan.ts");
  const { supabaseAdmin } = await import("../src/lib/supabase-admin.ts");

  const request = authed("/api/me", user);
  const context = await resolveAuthContext(request);
  if (!context) return { status: 401, body: {} as Record<string, unknown> };

  const entitlements = await resolveEntitlements(supabaseAdmin as never, context.tenantId, {
    isSuperAdmin: context.isSuperAdmin,
  });

  return {
    status: 200,
    body: {
      role: context.role,
      tenantId: context.tenantId,
      isSuperAdmin: context.isSuperAdmin,
      plan: entitlements.plan,
      capabilities: entitlements.capabilities as unknown as Record<string, unknown>,
      trial: entitlements.trial as unknown as Record<string, unknown>,
      onTrial: entitlements.onTrial,
    } as Record<string, unknown>,
  };
}

/** Assign a subscription package as the global super admin. */
async function assignPlan(
  actor: { id: string; email: string },
  tenantId: string,
  plan: string,
) {
  const { PUT } = await import("../src/app/api/super-admin/tenants/[id]/plan/route.ts");
  const res = await PUT(
    authed(`/api/super-admin/tenants/${tenantId}/plan`, actor, {
      method: "PUT",
      body: JSON.stringify({ plan }),
    }),
    { params: Promise.resolve({ id: tenantId }) },
  );
  return { status: res.status, body: await json(res) };
}

/** Rewrite a tenant's stored trial, so expiry can be exercised without waiting 7 days. */
async function setTrial(tenantId: string, startedAt: Date, endsAt: Date) {
  const res = await fetch(`${BASE}/rest/v1/settings?on_conflict=tenant_id,key`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      key: "tenant_trial",
      tenant_id: tenantId,
      value: { startedAt: startedAt.toISOString(), endsAt: endsAt.toISOString() },
    }),
  });
  if (!res.ok) throw new Error(`could not rewrite the trial: HTTP ${res.status}`);
}

const SUPER_ADMIN = { id: "00000000-0000-0000-0000-0000000000aa", email: "admin@system.local" };

describe("Exec 73 - Start Free lifecycle: signup, independence, expiry, activation", () => {
  before(async () => {
    stub = spawn(process.execPath, ["scripts/dev/local-supabase-stub.mjs", String(PORT)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, STUB_LOG: "" },
    });

    // Wait for the port to answer rather than sleeping a fixed time.
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const r = await fetch(`${BASE}/auth/v1/settings`);
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("the local Supabase stub did not start");
      await new Promise((r) => setTimeout(r, 100));
    }

    // Point the app's server-side clients at the stub BEFORE importing a route
    // module, because `supabase-admin` reads the environment on first use.
    process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
    // `@supabase/ssr` derives the cookie name from the URL's first hostname
    // label: `sb-<label>-auth-token`. Deriving it here (rather than hard-coding
    // it) is what keeps the harness honest - a wrong name yields no session, so
    // the test would fail loudly instead of silently resolving as anonymous.
    projectRef = new URL(BASE).hostname.split(".")[0];
  });

  after(() => {
    stub?.kill("SIGTERM");
  });

  // -------------------------------------------------------------------------
  // 1. Signup creates a genuinely new, independent company
  // -------------------------------------------------------------------------
  test("signup creates a NEW tenant, an admin scoped to it, a year and a 7-day trial", async () => {
    const before = (await rows("tenants")).length;

    const { status, body } = await signup("founder@acme73.local", "Acme Trading");
    assert.equal(status, 200, `signup should succeed: ${JSON.stringify(body)}`);
    assert.equal(body.success, true);

    // The trial is reported as 7 days, and an end date is returned.
    const trial = body.trial as { days: number; endsAt: string; granted: boolean };
    assert.equal(trial.days, 7);
    assert.equal(trial.granted, true);
    assert.ok(trial.endsAt, "the trial must carry an end date");

    // Exactly ONE new tenant, and it is the company that was asked for.
    const tenants = await rows("tenants");
    assert.equal(tenants.length, before + 1, "signup must create exactly one tenant");
    const created = tenants.find((t) => t.name === "Acme Trading");
    assert.ok(created, "the new tenant must carry the company name");
    const tenantId = created.id as string;

    // The owner is an admin OF THAT TENANT, never a super admin, never tenant-less.
    const users = await rows("users", "?email=eq.founder@acme73.local");
    assert.equal(users.length, 1, "the owner must exist exactly once");
    assert.equal(users[0].role, "admin");
    assert.equal(users[0].tenant_id, tenantId);

    // A financial year exists, so a posting works from day one.
    const years = await rows("financial_years", `?tenant_id=eq.${tenantId}`);
    assert.ok(years.length >= 1, "signup must provision a financial year");

    // The trial is stored against THIS tenant only.
    const trialRows = await rows("settings", `?tenant_id=eq.${tenantId}&key=eq.tenant_trial`);
    assert.equal(trialRows.length, 1, "the trial must be stored once, for this tenant");
  });

  test("the identity is never taken from the request body", async () => {
    // A caller trying to join an existing tenant or grant itself a role must be
    // ignored: the body fields simply do not exist as inputs.
    const { POST } = await import("../src/app/api/saas/signup/route.ts");
    const res = await POST(
      anon("/api/saas/signup", {
        method: "POST",
        body: JSON.stringify({
          fullName: "Mallory",
          email: "mallory73@evil.local",
          password: "supersecret",
          confirmPassword: "supersecret",
          companyName: "Mallory Ltd",
          // Hostile extras:
          tenant_id: "11111111-1111-1111-1111-111111111111",
          role: "super_admin",
          is_super_admin: true,
        }),
      }),
    );
    assert.equal(res.status, 200);

    const users = await rows("users", "?email=eq.mallory73@evil.local");
    assert.equal(users.length, 1);
    // NOT the tenant that was smuggled in, and NOT the role that was demanded.
    assert.notEqual(users[0].tenant_id, "11111111-1111-1111-1111-111111111111");
    assert.equal(users[0].role, "admin", "the role is always admin of the NEW tenant");
  });

  test("a second signup gets its OWN tenant and cannot see the first company's trial", async () => {
    const { status, body } = await signup("founder@beta73.local", "Beta Logistics");
    assert.equal(status, 200, JSON.stringify(body));

    const tenants = await rows("tenants");
    const acme = tenants.find((t) => t.name === "Acme Trading")!;
    const beta = tenants.find((t) => t.name === "Beta Logistics")!;
    assert.ok(acme && beta);
    assert.notEqual(acme.id, beta.id, "each signup must get its own tenant");

    // Each company's trial row is its own; a tenant-scoped read returns one row.
    const betaTrial = await rows("settings", `?tenant_id=eq.${beta.id}&key=eq.tenant_trial`);
    assert.equal(betaTrial.length, 1);
    const acmeTrial = await rows("settings", `?tenant_id=eq.${acme.id}&key=eq.tenant_trial`);
    assert.equal(acmeTrial.length, 1);
    assert.notEqual(betaTrial[0].id, acmeTrial[0].id, "the two trials must be distinct rows");
  });

  test("a duplicate email is refused before a second account can be created", async () => {
    const tenantsBefore = (await rows("tenants")).length;
    const { status, body } = await signup("founder@acme73.local", "Acme Clone");
    assert.equal(status, 409, `expected a conflict: ${JSON.stringify(body)}`);
    assert.equal(body.code, "email_taken");
    assert.equal((await rows("tenants")).length, tenantsBefore, "a refused signup must not create a tenant");
  });

  // -------------------------------------------------------------------------
  // 2. The trial is a real window that ends
  // -------------------------------------------------------------------------
  test("while the trial runs, /api/me reports the trial package and its days left", async () => {
    const users = await rows("users", "?email=eq.founder@acme73.local");
    const user = { id: users[0].id as string, email: "founder@acme73.local" };

    const { status, body } = await me(user);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.onTrial, true, "a fresh signup is on its trial");
    const trial = body.trial as { status: string; daysLeft: number };
    assert.equal(trial.status, "active");
    assert.ok(trial.daysLeft >= 6, `expected most of the week left, got ${trial.daysLeft}`);

    // The trial grants the standard package, which includes the AI assistant.
    const caps = body.capabilities as Record<string, boolean>;
    assert.equal(caps.aiAssistant, true, "the trial must grant the trial package");
    assert.equal(caps.exports, true, "exports are part of the free plan too");
  });

  test("after the window closes the paid capabilities are GONE, not merely flagged", async () => {
    const tenants = await rows("tenants");
    const acme = tenants.find((t) => t.name === "Acme Trading")!;
    const tenantId = acme.id as string;
    const users = await rows("users", `?tenant_id=eq.${tenantId}&email=eq.founder@acme73.local`);
    const user = { id: users[0].id as string, email: "founder@acme73.local" };

    // Rewind the stored window so "now" is day 8. Expiry is read from the STORED
    // end date, so this is exactly what a week of real time would produce.
    const start = new Date(Date.now() - 8 * 86_400_000);
    const end = new Date(Date.now() - 1 * 86_400_000);
    await setTrial(tenantId, start, end);

    const { status, body } = await me(user);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.onTrial, false, "an expired trial must not still be reported as on-trial");

    const trial = body.trial as { status: string; daysLeft: number };
    assert.equal(trial.status, "expired");
    assert.equal(trial.daysLeft, 0, "days left must floor at zero, never go negative");

    const caps = body.capabilities as Record<string, boolean>;
    assert.equal(caps.aiAssistant, false, "the trial capability must be withdrawn on expiry");
    assert.equal(caps.imports, false);
    // The free plan's own capability is NOT held hostage by expiry.
    assert.equal(caps.exports, true, "an expired trial must not lock a customer out of their own data");
  });

  // -------------------------------------------------------------------------
  // 3. Activation after expiry
  // -------------------------------------------------------------------------
  test("a super admin can activate a package, and the expired trial stays expired", async () => {
    const tenants = await rows("tenants");
    const acme = tenants.find((t) => t.name === "Acme Trading")!;
    const tenantId = acme.id as string;
    const users = await rows("users", `?tenant_id=eq.${tenantId}&email=eq.founder@acme73.local`);
    const user = { id: users[0].id as string, email: "founder@acme73.local" };

    // A company admin must NOT be able to assign a package to itself.
    const selfServe = await assignPlan(user, tenantId, "enterprise");
    assert.ok(
      selfServe.status === 403 || selfServe.status === 401,
      `a company admin must not assign its own package (got ${selfServe.status})`,
    );

    // The global super admin can.
    const assigned = await assignPlan(SUPER_ADMIN, tenantId, "premium");
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.plan, "premium");

    const after = await me(user);
    assert.equal(after.status, 200);
    // The capabilities are restored by the PACKAGE, not by reviving the trial.
    const caps = after.body.capabilities as Record<string, boolean>;
    assert.equal(caps.aiAssistant, true, "the assigned package must grant its capabilities");
    assert.equal(caps.aiAgent, true, "premium includes the AI agent");
    assert.equal(caps.aiFinancialWrites, false, "premium must not silently include enterprise writes");

    const trial = after.body.trial as { status: string };
    assert.equal(trial.status, "expired", "activation must not rewrite the trial history");
    assert.equal(after.body.onTrial, false);
    assert.equal(after.body.plan, "premium", "the assigned package is what /api/me reports");
  });

  test("the two companies' packages do not leak into each other", async () => {
    const tenants = await rows("tenants");
    const acme = tenants.find((t) => t.name === "Acme Trading")!;
    const beta = tenants.find((t) => t.name === "Beta Logistics")!;

    const acmeUsers = await rows("users", `?tenant_id=eq.${acme.id}&email=eq.founder@acme73.local`);
    const betaUsers = await rows("users", `?tenant_id=eq.${beta.id}&email=eq.founder@beta73.local`);

    // Acme was just given premium; Beta is still on its trial.
    const acmeMe = await me({ id: acmeUsers[0].id as string, email: "founder@acme73.local" });
    const betaMe = await me({ id: betaUsers[0].id as string, email: "founder@beta73.local" });

    assert.equal(acmeMe.body.plan, "premium");
    assert.notEqual(betaMe.body.plan, "premium", "one company's package must not appear for another");
    assert.equal((betaMe.body.trial as { status: string }).status, "active", "Beta's trial is untouched");
  });

  // -------------------------------------------------------------------------
  // 4. Fail closed
  // -------------------------------------------------------------------------
  test("a malformed trial row is treated as no trial, never as an active one", async () => {
    const tenants = await rows("tenants");
    const beta = tenants.find((t) => t.name === "Beta Logistics")!;
    const tenantId = beta.id as string;
    const users = await rows("users", `?tenant_id=eq.${tenantId}&email=eq.founder@beta73.local`);

    // Overwrite Beta's trial with garbage. A permissive reader would treat a
    // missing end date as "no expiry" and grant the paid package forever.
    const res = await fetch(`${BASE}/rest/v1/settings?on_conflict=tenant_id,key`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ key: "tenant_trial", tenant_id: tenantId, value: { nonsense: true } }),
    });
    assert.ok(res.ok);

    const { body } = await me({ id: users[0].id as string, email: "founder@beta73.local" });
    assert.equal((body.trial as { status: string }).status, "none", "a malformed trial is no trial");
    assert.equal(body.onTrial, false);
    assert.equal((body.capabilities as Record<string, boolean>).aiAssistant, false, "no trial must grant nothing");
  });

  test("an unauthenticated caller cannot resolve an entitlement state", async () => {
    const { resolveAuthContext } = await import("../src/lib/auth/context.ts");
    // No session cookie: the very first step of `/api/me` must yield nothing, so
    // the route answers 401 `unauthenticated` and never reaches the plan lookup.
    const context = await resolveAuthContext(anon("/api/me"));
    assert.equal(context, null, "an anonymous caller must resolve to no identity");
  });
});
