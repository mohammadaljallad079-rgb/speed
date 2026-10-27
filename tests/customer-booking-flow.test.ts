import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  listAvailableCars,
  createBooking,
  computePrice,
  isCarRentable,
  periodsOverlap,
  type BookingDb,
} from "../src/lib/rental/booking-service.ts";
import { ApiError } from "../src/lib/auth/errors.ts";

/**
 * Customer booking flow — the car must appear, be bookable, and stay isolated.
 *
 * The root cause this guards against: the customer portal read `cars` with the
 * browser client using `.eq('status','available')` and **no tenant scope**, while
 * a customer account had no `tenant_id` at all. The fix moves both the car list
 * and the booking creation behind tenant-scoped server routes. These tests pin
 * the availability, double-booking, tenant-isolation and spoofing rules against a
 * PostgREST-like stub.
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const TENANT_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const TENANT_B = "bbbbbbbb-0000-0000-0000-00000000000b";

type Row = Record<string, any>;

/** Minimal PostgREST-like stub: applies the filters it is given. */
function makeStub(seed: { cars: Row[]; contracts?: Row[] }) {
  const state = {
    cars: [...seed.cars],
    rental_contracts: [...(seed.contracts ?? [])],
    inserted: [] as Row[],
  };
  let seq = 0;

  class Query implements PromiseLike<{ data: unknown; error: unknown }> {
    private table: string;
    private op: "select" | "insert" = "select";
    private filters: Array<[string, unknown, "eq" | "is" | "in"]> = [];
    private payload: Row | Row[] | null = null;

    constructor(table: string) {
      this.table = table;
    }
    select(_cols?: string) {
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push([column, value, "eq"]);
      return this;
    }
    is(column: string, value: null) {
      this.filters.push([column, value, "is"]);
      return this;
    }
    in(column: string, values: readonly string[]) {
      this.filters.push([column, values as unknown, "in"]);
      return this;
    }
    order(_column: string, _options?: { ascending?: boolean }) {
      return this;
    }
    limit(_count: number) {
      return this;
    }
    insert(rows: Row | Row[]) {
      this.op = "insert";
      this.payload = rows;
      return this;
    }
    async maybeSingle() {
      const rows = this.run();
      return { data: rows[0] ?? null, error: null };
    }
    async single() {
      const rows = this.run();
      return { data: rows[0] ?? null, error: null };
    }
    private matches(row: Row): boolean {
      return this.filters.every(([col, val, kind]) => {
        if (kind === "is") return row[col] == null;
        if (kind === "in") return (val as unknown[]).includes(row[col]);
        return row[col] === val;
      });
    }
    private run(): Row[] {
      if (this.op === "insert") {
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const created = rows.map((r) => {
          const row = { id: `gen-${++seq}`, ...r };
          (state as any)[this.table].push(row);
          state.inserted.push(row);
          return row;
        });
        return created;
      }
      return ((state as any)[this.table] as Row[]).filter((r) => this.matches(r));
    }
    then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve({ data: this.run(), error: null }).then(onfulfilled, onrejected);
    }
  }

  const db = {
    from(table: string) {
      return new Query(table);
    },
    rpc() {
      return Promise.resolve({ data: "RC-TEST-1", error: null });
    },
  } as unknown as BookingDb;

  return { db, state };
}

