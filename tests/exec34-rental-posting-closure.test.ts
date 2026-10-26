import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  assertDateInOpenFinancialYear,
  assertWritableTenant,
  can,
} from "../src/lib/auth/policy.ts";
import { DEFAULT_ROLE_PERMISSIONS } from "../src/lib/auth/permissions.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";
import {
  buildSaleJournal,
  postSaleInvoice,
  SALE_ACCOUNT_CODES,
  type PostingClient,
} from "../src/lib/accounting/sales-posting.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Exec 34 - the rental posting gap is closed.
 *
 * `rentals/new` (and the extension page) used to write the invoice, the
 * receipt and the journal from the browser. They now go through the single
 * server posting path (`POST /api/invoices`). These tests pin both the wiring
 * and the money/authorization behaviour that path must guarantee.
 */

function context(role: AuthContext["role"], overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    authUserId: "00000000-0000-0000-0000-000000000001",
    email: "user@example.com",
    fullName: "Test User",
    role,
    tenantId: null,
    customerId: null,
    branchIds: null,
    financialYearId: null,
    permissions: DEFAULT_ROLE_PERMISSIONS[role],
    isAdmin: role === "admin" || role === "super_admin",
    isSuperAdmin: role === "super_admin",
    ...overrides,
  };
}

/** Minimal PostgREST-like stub: accounts by code, journal_entries with an
 *  idempotency guard on entry_type+reference_number, and journal_lines. */
