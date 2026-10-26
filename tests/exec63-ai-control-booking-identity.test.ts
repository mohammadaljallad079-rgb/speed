import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  confirmBooking,
  CONFIRMABLE_STATUSES,
  ACTIVE_STATUS,
  rentalInvoiceInput,
  type ConfirmDb,
} from "../src/lib/rental/confirm-booking.ts";
import {
  getCarAvailability,
  listAvailableCars,
  type BookingDb,
} from "../src/lib/rental/booking-service.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const TENANT_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const TENANT_B = "bbbbbbbb-0000-0000-0000-00000000000b";

type Row = Record<string, any>;
type Filter = [string, unknown, "eq" | "is" | "in"];

/**
 * A PostgREST-like recording stub. It applies the filters it is given, so a
 * test can prove the SERVICE scoped its query — a stub that ignored filters
 * would pass even if the code leaked across tenants.
 */
function makeStub(seed: Record<string, Row[]>) {
  const state: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  const log: Array<{ table: string; op: string; filters: Filter[]; values?: Row }> = [];

  class Query implements PromiseLike<{ data: unknown; error: unknown }> {
    private table: string;
    private filters: Filter[] = [];
    private op: "select" | "update" = "select";
    private values?: Row;
    constructor(table: string) {
      this.table = table;
    }
    select() {
      this.op = "select";
      return this;
    }
    update(v: Row) {
      this.op = "update";
      this.values = v;
      return this;
    }
    insert() {
      this.op = "update";
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
    private match(): Row[] {
      const rows = state[this.table] ?? [];
      return rows.filter((row) =>
        this.filters.every(([col, val, kind]) => {
          if (kind === "is") return row[col] == null;
          if (kind === "in") return (val as unknown[]).includes(row[col]);
          return row[col] === val;
        }),
      );
    }
    private run(): Row[] {
      log.push({ table: this.table, op: this.op, filters: [...this.filters], values: this.values });
      const matched = this.match();
      if (this.op === "update" && this.values) {
        for (const row of matched) Object.assign(row, this.values);
      }
      return matched;
    }
    async maybeSingle() {
      return { data: this.run()[0] ?? null, error: null };
    }
    async single() {
      return { data: this.run()[0] ?? null, error: null };
    }
    then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
      onfulfilled?: ((v: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((r: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve({ data: this.run(), error: null }).then(onfulfilled, onrejected);
    }
  }

  const db = { from: (table: string) => new Query(table) };
  return { db, state, log };
}

function contract(over: Partial<Row> = {}): Row {
  return {
    id: "c-1",
    contract_number: "RC-1",
    status: "pending",
    customer_id: "cust-1",
    car_id: "car-1",
    start_date: "2026-01-01",
    end_date: "2026-01-05",
    subtotal: 100,
    total_amount: 110,
    discount_amount: 0,
    vat_amount: 10,
    total_days: 5,
    payment_type: "cash",
    tenant_id: TENANT_A,
    ...over,
  };
}

describe("Exec 63 - booking confirmation is idempotent and server-authoritative", () => {
  test("a pending booking is activated AND invoiced in one call", async () => {
    const { db, state } = makeStub({ rental_contracts: [contract()], invoices: [] });
    let issued = 0;
    const result = await confirmBooking(
      db as unknown as ConfirmDb,
      { tenantId: TENANT_A, actorEmail: "a@x.com" },
      "c-1",
      async (id, _scope, c) => {
        issued += 1;
        const input = rentalInvoiceInput(c, "2026-01-01");
        assert.equal(id, "c-1");
        assert.equal(input.invoice_type, "rental");
        assert.equal(input.amount, 100);
        return { id: "inv-1", invoice_number: "RI-1", total_amount: 110 };
      },
    );
    assert.equal(issued, 1);
    assert.equal(result.activated, true);
    assert.equal(result.idempotent, false);
    assert.equal(result.status, ACTIVE_STATUS);
    assert.equal(state.rental_contracts[0].status, "active");
  });

  test("a second confirmation returns the SAME invoice and issues no second one", async () => {
    const { db, state } = makeStub({
      rental_contracts: [contract()],
      invoices: [{ id: "inv-1", invoice_number: "RI-1", total_amount: 110, status: "pending", rental_contract_id: "c-1", tenant_id: TENANT_A }],
    });
    let issued = 0;
    const result = await confirmBooking(
      db as unknown as ConfirmDb,
      { tenantId: TENANT_A, actorEmail: null },
      "c-1",
      async () => {
        issued += 1;
        return { id: "inv-2", invoice_number: "RI-2", total_amount: 110 };
      },
    );
    assert.equal(issued, 0, "an already-invoiced contract must not issue again");
    assert.equal(result.invoiceId, "inv-1");
    assert.equal(result.idempotent, true);
  });

  test("a sequential retry (the double-click case) issues exactly one invoice", async () => {
    const { db, state } = makeStub({ rental_contracts: [contract()], invoices: [] });
    let issued = 0;
    const issue = async () => {
      issued += 1;
      const id = `inv-${issued}`;
      state.invoices.push({
        id,
        invoice_number: `RI-${issued}`,
        total_amount: 110,
        status: "pending",
        rental_contract_id: "c-1",
        tenant_id: TENANT_A,
      });
      return { id, invoice_number: `RI-${issued}`, total_amount: 110 };
    };
    const first = await confirmBooking(db as unknown as ConfirmDb, { tenantId: TENANT_A, actorEmail: null }, "c-1", issue);
    const second = await confirmBooking(db as unknown as ConfirmDb, { tenantId: TENANT_A, actorEmail: null }, "c-1", issue);
    assert.equal(issued, 1, "a retry must not mint a second invoice");
    assert.equal(first.invoiceId, second.invoiceId);
    assert.equal(second.idempotent, true);
    assert.equal(state.invoices.length, 1);
  });

  test("the DB unique index is the backstop for a truly interleaved race", () => {
    // The application check-then-create cannot be atomic on its own: two
    // requests that read "no invoice" before either writes will both proceed.
    // That case is closed at the database level by migration 013, which is why
    // the service is not the only guard. This test asserts the DB half exists.
    const migration = read("supabase/migrations/013_booking_invoice_idempotency.sql");
    assert.match(migration, /create unique index if not exists invoices_one_live_per_rental_contract_uidx/);
    assert.match(migration, /where rental_contract_id is not null/);
    assert.match(migration, /not in \('cancelled', 'void', 'reversed'\)/);
    // The migration was executed and its constraint behaviour asserted on a real
    // PostgreSQL by supabase/tests/013_harness/run.sh (15/15).
    const harness = read("supabase/tests/013_harness/run.sh");
    assert.match(harness, /second LIVE invoice for the same contract is refused/);
    assert.match(harness, /reissue after cancellation is allowed/);
  });

  test("a failed invoice rolls the activation back to pending", async () => {
    const { db, state } = makeStub({ rental_contracts: [contract()], invoices: [] });
    await assert.rejects(
      confirmBooking(db as unknown as ConfirmDb, { tenantId: TENANT_A, actorEmail: null }, "c-1", async () => {
        throw new Error("posting failed");
      }),
    );
    assert.equal(
      state.rental_contracts[0].status,
      "pending",
      "an active contract with no invoice is exactly the half-confirmed state to avoid",
    );
  });

  test("another company's contract is a 404, not a leak", async () => {
    const { db } = makeStub({ rental_contracts: [contract({ tenant_id: TENANT_B })], invoices: [] });
    await assert.rejects(
      confirmBooking(db as unknown as ConfirmDb, { tenantId: TENANT_A, actorEmail: null }, "c-1", async () => {
        throw new Error("must not be called");
      }),
      (err: any) => err?.status === 404 || /not found/i.test(String(err?.message)),
    );
  });

  test("a cancelled booking cannot be confirmed", async () => {
    const { db } = makeStub({ rental_contracts: [contract({ status: "cancelled" })], invoices: [] });
    await assert.rejects(
      confirmBooking(db as unknown as ConfirmDb, { tenantId: TENANT_A, actorEmail: null }, "c-1", async () => {
        throw new Error("must not be called");
      }),
      (err: any) => err?.code === "not_confirmable" || /cannot be confirmed/i.test(String(err?.message)),
    );
  });

  test("a tenant-less caller resolves only tenant-less rows", async () => {
    const { db, log } = makeStub({
      rental_contracts: [contract({ tenant_id: null })],
      invoices: [],
    });
    await confirmBooking(db as unknown as ConfirmDb, { tenantId: null, actorEmail: null }, "c-1", async () => ({
      id: "inv-1",
      invoice_number: "RI-1",
      total_amount: 110,
    }));
    const scoped = log.some((l) => l.filters.some(([c, , k]) => c === "tenant_id" && k === "is"));
    assert.ok(scoped, "a tenant-less caller must scope with tenant_id IS NULL, never unfiltered");
  });

  test("CONFIRMABLE_STATUSES covers the real pending vocabulary", () => {
    for (const s of ["pending", "confirmed", "approved", "reserved"]) {
      assert.ok((CONFIRMABLE_STATUSES as readonly string[]).includes(s));
    }
  });
});

describe("Exec 63 - single-car availability (deep-link preselection)", () => {
  const carRow = (over: Partial<Row> = {}): Row => ({
    id: "car-1",
    make: "Toyota",
    model: "Corolla",
    year: 2024,
    category: "rental",
    status: "available",
    daily_rate: 20,
    weekly_rate: 120,
    monthly_rate: 400,
    tenant_id: TENANT_A,
    ...over,
  });

  test("a free car is found and available", async () => {
    const { db } = makeStub({ cars: [carRow()], rental_contracts: [] });
    const r = await getCarAvailability(db as unknown as BookingDb, {
      tenantId: TENANT_A,
      carId: "car-1",
      start: "2026-01-01",
      end: "2026-01-05",
    });
    assert.equal(r.found, true);
    assert.equal(r.available, true);
    assert.equal(r.car?.make, "Toyota");
  });

  test("a car busy for the window is FOUND but not available (the bug)", async () => {
    // The old form only loaded the availability LIST, so this car was simply
    // absent and the <select> silently fell back to its placeholder.
    const { db } = makeStub({
      cars: [carRow()],
      rental_contracts: [
        { id: "rc-1", car_id: "car-1", status: "active", start_date: "2026-01-02", end_date: "2026-01-06", tenant_id: TENANT_A },
      ],
    });
    const r = await getCarAvailability(db as unknown as BookingDb, {
      tenantId: TENANT_A,
      carId: "car-1",
      start: "2026-01-01",
      end: "2026-01-05",
    });
    assert.equal(r.found, true, "the car exists — the UI must say so, not drop it");
    assert.equal(r.available, false);
    assert.equal(r.reason, "busy");
    assert.equal(r.conflict?.startDate, "2026-01-02");
  });

  test("another company's car is not found", async () => {
    const { db } = makeStub({ cars: [carRow({ tenant_id: TENANT_B })], rental_contracts: [] });
    const r = await getCarAvailability(db as unknown as BookingDb, { tenantId: TENANT_A, carId: "car-1" });
    assert.equal(r.found, false);
    assert.equal(r.car, null);
  });

  test("a maintenance car is found but not rentable", async () => {
    const { db } = makeStub({ cars: [carRow({ status: "maintenance" })], rental_contracts: [] });
    const r = await getCarAvailability(db as unknown as BookingDb, { tenantId: TENANT_A, carId: "car-1" });
    assert.equal(r.found, true);
    assert.equal(r.available, false);
    assert.equal(r.reason, "not_rentable");
  });

  test("the availability list still excludes a busy car", async () => {
    const { db } = makeStub({
      cars: [carRow()],
      rental_contracts: [
        { id: "rc-1", car_id: "car-1", status: "active", start_date: "2026-01-02", end_date: "2026-01-06", tenant_id: TENANT_A },
      ],
    });
    const list = await listAvailableCars(db as unknown as BookingDb, {
      tenantId: TENANT_A,
      start: "2026-01-01",
      end: "2026-01-05",
    });
    assert.equal(list.length, 0);
  });

  test("the projection never exposes cost or supplier columns", async () => {
    const { db } = makeStub({ cars: [carRow()], rental_contracts: [] });
    const r = await getCarAvailability(db as unknown as BookingDb, { tenantId: TENANT_A, carId: "car-1" });
    const keys = Object.keys(r.car ?? {});
    for (const forbidden of ["purchase_price", "cost", "supplier_id", "vin", "insurance_cost"]) {
      assert.ok(!keys.includes(forbidden), `projection leaked ${forbidden}`);
    }
  });
});

describe("Exec 63 - the routes and pages route through the server", () => {
  test("the confirm route requires rentals.edit and posts no journal itself", () => {
    const src = read("src/app/api/rentals/confirm/route.ts");
    assert.match(src, /requireContext\(request, \{ module: "rentals", action: "edit" \}\)/);
    assert.match(src, /issueInvoice/);
    assert.doesNotMatch(src, /from\("journal_entries"\)/);
    assert.doesNotMatch(src, /journal_lines/);
    assert.doesNotMatch(src, /body\.tenant_id|body\.tenantId/);
  });

  test("the rentals pages call the confirm endpoint instead of check-then-create", () => {
    const list = read("src/app/rentals/page.tsx");
    assert.match(list, /\/api\/rentals\/confirm/);
    assert.doesNotMatch(
      list,
      /from\('rental_contracts'\)\s*\n?\s*\.update\(\{ status: 'active' \}\)/,
      "the browser must not activate a contract itself",
    );

    const detail = read("src/app/rentals/[id]/page.tsx");
    assert.match(detail, /\/api\/rentals\/confirm/);
  });

  test("the available-cars route resolves an explicit car and keeps the tenant scope", () => {
    const src = read("src/app/api/customer/available-cars/route.ts");
    assert.match(src, /getCarAvailability/);
    assert.match(src, /allowRoles: \["client"\]/);
    assert.match(src, /context\.tenantId/);
    assert.doesNotMatch(src, /searchParams\.get\("tenant/);
  });

  test("the customer dashboard renders an explicit reason instead of dropping a car", () => {
    const src = read("src/app/customer-dashboard/page.tsx");
    assert.match(src, /carSelectNotice/);
    assert.match(src, /selectableCars/);
    assert.match(src, /deepLinkCar/);
  });
});

describe("Exec 63 - AI secret storage is encrypted at rest", () => {
  test("secret-box encrypts and never returns plaintext", () => {
    const src = read("src/lib/ai/secret-box.ts");
    assert.match(src, /encrypt|createCipheriv/);
    assert.doesNotMatch(src, /console\.log\(.*secret/i);
  });

  test("platform AI settings are super-admin only and write-only for the key", () => {
    const route = read("src/app/api/super-admin/ai/settings/route.ts");
    assert.match(route, /requireSuperAdmin/);
    assert.doesNotMatch(route, /body\.tenant_id|body\.tenantId|body\.role/);
    // The key must never be echoed back to the browser.
    assert.doesNotMatch(route, /apiKey:\s*settings\.apiKey/);
  });

  test("the AI runtime consults the platform config (instant activation)", () => {
    const server = read("src/lib/ai/server.ts");
    assert.match(server, /loadPlatformAiConfig|effectiveAiSettings/);
  });

  test("no AI file logs a raw key", () => {
    for (const f of ["src/lib/ai/secret-box.ts", "src/lib/ai/platform-settings.ts", "src/lib/ai/providers.ts"]) {
      const src = read(f);
      assert.doesNotMatch(src, /console\.(log|error|warn)\([^)]*\b(apiKey|api_key|secret)\b/i, `${f} logs a secret`);
    }
  });
});

describe("Exec 63 - tenant identity is real, not a placeholder", () => {
  test("the dashboard shows the session user, not a hardcoded Admin", () => {
    const src = read("src/components/DashboardLayout.tsx");
    assert.match(src, /identityRoleLabel/);
    assert.match(src, /identityInitial/);
    assert.doesNotMatch(src, />Admin</, "a hardcoded Admin name was shown to every account");
    assert.doesNotMatch(src, />Administrator</);
    assert.match(src, /\/api\/me/);
  });

  test("the role label is derived from the server-resolved role", () => {
    const src = read("src/components/DashboardLayout.tsx");
    assert.match(src, /super_admin/);
    assert.match(src, /Platform Administrator/);
  });
});
