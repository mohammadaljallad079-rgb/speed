import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildMonthlyReceipts,
  buildMonthlyInvoices,
  buildRentedVehicles,
  buildOutstandingByClient,
  loadOperationsReport,
  isOperationsReportKind,
  monthKey,
  type OperationsReportKind,
} from "../src/lib/reporting/operations-reports.ts";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// Recording PostgREST-like stub (applies the filters it is given).
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
class FakeQuery implements PromiseLike<{ data: Row[] | null; error: unknown }> {
  rows: Row[];
  filters: { col: string; op: string; val: unknown }[] = [];
  constructor(rows: Row[]) { this.rows = rows; }
  select() { return this; }
  eq(col: string, val: string) { this.filters.push({ col, op: "eq", val }); return this; }
  gte(col: string, val: string) { this.filters.push({ col, op: "gte", val }); return this; }
  lte(col: string, val: string) { this.filters.push({ col, op: "lte", val }); return this; }
  private apply(): Row[] {
    return this.rows.filter((r) => this.filters.every((f) => {
      const v = r[f.col];
      if (f.op === "eq") return String(v) === String(f.val);
      if (f.op === "gte") return String(v) >= String(f.val);
      if (f.op === "lte") return String(v) <= String(f.val);
      return true;
    }));
  }
  then<R1, R2 = never>(onF: ((v: { data: Row[] | null; error: unknown }) => R1 | PromiseLike<R1>) | null, onR?: ((r: unknown) => R2 | PromiseLike<R2>) | null) {
    return Promise.resolve({ data: this.apply(), error: null }).then(onF, onR);
  }
}
class FakeDb {
  tables: Record<string, Row[]>;
  seen: { table: string; filters: { col: string; op: string; val: unknown }[] }[] = [];
  constructor(tables: Record<string, Row[]>) { this.tables = tables; }
  from(table: string) {
    const q = new FakeQuery(this.tables[table] ?? []);
    const rec = { table, filters: q.filters };
    this.seen.push(rec);
    return q;
  }
}

const db = (tables: Record<string, Row[]>) => new FakeDb(tables) as unknown as Parameters<typeof loadOperationsReport>[0];

// ---------------------------------------------------------------------------

describe("monthKey", () => {
  test("buckets ISO dates and rejects junk", () => {
    assert.equal(monthKey("2026-03-15"), "2026-03");
    assert.equal(monthKey("2026-03-15T10:00:00Z"), "2026-03");
    assert.equal(monthKey(""), "");
    assert.equal(monthKey(null), "");
    assert.equal(monthKey("not-a-date"), "");
  });
});

describe("buildMonthlyReceipts", () => {
  test("groups by month, sums amounts, excludes cancelled", () => {
    const r = buildMonthlyReceipts([
      { payment_date: "2026-01-05", amount: 100, status: "completed" },
      { payment_date: "2026-01-20", amount: 50.5, status: "completed" },
      { payment_date: "2026-02-01", amount: 200, status: "completed" },
      { payment_date: "2026-02-02", amount: 999, status: "cancelled" },
    ]);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[0], { month: "2026-01", receipts: 2, total: 150.5 });
    assert.deepEqual(r.rows[1], { month: "2026-02", receipts: 1, total: 200 });
    assert.equal(r.totals.receipts, 3);
    assert.equal(r.totals.total, 350.5);
  });
});

describe("buildMonthlyInvoices", () => {
  test("totals gross and net-of-VAT per month, excludes cancelled", () => {
    const r = buildMonthlyInvoices([
      { invoice_date: "2026-03-01", total_amount: 110, vat_amount: 10, status: "issued" },
      { invoice_date: "2026-03-15", total_amount: 55, vat_amount: 5, status: "paid" },
      { invoice_date: "2026-04-01", total_amount: 220, vat_amount: 20, status: "cancelled" },
    ]);
    assert.equal(r.rows.length, 1);
    assert.deepEqual(r.rows[0], { month: "2026-03", invoices: 2, total: 165, net: 150 });
    assert.equal(r.totals.net, 150);
    assert.equal(r.totals.total, 165);
  });

  test("falls back to amount when total_amount missing", () => {
    const r = buildMonthlyInvoices([{ invoice_date: "2026-05-01", amount: 100, vat_amount: 10 }]);
    assert.equal(r.rows[0].total, 100);
    assert.equal(r.rows[0].net, 90);
  });
});

describe("buildRentedVehicles", () => {
  test("keeps only cars with status 'rented'", () => {
    const r = buildRentedVehicles([
      { plate_number: "B2", make: "Toyota", model: "Corolla", status: "rented", daily_rate: 10 },
      { plate_number: "A1", make: "Kia", model: "Rio", status: "available", daily_rate: 8 },
      { plate_number: "C3", make: "Honda", model: "Civic", status: "RENTED", daily_rate: 12 },
    ]);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows.map((x) => x.plate_number), ["B2", "C3"]);
    assert.equal(r.totals.vehicles, 2);
  });
});

