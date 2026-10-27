/**
 * Exec 73 - the customer "Book Now" path, at the route level.
 *
 * WHY THIS EXISTS
 * ---------------
 * Driving the flow in a real browser (scripts/dev/e2e-exec73-book-now.mjs)
 * found that EVERY booking failed. `POST /api/customer/bookings` was never even
 * reached: the dashboard first persists the customer's identity documents with
 * `PUT /api/customer/profile`, that route was gated on the ERP permission
 * `customers.edit`, and `DEFAULT_ROLE_PERMISSIONS.client` is empty by design -
 * so the only role the route exists for could never pass. The dashboard treats a
 * failed profile write as fatal and returned before creating the booking.
 *
 * The browser run proves the fix end-to-end, but it needs a dev server. These
 * tests pin the same contract at the route level, so a regression fails in
 * `npm test` without one.
 *
 * The routes under test are the REAL handlers. They are driven against the same
 * local HTTP stand-in the other Exec 73 tests use; nothing about the
 * authorisation decision is mocked.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { NextRequest } from "next/server";

const PORT = 54395;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVICE_KEY = "local-service-key";

/** The rental customer the stand-in exposes, linked to customer `c1`. */
const CUSTOMER = { id: "cccccccc-1111-1111-1111-111111111111", email: "customer@speed.local" };
/** An ERP administrator, to prove the ERP role cannot use the customer route. */
const ADMIN = { id: "aaaaaaaa-1111-1111-1111-111111111111", email: "speedadmin@speed.local" };

let stub: ChildProcess;
let projectRef = "";

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

type NextInit = ConstructorParameters<typeof NextRequest>[1];

function authed(path: string, user: { id: string; email: string }, init: NextInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  headers.set("cookie", `sb-${projectRef}-auth-token=${sessionCookie(user.id, user.email)}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new NextRequest(`${BASE}${path}`, { ...init, headers });
}

function anon(path: string, init: NextInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new NextRequest(`${BASE}${path}`, { ...init, headers });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function rows(table: string, query = ""): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE}/rest/v1/${table}${query}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`stub read ${table} failed: HTTP ${res.status}`);
  return (await res.json()) as Array<Record<string, unknown>>;
}

async function startStub(): Promise<void> {
  stub = spawn(process.execPath, ["scripts/dev/local-supabase-stub.mjs", String(PORT)], {
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/auth/v1/settings`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "local-stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-stub-service-role-key-long-enough";
  // `@supabase/ssr` names the cookie after the URL's first hostname label.
  projectRef = new URL(BASE).hostname.split(".")[0];
}

before(async () => {
  await startStub();
});

after(() => {
  stub?.kill();
});

describe("Exec 73 - a customer can complete a booking", () => {
  test("the customer profile route is reachable by the role it exists for", async () => {
    const { PUT } = await import("../src/app/api/customer/profile/route.ts");
    const res = await PUT(
      authed("/api/customer/profile", CUSTOMER, {
        method: "PUT",
        body: JSON.stringify({ cpr_number: "730101234", driver_license: "DL-73" }),
      }),
    );
    // Regression: this used to be an unconditional 403 because the route asked
    // for `customers.edit`, which `client` can never hold.
    assert.equal(res.status, 200, "a client must be able to save its own identity documents");
    assert.equal((await json(res)).ok, true);

    const saved = await rows("customers", "?id=eq.c1&select=cpr_number,driver_license");
    assert.equal(saved[0]?.cpr_number, "730101234", "the write reached the caller's own row");
  });

  test("the profile write stays confined to the caller's own customer row", async () => {
    const { PUT } = await import("../src/app/api/customer/profile/route.ts");
    // The body cannot name a row: the id comes from `users.customer_id`.
    const res = await PUT(
      authed("/api/customer/profile", CUSTOMER, {
        method: "PUT",
        body: JSON.stringify({ cpr_number: "999", id: "c2", tenant_id: "other" }),
      }),
    );
    assert.equal(res.status, 200);
    const other = await rows("customers", "?id=eq.c2&select=cpr_number");
    assert.notEqual(other[0]?.cpr_number, "999", "another customer's row must not be touched");
  });

  test("the profile route refuses an ERP administrator and an anonymous caller", async () => {
    const { PUT } = await import("../src/app/api/customer/profile/route.ts");
    const asAdmin = await PUT(
      authed("/api/customer/profile", ADMIN, {
        method: "PUT",
        body: JSON.stringify({ cpr_number: "1" }),
      }),
    );
    assert.equal(asAdmin.status, 403, "the customer portal route is for customers, not the ERP");

    const asAnon = await PUT(
      anon("/api/customer/profile", { method: "PUT", body: JSON.stringify({ cpr_number: "1" }) }),
    );
    assert.equal(asAnon.status, 401, "an anonymous caller is refused");
  });

  test("the booking is created, and carries the selected vehicle and window", async () => {
    const { POST } = await import("../src/app/api/customer/bookings/route.ts");
    const res = await POST(
      authed("/api/customer/bookings", CUSTOMER, {
        method: "POST",
        body: JSON.stringify({
          car_id: "car3",
          start_date: "2027-03-01",
          end_date: "2027-03-04",
          pickup_location: "Manama",
          dropoff_location: "Manama",
          rental_type: "daily",
        }),
      }),
    );
    assert.equal(res.status, 200, `booking failed: ${JSON.stringify(await json(res))}`);

    const saved = await rows("rental_contracts", "?car_id=eq.car3&select=car_id,start_date,end_date,customer_id");
    assert.equal(saved.length, 1, "exactly one reservation was created");
    assert.equal(saved[0]?.car_id, "car3", "the saved vehicle is the one selected");
    assert.equal(saved[0]?.customer_id, "c1", "the booking belongs to the caller's own customer");
    assert.equal(saved[0]?.start_date, "2027-03-01");
    assert.equal(saved[0]?.end_date, "2027-03-04");
  });

  test("the booking cannot be pointed at another company's car", async () => {
    const { POST } = await import("../src/app/api/customer/bookings/route.ts");
    const res = await POST(
      authed("/api/customer/bookings", CUSTOMER, {
        method: "POST",
        body: JSON.stringify({
          car_id: "car-does-not-exist",
          start_date: "2027-04-01",
          end_date: "2027-04-04",
          pickup_location: "Manama",
          dropoff_location: "Manama",
        }),
      }),
    );
    assert.ok(res.status >= 400, "an unknown car is refused, never silently inserted");
  });

  test("an overlapping booking for the same car is refused", async () => {
    const { POST } = await import("../src/app/api/customer/bookings/route.ts");
    const res = await POST(
      authed("/api/customer/bookings", CUSTOMER, {
        method: "POST",
        body: JSON.stringify({
          car_id: "car3",
          start_date: "2027-03-02",
          end_date: "2027-03-05",
          pickup_location: "Manama",
          dropoff_location: "Manama",
        }),
      }),
    );
    assert.equal(res.status, 409, "a car already booked for the window is refused");
  });

  test("the availability route only ever offers cars the caller may book", async () => {
    const { GET } = await import("../src/app/api/customer/available-cars/route.ts");
    const res = await GET(authed("/api/customer/available-cars?car=car3", CUSTOMER));
    assert.equal(res.status, 200);
    const body = await json(res);
    const cars = (body.cars ?? []) as Array<Record<string, unknown>>;
    assert.ok(cars.length > 0, "at least the free car is offered");
    // `car2` holds an active contract into 2027, so it must not be offered.
    assert.ok(!cars.some((c) => c.id === "car2"), "a car that is out is not offered");
  });
});
