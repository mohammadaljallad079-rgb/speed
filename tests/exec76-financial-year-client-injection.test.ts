import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { issueInvoice } from "../src/lib/sales/service.ts";
import { createSalesReturn } from "../src/lib/sales/return-service.ts";
import { getActiveFinancialYear } from "../src/lib/auth/context.ts";

/**
 * Execution 76 - the financial-year lookup must use the caller's client.
 *
 * THE DEFECT THIS SUITE PINS DOWN
 * -------------------------------
 * `createSalesReturn` and `issueInvoice` both take an injected database client,
 * and every other read and write in them goes through it. The financial-year
 * lookup did not: `getActiveFinancialYear` read the GLOBAL `supabaseAdmin`.
 *
 * Two consequences, both real:
 *
 *   1. Neither service could be run without real Supabase credentials, so their
 *      tests failed with "Missing Supabase service role configuration" instead of
 *      exercising the code.
 *   2. Worse, when placeholder credentials WERE present the lookup made a real
 *      network call that failed silently, `getActiveFinancialYear` returned null,
 *      and `assertDateInOpenFinancialYear` SKIPPED its check. The financial-year
 *      guard was therefore not being exercised at all - the tests passed without
 *      ever proving the guard works.
 *
 * The fix threads the injected client into the lookup. The tests below prove the
 * guard is now genuinely live by driving a real financial year through the stub,
 * and they fail if the lookup ever reaches outside the injected client again.
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const T = "tttttttt-0000-0000-0000-000000000076";
const CUSTOMER = "cust-0076";

function ctx(tenantId: string | null) {
  return {
    userId: "u-76",
    tenantId,
    branchId: null,
    financialYearId: null,
    role: "admin",
    permissions: {},
    isSuperAdmin: false,
  } as never;
}

/**
 * A recording PostgREST stub that applies the filters it is given and returns only
 * the rows that match - the same shape the other accounting suites use.
 */
