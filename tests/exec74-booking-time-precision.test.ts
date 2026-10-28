/**
 * Exec 74 — a booking is an hour window, not a calendar day.
 *
 * The requirement: the customer must choose a pickup TIME and a return TIME, the
 * precise instants must be stored, and overlap prevention must work at that
 * precision. Date-only is explicitly not acceptable.
 *
 * These tests cover the application half (the pure timezone core and the booking
 * service). The database half is proved by EXECUTION, not by these tests:
 *
 *   bash supabase/tests/018_harness/run.sh     (25 assertions, real PostgreSQL 17)
 *   python3 supabase/tests/018_harness/race.py (13 assertions, two real sessions)
 *
 * The split matters: a stub can show that the service SENDS the right columns,
 * but only a real PostgreSQL can show that the trigger refuses the overlap.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BookingWindowError,
  companyNow,
  companyToday,
  DEFAULT_COMPANY_TIMEZONE,
  instantsOverlap,
  isIsoTime,
  isValidTimeZone,
  rentalDays,
  resolveBookingWindow,
  resolveCompanyTimezone,
  timezoneLabel,
  toZonedIso,
  zonedWallClockToInstant,
} from "../src/lib/rental/timezone.ts";
import { createBooking, listAvailableCars, type CreateBookingInput } from "../src/lib/rental/booking-service.ts";
import { ApiError } from "../src/lib/auth/errors.ts";

// ---------------------------------------------------------------------------
// The pure timezone core
// ---------------------------------------------------------------------------

test("an invalid or absent zone falls back to the default rather than throwing", () => {
  assert.equal(resolveCompanyTimezone(undefined), DEFAULT_COMPANY_TIMEZONE);
  assert.equal(resolveCompanyTimezone(null), DEFAULT_COMPANY_TIMEZONE);
  assert.equal(resolveCompanyTimezone(""), DEFAULT_COMPANY_TIMEZONE);
  assert.equal(resolveCompanyTimezone("   "), DEFAULT_COMPANY_TIMEZONE);
  // A zone PostgreSQL/Intl does not know must not become an instant-shifting bug.
  assert.equal(resolveCompanyTimezone("Mars/Olympus_Mons"), DEFAULT_COMPANY_TIMEZONE);
  assert.equal(resolveCompanyTimezone("Asia/Bahrain"), "Asia/Bahrain");
  assert.equal(resolveCompanyTimezone("UTC"), "UTC");
});

test("isValidTimeZone accepts real zones and rejects invented ones", () => {
  assert.equal(isValidTimeZone("Asia/Bahrain"), true);
  assert.equal(isValidTimeZone("Europe/London"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Nowhere/Nothing"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(42), false);
});

test("a wall-clock reading becomes an instant in the COMPANY's zone, not the host's", () => {
  // 09:00 in Bahrain is 06:00Z. If the host's zone leaked in, this would differ.
  const instant = zonedWallClockToInstant("2026-03-01", "09:00", "Asia/Bahrain");
  assert.equal(instant.toISOString(), "2026-03-01T06:00:00.000Z");

  const utc = zonedWallClockToInstant("2026-03-01", "09:00", "UTC");
  assert.equal(utc.toISOString(), "2026-03-01T09:00:00.000Z");

  // Same wall clock, different zone -> different instant. This is the whole point.
  assert.notEqual(instant.getTime(), utc.getTime());
});

test("the conversion is DST-correct across a real transition", () => {
  // Europe/London springs forward 2026-03-29 01:00Z. Before: +00:00. After: +01:00.
  const before = zonedWallClockToInstant("2026-03-28", "09:00", "Europe/London");
  const after = zonedWallClockToInstant("2026-03-30", "09:00", "Europe/London");
  assert.equal(before.toISOString(), "2026-03-28T09:00:00.000Z");
  assert.equal(after.toISOString(), "2026-03-30T08:00:00.000Z");
});

test("toZonedIso renders an offset, so the stored value is unambiguous", () => {
  const instant = new Date("2026-03-01T06:00:00Z");
  assert.equal(toZonedIso(instant, "Asia/Bahrain"), "2026-03-01T09:00:00+03:00");
  assert.equal(toZonedIso(instant, "UTC"), "2026-03-01T06:00:00+00:00");
});

test("resolveBookingWindow produces both the instants and the wall clock", () => {
  const w = resolveBookingWindow(
    { startDate: "2026-03-01", startTime: "09:00", endDate: "2026-03-01", endTime: "11:00" },
    "Asia/Bahrain",
  );
  assert.equal(w.startAt, "2026-03-01T09:00:00+03:00");
  assert.equal(w.endAt, "2026-03-01T11:00:00+03:00");
});

test("resolveBookingWindow REFUSES a window that does not move forward", () => {
  // Same day, return before pickup: not a rental.
  assert.throws(
    () => resolveBookingWindow(
      { startDate: "2026-03-01", startTime: "11:00", endDate: "2026-03-01", endTime: "09:00" },
      "Asia/Bahrain",
    ),
    (e: unknown) => e instanceof BookingWindowError && (e as BookingWindowError).field === "endDate",
  );
  // Zero length: a car cannot be let for no time at all.
  assert.throws(
    () => resolveBookingWindow(
      { startDate: "2026-03-01", startTime: "09:00", endDate: "2026-03-01", endTime: "09:00" },
      "Asia/Bahrain",
    ),
  );
});

test("resolveBookingWindow refuses a malformed date or time", () => {
  const bad = [
    { startDate: "2026-02-30", startTime: "09:00", endDate: "2026-03-01", endTime: "09:00" },
    { startDate: "2026-03-01", startTime: "25:00", endDate: "2026-03-02", endTime: "09:00" },
    { startDate: "01/03/2026", startTime: "09:00", endDate: "2026-03-02", endTime: "09:00" },
    { startDate: "2026-03-01", startTime: "9am", endDate: "2026-03-02", endTime: "09:00" },
  ];
  for (const input of bad) {
    assert.throws(() => resolveBookingWindow(input, "Asia/Bahrain"), `should reject ${JSON.stringify(input)}`);
  }
});

test("isIsoTime accepts HH:MM and HH:MM:SS, rejects everything else", () => {
  assert.equal(isIsoTime("09:00"), true);
  assert.equal(isIsoTime("23:59"), true);
  assert.equal(isIsoTime("09:00:30"), true);
  assert.equal(isIsoTime("24:00"), false);
  assert.equal(isIsoTime("09:60"), false);
  assert.equal(isIsoTime("9:00"), false);
  assert.equal(isIsoTime(""), false);
});

test("instantsOverlap is half-open: a 09:00 return frees a 09:00 pickup", () => {
  // 09:00-11:00, 11:00-13:00 and 10:00-12:00 in Bahrain (+03) == 06-08Z, 08-10Z, 07-09Z.
  const a = ["2026-03-01T06:00:00Z", "2026-03-01T08:00:00Z"];
  const adjacent = ["2026-03-01T08:00:00Z", "2026-03-01T10:00:00Z"];
  const overlapping = ["2026-03-01T07:00:00Z", "2026-03-01T09:00:00Z"];

  assert.equal(instantsOverlap(a[0], a[1], adjacent[0], adjacent[1]), false, "adjacent must not conflict");
  assert.equal(instantsOverlap(a[0], a[1], overlapping[0], overlapping[1]), true, "overlap must conflict");
  // Symmetric.
  assert.equal(instantsOverlap(adjacent[0], adjacent[1], a[0], a[1]), false);
  assert.equal(instantsOverlap(overlapping[0], overlapping[1], a[0], a[1]), true);
});

test("rentalDays counts on the wall clock, so a same-day rental is one day", () => {
  // 09:00-11:00 same day = 1 day, not 0 and not 1.5 rounded up to 2.
  assert.equal(rentalDays("2026-03-01T09:00:00+03:00", "2026-03-01T11:00:00+03:00", "Asia/Bahrain"), 1);
  // 09:00 Monday -> 09:00 Tuesday = exactly one day.
  assert.equal(rentalDays("2026-03-01T09:00:00+03:00", "2026-03-02T09:00:00+03:00", "Asia/Bahrain"), 1);
  // A part day beyond that is charged as a whole day.
  assert.equal(rentalDays("2026-03-01T09:00:00+03:00", "2026-03-02T11:00:00+03:00", "Asia/Bahrain"), 2);
  // A week.
  assert.equal(rentalDays("2026-03-01T09:00:00+03:00", "2026-03-08T09:00:00+03:00", "Asia/Bahrain"), 7);
  // Backwards floors at 1, never a negative - a negative would invert a price.
  assert.equal(rentalDays("2026-03-02T09:00:00+03:00", "2026-03-01T09:00:00+03:00", "Asia/Bahrain"), 1);
});

test("companyToday/companyNow use the company's calendar, not the device's", () => {
  // 2026-03-01T22:30Z is already 2026-03-02 in Bahrain (+03) but still the 1st in UTC.
  const at = new Date("2026-03-01T22:30:00Z");
  assert.equal(companyToday("Asia/Bahrain", at), "2026-03-02");
  assert.equal(companyToday("UTC", at), "2026-03-01");
  assert.equal(companyNow("Asia/Bahrain", at), "01:30");
});

test("timezoneLabel is a human label and never throws on a bad zone", () => {
  const at = new Date("2026-03-01T06:00:00Z");
  assert.equal(timezoneLabel("Asia/Bahrain", at), "UTC+03:00");
  assert.equal(timezoneLabel("UTC", at), "UTC+00:00");
  assert.equal(typeof timezoneLabel("Nowhere/Nothing", at), "string");
});

// ---------------------------------------------------------------------------
// The booking service
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * A recording PostgREST-like stub that applies the filters it is given. `failOn`
 * lets a test make the write fail the way migration 018 makes it fail, and
 * `missingColumns` lets a test simulate a database that predates 018.
 */
