import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildSaleJournal,
  buildSaleReversalJournal,
  postSaleInvoice,
  reverseSaleInvoice,
  findPostedJournal,
  SALE_ACCOUNT_CODES,
  type SaleAccountIds,
  type PostingClient,
} from "../src/lib/accounting/sales-posting.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const ACCOUNTS: SaleAccountIds = {
  revenueAccountId: "acc-rev",
  vatAccountId: "acc-vat",
  arAccountId: "acc-ar",
  cashAccountId: "acc-cash",
};

/**
 * PostgREST-like recording stub for the sales posting service. Models
 * `accounts` (by code), `journal_entries` (with an idempotency guard on
 * entry_type+reference_number when asked) and `journal_lines`.
 */
function makeStub(seed: { accounts?: any[]; failLines?: boolean; guardUnique?: boolean } = {}) {
  const accounts = seed.accounts ?? [
    { id: "acc-cash", code: "11001" },
    { id: "acc-bank", code: "11002" },
    { id: "acc-ar", code: "12001" },
    { id: "acc-rev", code: "41002" },
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
    constructor(t: string) {
      this.table = t;
    }
    select(_c?: string) {
      return this;
    }
    eq(c: string, v: any) {
      this.filters.push([c, v]);
      return this;
    }
    is(c: string, v: any) {
      this.isFilters.push([c, v]);
      return this;
    }
    or(f: string) {
      this.orFilter = f;
      return this;
    }
    in(_c: string, v: any[]) {
      this.inVals = v;
      return this;
    }
    /** The RLS predicate, as PostgREST would apply it. */
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
    limit(_n: number) {
      return this;
    }
    insert(r: any) {
      this.op = "insert";
      this.row = r;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    async _run() {
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
          if (seed.guardUnique) {
            const clash = entries.find(
              (e) => e.entry_type === r.entry_type && e.reference_number === r.reference_number,
            );
            if (clash) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
          }
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
        if (this.table === "journal_entries") {
          const idx = entries.findIndex((e) => this.filters.every(([c, v]) => e[c] === v));
          if (idx >= 0) entries.splice(idx, 1);
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    async single() {
      const r = await this._run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    }
    async maybeSingle() {
      const r = await this._run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    }
    then(res: any, rej: any) {
      return this._run().then(res, rej);
    }
  }
  return { client: { from: (t: string) => new Q(t) } as unknown as PostingClient, entries, lines };
}

const baseInput = {
  journalNumber: "JV-1",
  invoiceNumber: "SI-1",
  entryDate: "2026-02-01",
  description: "sale",
  customerId: "cust-1",
  paymentMethod: "cash",
  accounts: ACCOUNTS,
};

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 1000) / 1000;

describe("Exec29 Item 10 - buildSaleJournal", () => {
  test("no advance: Dr AR = Cr revenue + Cr VAT, balanced", () => {
    const j = buildSaleJournal({ ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 })!;
    assert.ok(j);
    assert.equal(j.header.entry_type, "sale_invoice");
    assert.equal(j.header.status, "posted");
    assert.equal(j.header.is_balanced, true);
    assert.equal(sum(j.lines.map((l) => l.debit)), 110);
    assert.equal(sum(j.lines.map((l) => l.credit)), 110);
    assert.equal(j.header.total_debit, j.header.total_credit);
    // AR debit 110, revenue credit 100, VAT credit 10
    assert.equal(j.lines.find((l) => l.account_id === "acc-ar")!.debit, 110);
    assert.equal(j.lines.find((l) => l.account_id === "acc-rev")!.credit, 100);
    assert.equal(j.lines.find((l) => l.account_id === "acc-vat")!.credit, 10);
  });

  test("advance: Dr Cash + Dr AR = Cr revenue + Cr VAT", () => {
    const j = buildSaleJournal({ ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 30, remaining: 80 })!;
    assert.equal(j.lines.find((l) => l.account_id === "acc-cash")!.debit, 30);
    assert.equal(j.lines.find((l) => l.account_id === "acc-ar")!.debit, 80);
    assert.equal(sum(j.lines.map((l) => l.debit)), sum(j.lines.map((l) => l.credit)));
  });

  test("discount reduces revenue, not VAT", () => {
    const j = buildSaleJournal({ ...baseInput, amount: 110, discount: 10, vat: 10, advancePayment: 0, remaining: 110 })!;
    assert.equal(j.lines.find((l) => l.account_id === "acc-rev")!.credit, 100);
    assert.equal(j.lines.find((l) => l.account_id === "acc-vat")!.credit, 10);
    assert.equal(j.lines.find((l) => l.account_id === "acc-ar")!.debit, 110);
  });

  test("bank method uses the bank account", () => {
    const j = buildSaleJournal({ ...baseInput, paymentMethod: "bank", amount: 50, discount: 0, vat: 0, advancePayment: 50, remaining: 0, accounts: { ...ACCOUNTS, cashAccountId: "acc-bank" } })!;
    assert.equal(j.lines.find((l) => l.account_id === "acc-bank")!.debit, 50);
  });

  test("returns null for a non-positive total", () => {
    assert.equal(buildSaleJournal({ ...baseInput, amount: 0, discount: 0, vat: 0, advancePayment: 0, remaining: 0 }), null);
  });

  test("returns null when the split does not reconstruct the total", () => {
    // remaining is wrong (should be 110) -> refuse rather than post a bad entry.
    assert.equal(buildSaleJournal({ ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 100 }), null);
  });

  test("returns null when a required account is missing", () => {
    assert.equal(
      buildSaleJournal({ ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110, accounts: { ...ACCOUNTS, arAccountId: "" } }),
      null,
    );
  });

  test("returns null when VAT is charged but no VAT account exists", () => {
    assert.equal(
      buildSaleJournal({ ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110, accounts: { ...ACCOUNTS, vatAccountId: "" } }),
      null,
    );
  });
});

describe("Exec29 Item 4 - buildSaleReversalJournal", () => {
  test("mirrors every line (debit<->credit) and balances", () => {
    const fwd = buildSaleJournal({ ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 30, remaining: 80 })!;
    const rev = buildSaleReversalJournal({ ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 30, remaining: 80 })!;
    assert.equal(rev.header.entry_type, "sale_reversal");
    assert.equal(rev.lines.length, fwd.lines.length);
    for (let i = 0; i < fwd.lines.length; i++) {
      assert.equal(rev.lines[i].debit, fwd.lines[i].credit);
      assert.equal(rev.lines[i].credit, fwd.lines[i].debit);
    }
    assert.equal(sum(rev.lines.map((l) => l.debit)), sum(rev.lines.map((l) => l.credit)));
  });

  test("returns null when the forward journal would not balance", () => {
    assert.equal(buildSaleReversalJournal({ ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 100 }), null);
  });
});

describe("Exec29 Item 10 - postSaleInvoice idempotency", () => {
  test("first call creates the journal", async () => {
    const { client, entries } = makeStub();
    const r = await postSaleInvoice(client, { ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 });
    assert.equal(r.created, true);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].entry_type, "sale_invoice");
  });

  test("a retry returns the SAME journal and does not double revenue", async () => {
    const { client, entries } = makeStub();
    const a = await postSaleInvoice(client, { ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 });
    const b = await postSaleInvoice(client, { ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 });
    assert.equal(b.created, false);
    assert.equal(b.journalId, a.journalId);
    assert.equal(entries.length, 1);
  });

  test("concurrent issue posts exactly one journal (guardUnique)", async () => {
    const { client, entries } = makeStub({ guardUnique: true });
    const results = await Promise.allSettled([
      postSaleInvoice(client, { ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 }),
      postSaleInvoice(client, { ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    assert.ok(fulfilled.length >= 1);
    assert.equal(entries.length, 1);
  });

  test("a failed line write removes the orphan header and throws", async () => {
    const { client, entries } = makeStub({ failLines: true });
    await assert.rejects(
      postSaleInvoice(client, { ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 }),
    );
    assert.equal(entries.length, 0);
  });
});

describe("Exec29 Item 4 - reverseSaleInvoice", () => {
  test("reverses a posted sale once and is idempotent", async () => {
    const { client, entries } = makeStub();
    await postSaleInvoice(client, { ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 });
    const r1 = await reverseSaleInvoice(client, { ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 });
    assert.equal(r1!.created, true);
    const r2 = await reverseSaleInvoice(client, { ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 });
    assert.equal(r2!.created, false);
    assert.equal(r2!.journalId, r1!.journalId);
    assert.equal(entries.filter((e) => e.entry_type === "sale_reversal").length, 1);
  });

  test("returns null when there is no posted sale to reverse", async () => {
    const { client } = makeStub();
    const r = await reverseSaleInvoice(client, { ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 });
    assert.equal(r, null);
  });

  test("findPostedJournal scopes by entry_type", async () => {
    const { client } = makeStub();
    await postSaleInvoice(client, { ...baseInput, amount: 100, discount: 0, vat: 10, advancePayment: 0, remaining: 110 });
    assert.ok(await findPostedJournal(client, "sale_invoice", "SI-1"));
    assert.equal(await findPostedJournal(client, "sale_reversal", "SI-1"), null);
  });
});

describe("Exec29 - route + page wiring (source assertions)", () => {
  // The posting invariants moved from the route into the shared service that the
  // route and the AI agent both call; assert over the whole path.
  const invoicesRoute = read("src/app/api/invoices/route.ts") + read("src/lib/sales/service.ts");
  const reverseRoute = read("src/app/api/invoices/[id]/reverse/route.ts");
  const newPage = read("src/app/invoices/new/page.tsx");
  const editPage = read("src/app/invoices/[id]/page.tsx");

  test("POST /api/invoices authenticates and authorizes on the server", () => {
    assert.match(invoicesRoute, /requireContext\(request, \{ module: "sales", action: "create" \}/);
    assert.match(invoicesRoute, /assertReferences/);
    assert.match(invoicesRoute, /assertWritableTenant/);
    assert.match(invoicesRoute, /assertDateInOpenFinancialYear/);
    assert.match(invoicesRoute, /postSaleInvoice/);
    assert.match(invoicesRoute, /logAudit/);
  });

  test("POST /api/invoices compensates by deleting the invoice if posting fails", () => {
    assert.match(invoicesRoute, /createdInvoiceId/);
    assert.match(invoicesRoute, /\.from\("invoices"\)\s*\.delete\(\)/);
  });

  test("reverse route authenticates, scopes by tenant, and is idempotent", () => {
    assert.match(reverseRoute, /requireContext\(request, \{ module: "invoices", action: "edit" \}/);
    assert.match(reverseRoute, /\.eq\("tenant_id", context\.tenantId\)/);
    assert.match(reverseRoute, /reverseSaleInvoice/);
    assert.match(reverseRoute, /already_cancelled/);
    assert.match(reverseRoute, /logAudit/);
  });

  test("invoices/new posts to the unified service, not a browser insert", () => {
    assert.match(newPage, /fetch\("\/api\/invoices"/);
    assert.doesNotMatch(newPage, /supabase\.from\("invoices"\)\.insert/);
    assert.doesNotMatch(newPage, /supabase\.from\("journal_entries"\)\.insert/);
  });

  test("edit page offers reversal (not in-place edit/delete) for a posted invoice", () => {
    assert.match(editPage, /isSaleInvoicePosted/);
    assert.match(editPage, /handleReverse/);
    assert.match(editPage, /\/reverse/);
    assert.match(editPage, /isPosted \? \(/);
    assert.match(editPage, /disabled=\{loading \|\| isPosted\}/);
  });
});

describe("Exec29 Item 11 - dependent-record guard", () => {
  const invoiceRoute = read("src/app/api/invoices/[id]/route.ts");
  const editPage = read("src/app/invoices/[id]/page.tsx");

  /** Count stub: returns a fixed count per table, or an error. */
  function countStub(counts: Record<string, number>, errorTables: string[] = []) {
    return {
      from(table: string) {
        const b: any = {
          select: () => b,
          eq: () => b,
          // The posting lookup is tenant-scoped, so `.is`/`.limit`/`.maybeSingle`
          // must exist on the chain even when the test only exercises counts.
          is: () => b,
          limit: () => b,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (res: any) =>
            Promise.resolve(
              errorTables.includes(table)
                ? { count: null, error: { message: "boom" } }
                : { count: counts[table] ?? 0, error: null },
            ).then(res),
        };
        return b;
      },
    };
  }

  test("counts payments and returns for an invoice", async () => {
    const { countInvoiceDependents } = await import("../src/lib/accounting/invoice-guards.ts");
    const d = await countInvoiceDependents(countStub({ payments: 2, sales_returns: 1 }) as never, "inv-1");
    assert.equal(d.state, "found");
    assert.deepEqual(d.state === "found" ? d.value : null, { payments: 2, returns: 1, total: 3 });
  });

  test("hasInvoiceDependents is false for a clean invoice", async () => {
    const { hasInvoiceDependents } = await import("../src/lib/accounting/invoice-guards.ts");
    assert.equal(await hasInvoiceDependents(countStub({ payments: 0, sales_returns: 0 }) as never, "inv-1"), false);
  });

  test("hasInvoiceDependents is true when a payment exists", async () => {
    const { hasInvoiceDependents } = await import("../src/lib/accounting/invoice-guards.ts");
    assert.equal(await hasInvoiceDependents(countStub({ payments: 1, sales_returns: 0 }) as never, "inv-1"), true);
  });

  // The guard must fail CLOSED. Treating an unreadable table as "zero dependents"
  // reads a failure to check as permission to delete, which would orphan the rows
  // the check existed to protect.
  test("an unreadable table blocks the delete rather than counting as zero", async () => {
    const { hasInvoiceDependents, countInvoiceDependents, decideInvoiceDeletion } = await import(
      "../src/lib/accounting/invoice-guards.ts"
    );
    const stub = countStub({}, ["payments", "sales_returns"]);
    assert.equal(await hasInvoiceDependents(stub as never, "inv-1"), true);
    assert.equal((await countInvoiceDependents(stub as never, "inv-1")).state, "unknown");

    const decision = await decideInvoiceDeletion(stub as never, {
      id: "inv-1",
      invoiceNumber: "SI-1",
      tenantId: null,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "unverified");
  });

  test("an empty id cannot be counted, so it is not proof of no dependents", async () => {
    const { hasInvoiceDependents, countInvoiceDependents } = await import("../src/lib/accounting/invoice-guards.ts");
    assert.equal(await hasInvoiceDependents(countStub({ payments: 5 }) as never, ""), true);
    assert.equal((await countInvoiceDependents(countStub({ payments: 5 }) as never, "")).state, "unknown");
  });

  test("DELETE route is server-authoritative and blocks posted/dependent deletes", () => {
    assert.match(invoiceRoute, /export async function DELETE/);
    assert.match(invoiceRoute, /requireContext\(request, \{ module: "invoices", action: "delete" \}/);
    // One fail-closed decision authority rather than two fail-open checks.
    assert.match(invoiceRoute, /decideInvoiceDeletion/);
    assert.match(invoiceRoute, /logAudit/);
    // An unverifiable check is a 409, not a silent permit.
    assert.match(invoiceRoute, /code === "unverified"/);
    assert.match(invoiceRoute, /conflict\(/);
    assert.match(invoiceRoute, /\.eq\("tenant_id", context\.tenantId\)/);
  });

  test("edit page refuses to delete an invoice with dependents", () => {
    assert.match(editPage, /hasInvoiceDependents/);
    assert.match(editPage, /cannot be deleted/);
  });
});