function car(overrides: Partial<Row> = {}): Row {
  return {
    id: "car-a1",
    make: "Toyota",
    model: "Camry",
    year: 2024,
    status: "available",
    category: "rental",
    daily_rate: 20,
    weekly_rate: 120,
    monthly_rate: 450,
    tenant_id: TENANT_A,
    created_at: "2024-01-01",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------
describe("booking rules are pure and date-correct", () => {
  test("only rentable vehicles are offered (status is not the availability source)", () => {
    assert.equal(isCarRentable(car()), true);
    // A permanently unavailable vehicle is excluded...
    assert.equal(isCarRentable(car({ status: "maintenance" })), false);
    assert.equal(isCarRentable(car({ status: "sold" })), false);
    // ...but `rented` is a transient flag that nothing resets, so it must NOT
    // exclude a car. Open contracts decide availability (see Exec 57).
    assert.equal(isCarRentable(car({ status: "rented" })), true);
    // A sale car is not for rent.
    assert.equal(isCarRentable(car({ category: "sale" })), false);
    assert.equal(isCarRentable(car({ category: "both" })), true);
    // Case/space tolerant: a status saved as " Available " still matches.
    assert.equal(isCarRentable(car({ status: " Available " })), true);
  });

  test("overlap is half-open (turnover days do not conflict)", () => {
    assert.equal(periodsOverlap("2024-06-01", "2024-06-05", "2024-06-05", "2024-06-10"), false);
    assert.equal(periodsOverlap("2024-06-01", "2024-06-05", "2024-06-04", "2024-06-10"), true);
    assert.equal(periodsOverlap("2024-06-01", "2024-06-05", "2024-05-30", "2024-06-01"), false);
    assert.equal(periodsOverlap("2024-06-05", "2024-06-10", "2024-06-01", "2024-06-06"), true);
  });

  test("price is computed from the car's own rates", () => {
    const c = car({ daily_rate: 20, weekly_rate: 140, monthly_rate: 450 });
    assert.equal(computePrice(c, "2024-06-01", "2024-06-03", "daily").subtotal, 40);
    // 8 days -> 2 weeks at the weekly rate.
    assert.equal(computePrice(c, "2024-06-01", "2024-06-09", "weekly").subtotal, 280);
    // 40 days -> 2 months at the monthly rate.
    assert.equal(computePrice(c, "2024-06-01", "2024-07-11", "monthly").subtotal, 900);
  });
});

// ---------------------------------------------------------------------------
// Availability (the car appears)
// ---------------------------------------------------------------------------
describe("a car added by the company appears to its customer", () => {
  test("available rental car is listed (no date window)", async () => {
    const { db } = makeStub({ cars: [car()] });
    const cars = await listAvailableCars(db, { tenantId: TENANT_A });
    assert.equal(cars.length, 1);
    assert.equal(cars[0].id, "car-a1");
    assert.equal(cars[0].daily_rate, 20);
  });

  test("non-rentable cars never appear", async () => {
    const { db } = makeStub({
      cars: [
        car({ id: "ok" }),
        car({ id: "maint", status: "maintenance" }),
        car({ id: "sold", status: "sold" }),
        car({ id: "sale", category: "sale" }),
      ],
    });
    const cars = await listAvailableCars(db, { tenantId: TENANT_A });
    assert.deepEqual(cars.map((c) => c.id), ["ok"]);
  });

  test("a car with an overlapping booking is hidden for that window only", async () => {
    const { db } = makeStub({
      cars: [car({ id: "car-a1" })],
      contracts: [
        { id: "r1", car_id: "car-a1", start_date: "2024-06-10", end_date: "2024-06-15", status: "pending", tenant_id: TENANT_A },
      ],
    });
    // Overlapping window -> hidden.
    const busy = await listAvailableCars(db, { tenantId: TENANT_A, start: "2024-06-12", end: "2024-06-14" });
    assert.equal(busy.length, 0);
    // A free window -> visible again.
    const free = await listAvailableCars(db, { tenantId: TENANT_A, start: "2024-06-20", end: "2024-06-22" });
    assert.deepEqual(free.map((c) => c.id), ["car-a1"]);
  });

  test("a cancelled/completed booking does not block the car", async () => {
    const { db } = makeStub({
      cars: [car({ id: "car-a1" })],
      contracts: [
        { id: "r1", car_id: "car-a1", start_date: "2024-06-10", end_date: "2024-06-15", status: "cancelled", tenant_id: TENANT_A },
        { id: "r2", car_id: "car-a1", start_date: "2024-06-10", end_date: "2024-06-15", status: "completed", tenant_id: TENANT_A },
      ],
    });
    const cars = await listAvailableCars(db, { tenantId: TENANT_A, start: "2024-06-12", end: "2024-06-14" });
    assert.deepEqual(cars.map((c) => c.id), ["car-a1"]);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------
describe("company isolation", () => {
  test("a customer only sees its own company's cars", async () => {
    const { db } = makeStub({
      cars: [car({ id: "a1", tenant_id: TENANT_A }), car({ id: "b1", tenant_id: TENANT_B })],
    });
    const cars = await listAvailableCars(db, { tenantId: TENANT_A });
    assert.deepEqual(cars.map((c) => c.id), ["a1"]);
  });

  test("a customer cannot book another company's car (422, no write)", async () => {
    const { db, state } = makeStub({ cars: [car({ id: "b1", tenant_id: TENANT_B })] });
    await assert.rejects(
      () =>
        createBooking(
          db,
          { tenantId: TENANT_A, customerId: "cust-a" },
          { carId: "b1", startDate: "2024-06-01", endDate: "2024-06-03", pickupLocation: "Manama", dropoffLocation: "Manama" },
        ),
      (err: unknown) => err instanceof ApiError && err.status === 422,
    );
    assert.equal(state.inserted.length, 0);
  });

  test("a booking is stamped with the car's company, never a caller-supplied one", async () => {
    const { db, state } = makeStub({ cars: [car({ id: "a1", tenant_id: TENANT_A })] });
    const created = await createBooking(
      db,
      { tenantId: TENANT_A, customerId: "cust-a" },
      {
        carId: "a1",
        startDate: "2024-06-01",
        endDate: "2024-06-03",
        pickupLocation: "Manama",
        dropoffLocation: "Manama",
        // A caller cannot smuggle a different tenant through the input.
        ...( { tenant_id: TENANT_B } as object),
      } as never,
    );
    assert.equal(created.tenantId, TENANT_A);
    assert.equal(state.inserted[0].tenant_id, TENANT_A);
  });
});

// ---------------------------------------------------------------------------
// Booking creation + double-booking
// ---------------------------------------------------------------------------
describe("booking creation", () => {
  const input = { carId: "car-a1", startDate: "2024-06-01", endDate: "2024-06-03", pickupLocation: "Manama", dropoffLocation: "Airport" };

  test("a valid booking is created with a number, the session customer and computed total", async () => {
    const { db, state } = makeStub({ cars: [car()] });
    const created = await createBooking(db, { tenantId: TENANT_A, customerId: "cust-a" }, input);
    assert.equal(created.contractNumber, "RC-TEST-1");
    const row = state.inserted[0];
    assert.equal(row.customer_id, "cust-a");
    assert.equal(row.car_id, "car-a1");
    assert.equal(row.status, "pending");
    assert.equal(row.total_amount, 40); // 2 days * 20
    assert.equal(row.tenant_id, TENANT_A);
  });

  test("an overlapping booking is rejected with 409 and writes nothing", async () => {
    const { db, state } = makeStub({
      cars: [car()],
      contracts: [{ id: "r1", car_id: "car-a1", start_date: "2024-06-02", end_date: "2024-06-05", status: "active", tenant_id: TENANT_A }],
    });
    await assert.rejects(
      () => createBooking(db, { tenantId: TENANT_A, customerId: "cust-a" }, input),
      (err: unknown) => err instanceof ApiError && err.status === 409,
    );
    assert.equal(state.inserted.length, 0);
  });

  test("a booking for a non-overlapping window succeeds", async () => {
    const { db, state } = makeStub({
      cars: [car()],
      contracts: [{ id: "r1", car_id: "car-a1", start_date: "2024-06-10", end_date: "2024-06-15", status: "active", tenant_id: TENANT_A }],
    });
    await createBooking(db, { tenantId: TENANT_A, customerId: "cust-a" }, input);
    assert.equal(state.inserted.length, 1);
  });

  test("a bad date range is rejected before any write", async () => {
    const { db, state } = makeStub({ cars: [car()] });
    await assert.rejects(
      () => createBooking(db, { tenantId: TENANT_A, customerId: "cust-a" }, { ...input, startDate: "2024-06-03", endDate: "2024-06-01" }),
      (err: unknown) => err instanceof ApiError && err.status === 400,
    );
    assert.equal(state.inserted.length, 0);
  });

  test("a non-rentable car cannot be booked", async () => {
    const { db, state } = makeStub({ cars: [car({ status: "maintenance" })] });
    await assert.rejects(
      () => createBooking(db, { tenantId: TENANT_A, customerId: "cust-a" }, input),
      (err: unknown) => err instanceof ApiError && err.status === 400,
    );
    assert.equal(state.inserted.length, 0);
  });

  test("a missing customer link is rejected", async () => {
    const { db } = makeStub({ cars: [car()] });
    await assert.rejects(
      () => createBooking(db, { tenantId: TENANT_A, customerId: null }, input),
      (err: unknown) => err instanceof ApiError && err.status === 400,
    );
  });
});

// ---------------------------------------------------------------------------
// Wiring: the browser no longer touches cars/rental_contracts directly
// ---------------------------------------------------------------------------
describe("customer portal uses the tenant-scoped server routes", () => {
  test("available-cars route guards with the client role and session tenant", () => {
    const src = read("src/app/api/customer/available-cars/route.ts");
    assert.match(src, /requireContext\(/);
    assert.match(src, /allowRoles:\s*\[\s*["']client["']\s*\]/);
    assert.match(src, /context\.tenantId/);
    // Identity never comes from the query string.
    assert.doesNotMatch(src, /searchParams\.get\(\s*["'](tenant_id|tenantId)["']\s*\)/);
  });

  test("bookings route takes the customer and tenant from the session, not the body", () => {
    const src = read("src/app/api/customer/bookings/route.ts");
    assert.match(src, /requireContext\(/);
    assert.match(src, /allowRoles:\s*\[\s*["']client["']\s*\]/);
    assert.match(src, /context\.customerId/);
    assert.match(src, /context\.tenantId/);
    assert.doesNotMatch(src, /body\.customer_id/);
    assert.doesNotMatch(src, /body\.tenant_id/);
  });

  test("the customer dashboard no longer reads cars or inserts bookings with the browser client", () => {
    const src = read("src/app/customer-dashboard/page.tsx");
    assert.doesNotMatch(src, /from\(['"]cars['"]\)\s*\.\s*select/);
    assert.doesNotMatch(src, /from\(['"]rental_contracts['"]\)\s*\.\s*insert/);
    assert.match(src, /\/api\/customer\/available-cars/);
    assert.match(src, /\/api\/customer\/bookings/);
  });

  test("the customer dashboard and booking pages require a session", async () => {
    const { isProtectedPage } = await import("../src/middleware.ts");
    assert.equal(isProtectedPage("/customer-dashboard"), true);
    assert.equal(isProtectedPage("/booking/123"), true);
  });
});