function stubDb(options: {
  contracts?: Row[]
  car?: Row
  failOn?: unknown
  missingColumns?: string[]
  /** The tenant the stub's car belongs to; contract rows must match it. */
  carTenant?: string
} = {}) {
  const contracts = options.contracts ?? [];
  const inserts: Row[] = [];
  const missing = new Set(options.missingColumns ?? []);
  return {
    inserts,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let statusIn: string[] | null = null;

      const matches = (row: Row) => {
        for (const [k, v] of Object.entries(filters)) {
          if (v === null) { if (row[k] != null) return false; } else if (row[k] !== v) return false;
        }
        if (statusIn && !statusIn.includes(String(row.status))) return false;
        return true;
      };

      const builder: Record<string, unknown> = {};
      const self = () => builder;

      // The INSERT chain: insert(row).select(cols).single()
      const insertChain = (row: Row) => {
        const result = () => {
          if (options.failOn && table === "rental_contracts") {
            return { data: null, error: options.failOn };
          }
          // A database without 018 rejects the columns it does not have yet.
          for (const col of Object.keys(row)) {
            if (missing.has(col)) {
              return {
                data: null,
                error: { code: "PGRST204", message: `Could not find the '${col}' column` },
              };
            }
          }
          inserts.push({ ...row, __table: table });
          return { data: { id: "contract-1", ...row }, error: null };
        };
        const chain: Record<string, unknown> = {
          select: () => chain,
          single: () => Promise.resolve(result()),
          maybeSingle: () => Promise.resolve(result()),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
        };
        return chain;
      };

      Object.assign(builder, {
        select: self,
        eq(column: string, value: unknown) { filters[column] = value; return self(); },
        is(column: string, value: null) { filters[column] = value; return self(); },
        in(column: string, values: string[]) { if (column === "status") statusIn = values; return self(); },
        order: self,
        limit: self,
        insert: insertChain,
        maybeSingle() {
          if (table === "cars") {
            const car = options.car ?? {
              id: "car-1", category: "rental", status: "available",
              tenant_id: options.carTenant ?? "t1",
            };
            return Promise.resolve({ data: matches(car as Row) ? car : null, error: null });
          }
          const rows = contracts.filter(matches);
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then(resolve: (v: unknown) => unknown) {
          // The overlap pre-check: a select that resolves to the matching contracts.
          return Promise.resolve({ data: contracts.filter(matches), error: null }).then(resolve);
        },
      });
      return builder;
    },
  };
}

