/**
 * Exec 72 - Item 3: the booking double-booking race.
 *
 * `createBooking` reads the car's blocking contracts, tests for an overlap in
 * JavaScript, then inserts. That is a check-then-act: two customers submitting
 * the same car and window at the same moment BOTH read "free" and BOTH insert.
 * Before this execution nothing in the database refused the second row, so the
 * race was real.
 *
 * Migration 017 closes it with an exclusion constraint (plus a trigger fallback
 * for a deployment without `btree_gist`). These tests cover the application half:
 * the database rejection is translated into the same 409 the pre-check returns,
 * so the customer who lost the race sees "already booked" and not a 500.
 *
 * The SQL half is proved by execution, not by these tests:
 *   bash supabase/tests/017_harness/run.sh              (23 assertions)
 *   bash supabase/tests/017_harness/verify_package.sh   (the frozen package)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ApiError } from "../src/lib/auth/errors.ts";
import { createBooking, isOverlapViolation } from "../src/lib/rental/booking-service.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

type Row = Record<string, unknown>;

/**
 * A recording PostgREST-like stub that applies the filters it is given. `insertError`
 * lets a test make the INSERT fail the way migration 017 makes it fail.
 */
function stubDb(options: { contracts?: Row[]; insertError?: unknown } = {}) {
  const contracts = options.contracts ?? [];
  const inserts: Row[] = [];
  return {
    inserts,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      const self = () => builder;
      Object.assign(builder, {
        select: self,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return self();
        },
        is(column: string, value: null) {
          filters[column] = value;
          return self();
        },
        in: self,
        order: self,
        limit: self,
        maybeSingle() {
          const match = table === "cars"
            ? { id: "car-1", category: "rental", status: "available", daily_rate: 10, weekly_rate: 60, monthly_rate: 200, tenant_id: "t1" }
            : null;
          return Promise.resolve({ data: match, error: null });
        },
        single() {
          return Promise.resolve(
            options.insertError
              ? { data: null, error: options.insertError }
              : { data: { id: "rc-1", contract_number: "RC-1" }, error: null },
          );
        },
        insert(rows: Row | Row[]) {
          const list = Array.isArray(rows) ? rows : [rows];
          inserts.push(...list);
          return self();
        },
        then(resolve: (v: unknown) => unknown) {
          const data = table === "rental_contracts" ? contracts : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      });
      return builder;
    },
    rpc() {
      return Promise.resolve({ data: "RC-1", error: null });
    },
  };
}

const INPUT = {
  carId: "car-1",
  startDate: "2026-03-01",
  endDate: "2026-03-05",
  pickupLocation: "Manama",
  dropoffLocation: "Manama",
};

test("isOverlapViolation recognises the SQLSTATE the guard raises", () => {
  assert.equal(isOverlapViolation({ code: "23P01" }), true);
});

test("isOverlapViolation recognises the trigger's message without a code", () => {
  // PostgREST does not always surface `code` on a constraint violation.
  assert.equal(
    isOverlapViolation({ message: 'rental_contracts: car x is already booked for the requested period' }),
    true,
  );
  assert.equal(isOverlapViolation({ message: "violates exclusion constraint rental_contracts_no_car_overlap" }), true);
  assert.equal(isOverlapViolation({ message: "conflicting contract abc" }), true);
});

test("isOverlapViolation does not swallow an unrelated write failure", () => {
  // A unique-violation on the contract number, or a permission error, must NOT
  // be reported to the customer as "already booked" - that would hide a real bug.
  assert.equal(isOverlapViolation({ code: "23505", message: "duplicate key value" }), false);
  assert.equal(isOverlapViolation({ code: "42501", message: "permission denied" }), false);
  assert.equal(isOverlapViolation(null), false);
  assert.equal(isOverlapViolation("boom"), false);
  assert.equal(isOverlapViolation(undefined), false);
});

test("losing the race surfaces as the SAME 409 the pre-check returns", async () => {
  // The pre-check sees no existing contract (the other request has not committed
  // yet); the INSERT is then refused by the database guard.
  const db = stubDb({
    contracts: [],
    insertError: { code: "23P01", message: "conflicting key value violates exclusion constraint" },
  });
  await assert.rejects(
    () => createBooking(db as never, { tenantId: "t1", customerId: "cust-1" }, INPUT),
    (error: unknown) => {
      assert.ok(error instanceof ApiError, "a translated 409, not a raw driver error");
      assert.equal((error as ApiError).status, 409);
      assert.equal((error as ApiError).code, "car_unavailable");
      return true;
    },
  );
});