describe("buildOutstandingByClient", () => {
  test("keeps only positive balances, groups by customer, resolves names", () => {
    const r = buildOutstandingByClient(
      [
        { customer_id: "c1", total_amount: 100, paid_amount: 40, status: "issued" },
        { customer_id: "c1", total_amount: 50, paid_amount: 50, status: "paid" }, // settled -> dropped
        { customer_id: "c2", total_amount: 300, paid_amount: 0, status: "issued" },
        { customer_id: "c3", total_amount: 80, paid_amount: 0, status: "cancelled" }, // dropped
      ],
      [{ id: "c1", full_name: "Ali" }, { id: "c2", full_name: "Sara" }],
    );
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0].client, "Sara");
    assert.equal(r.rows[0].outstanding, 300);
    assert.equal(r.rows[1].client, "Ali");
    assert.equal(r.rows[1].outstanding, 60);
    assert.equal(r.totals.outstanding, 360);
  });
});

describe("loadOperationsReport — scoping", () => {
  test("applies tenant filter and date range on payments", async () => {
    const fdb = new FakeDb({
      payments: [
        { payment_date: "2026-01-05", amount: 100, status: "completed", tenant_id: "t1" },
        { payment_date: "2026-01-06", amount: 500, status: "completed", tenant_id: "t2" },
      ],
    });
    const r = await loadOperationsReport(fdb as never, "monthly_receipts", { tenantId: "t1" });
    assert.equal(r.totals.total, 100);
    const rec = fdb.seen.find((s) => s.table === "payments")!;
    assert.ok(rec.filters.some((f) => f.col === "tenant_id" && f.op === "eq" && f.val === "t1"));
  });

  test("date range is applied to invoices but not to cars", async () => {
    const fdb = new FakeDb({
      cars: [{ plate_number: "A1", status: "rented", tenant_id: "t1" }],
    });
    await loadOperationsReport(fdb as never, "rented_vehicles", { tenantId: "t1", from: "2026-01-01", to: "2026-12-31" });
    const carRec = fdb.seen.find((s) => s.table === "cars")!;
    assert.ok(!carRec.filters.some((f) => f.op === "gte" || f.op === "lte"));
    assert.ok(carRec.filters.some((f) => f.col === "tenant_id" && f.val === "t1"));
  });

  test("outstanding reads invoices + customers, both tenant-scoped", async () => {
    const fdb = new FakeDb({
      invoices: [{ customer_id: "c1", total_amount: 100, paid_amount: 0, status: "issued", tenant_id: "t1" }],
      customers: [{ id: "c1", full_name: "Ali", tenant_id: "t1" }],
    });
    const r = await loadOperationsReport(fdb as never, "outstanding_by_client", { tenantId: "t1" });
    assert.equal(r.rows[0].client, "Ali");
    for (const table of ["invoices", "customers"]) {
      const rec = fdb.seen.find((s) => s.table === table)!;
      assert.ok(rec.filters.some((f) => f.col === "tenant_id" && f.val === "t1"), `${table} not tenant-scoped`);
    }
  });

  test("customers projection only names real columns (no phantom `name`)", async () => {
    const src = read("src/lib/reporting/operations-reports.ts");
    // The live `customers` table has `full_name` but no `name` column; selecting a
    // non-existent column makes PostgREST return an error (HTTP 400/500).
    assert.match(src, /"customers", "id,full_name"/);
    assert.ok(!/"customers", "[^"]*\bname\b[^"]*full_name[^"]*"/.test(src));
    assert.ok(!/select\([^)]*\bname\b[^)]*full_name/.test(src));
  });
});

describe("isOperationsReportKind", () => {
  test("accepts the four kinds and rejects others", () => {
    const good: OperationsReportKind[] = ["monthly_receipts", "monthly_invoices", "rented_vehicles", "outstanding_by_client"];
    for (const k of good) assert.ok(isOperationsReportKind(k));
    assert.ok(!isOperationsReportKind("vat_report"));
    assert.ok(!isOperationsReportKind(""));
  });
});

describe("wiring: pages and route", () => {
  test("each of the four pages renders the operations report component", () => {
    const pages: [string, string][] = [
      ["src/app/reports/monthly-receipts/page.tsx", "monthly_receipts"],
      ["src/app/reports/monthly-invoices/page.tsx", "monthly_invoices"],
      ["src/app/reports/rented-vehicles/page.tsx", "rented_vehicles"],
      ["src/app/reports/outstanding-by-client/page.tsx", "outstanding_by_client"],
    ];
    for (const [rel, kind] of pages) {
      const src = read(rel);
      assert.match(src, /OperationsReportPage/, `${rel} must use the shared component`);
      assert.match(src, new RegExp(`kind="${kind}"`), `${rel} must pass kind=${kind}`);
      assert.ok(!/StructuredEmptyState/.test(src), `${rel} must no longer be an empty placeholder`);
    }
  });

  test("the operations API route is guarded by reports.view", () => {
    const src = read("src/app/api/reports/operations/route.ts");
    assert.match(src, /requireContext\(request, \{ module: "reports", action: "view" \}\)/);
    assert.match(src, /tenantId: context\.tenantId/);
  });

  test("the route never reads a tenant from the request (no tenant_id injection)", () => {
    const src = read("src/app/api/reports/operations/route.ts");
    const params = [...src.matchAll(/searchParams\.get\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual(params.sort(), ["from", "kind", "to"]);
    assert.ok(!/searchParams\.get\("tenant/i.test(src), "tenant must never come from the query string");
  });

  test("the client component sends no tenant identifier", () => {
    const src = read("src/components/reports/OperationsReportPage.tsx");
    assert.ok(!/tenant/i.test(src), "client must not send a tenant identifier");
  });
});