const INPUT: CreateBookingInput = {
  carId: "car-1",
  startDate: "2026-03-01",
  startTime: "09:00",
  endDate: "2026-03-01",
  endTime: "11:00",
  pickupLocation: "Manama",
  dropoffLocation: "Manama",
};

test("createBooking stores the PRECISE instants, not only the dates", async () => {
  const db = stubDb();
  await createBooking(db as never, { tenantId: "t1", customerId: "cust-1", timeZone: "Asia/Bahrain" }, INPUT);

  const row = db.inserts.find((r) => r.__table === "rental_contracts");
  assert.ok(row, "a rental_contracts row was written");
  // The precise window is present, and it is a real instant with an offset.
  assert.equal(row.start_at, "2026-03-01T09:00:00+03:00");
  assert.equal(row.end_at, "2026-03-01T11:00:00+03:00");
  // The wall-clock reading is preserved alongside it, so the row is readable
  // without knowing the zone.
  assert.equal(row.start_date, "2026-03-01");
  assert.equal(row.start_time, "09:00");
  assert.equal(row.end_date, "2026-03-01");
  assert.equal(row.end_time, "11:00");
});

test("the same wall clock in a different company zone stores a different instant", async () => {
  const bahrain = stubDb({ carTenant: "t1" });
  await createBooking(bahrain as never, { tenantId: "t1", customerId: "c", timeZone: "Asia/Bahrain" }, INPUT);
  const utc = stubDb({ carTenant: "t2" });
  await createBooking(utc as never, { tenantId: "t2", customerId: "c", timeZone: "UTC" }, INPUT);

  const b = bahrain.inserts.find((r) => r.__table === "rental_contracts")!;
  const u = utc.inserts.find((r) => r.__table === "rental_contracts")!;
  assert.notEqual(b.start_at, u.start_at);
  assert.equal(b.start_at, "2026-03-01T09:00:00+03:00");
  assert.equal(u.start_at, "2026-03-01T09:00:00+00:00");
});