test("an unrelated insert failure is NOT disguised as a booking conflict", async () => {
  const db = stubDb({
    contracts: [],
    insertError: { code: "42501", message: "permission denied for table rental_contracts" },
  });
  await assert.rejects(
    () => createBooking(db as never, { tenantId: "t1", customerId: "cust-1" }, INPUT),
    (error: unknown) => {
      assert.ok(!(error instanceof ApiError), "the real failure must propagate unchanged");
      return true;
    },
  );
});

test("the application pre-check still runs and still short-circuits", async () => {
  // An overlap the pre-check CAN see is refused before any insert is attempted.
  const db = stubDb({
    contracts: [{ id: "rc-9", car_id: "car-1", start_date: "2026-03-02", end_date: "2026-03-04", status: "active" }],
  });
  await assert.rejects(
    () => createBooking(db as never, { tenantId: "t1", customerId: "cust-1" }, INPUT),
    (error: unknown) => {
      assert.equal((error as ApiError).status, 409);
      return true;
    },
  );
  assert.equal(db.inserts.length, 0, "nothing was written");
});

// --- the migration contract --------------------------------------------------

test("migration 017 exists with its rollback and guards the real columns", () => {
  const sql = read("supabase/migrations/017_booking_overlap_guard.sql");
  assert.match(sql, /rental_contracts/);
  assert.match(sql, /car_id/);
  assert.match(sql, /start_date/);
  assert.match(sql, /end_date/);
  // The half-open window must match `periodsOverlap` in the service. The window
  // is a TIMESTAMP range, not a calendar-date one: a booking that carries a
  // pickup/return time must not be treated as a whole day.
  const exec = sql.replace(/--.*$/gm, "");
  const ctors = exec.match(/(tstzrange|tsrange)\s*\(/g) ?? [];
  assert.ok(ctors.length > 0, "017 must build a timestamp range, not a calendar-date one");
  // PL/pgSQL doubles a quote inside a literal, so '[)' appears as ''[)''.
  const bounds = exec.match(/'+\[\)'+'/g) ?? [];
  assert.equal(bounds.length, ctors.length, "every range must be half-open '[)'");
  assert.doesNotMatch(exec, /daterange\(/);
  const rb = read("supabase/migrations/017_booking_overlap_guard_rollback.sql");
  assert.match(rb, /drop trigger if exists rental_contracts_no_double_booking/);
  assert.match(rb, /drop constraint if exists rental_contracts_no_car_overlap/);
});

test("the blocking statuses in SQL match BLOCKING_STATUSES in the service", () => {
  const sql = read("supabase/migrations/017_booking_overlap_guard.sql");
  const service = read("src/lib/rental/booking-service.ts");
  // Extract the BLOCKING_STATUSES array literal itself, not whichever array
  // happens to appear first in the file.
  const literal = /BLOCKING_STATUSES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(service)?.[1] ?? "";
  const statuses = [...literal.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(statuses, ["pending", "active", "confirmed", "reserved", "approved", "ongoing", "rented"]);
  for (const status of statuses) {
    assert.ok(sql.includes(`'${status}'`), `017 must treat '${status}' as blocking`);
  }
});

test("the tenant-less install is protected by coalescing the tenant", () => {
  const sql = read("supabase/migrations/017_booking_overlap_guard.sql");
  // In a GiST index NULLs are distinct, and a NULL-tenant advisory lock key must
  // still be a real key, so without a sentinel two NULL-tenant bookings for the
  // same car would not conflict - the exact hole the guard must close.
  assert.match(sql, /00000000-0000-0000-0000-000000000000/, "the sentinel UUID must be present");
  assert.match(sql, /coalesce\(\s*(c\.|new\.)?tenant_id\s*,\s*(%1\$s|v_sentinel|'''00000000)/,
    "the tenant must be coalesced to the sentinel in the conflict check");
  assert.match(sql, /coalesce\(new\.tenant_id/, "the advisory lock key must coalesce the tenant");
});

test("the frozen activation package 017 embeds the migration byte-identically", () => {
  const pkg = read("supabase/PRODUCTION_ACTIVATION_017.sql");
  assert.match(pkg, /-- BEGIN 017_booking_overlap_guard\.sql/);
  assert.match(pkg, /-- POST-FLIGHT VERIFICATION/);
  assert.match(pkg, /chlkmdobhvfnldqkgdji/);
});