function makeStub(seed: { failLines?: boolean } = {}) {
  const accounts = [
    { id: "acc-cash", code: "11001" },
    { id: "acc-bank", code: "11002" },
    { id: "acc-ar", code: "12001" },
    { id: "acc-rev", code: "41002" },
    { id: "acc-rental", code: "41001" },
    { id: "acc-vat", code: "24000" },
  ];
  const entries: any[] = [];
  const lines: any[] = [];
  let seq = 0;
  class Q {
    table: string;
    op = "select";
    filters: [string, any][] = [];
    isFilters: [string, any][] = [];
    orFilter: string | null = null;
    inVals: any[] | null = null;
    row: any = null;
    constructor(t: string) { this.table = t; }
    select() { return this; }
    eq(c: string, v: any) { this.filters.push([c, v]); return this; }
    is(c: string, v: any) { this.isFilters.push([c, v]); return this; }
    or(f: string) { this.orFilter = f; return this; }
    in(_c: string, v: any[]) { this.inVals = v; return this; }
    _tenantMatch(a: any): boolean {
      // `IS NULL` must match a missing field too: a stub row with no tenant_id
      // is the NULL tenant, exactly as the database sees it.
      if (this.isFilters.length) {
        return this.isFilters.every(([c, v]) => (v === null ? a[c] == null : a[c] === v));
      }
      if (this.orFilter) {
        return this.orFilter.split(",").some((part) => {
          const m = /tenant_id\.eq\.(.+)/.exec(part);
          if (m) return a.tenant_id === m[1];
          if (part.includes("tenant_id.is.null")) return a.tenant_id == null;
          return false;
        });
      }
      return true;
    }
    limit() { return this; }
    insert(r: any) { this.op = "insert"; this.row = r; return this; }
    delete() { this.op = "delete"; return this; }
    async _run(): Promise<{ data: any; error: any }> {
      if (this.op === "select") {
        if (this.table === "accounts") {
          const byCode = accounts.filter((a) => (this.inVals ?? []).includes(a.code));
          return { data: byCode.filter((a) => this._tenantMatch(a)), error: null };
        }
        if (this.table === "journal_entries") {
          const rows = entries.filter((r) => this.filters.every(([c, v]) => r[c] === v));
          return { data: rows, error: null };
        }
        return { data: [], error: null };
      }
      if (this.op === "insert") {
        const rows = Array.isArray(this.row) ? this.row : [this.row];
        if (this.table === "journal_entries") {
          const r = { id: `je-${++seq}`, ...rows[0] };
          const clash = entries.find((e) => e.entry_type === r.entry_type && e.reference_number === r.reference_number);
          if (clash) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
          entries.push(r);
          return { data: [r], error: null };
        }
        if (this.table === "journal_lines") {
          if (seed.failLines) return { data: null, error: { message: "line insert failed" } };
          rows.forEach((l) => lines.push(l));
          return { data: rows, error: null };
        }
      }
      if (this.op === "delete") {
        const idx = entries.findIndex((e) => this.filters.every(([c, v]) => e[c] === v));
        if (idx >= 0) entries.splice(idx, 1);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    async single() { const r = await this._run(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; }
    async maybeSingle() { return this.single(); }
    then(res: any, rej: any) { return this._run().then(res, rej); }
  }
  return { client: { from: (t: string) => new Q(t) } as unknown as PostingClient, entries, lines };
}

const ACCOUNTS = {
  revenueAccountId: "acc-rental",
  vatAccountId: "acc-vat",
  arAccountId: "acc-ar",
  cashAccountId: "acc-cash",
};

describe("Exec 34 - the rental form no longer writes finance from the browser", () => {
  const rentalNew = read("src/app/rentals/new/page.tsx");
  const extend = read("src/app/rentals/[id]/extend/page.tsx");

  test("rentals/new issues the invoice through POST /api/invoices", () => {
    assert.match(rentalNew, /fetch\("\/api\/invoices"/, "must post through the server API");
    assert.match(rentalNew, /invoice_type:\s*"rental"/, "must declare a rental invoice");
  });

  test("rentals/new no longer inserts invoices, payments or journals itself", () => {
    assert.doesNotMatch(rentalNew, /from\("invoices"\)\s*\.insert/, "no browser invoice insert");
    assert.doesNotMatch(rentalNew, /from\("payments"\)\s*\.insert/, "no browser receipt insert");
    assert.doesNotMatch(rentalNew, /from\("journal_entries"\)\s*\.insert/, "no browser journal header");
    assert.doesNotMatch(rentalNew, /from\("journal_lines"\)\s*\.insert/, "no browser journal lines");
    assert.doesNotMatch(rentalNew, /generate_document_number/, "the browser must not allocate numbers");
  });

  test("the rental extension page posts through the server too", () => {
    assert.match(extend, /fetch\('\/api\/invoices'/, "must post through the server API");
    assert.doesNotMatch(extend, /from\('invoices'\)\s*\.insert/, "no browser invoice insert");
    assert.doesNotMatch(extend, /'EXT-'\s*\+\s*Date\.now\(\)/, "no timestamp invoice number");
  });

  test("the rental contract is tenant-scoped from the session", () => {
    assert.match(rentalNew, /auth\.getUser\(\)/, "must read the authenticated user");
    assert.match(rentalNew, /tenant_id: tenantId/, "must set tenant_id on the contract");
  });

  test("no page writes an invoice directly any more", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".tsx") && /from\(["']invoices["']\)\s*\.insert/.test(fs.readFileSync(p, "utf8"))) {
          offenders.push(path.relative(ROOT, p));
        }
      }
    };
    walk(path.join(ROOT, "src/app"));
    assert.deepEqual(offenders, [], `these pages still insert invoices directly: ${offenders.join(", ")}`);
  });
});

describe("Exec 34 - the invoice API owns identity, tenant and idempotency", () => {
  const route = read("src/app/api/invoices/route.ts") + read("src/lib/sales/service.ts");

  test("authenticates and derives identity from the session", () => {
    assert.match(route, /requireContext\(request, \{ module: "sales", action: "create" \}/);
    assert.match(route, /assertReferences\(/, "cross-tenant FK check");
    assert.match(route, /assertWritableTenant\(/, "tenant comes from the session");
  });

  test("a rental is idempotent per contract", () => {
    assert.match(route, /eq\("rental_contract_id", (body|input)\.rental_contract_id\)/);
    assert.match(route, /idempotent:\s*true/, "a retry returns the existing invoice");
    assert.match(route, /invoice_type", "rental"/, "the guard is scoped to rental invoices");
  });

  test("paid amount and status are derived, never trusted", () => {
    assert.match(route, /const paidAmount = round3\(/);
    assert.match(route, /remainingAfterPaid/);
    assert.doesNotMatch(route, /paid_amount:\s*0,\n\s*payment_method/, "must not hard-code paid_amount: 0");
  });

  test("a posting failure removes both the invoice and its journal", () => {
    assert.match(route, /createdJournalId/);
    assert.match(route, /journal_lines"\)\s*\.delete\(\)\.eq\("journal_entry_id", createdJournalId\)/);
    assert.match(route, /journal_entries"\)\s*\.delete\(\)\.eq\("id", createdJournalId\)/);
    assert.match(route, /invoices"\)\s*\.delete\(\)\.eq\("id", createdInvoiceId\)/);
  });

  test("supports the rental extension type on the same path", () => {
    assert.match(route, /isExtension/);
    assert.match(route, /postsAsRental/);
  });
});

describe("Exec 34 - tenant scope is enforced behaviourally", () => {
  test("a caller may only write into its own tenant", () => {
    const a = context("admin", { tenantId: "tenant-a" });
    assert.equal(assertWritableTenant(a, undefined), "tenant-a");
    assert.equal(assertWritableTenant(a, null), "tenant-a");
    assert.equal(assertWritableTenant(a, "tenant-a"), "tenant-a");
    assert.throws(() => assertWritableTenant(a, "tenant-b"), /another tenant/);
  });

  test("a tenant-less (single-tenant install) caller stays tenant-less", () => {
    const c = context("admin", { tenantId: null });
    assert.equal(assertWritableTenant(c, undefined), null);
  });

  test("a client cannot create a sale/invoice", () => {
    assert.equal(can(context("client"), "sales", "create"), false);
    assert.equal(can(context("admin", { tenantId: "tenant-a" }), "sales", "create"), true);
  });
});

describe("Exec 34 - financial-year and permission gates", () => {
  const year = { id: "fy1", name: "2026", start_date: "2026-01-01", end_date: "2026-12-31", is_current: true, status: "open" };

  test("a date inside the active year is accepted; outside or closed is rejected", () => {
    assert.doesNotThrow(() => assertDateInOpenFinancialYear(year, "2026-06-01"));
    assert.throws(() => assertDateInOpenFinancialYear(year, "2027-01-01"), /outside the active financial year/);
    assert.throws(() => assertDateInOpenFinancialYear({ ...year, status: "closed" }, "2026-06-01"), /closed/);
  });

  test("no configured year skips validation (backward compatible)", () => {
    assert.doesNotThrow(() => assertDateInOpenFinancialYear(null, "2026-06-01"));
  });
});

describe("Exec 34 - a rental invoice posts a balanced, idempotent journal", () => {
  const base = {
    amount: 100,
    discount: 0,
    vat: 10,
    journalNumber: "JV-1",
    invoiceNumber: "RI-1",
    entryDate: "2026-02-01",
    description: "rental",
    customerId: "cust-1",
    paymentMethod: "cash",
    accounts: ACCOUNTS,
    entryType: "rental_invoice" as const,
    revenueCode: SALE_ACCOUNT_CODES.rentalRevenue,
  };

  test("rental revenue is recognised net of VAT and the entry balances", () => {
    const j = buildSaleJournal({ ...base, advancePayment: 0, remaining: 110 });
    assert.ok(j);
    assert.equal(j.header.entry_type, "rental_invoice");
    assert.equal(j.header.total_debit, 110);
    assert.equal(j.header.total_credit, 110);
    const byAcc = Object.fromEntries(j.lines.map((l) => [l.account_id, l]));
    assert.equal(byAcc["acc-ar"].debit, 110, "AR carries the VAT-inclusive total");
    assert.equal(byAcc["acc-rental"].credit, 100, "rental revenue is net of VAT");
    assert.equal(byAcc["acc-vat"].credit, 10, "output VAT separated");
  });

  test("an advance splits cash and AR without changing the credit side", () => {
    const j = buildSaleJournal({ ...base, advancePayment: 40, remaining: 70 });
    assert.ok(j);
    const byAcc = Object.fromEntries(j.lines.map((l) => [l.account_id, l]));
    assert.equal(byAcc["acc-cash"].debit, 40);
    assert.equal(byAcc["acc-ar"].debit, 70);
    assert.equal(byAcc["acc-rental"].credit, 100);
    assert.equal(byAcc["acc-vat"].credit, 10);
  });

  test("postSaleInvoice posts once; a retry is idempotent (no double revenue)", async () => {
    const { client, entries, lines } = makeStub();
    const first = await postSaleInvoice(client, { ...base, advancePayment: 0, remaining: 110 });
    const second = await postSaleInvoice(client, { ...base, advancePayment: 0, remaining: 110 });
    assert.equal(first.created, true);
    assert.equal(second.created, false, "the retry must not create a second journal");
    assert.equal(second.journalId, first.journalId);
    assert.equal(entries.length, 1, "exactly one journal header");
    assert.equal(entries[0].entry_type, "rental_invoice");
    assert.equal(lines.length, 3, "AR + rental revenue + VAT");
  });

  test("a failure while writing lines does not leave a silent half-posting", async () => {
    const { client, entries } = makeStub({ failLines: true });
    await assert.rejects(
      postSaleInvoice(client, { ...base, advancePayment: 0, remaining: 110 }),
      (err: { message?: string }) => String(err?.message) === "line insert failed",
    );
    // writeJournal removes the header it just created when the lines fail, so a
    // failed posting leaves no orphan journal header behind.
    assert.equal(entries.length, 0, "no orphan journal header");
  });
});