test("createBooking refuses a zero-length or backwards window before writing", async () => {
  const db = stubDb();
  await assert.rejects(
    () => createBooking(db as never, { tenantId: "t1", customerId: "c" }, {
      ...INPUT, startTime: "11:00", endTime: "09:00",
    }),
    (e: unknown) => e instanceof ApiError && (e as ApiError).status === 400,
  );
  assert.equal(db.inserts.length, 0, "nothing was written");
});

test("createBooking refuses a missing time rather than defaulting to midnight", async () => {
  // A silent 00:00 default would turn "09:00" into a 15-hour rental and change the
  // price. The window must be rejected instead.
  const db = stubDb();
  await assert.rejects(
    () => createBooking(db as never, { tenantId: "t1", customerId: "c" }, { ...INPUT, startTime: "" }),
  );
  assert.equal(db.inserts.length, 0);
});

test("a booking that overlaps a blocking contract is refused with 409", async () => {
  const db = stubDb({
    contracts: [{
      id: "existing",
      car_id: "car-1",
      tenant_id: "t1",
      status: "active",
      start_date: "2026-03-01",
      start_time: "10:00",
      end_date: "2026-03-01",
      end_time: "12:00",
    }],
  });
  await assert.rejects(
    () => createBooking(db as never, { tenantId: "t1", customerId: "c", timeZone: "Asia/Bahrain" }, INPUT),
    (e: unknown) => e instanceof ApiError && (e as ApiError).status === 409,
  );
});

