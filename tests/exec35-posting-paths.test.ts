import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  MANUAL_ACCOUNT_CODES,
  findPostedManualJournal,
  postBankTransfer,
  postDepositRefund,
  postPayroll,
  postPettyCash,
  resolveAccountIds,
  writeJournal,
  type PostingClient,
} from "../src/lib/accounting/manual-posting.ts";
import {
  buildPurchaseJournal,
  expenseCodeFor,
  PURCHASE_ACCOUNT_CODES,
} from "../src/lib/accounting/purchase-posting.ts";
import {
  buildVehiclePurchaseJournal,
  VEHICLE_ACCOUNT_CODES,
} from "../src/lib/accounting/vehicle-posting.ts";
import { DEFAULT_ROLE_PERMISSIONS } from "../src/lib/auth/permissions.ts";
import { can, assertWritableTenant } from "../src/lib/auth/policy.ts";

/**
 * Execution 35 - the remaining browser-side financial posting paths.
 *
 * Each of purchases, cars, petty cash, bank transfer, payroll and deposit refund
 * used to build and write its journal in the browser. These tests pin the new
 * contract: the *pages* only call their server route; the *services* own the
 * ledger write; the shapes never create revenue for a purchase/vehicle/transfer;
 * a retry is idempotent; and a failed line write leaves no orphan header.
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ---------------------------------------------------------------------------
// PostgREST-like recording stub (no live database)
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function makeStub(seed: { tables?: Record<string, Row[]>; accounts?: Row[]; failLines?: boolean; noRpc?: boolean } = {}) {
  const tables: Record<string, Row[]> = seed.tables ?? {};
  const written = { journal_entries: [] as Row[], journal_lines: [] as Row[], deletes: [] as Row[] };
  let seq = 0;

  class Q {
    table: string;
    op = "select";
    filters: [string, any][] = [];
    isFilters: [string, any][] = [];
    inVals: any[] | null = null;
    orFilter: string | null = null;
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
    _tenantMatch(row: Row): boolean {
      if (this.isFilters.length) {
        return this.isFilters.every(([c, v]) => (v === null ? row[c] == null : row[c] === v));
      }
      if (this.orFilter) {
        const parts = this.orFilter.split(",");
        return parts.some((p) => {
          const m = /tenant_id\.eq\.(.+)/.exec(p);
          if (m) return row.tenant_id === m[1];
          if (p.includes("tenant_id.is.null")) return row.tenant_id === null || row.tenant_id === undefined;
          return false;
        });
      }
      return true;
    }
    async _run() {
      if (this.op === "select") {
        if (this.table === "accounts") {
          const byCode = (seed.accounts ?? []).filter((a) => (this.inVals ?? []).includes(a.code));
          return { data: byCode.filter((a) => this._tenantMatch(a)), error: null };
        }
        const rows = (tables[this.table] ?? []).filter((r) => this.filters.every(([c, v]) => r[c] === v));
        return { data: rows, error: null };
      }
      if (this.op === "insert") {
        const rows = Array.isArray(this.row) ? this.row : [this.row];
        if (this.table === "journal_entries") {
          const r = { id: `je-${++seq}`, ...rows[0] };
          written.journal_entries.push(r);
          return { data: [r], error: null };
        }
        if (this.table === "journal_lines") {
          if (seed.failLines) return { data: null, error: { message: "line insert failed" } };
          rows.forEach((l) => written.journal_lines.push(l));
          return { data: rows, error: null };
        }
        return { data: rows, error: null };
      }
      if (this.op === "delete") {
        written.deletes.push({ table: this.table, filters: this.filters });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    async single() {
      const r = await this._run();
      return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error };
    }
    async maybeSingle() {
      const r = await this._run();
      return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error };
    }
    then(res: any, rej: any) {
      return this._run().then(res, rej);
    }
  }

  // The production database has migration 011 applied, so the client exposes the
  // atomic `post_journal_entry` RPC. A tenanted journal now REQUIRES it: the
  // two-request fallback is closed for a company (Exec 66). Modelling the real
  // database here is what makes the shape assertions meaningful.
  const rpc = async (fn: string, args: Record<string, any> = {}) => {
    if (fn !== "post_journal_entry") return { data: null, error: { message: `unknown rpc ${fn}` } };
    const header = args.p_header ?? {};
    const lines = (args.p_lines ?? []) as Row[];
    const debit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const credit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    if (Math.round(debit * 1000) !== Math.round(credit * 1000)) {
      return { data: null, error: { code: "23514", message: "journal does not balance" } };
    }
    const entry = { id: `je-${++seq}`, status: "posted", ...header };
    written.journal_entries.push(entry);
    lines.forEach((l) => written.journal_lines.push({ ...l, journal_entry_id: entry.id }));
    return { data: entry.id, error: null };
  };

  const base = { from: (t: string) => new Q(t) };
  const client = (seed.noRpc ? base : { ...base, rpc }) as unknown as PostingClient;
  return { client, written };
}

const ACCOUNTS: Row[] = [
  { id: "acc-cash-own", code: MANUAL_ACCOUNT_CODES.cash, tenant_id: "t1" },
  { id: "acc-cash-shared", code: MANUAL_ACCOUNT_CODES.cash, tenant_id: null },
  { id: "acc-bank", code: MANUAL_ACCOUNT_CODES.bank, tenant_id: null },
  { id: "acc-petty", code: MANUAL_ACCOUNT_CODES.pettyCash, tenant_id: null },
  { id: "acc-deposit", code: MANUAL_ACCOUNT_CODES.depositLiability, tenant_id: null },
  { id: "acc-salary", code: MANUAL_ACCOUNT_CODES.salariesExpense, tenant_id: null },
];

// ---------------------------------------------------------------------------
// Pure builders: purchase + vehicle never create revenue
// ---------------------------------------------------------------------------

describe("purchase journal (no inventory, no revenue)", () => {
  const j = buildPurchaseJournal({
    journalNumber: "JV-1",
    invoiceNumber: "BILL-1",
    date: "2026-02-01",
    description: "Supplier bill - BILL-1",
    grandTotal: 110,
    advancePayment: 40,
    remainingAmount: 70,
    expenseAccountId: "exp",
    cashAccountId: "cash",
    payableAccountId: "ap",
  })!;

  test("debits the expense and credits cash + AP", () => {
    assert.deepEqual(
      j.lines.map((l) => [l.account_id, l.debit, l.credit]),
      [["exp", 110, 0], ["cash", 0, 40], ["ap", 0, 70]],
    );
    assert.equal(j.header.entry_type, "purchase_invoice");
  });

  test("is balanced", () => {
    const d = j.lines.reduce((s, l) => s + l.debit, 0);
    const c = j.lines.reduce((s, l) => s + l.credit, 0);
    assert.equal(d, c);
    assert.equal(j.header.total_debit, d);
    assert.equal(j.header.total_credit, c);
  });

  test("never touches a revenue account", () => {
    // 4xxxx codes are revenue; a purchase must use an expense/asset account.
    for (const l of j.lines) {
      assert.ok(!/^4/.test(l.account_id), "purchase must not hit revenue");
    }
  });

  test("a cash purchase has no AP line", () => {
    const cash = buildPurchaseJournal({
      journalNumber: "JV-2", invoiceNumber: "B", date: "d", description: "x",
      grandTotal: 50, advancePayment: 50, remainingAmount: 0,
      expenseAccountId: "exp", cashAccountId: "cash", payableAccountId: "ap",
    })!;
    assert.equal(cash.lines.length, 2);
    assert.equal(cash.lines[1].account_id, "cash");
  });

  test("a non-positive total or missing account cannot post", () => {
    const base = {
      journalNumber: "JV-3", invoiceNumber: "B", date: "d", description: "x",
      grandTotal: 10, advancePayment: 10, remainingAmount: 0,
      expenseAccountId: "exp", cashAccountId: "cash", payableAccountId: "ap",
    };
    assert.equal(buildPurchaseJournal({ ...base, grandTotal: 0 }), null);
    assert.equal(buildPurchaseJournal({ ...base, expenseAccountId: "" }), null);
  });

  test("expense category maps to a 51xxx expense code", () => {
    assert.equal(expenseCodeFor("fuel"), "51001");
    assert.equal(expenseCodeFor("unknown"), "51099");
    assert.equal(PURCHASE_ACCOUNT_CODES.payable, "21001");
  });
});

describe("vehicle acquisition journal (capitalise, never revenue)", () => {
  const j = buildVehiclePurchaseJournal({
    journalNumber: "JV-1",
    reference: "PLATE-1",
    date: "2026-02-01",
    description: "Vehicle purchase",
    purchasePrice: 1000,
    downPayment: 400,
    loanAmount: 600,
    fleetAccountId: "fleet",
    bankAccountId: "bank",
    loanAccountId: "loan",
  })!;

  test("debits the fleet asset and credits bank + loan", () => {
    assert.deepEqual(
      j.lines.map((l) => [l.account_id, l.debit, l.credit]),
      [["fleet", 1000, 0], ["bank", 0, 400], ["loan", 0, 600]],
    );
    assert.equal(j.header.entry_type, "vehicle_purchase");
    assert.equal(VEHICLE_ACCOUNT_CODES.fleet, "13001");
  });

  test("rejects a down payment + loan that does not equal the price", () => {
    const bad = buildVehiclePurchaseJournal({
      journalNumber: "JV", reference: "r", date: "d", description: "x",
      purchasePrice: 1000, downPayment: 400, loanAmount: 500,
      fleetAccountId: "fleet", bankAccountId: "bank", loanAccountId: "loan",
    });
    assert.equal(bad, null);
  });

  test("a full cash purchase has no loan line", () => {
    const cash = buildVehiclePurchaseJournal({
      journalNumber: "JV", reference: "r", date: "d", description: "x",
      purchasePrice: 1000, downPayment: 1000, loanAmount: 0,
      fleetAccountId: "fleet", bankAccountId: "bank", loanAccountId: "loan",
    })!;
    assert.equal(cash.lines.length, 2);
    assert.ok(cash.lines.every((l) => l.account_id !== "loan"));
  });
});

// ---------------------------------------------------------------------------
// Service: account resolution, tenant scope, idempotency, compensation
// ---------------------------------------------------------------------------

describe("resolveAccountIds (tenant-scoped chart)", () => {
  test("prefers a tenant-owned account over the shared one", async () => {
    const { client } = makeStub({ accounts: ACCOUNTS });
    const ids = await resolveAccountIds(client, [MANUAL_ACCOUNT_CODES.cash], "t1");
    assert.equal(ids[MANUAL_ACCOUNT_CODES.cash], "acc-cash-own");
  });

  test("falls back to the shared chart when the tenant has no own account", async () => {
    const { client } = makeStub({ accounts: ACCOUNTS });
    const ids = await resolveAccountIds(client, [MANUAL_ACCOUNT_CODES.bank], "t1");
    assert.equal(ids[MANUAL_ACCOUNT_CODES.bank], "acc-bank");
  });

  test("a tenant-less caller only sees the shared chart", async () => {
    const { client } = makeStub({ accounts: ACCOUNTS });
    const ids = await resolveAccountIds(client, [MANUAL_ACCOUNT_CODES.cash], null);
    assert.equal(ids[MANUAL_ACCOUNT_CODES.cash], "acc-cash-shared");
  });

  test("throws when a required account is absent", async () => {
    const { client } = makeStub({ accounts: [] });
    await assert.rejects(() => resolveAccountIds(client, [MANUAL_ACCOUNT_CODES.cash], "t1"));
  });
});

describe("writeJournal compensation", () => {
  // The two-request fallback covers the window before migration 011 is applied.
  test("a failed line insert removes the orphan header (pre-011 fallback)", async () => {
    const { client, written } = makeStub({ failLines: true, noRpc: true });
    await assert.rejects(() => writeJournal(client, {
      header: { journal_number: "n", entry_date: "d", description: "x", entry_type: "bank_transfer", status: "posted", total_debit: 1, total_credit: 1, is_balanced: true },
      lines: [
        { account_id: "a", debit: 1, credit: 0, description: "x" },
        { account_id: "b", debit: 0, credit: 1, description: "x" },
      ],
    }));
    assert.equal(written.journal_entries.length, 1);
    assert.equal(written.deletes.length, 1);
    assert.equal(written.deletes[0].table, "journal_entries");
  });

  test("the fallback still stamps the company on a pre-011 database", async () => {
    const { client, written } = makeStub({ noRpc: true });
    await writeJournal(client, {
      header: { journal_number: "n", entry_date: "d", description: "x", entry_type: "bank_transfer", status: "posted", total_debit: 1, total_credit: 1, is_balanced: true },
      lines: [
        { account_id: "a", debit: 1, credit: 0, description: "x" },
        { account_id: "b", debit: 0, credit: 1, description: "x" },
      ],
    }, "t1");
    assert.equal(written.journal_entries[0].tenant_id, "t1");
    assert.deepEqual(written.journal_lines.map((l) => l.tenant_id), ["t1", "t1"]);
  });

  test("refuses an unbalanced journal before writing anything", async () => {
    const { client, written } = makeStub();
    await assert.rejects(() => writeJournal(client, {
      header: { journal_number: "n", entry_date: "d", description: "x", entry_type: "bank_transfer", status: "posted", total_debit: 2, total_credit: 1, is_balanced: true },
      lines: [
        { account_id: "a", debit: 2, credit: 0, description: "x" },
        { account_id: "b", debit: 0, credit: 1, description: "x" },
      ],
    }));
    assert.equal(written.journal_entries.length, 0);
  });
});

describe("idempotency", () => {
  test("bank transfer with an existing reference does not post again", async () => {
    const { client, written } = makeStub({
      tables: { journal_entries: [{ id: "existing", entry_type: "bank_transfer", reference_number: "BT-REF", tenant_id: "t1" }] },
    });
    const res = await postBankTransfer(client, {
      journalNumber: "BT-1", tenantId: "t1", date: "d", description: "x",
      amount: 10, fromAccountId: "a", toAccountId: "b", reference: "BT-REF",
    });
    assert.equal(res.created, false);
    assert.equal(res.journalId, "existing");
    assert.equal(written.journal_entries.length, 0);
  });

  test("findPostedManualJournal matches on entry_type + reference, within the tenant", async () => {
    const { client } = makeStub({
      tables: { journal_entries: [{ id: "j1", entry_type: "payroll", reference_number: "PAYROLL-2026-02-01", tenant_id: "t1" }] },
    });
    const found = await findPostedManualJournal(client, "payroll", "PAYROLL-2026-02-01", "t1");
    assert.equal(found?.id, "j1");
    assert.equal(await findPostedManualJournal(client, "payroll", "nope", "t1"), null);
  });

  test("another company's journal for the SAME reference is not seen as ours", async () => {
    // A reference is unique within a company, not across companies. Without the
    // tenant filter a retry in t2 would find t1's journal and skip its own
    // posting - a silently lost financial entry.
    const { client } = makeStub({
      tables: { journal_entries: [{ id: "other", entry_type: "payroll", reference_number: "PAYROLL-X", tenant_id: "t1" }] },
    });
    assert.equal(await findPostedManualJournal(client, "payroll", "PAYROLL-X", "t2"), null);
    assert.equal((await findPostedManualJournal(client, "payroll", "PAYROLL-X", "t1"))?.id, "other");
  });

  test("a retried transfer writes nothing and does not move the cache", async () => {
    const { client, written } = makeStub({
      tables: { journal_entries: [{ id: "existing", entry_type: "bank_transfer", reference_number: "BT-RETRY", tenant_id: "t1" }] },
    });
    const first = await postBankTransfer(client, {
      journalNumber: "BT-1", tenantId: "t1", date: "d", description: "x",
      amount: 25, fromAccountId: "a", toAccountId: "b", reference: "BT-RETRY",
    });
    assert.equal(first.created, false);
    assert.equal(written.journal_entries.length, 0);
    assert.equal(written.journal_lines.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Service: shapes for each transaction type
// ---------------------------------------------------------------------------

describe("service shapes", () => {
  test("bank transfer debits the destination and credits the source (no revenue/expense)", async () => {
    const { client, written } = makeStub();
    await postBankTransfer(client, {
      journalNumber: "BT-1", tenantId: "t1", date: "d", description: "x",
      amount: 100, fromAccountId: "cash", toAccountId: "bank", reference: "R1",
    });
    assert.deepEqual(
      written.journal_lines.map((l) => [l.account_id, l.debit, l.credit]),
      [["bank", 100, 0], ["cash", 0, 100]],
    );
  });

  test("petty cash fund debits petty cash / credits main cash", async () => {
    const { client, written } = makeStub();
    await postPettyCash(client, {
      journalNumber: "PC-1", date: "d", description: "x", amount: 30, kind: "fund",
      pettyAccountId: "petty", expenseAccountId: "cash", fundDescription: "f", expenseDescription: "e",
    });
    assert.deepEqual(
      written.journal_lines.map((l) => [l.account_id, l.debit, l.credit]),
      [["petty", 30, 0], ["cash", 0, 30]],
    );
  });

  test("petty cash expense debits the expense account / credits petty cash", async () => {
    const { client, written } = makeStub();
    await postPettyCash(client, {
      journalNumber: "PC-2", date: "d", description: "x", amount: 30, kind: "expense",
      pettyAccountId: "petty", expenseAccountId: "exp", fundDescription: "f", expenseDescription: "e",
    });
    assert.deepEqual(
      written.journal_lines.map((l) => [l.account_id, l.debit, l.credit]),
      [["exp", 30, 0], ["petty", 0, 30]],
    );
  });

  test("payroll debits salaries expense / credits cash", async () => {
    const { client, written } = makeStub();
    await postPayroll(client, {
      journalNumber: "PAY-1", tenantId: "t1", date: "d", description: "x",
      amount: 1200, salaryAccountId: "sal", cashAccountId: "cash", reference: "PAYROLL-d",
    });
    assert.deepEqual(
      written.journal_lines.map((l) => [l.account_id, l.debit, l.credit]),
      [["sal", 1200, 0], ["cash", 0, 1200]],
    );
  });

  test("two payroll runs on the same date post two journals when their references differ", async () => {
    const { client, written } = makeStub();
    const base = { tenantId: "t1", date: "2026-02-01", description: "x", salaryAccountId: "sal", cashAccountId: "cash" };
    const a = await postPayroll(client, { ...base, journalNumber: "PAY-1", amount: 1000, reference: "PAYROLL-2026-02-01-aaaa" });
    const b = await postPayroll(client, { ...base, journalNumber: "PAY-2", amount: 500, reference: "PAYROLL-2026-02-01-bbbb" });
    assert.equal(a.created, true);
    assert.equal(b.created, true, "a second run on the same date is not swallowed");
    assert.equal(written.journal_entries.length, 2);
  });

  test("a retry of the same payroll reference is idempotent", async () => {
    const { client, written } = makeStub({
      tables: { journal_entries: [{ id: "existing", entry_type: "payroll", reference_number: "PAYROLL-2026-02-01-aaaa", tenant_id: "t1" }] },
    });
    const again = await postPayroll(client, {
      tenantId: "t1", date: "2026-02-01", description: "x", journalNumber: "PAY-3",
      amount: 1000, salaryAccountId: "sal", cashAccountId: "cash", reference: "PAYROLL-2026-02-01-aaaa",
    });
    assert.equal(again.created, false);
    assert.equal(written.journal_entries.length, 0, "a retry writes nothing");
  });

  test("deposit refund debits the deposit liability / credits cash (never revenue)", async () => {
    const { client, written } = makeStub();
    await postDepositRefund(client, {
      journalNumber: "DEP-1", tenantId: "t1", date: "d", description: "x",
      amount: 200, depositAccountId: "dep", cashAccountId: "cash", reference: "CON-1",
    });
    assert.deepEqual(
      written.journal_lines.map((l) => [l.account_id, l.debit, l.credit]),
      [["dep", 200, 0], ["cash", 0, 200]],
    );
    assert.equal(MANUAL_ACCOUNT_CODES.depositLiability, "25000");
  });
});

// ---------------------------------------------------------------------------
// Authorization + tenant scoping (pure rules)
// ---------------------------------------------------------------------------

describe("authorization rules for the posting modules", () => {
  const ctx = (role: "admin" | "staff" | "client" | "super_admin", tenantId: string | null = "t1") => ({
    authUserId: "u1",
    email: "u@example.com",
    fullName: null,
    role,
    tenantId,
    customerId: null,
    branchIds: null,
    isAdmin: role === "admin" || role === "super_admin",
    isSuperAdmin: role === "super_admin",
    permissions: DEFAULT_ROLE_PERMISSIONS[role],
    financialYearId: null,
  });

  test("admin and staff may create accounting documents", () => {
    for (const role of ["admin", "staff"] as const) {
      assert.equal(can(ctx(role), "accounting", "create"), true, `${role} accounting.create`);
      assert.equal(can(ctx(role), "purchases", "create"), true, `${role} purchases.create`);
      assert.equal(can(ctx(role), "payroll", "create"), true, `${role} payroll.create`);
    }
  });

  test("a client cannot create any of these documents", () => {
    for (const m of ["accounting", "purchases", "payroll", "rentals", "cars"] as const) {
      assert.equal(can(ctx("client"), m, "create"), false, `client ${m}.create`);
    }
  });

  test("a tenant caller cannot write into another tenant", () => {
    assert.throws(() => assertWritableTenant(ctx("admin", "t1"), "t2"));
    assert.equal(assertWritableTenant(ctx("admin", "t1"), "t1"), "t1");
  });

  test("a tenant caller may write its own tenant-less value (single-tenant install)", () => {
    assert.equal(assertWritableTenant(ctx("admin", "t1"), undefined), "t1");
  });
});

// ---------------------------------------------------------------------------
// Pages delegate; routes own the auth + posting
// ---------------------------------------------------------------------------

const PAGES = {
  purchases: "src/app/purchases/new/page.tsx",
  cars: "src/app/cars/new/page.tsx",
  petty: "src/app/accounting/petty-cash/page.tsx",
  bank: "src/app/accounting/bank-transfer/page.tsx",
  payroll: "src/app/hr/payroll/page.tsx",
  deposit: "src/app/rentals/[id]/refund-deposit/page.tsx",
};

const ROUTES = {
  purchases: "src/app/api/purchases/route.ts",
  cars: "src/app/api/cars/route.ts",
  petty: "src/app/api/accounting/petty-cash/route.ts",
  bank: "src/app/api/accounting/bank-transfer/route.ts",
  payroll: "src/app/api/payroll/route.ts",
  deposit: "src/app/api/rentals/deposit-refund/route.ts",
};

describe("browser pages no longer write finance", () => {
  for (const [name, p] of Object.entries(PAGES)) {
    test(`${name} page delegates to its API route`, () => {
      const src = read(p);
      assert.match(src, /fetch\('\/api\//, "must POST to a server route");
    });

    test(`${name} page writes no journal, line, balance or number`, () => {
      const src = read(p);
      assert.doesNotMatch(src, /from\(['"]journal_entries['"]\)/, "no journal header writes");
      assert.doesNotMatch(src, /from\(['"]journal_lines['"]\)/, "no journal line writes");
      assert.doesNotMatch(src, /applyAccountBalanceDelta/, "no balance writes");
      assert.doesNotMatch(src, /nextDocumentNumber/, "numbers are server-side");
      assert.doesNotMatch(src, /journal_entry_lines/, "must not touch the orphaned table");
    });
  }

  test("purchases/new posts to /api/purchases and no longer imports a journal path", () => {
    const src = read(PAGES.purchases);
    assert.match(src, /fetch\('\/api\/purchases'/);
    assert.doesNotMatch(src, /entry_type: 'purchase_invoice'/, "the browser must not build the purchase journal");
  });

  test("cars/new posts to /api/cars", () => {
    const src = read(PAGES.cars);
    assert.match(src, /fetch\('\/api\/cars'/);
    assert.doesNotMatch(src, /entry_type: 'vehicle_purchase'/, "the browser must not build the vehicle journal");
  });
});

describe("API routes enforce auth, tenant scope and balanced posting", () => {
  for (const [name, p] of Object.entries(ROUTES)) {
    test(`${name} route requires an authenticated, permitted caller`, () => {
      const src = read(p);
      assert.match(src, /requireContext\(request, \{ module: "([a-z_]+)", action: "create" \}\)/, "must guard with requireContext");
    });

    test(`${name} route derives the tenant from the session and checks the year`, () => {
      const src = read(p);
      assert.match(src, /assertWritableTenant\(/, "must reject a forged tenant");
      assert.match(src, /getActiveFinancialYear\(|assertDateInOpenFinancialYear\(/, "must validate the financial year");
    });
  }

  test("the routes never write the ledger themselves (the service does)", () => {
    for (const p of Object.values(ROUTES)) {
      assert.doesNotMatch(read(p), /from\(['"]journal_lines['"]\)/, `${p} must not write lines directly`);
      assert.doesNotMatch(read(p), /journal_entry_lines/, `${p} must not touch the orphaned table`);
    }
  });

  test("the purchase and vehicle routes validate references and are idempotent", () => {
    assert.match(read(ROUTES.purchases), /assertReferences\(/, "purchase must validate supplier/car");
    assert.match(read(ROUTES.purchases), /invoice_number.*eq|eq\("invoice_number"/, "purchase is keyed by invoice number");
    assert.match(read(ROUTES.cars), /context\.isAdmin/, "only an admin may set purchase/financing fields");
  });
});

describe("manual journal screen: reads stay in the browser, writes move to the server", () => {
  const PAGE = "src/app/accounting/journal-entries/page.tsx";
  const ROUTE = "src/app/api/journal-entries/route.ts";

  test("the page delegates every write to /api/journal-entries", () => {
    const src = read(PAGE);
    assert.match(src, /fetch\("\/api\/journal-entries"/, "save must POST/PUT to the route");
    assert.match(src, /method: "PUT"/, "editing an existing entry uses PUT");
    assert.match(src, /method: "DELETE"/, "delete uses the route");
    assert.match(src, /method: "PATCH"/, "approve uses the route");
  });

  test("the page never inserts, updates or deletes the ledger itself", () => {
    const src = read(PAGE);
    for (const table of ["journal_entries", "journal_lines"]) {
      const write = new RegExp(`from\\(["']${table}["']\\)\\s*\\.(insert|update|delete)`);
      assert.doesNotMatch(src, write, `${table} must not be written from the browser`);
    }
    assert.doesNotMatch(src, /journal_entry_lines/, "must not touch the orphaned table");
  });

  test("the route guards the write and stamps the tenant from the session", () => {
    const src = read(ROUTE);
    assert.match(src, /requireContext\(request, \{ module: "accounting", action: "create" \}\)/, "POST guard");
    assert.match(src, /requireContext\(request, \{ module: "accounting", action: "edit" \}\)/, "PUT/PATCH guard");
    assert.match(src, /requireContext\(request, \{ module: "accounting", action: "delete" \}\)/, "DELETE guard");
    assert.match(src, /assertWritableTenant\(context,/, "must reject a forged tenant");
    assert.match(src, /getActiveFinancialYear\(/, "must resolve the year from the session");
    assert.match(src, /assertDateInOpenFinancialYear\(/, "must validate the entry date");
    assert.match(src, /header\.tenant_id = tenantId/, "tenant comes from the session");
  });

  test("the route refuses an unbalanced entry and an unavailable account", () => {
    const src = read(ROUTE);
    assert.match(src, /totalDebit !== totalCredit/, "balanced rule enforced server-side");
    assert.match(src, /accounts are not available to this tenant/, "account must belong to the tenant or be shared");
    assert.match(src, /\.from\("journal_entries"\)\.delete\(\)\.eq\("id", createdId\)/, "a failed line write removes the orphan header");
  });

  test("DELETE scopes to the caller's tenant and refuses a system-posted entry", () => {
    const src = read(ROUTE);
    assert.match(src, /const MANUAL_ENTRY_TYPES/, "the manual allow-list must exist");
    // The delete must load the row inside the tenant before removing anything.
    assert.match(src, /loadQuery = context\.tenantId \? loadQuery\.eq\("tenant_id", context\.tenantId\) : loadQuery\.is\("tenant_id", null\)/, "delete must filter by tenant");
    assert.match(src, /MANUAL_ENTRY_TYPES\.has\(entryType\)/, "a system entry cannot be deleted here");
    assert.match(src, /throw notFound\("Journal entry not found"\)/, "a foreign id resolves to not found");
    // The header delete itself must be tenant-scoped too.
    assert.match(src, /headerQuery = context\.tenantId \? headerQuery\.eq\("tenant_id", context\.tenantId\)/, "header delete is tenant-scoped");
  });

  test("PUT refuses to edit a system-posted entry", () => {
    const src = read(ROUTE);
    assert.match(src, /A system-posted entry is not editable here/, "PUT guards system entries");
    assert.match(src, /MANUAL_ENTRY_TYPES\.has\(String\(\(current as \{ entry_type\?: string \}\)\.entry_type/, "PUT checks the stored entry_type");
  });
});

describe("Exec 36 - compensation must never delete a pre-existing posting", () => {
  test("/api/invoices only compensates a journal THIS call created", () => {
    const src = read("src/app/api/invoices/route.ts") + read("src/lib/sales/service.ts");
    assert.match(src, /if \(created\) createdJournalId = journalId/, "createdJournalId is set only when created");
    // The old unconditional assignment must be gone, or a retry could delete a
    // real posting in the catch block.
    assert.doesNotMatch(src, /^\s*createdJournalId = journalId;\s*$/m, "no unconditional assignment");
  });
});

describe("Exec 36 - payroll idempotency is keyed by run reference, not the date", () => {
  const ROUTE = "src/app/api/payroll/route.ts";
  const PAGE = "src/app/hr/payroll/page.tsx";

  test("the route requires a reference and does not fall back to the date", () => {
    const src = read(ROUTE);
    assert.match(src, /reference is required/, "a missing reference is a bad request");
    assert.doesNotMatch(src, /`PAYROLL-\$\{date\}`/, "must not derive the key from the date alone");
  });

  test("the form sends a stable per-run reference", () => {
    const src = read(PAGE);
    assert.match(src, /reference: `PAYROLL-\$\{payrollDate\}-\$\{payrollRunId\}`/, "reference includes a per-run id");
    assert.match(src, /setPayrollRunId\(/, "the run id rotates after a successful run");
  });
});
