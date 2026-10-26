import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  listAvailableCars,
  isCarRentable,
  UNRENTABLE_STATUSES,
  type BookingDb,
} from "../src/lib/rental/booking-service.ts";
import { resolveCustomerTenantId } from "../src/lib/rental/customer-tenant.ts";
import { carStatusForContractChange } from "../src/lib/rental/car-status.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const TENANT_A = "aaaaaaaa-0000-0000-0000-00000000000a";

type Row = Record<string, any>;

/** Minimal PostgREST-like stub that applies the filters it is given. */
function makeStub(seed: { cars: Row[]; contracts?: Row[] }) {
  const state = { cars: [...seed.cars], rental_contracts: [...(seed.contracts ?? [])] };

  class Query implements PromiseLike<{ data: unknown; error: unknown }> {
    private table: string;
    private filters: Array<[string, unknown, "eq" | "is" | "in"]> = [];
    constructor(table: string) {
      this.table = table;
    }
    select() {
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push([c, v, "eq"]);
      return this;
    }
    is(c: string, v: null) {
      this.filters.push([c, v, "is"]);
      return this;
    }
    in(c: string, v: readonly string[]) {
      this.filters.push([c, v, "in"]);
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    insert() {
      return this;
    }
    async maybeSingle() {
      return { data: this.run()[0] ?? null, error: null };
    }
    async single() {
      return { data: this.run()[0] ?? null, error: null };
    }
    private run(): Row[] {
      return ((state as any)[this.table] as Row[]).filter((row) =>
        this.filters.every(([col, val, kind]) => {
          if (kind === "is") return row[col] == null;
          if (kind === "in") return (val as unknown[]).includes(row[col]);
          return row[col] === val;
        }),
      );
    }
    then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
      ok?: ((v: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
      bad?: ((r: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve({ data: this.run(), error: null }).then(ok, bad);
    }
  }

  const db = {
    from: (t: string) => new Query(t),
    rpc: () => Promise.resolve({ data: "RC-1", error: null }),
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

/**
 * Execution 57 — booking availability root causes.
 *
 * Two independent defects made a bookable car invisible to its own customer:
 *
 * 1. Availability was read off the denormalised `cars.status` flag. Nothing
 *    resets that flag when a rental is completed or cancelled (only the
 *    change-vehicle screen ever did), so a car that finished a rental stayed
 *    `rented` and disappeared from the booking list forever. The authoritative
 *    source of "is this car out" is the rental contracts, not the flag.
 *
 * 2. The customer signup resolver could assign a tenant that does not own the
 *    cars the customer is about to browse. It preferred the tenant that owns
 *    available cars, but when every available car was tenant-less it fell back
 *    to a bare `tenants` row — pointing the customer at a scope containing no
 *    cars. The resolver must derive the answer from the cars themselves.
 */
describe("availability is derived from contracts, not a stale status flag", () => {
  test("a stale `rented` flag with no contract does not hide a free car", async () => {
    const { db } = makeStub({ cars: [car({ id: "stuck", status: "rented" })], contracts: [] });
    const cars = await listAvailableCars(db, { tenantId: TENANT_A, start: "2024-06-01", end: "2024-06-03" });
    assert.deepEqual(cars.map((c) => c.id), ["stuck"]);
  });

  test("a car out on an active contract is hidden for the overlapping window", async () => {
    const { db } = makeStub({
      cars: [car({ id: "out", status: "rented" })],
      contracts: [{ id: "r1", car_id: "out", start_date: "2024-06-01", end_date: "2024-06-05", status: "active", tenant_id: TENANT_A }],
    });
    const busy = await listAvailableCars(db, { tenantId: TENANT_A, start: "2024-06-02", end: "2024-06-04" });
    assert.deepEqual(busy.map((c) => c.id), []);
    const later = await listAvailableCars(db, { tenantId: TENANT_A, start: "2024-06-10", end: "2024-06-12" });
    assert.deepEqual(later.map((c) => c.id), ["out"]);
  });

  test("with no dates, a car that is out on a contract is not offered", async () => {
    const { db } = makeStub({
      cars: [car({ id: "out", status: "rented" }), car({ id: "free" })],
      contracts: [{ id: "r1", car_id: "out", start_date: "2024-06-01", end_date: "2024-06-30", status: "active", tenant_id: TENANT_A }],
    });
    // Pin "today" inside the contract so the result is deterministic.
    const cars = await listAvailableCars(db, { tenantId: TENANT_A, today: "2024-06-15" });
    assert.deepEqual(cars.map((c) => c.id), ["free"]);
    // Once the contract has ended the car is offered again, even though its
    // denormalised status flag is still `rented`.
    const after = await listAvailableCars(db, { tenantId: TENANT_A, today: "2024-07-15" });
    assert.deepEqual(after.map((c) => c.id).sort(), ["free", "out"]);
  });

  test("maintenance and sold vehicles are never offered", async () => {
    assert.deepEqual([...UNRENTABLE_STATUSES].sort(), ["inactive", "maintenance", "out_of_service", "sold"]);
    assert.equal(isCarRentable(car({ status: "maintenance" })), false);
    assert.equal(isCarRentable(car({ status: "sold" })), false);
    assert.equal(isCarRentable(car({ status: "inactive" })), false);
    // `rented` is a transient flag, not a permanent exclusion.
    assert.equal(isCarRentable(car({ status: "rented" })), true);
    assert.equal(isCarRentable(car({ status: "available" })), true);
    assert.equal(isCarRentable(car({ status: " Available " })), true);
    // A sale car is inventory, not a rental.
    assert.equal(isCarRentable(car({ category: "sale" })), false);
    assert.equal(isCarRentable(car({ category: "both" })), true);

    const { db } = makeStub({
      cars: [car({ id: "m", status: "maintenance" }), car({ id: "s", status: "sold" }), car({ id: "ok" })],
    });
    const cars = await listAvailableCars(db, { tenantId: TENANT_A });
    assert.deepEqual(cars.map((c) => c.id), ["ok"]);
  });
});

describe("the customer tenant resolver follows the cars, never a bare tenant row", () => {
  test("available cars all tenant-less -> the customer stays tenant-less", () => {
    // One tenant exists, but it owns none of the cars: assigning it would hide
    // every car from the customer.
    assert.equal(resolveCustomerTenantId([{ tenant_id: null }], [{ id: TENANT_A }]), null);
  });

  test("available cars owned by exactly one tenant -> that tenant", () => {
    assert.equal(resolveCustomerTenantId([{ tenant_id: TENANT_A }], []), TENANT_A);
    assert.equal(resolveCustomerTenantId([{ tenant_id: TENANT_A }, { tenant_id: TENANT_A }], [{ id: "other" }]), TENANT_A);
  });

  test("available cars split across tenants -> do not guess", () => {
    assert.equal(resolveCustomerTenantId([{ tenant_id: TENANT_A }, { tenant_id: "b" }], []), null);
  });

  test("no available cars at all -> fall back to a single unambiguous tenant", () => {
    assert.equal(resolveCustomerTenantId([], [{ id: TENANT_A }]), TENANT_A);
    assert.equal(resolveCustomerTenantId([], [{ id: "a" }, { id: "b" }]), null);
    assert.equal(resolveCustomerTenantId([], []), null);
  });

  test("the signup route uses the pure resolver", () => {
    const src = read("src/app/api/customer-signup/route.ts");
    assert.match(src, /resolveCustomerTenantId/);
    assert.match(src, /from\s+["']@\/lib\/rental\/customer-tenant["']/);
  });
});

describe("the dashboard message distinguishes 'no cars' from 'none free'", () => {
  test("the empty-state copy does not blame the dates when no dates are chosen", () => {
    const src = read("src/app/customer-dashboard/page.tsx");
    // The "try changing the dates" copy must be gated on both dates being set;
    // otherwise it is shown before any date is picked and misleads the user.
    assert.match(src, /startDate\s*&&\s*endDate[\s\S]{0,400}?Try changing the dates/);
    assert.match(src, /No cars are available right now/);
  });
});

describe("a terminal contract transition releases the car", () => {
  test("completed / cancelled / closed / returned release; live states do not", () => {
    for (const s of ["completed", "cancelled", "closed", "returned", " Completed "]) {
      assert.equal(carStatusForContractChange(s), "available", s);
    }
    for (const s of ["pending", "active", "reserved", null, undefined, ""]) {
      assert.equal(carStatusForContractChange(s), null, String(s));
    }
  });

  test("the rental screens call the helper instead of leaving the flag stuck", () => {
    // Both screens derive the released status from the ONE helper rather than
    // hard-coding a literal, so a future change to the terminal-status list
    // cannot leave one screen behind.
    for (const f of ["src/app/rentals/page.tsx", "src/app/rentals/[id]/page.tsx"]) {
      const src = read(f);
      assert.match(src, /carStatusForContractChange/, `${f} must derive the release through the helper`);
      assert.match(src, /from\(['"]cars['"]\)\.update\(\{\s*status:\s*releaseStatus\s*\}\)/, `${f} must apply the helper's result`);
    }
  });
});