test("a same-day booking at a DIFFERENT time is accepted (the point of the change)", async () => {
  // 09:00-11:00 then 14:00-16:00 on the same date: different rentals.
  const db = stubDb({
    contracts: [{
      id: "existing",
      car_id: "car-1",
      tenant_id: "t1",
      status: "active",
      start_date: "2026-03-01",
      start_time: "09:00",
      end_date: "2026-03-01",
      end_time: "11:00",
    }],
  });
  await createBooking(db as never, { tenantId: "t1", customerId: "c", timeZone: "Asia/Bahrain" }, {
    ...INPUT, startTime: "14:00", endTime: "16:00",
  });
  assert.equal(db.inserts.filter((r) => r.__table === "rental_contracts").length, 1);
});

test("a same-day booking adjacent to an existing one is accepted", async () => {
  // The existing booking returns at 11:00; the new one starts at 11:00.
  const db = stubDb({
    contracts: [{
      id: "existing",
      car_id: "car-1",
      tenant_id: "t1",
      status: "active",
      start_date: "2026-03-01",
      start_time: "09:00",
      end_date: "2026-03-01",
      end_time: "11:00",
    }],
  });
  await createBooking(db as never, { tenantId: "t1", customerId: "c", timeZone: "Asia/Bahrain" }, {
    ...INPUT, startTime: "11:00", endTime: "13:00",
  });
  assert.equal(db.inserts.filter((r) => r.__table === "rental_contracts").length, 1);
});

test("a NON-blocking contract on the same car does not conflict", async () => {
  const db = stubDb({
    contracts: [{
      id: "cancelled",
      car_id: "car-1",
      tenant_id: "t1",
      status: "cancelled",
      start_date: "2026-03-01",
      start_time: "09:00",
      end_date: "2026-03-01",
      end_time: "11:00",
    }],
  });
  await createBooking(db as never, { tenantId: "t1", customerId: "c", timeZone: "Asia/Bahrain" }, INPUT);
  assert.equal(db.inserts.filter((r) => r.__table === "rental_contracts").length, 1);
});

test("the database losing the race still surfaces as the same 409", async () => {
  // The pre-check saw nothing; the INSERT is refused by migration 018's guard.
  const db = stubDb({ failOn: { code: "23P01", message: "conflicting key value violates exclusion constraint" } });
  await assert.rejects(
    () => createBooking(db as never, { tenantId: "t1", customerId: "c", timeZone: "Asia/Bahrain" }, INPUT),
    (e: unknown) => e instanceof ApiError && (e as ApiError).status === 409,
  );
});

test("a database without 018 still accepts the booking (the app runs before the migration)", async () => {
  // `insertTolerant` must drop only the columns the DB lacks, so the feature
  // degrades to the date-only shape instead of failing.
  const db = stubDb({ missingColumns: ["start_at", "end_at"] });
  const booking = await createBooking(
    db as never,
    { tenantId: "t1", customerId: "c", timeZone: "Asia/Bahrain" },
    INPUT,
  );
  assert.ok(booking, "the booking still succeeded");
  const row = db.inserts.find((r) => r.__table === "rental_contracts")!;
  assert.equal(row.start_at, undefined, "the missing column was dropped");
  assert.equal(row.start_time, "09:00", "the wall-clock time was still stored");
});

// ---------------------------------------------------------------------------
// The availability LIST must judge the same window the form collected
// ---------------------------------------------------------------------------

/**
 * A stub for `listAvailableCars`, which reads `cars` then `rental_contracts`.
 * The car has no `created_at`, which the service orders by; the stub ignores the
 * ordering and returns the rows, which is all the filter under test needs.
 */