function makeDb(opts: { year?: Record<string, unknown> | null } = {}) {
  const rows: Record<string, any[]> = {
    financial_years: opts.year === null ? [] : [opts.year ?? {
      id: "fy-2026",
      name: "2026",
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      is_current: true,
      status: "open",
      tenant_id: T,
    }],
    customers: [{ id: CUSTOMER, tenant_id: T, name: "Acme" }],
    accounts: [
      { id: "acct-11001", code: "11001", tenant_id: T, is_active: true, is_postable: true },
      { id: "acct-11002", code: "11002", tenant_id: T, is_active: true, is_postable: true },
      { id: "acct-12001", code: "12001", tenant_id: T, is_active: true, is_postable: true },
      { id: "acct-41002", code: "41002", tenant_id: T, is_active: true, is_postable: true },
      { id: "acct-41001", code: "41001", tenant_id: T, is_active: true, is_postable: true },
      { id: "acct-24000", code: "24000", tenant_id: T, is_active: true, is_postable: true },
    ],
    invoices: [],
    payments: [],
    sales_returns: [],
    journal_entries: [],
    journal_lines: [],
  };
  let seq = 0;
  const calls: string[] = [];

  class Q {
    table: string;
    op = "select";
    eqs: [string, any][] = [];
    iss: [string, any][] = [];
    row: any = null;
    constructor(t: string) {
      this.table = t;
    }
    select() {
      return this;
    }
    eq(c: string, v: any) {
      this.eqs.push([c, v]);
      return this;
    }
    is(c: string, v: any) {
      this.iss.push([c, v]);
      return this;
    }
    in() {
      return this;
    }
    or() {
      return this;
    }
    limit() {
      return this;
    }
    order() {
      return this;
    }
    insert(r: any) {
      this.op = "insert";
      this.row = r;
      return this;
    }
    update(r: any) {
      this.op = "update";
      this.row = r;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    _match(r: any) {
      if (!this.eqs.every(([c, v]) => r[c] === v)) return false;
      return this.iss.every(([c, v]) => (v === null ? r[c] == null : r[c] === v));
    }
    async _run() {
      calls.push(`${this.op} ${this.table}`);
      const table = rows[this.table] ?? (rows[this.table] = []);
      if (this.op === "select") return { data: table.filter((r) => this._match(r)), error: null };
      if (this.op === "insert") {
        const incoming = Array.isArray(this.row) ? this.row : [this.row];
        const created = incoming.map((r) => ({ id: `${this.table}-${++seq}`, ...r }));
        created.forEach((r) => table.push(r));
        return { data: Array.isArray(this.row) ? created : created[0], error: null };
      }
      if (this.op === "update") {
        table.filter((r) => this._match(r)).forEach((r) => Object.assign(r, this.row));
        return { data: null, error: null };
      }
      if (this.op === "delete") {
        for (let i = table.length - 1; i >= 0; i--) if (this._match(table[i])) table.splice(i, 1);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    single() {
      return this._single();
    }
    maybeSingle() {
      return this._single();
    }
    async _single() {
      const res = await this._run();
      const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
      return { data, error: res.error };
    }
    then(f: any, r: any) {
      return this._run().then(f, r);
    }
  }

  const rpc = async (fn: string, args: Record<string, any> = {}) => {
    calls.push(`rpc ${fn}`);
    if (fn === "generate_document_number") return { data: `DOC-${++seq}`, error: null };
    if (fn === "post_journal_entry") {
      const header = args.p_header ?? {};
      const jlines = (args.p_lines ?? []) as any[];
      const debit = jlines.reduce((n, l) => n + (Number(l.debit) || 0), 0);
      const credit = jlines.reduce((n, l) => n + (Number(l.credit) || 0), 0);
      if (Math.round(debit * 1000) !== Math.round(credit * 1000)) {
        return { data: null, error: { code: "23514", message: "journal does not balance" } };
      }
      const entry = { id: `je-${++seq}`, status: "posted", ...header };
      rows.journal_entries.push(entry);
      jlines.forEach((l) => rows.journal_lines.push({ id: `jl-${++seq}`, ...l, journal_entry_id: entry.id }));
      return { data: entry.id, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } };
  };

  return { client: { from: (t: string) => new Q(t), rpc }, rows, calls };
}

// ---------------------------------------------------------------------------
// The lookup itself
// ---------------------------------------------------------------------------

describe("exec76 getActiveFinancialYear uses the client it is given", () => {
  test("reads the year through the injected client, never the global one", async () => {
    const db = makeDb();
    const year = await getActiveFinancialYear(T, db.client as never);
    assert.ok(year, "the injected client must be consulted");
    assert.equal(year!.name, "2026");
    assert.ok(
      db.calls.some((c) => c === "select financial_years"),
      "the lookup must run against the injected client",
    );
  });

  test("returns null when the injected client has no year for the tenant", async () => {
    const db = makeDb({ year: null });
    assert.equal(await getActiveFinancialYear(T, db.client as never), null);
  });

  test("scopes the lookup by tenant when one is given", async () => {
    const db = makeDb();
    await getActiveFinancialYear("other-tenant", db.client as never);
    // The stub applies the filter, so a foreign tenant finds no year.
    assert.equal(await getActiveFinancialYear("other-tenant", db.client as never), null);
  });
});

// ---------------------------------------------------------------------------
// issueInvoice
// ---------------------------------------------------------------------------

describe("exec76 issueInvoice resolves the financial year through its client", () => {
  test("issues an invoice against a stub with no credentials (runs offline)", async () => {
    const db = makeDb();
    const result = await issueInvoice(db.client as never, ctx(T), {
      customer_id: CUSTOMER,
      amount: 110,
      vat: 10,
      invoice_number: "SI-76-1",
      invoice_date: "2026-03-10",
    });
    assert.equal(result.invoice_number, "SI-76-1");
    // `amount` is the pre-VAT base, so the total carries the VAT: 110 + 10 = 120.
    assert.equal(result.total_amount, 120);
    assert.equal(db.rows.invoices.length, 1, "exactly one invoice row");
    assert.equal(db.rows.journal_entries.length, 1, "exactly one journal");
  });

  test("refuses an invoice dated OUTSIDE the active year (guard is live)", async () => {
    const db = makeDb();
    await assert.rejects(
      () =>
        issueInvoice(db.client as never, ctx(T), {
          customer_id: CUSTOMER,
          amount: 110,
          invoice_number: "SI-76-OUT",
          invoice_date: "2027-06-01",
        }),
      /outside the active financial year/i,
    );
    assert.equal(db.rows.invoices.length, 0, "nothing may be written outside the year");
  });

  test("refuses an invoice into a CLOSED year (guard is live)", async () => {
    const db = makeDb({ year: { ...makeDb().rows.financial_years[0], status: "closed" } });
    await assert.rejects(
      () =>
        issueInvoice(db.client as never, ctx(T), {
          customer_id: CUSTOMER,
          amount: 110,
          invoice_number: "SI-76-CLOSED",
          invoice_date: "2026-03-10",
        }),
      /closed/i,
    );
    assert.equal(db.rows.invoices.length, 0);
  });

  test("an install with NO financial year still issues (backward compatible)", async () => {
    const db = makeDb({ year: null });
    const result = await issueInvoice(db.client as never, ctx(T), {
      customer_id: CUSTOMER,
      amount: 110,
      invoice_number: "SI-76-NOYEAR",
      invoice_date: "2026-03-10",
    });
    assert.equal(result.invoice_number, "SI-76-NOYEAR");
    assert.equal(db.rows.invoices.length, 1);
  });
});

// ---------------------------------------------------------------------------
// createSalesReturn - the reported failure
// ---------------------------------------------------------------------------

describe("exec76 createSalesReturn resolves the financial year through its client", () => {
  function dbWithInvoice(year?: Record<string, unknown> | null) {
    const db = makeDb({ year });
    db.rows.invoices.push({
      id: "inv-76",
      invoice_number: "INV-76",
      customer_id: CUSTOMER,
      paid_amount: 99,
      total_amount: 99,
      status: "paid",
      tenant_id: T,
    });
    return db;
  }

  test("records a return against a stub with no credentials (runs offline)", async () => {
    const db = dbWithInvoice();
    const result = await createSalesReturn(db.client as never, ctx(T), {
      invoice_id: "inv-76",
      return_number: "SR-76-1",
      return_date: "2026-03-10",
      amount: 99,
    });
    assert.equal(result.amount, 99);
    assert.equal(db.rows.sales_returns.length, 1);
    assert.equal(db.rows.invoices[0].paid_amount, 0);
    assert.equal(db.rows.journal_entries.length, 1, "the return posts one journal");
  });

  test("refuses a return dated OUTSIDE the active year (guard is live)", async () => {
    const db = dbWithInvoice();
    await assert.rejects(
      () =>
        createSalesReturn(db.client as never, ctx(T), {
          invoice_id: "inv-76",
          return_number: "SR-76-OUT",
          return_date: "2027-06-01",
          amount: 10,
        }),
      /outside the active financial year/i,
    );
    assert.equal(db.rows.sales_returns.length, 0);
  });
});

// ---------------------------------------------------------------------------
// The boundary is enforced structurally, so it cannot silently reopen
// ---------------------------------------------------------------------------

describe("exec76 neither sales service reaches outside its injected client", () => {
  for (const file of ["src/lib/sales/return-service.ts", "src/lib/sales/service.ts"]) {
    test(`${file} does not reference the global admin client`, () => {
      const src = read(file);
      assert.doesNotMatch(
        src,
        /supabaseAdmin/,
        `${file} must resolve the year through its injected client, not the global one`,
      );
    });
  }

  test("getActiveFinancialYear takes the client as an injectable parameter", () => {
    const src = read("src/lib/auth/context.ts");
    const fn = /export async function getActiveFinancialYear\(([\s\S]*?)\n\}/.exec(src);
    assert.ok(fn, "getActiveFinancialYear must exist");
    assert.match(fn![1], /db:\s*FinancialYearDb\s*=\s*supabaseAdmin/, "the client must be a parameter");
    assert.match(fn![1], /db\s*\.from\("financial_years"\)|db\s*\n\s*\.from\("financial_years"\)/, "the query must use the parameter");
  });

  test("both services thread the client they were given into the lookup", () => {
    for (const file of ["src/lib/sales/return-service.ts", "src/lib/sales/service.ts"]) {
      const src = read(file);
      assert.match(
        src,
        /getActiveFinancialYear\(\s*tid,\s*client/,
        `${file} must pass the injected client into the year lookup`,
      );
      assert.match(src, /deps\.getYear/, `${file} must keep the lookup overridable`);
    }
  });
});