function listStub(contracts: Row[], cars: Row[]) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let statusIn: string[] | null = null;
      const matches = (row: Row) => {
        for (const [k, v] of Object.entries(filters)) {
          if (v === null) { if (row[k] != null) return false; } else if (row[k] !== v) return false;
        }
        if (statusIn && !statusIn.includes(String(row.status))) return false;
        return true;
      };
      const builder: Record<string, unknown> = {};
      const self = () => builder;
      Object.assign(builder, {
        select: self,
        eq(column: string, value: unknown) { filters[column] = value; return self(); },
        is(column: string, value: null) { filters[column] = value; return self(); },
        in(column: string, values: string[]) { if (column === "status") statusIn = values; return self(); },
        order: self,
        limit: self,
        then(resolve: (v: unknown) => unknown) {
          const source = table === "cars" ? cars : table === "rental_contracts" ? contracts : [];
          return Promise.resolve({ data: source.filter(matches), error: null }).then(resolve);
        },
      });
      return builder;
    },
  };
}

const RENTAL_CAR: Row = {
  id: "car-1", make: "Mazda", model: "CX5", category: "rental", status: "available",
  daily_rate: 25, weekly_rate: 150, monthly_rate: 600, tenant_id: "t1",
};

test("a SAME-DAY time window is used, not discarded (the end > start trap)", async () => {
  // `end > start` is false when both dates are equal, so a same-day selection used
  // to fall through to "cars free from today forever" - which OFFERED a car that
  // was already out for exactly that hour. A same-day rental is the commonest
  // booking there is, so this was a real availability defect, not an edge case.
  const contracts: Row[] = [{
    id: "busy", car_id: "car-1", tenant_id: "t1", status: "active",
    start_date: "2026-10-10", start_time: "09:00", end_date: "2026-10-10", end_time: "11:00",
  }];

  // 10:00-12:00 overlaps 09:00-11:00 -> the car must be withheld.
  const busy = await listAvailableCars(listStub(contracts, [RENTAL_CAR]) as never, {
    tenantId: "t1", start: "2026-10-10", startTime: "10:00", end: "2026-10-10", endTime: "12:00",
  });
  assert.equal(busy.length, 0, "a car booked 09:00-11:00 is not offered for 10:00-12:00");

  // 11:00-13:00 is adjacent -> the car is free (half-open).
  const free = await listAvailableCars(listStub(contracts, [RENTAL_CAR]) as never, {
    tenantId: "t1", start: "2026-10-10", startTime: "11:00", end: "2026-10-10", endTime: "13:00",
  });
  assert.equal(free.length, 1, "a car returned at 11:00 is offered for an 11:00 pickup");
});

test("a same-day DATE-ONLY request means that one day, not every day", async () => {
  // Without a time, the window is `[00:00, next 00:00)`. Falling through to
  // "free forever" would offer a car that is out on the very day requested.
  const contracts: Row[] = [{
    id: "busy", car_id: "car-1", tenant_id: "t1", status: "active",
    start_date: "2026-10-10", start_time: "09:00", end_date: "2026-10-10", end_time: "11:00",
  }];
  const sameDay = await listAvailableCars(listStub(contracts, [RENTAL_CAR]) as never, {
    tenantId: "t1", start: "2026-10-10", end: "2026-10-10",
  });
  assert.equal(sameDay.length, 0, "the car is out on 2026-10-10 and must not be offered for it");

  const otherDay = await listAvailableCars(listStub(contracts, [RENTAL_CAR]) as never, {
    tenantId: "t1", start: "2026-10-09", end: "2026-10-09",
  });
  assert.equal(otherDay.length, 1, "a different day is unaffected");
});

test("a same-day window with a zero-length time is not treated as a real rental", async () => {
  // 09:00 -> 09:00 on one date is not a rental. The window must not silently
  // become a full day (which would hide a car unnecessarily) nor "forever".
  const contracts: Row[] = [{
    id: "busy", car_id: "car-1", tenant_id: "t1", status: "active",
    start_date: "2026-10-10", start_time: "09:00", end_date: "2026-10-10", end_time: "11:00",
  }];
  const zero = await listAvailableCars(listStub(contracts, [RENTAL_CAR]) as never, {
    tenantId: "t1", start: "2026-10-10", startTime: "09:00", end: "2026-10-10", endTime: "09:00",
  });
  // Falls back to the same-day day window, which still overlaps the booking.
  assert.equal(zero.length, 0, "a degenerate same-day window is not 'free forever'");
});
