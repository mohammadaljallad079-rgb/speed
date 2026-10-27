import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  calculateDepreciation,
  bookValueAfter,
  buildDepreciationJournal,
  postDepreciation,
  resolveDepreciationAccounts,
  DEPRECIATION_ACCOUNT_CODES,
} from "../src/lib/accounting/depreciation-posting.ts";
import {
  buildTrialBalance,
  buildBalanceSheet,
} from "../src/lib/reporting/ledger.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Execution 53 — Stage 3: depreciation posting.
 *
 * The depreciation screen used to compute a schedule in the browser and write
 * nothing to the ledger. These tests prove the charge is now a real, balanced,
 * idempotent journal, and — the part that matters for the books — that the
 * balance sheet still balances after depreciation and that the asset is carried
 * at cost less accumulated depreciation.
 */

// ---------------------------------------------------------------------------
// A PostgREST-like recording stub (same shape as the other posting tests).
// ---------------------------------------------------------------------------

function makeDb(seedAccounts = true) {
  const accounts = seedAccounts
    ? [
        { id: "acc-accum", code: "14001", name_en: "Accumulated Depreciation", name_ar: "مجمع الإهلاك", type: "asset", is_active: true },
        { id: "acc-exp", code: "52001", name_en: "Depreciation Expense", name_ar: "مصروف الإهلاك", type: "expense", is_active: true },
        { id: "acc-fleet", code: "13001", name_en: "Vehicle Fleet", name_ar: "أسطول المركبات", type: "asset", is_active: true },
      ]
    : [];
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
    inCol: string | null = null;
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
    in(c: string, v: any[]) {
      this.inCol = c;
      this.inVals = v;
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
          const col = this.inCol ?? "code";
          const byCode = accounts.filter((a) => (this.inVals ?? []).includes((a as any)[col]));
          return { data: byCode.filter((a) => this._tenantMatch(a)), error: null };
        }
        if (this.table === "journal_entries") {
          return { data: entries.filter((r) => this.filters.every(([c, v]) => r[c] === v)), error: null };
        }
        if (this.table === "journal_lines") {
          const vals = this.inVals ?? [];
          return { data: lines.filter((l) => vals.includes(l.journal_entry_id)), error: null };
        }
        return { data: [], error: null };
      }
      if (this.op === "insert") {
        const rows = Array.isArray(this.row) ? this.row : [this.row];
        if (this.table === "journal_entries") {
          const r = { id: `je-${++seq}`, status: "posted", ...rows[0] };
          entries.push(r);
          return { data: r, error: null };
        }
        if (this.table === "journal_lines") {
          for (const r of rows) lines.push({ id: `jl-${++seq}`, ...r });
          return { data: null, error: null };
        }
      }
      if (this.op === "delete") {
        const keep = entries.filter((r) => !this.filters.every(([c, v]) => r[c] === v));
        entries.length = 0;
        entries.push(...keep);
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
      const result = await this._run();
      const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
      return { data, error: result.error };
    }
    then(onFulfilled: any, onRejected: any) {
      return this._run().then(onFulfilled, onRejected);
    }
  }

  return { client: { from: (t: string) => new Q(t) }, accounts, entries, lines };
}

// ---------------------------------------------------------------------------
// The depreciation calculation (pure)
// ---------------------------------------------------------------------------

describe("depreciation calculation", () => {
  test("straight line spreads (cost - salvage) over the useful life", () => {
    const charge = calculateDepreciation({
      method: "straight_line",
      cost: 10000,
      salvageValue: 1000,
      usefulLifeYears: 5,
      accumulatedToDate: 0,
    });
    // (10000 - 1000) / 5 = 1800
    assert.equal(charge, 1800);
  });

  test("declining balance charges a rate of the book value and decelerates", () => {
    const first = calculateDepreciation({
      method: "declining_balance",
      cost: 10000,
      salvageValue: 0,
      usefulLifeYears: 5,
      annualRate: 20,
      accumulatedToDate: 0,
    });
    const second = calculateDepreciation({
      method: "declining_balance",
      cost: 10000,
      salvageValue: 0,
      usefulLifeYears: 5,
      annualRate: 20,
      accumulatedToDate: first,
    });
    assert.equal(first, 2000); // 20% of 10000
    assert.equal(second, 1600); // 20% of the remaining 8000
    assert.ok(second < first, "declining balance must decelerate");
  });

  test("a charge never takes accumulated depreciation above the depreciable base", () => {
    // Two years already posted against a two-year life: the third is capped at
    // the remaining 1000, not a full 4500.
    const charge = calculateDepreciation({
      method: "straight_line",
      cost: 10000,
      salvageValue: 1000,
      usefulLifeYears: 2,
      accumulatedToDate: 9000,
    });
    assert.equal(charge, 0, "already at the depreciable base");
  });

  test("the final year is clamped to the remaining depreciable amount", () => {
    const charge = calculateDepreciation({
      method: "straight_line",
      cost: 10000,
      salvageValue: 1000,
      usefulLifeYears: 2,
      accumulatedToDate: 8600,
    });
    // remaining = 9000 - 8600 = 400, well under the 4500 annual charge.
    assert.equal(charge, 400);
  });

  test("salvage is never depreciated", () => {
    const charge = calculateDepreciation({
      method: "straight_line",
      cost: 5000,
      salvageValue: 5000,
      usefulLifeYears: 5,
      accumulatedToDate: 0,
    });
    assert.equal(charge, 0);
  });

  test("a non-positive life or rate yields no charge instead of a divide-by-zero", () => {
    assert.equal(
      calculateDepreciation({ method: "straight_line", cost: 1000, salvageValue: 0, usefulLifeYears: 0, accumulatedToDate: 0 }),
      0,
    );
    assert.equal(
      calculateDepreciation({ method: "declining_balance", cost: 1000, salvageValue: 0, usefulLifeYears: 5, annualRate: 0, accumulatedToDate: 0 }),
      0,
    );
  });

  test("book value is cost less accumulated depreciation", () => {
    assert.equal(bookValueAfter(10000, 1800), 8200);
  });

  test("amounts round to 3 decimals (Bahraini Dinar)", () => {
    const charge = calculateDepreciation({
      method: "straight_line",
      cost: 1000,
      salvageValue: 0,
      usefulLifeYears: 3,
      accumulatedToDate: 0,
    });
    assert.equal(charge, 333.333);
  });
});

// ---------------------------------------------------------------------------
// The journal builder (pure)
// ---------------------------------------------------------------------------

describe("the depreciation journal is a balanced expense/contra-asset entry", () => {
  test("it debits the expense and credits accumulated depreciation", () => {
    const journal = buildDepreciationJournal({
      journalNumber: "JV-1",
      reference: "DEP-car-1-2026-12-31",
      date: "2026-12-31",
      description: "Depreciation",
      amount: 1800,
      accumulatedAccountId: "acc-accum",
      expenseAccountId: "acc-exp",
    });
    assert.ok(journal);
    assert.equal(journal.header.entry_type, "depreciation");
    assert.equal(journal.header.status, "posted");
    assert.equal(journal.header.is_balanced, true);
    assert.equal(journal.header.total_debit, 1800);
    assert.equal(journal.header.total_credit, 1800);

    const expenseLine = journal.lines.find((l) => l.account_id === "acc-exp");
    const accumLine = journal.lines.find((l) => l.account_id === "acc-accum");
    assert.equal(expenseLine?.debit, 1800);
    assert.equal(expenseLine?.credit, 0);
    assert.equal(accumLine?.debit, 0);
    assert.equal(accumLine?.credit, 1800);
  });

  test("it refuses a non-positive amount", () => {
    for (const amount of [0, -100]) {
      assert.equal(
        buildDepreciationJournal({
          journalNumber: "JV-1",
          reference: "r",
          date: "2026-12-31",
          description: "d",
          amount,
          accumulatedAccountId: "a",
          expenseAccountId: "e",
        }),
        null,
      );
    }
  });

  test("it refuses a missing account or journal number", () => {
    const base = {
      journalNumber: "JV-1",
      reference: "r",
      date: "2026-12-31",
      description: "d",
      amount: 100,
      accumulatedAccountId: "a",
      expenseAccountId: "e",
    };
    assert.equal(buildDepreciationJournal({ ...base, accumulatedAccountId: "" }), null);
    assert.equal(buildDepreciationJournal({ ...base, expenseAccountId: "" }), null);
    assert.equal(buildDepreciationJournal({ ...base, journalNumber: "" }), null);
  });
});

// ---------------------------------------------------------------------------
// The posting service (DB-bound, via the injectable stub)
// ---------------------------------------------------------------------------

describe("postDepreciation writes one balanced journal and is idempotent", () => {
  const input = {
    journalNumber: "JV-1",
    reference: "DEP-car-1-2026-12-31",
    date: "2026-12-31",
    description: "Depreciation - Toyota Corolla",
    amount: 1800,
  };

  test("it writes a posted, balanced header and exactly two lines", async () => {
    const db = makeDb();
    const result = await postDepreciation(db.client as never, input);
    assert.equal(result.created, true);
    assert.equal(db.entries.length, 1);
    assert.equal(db.entries[0].entry_type, "depreciation");
    assert.equal(db.entries[0].status, "posted");
    assert.equal(db.lines.length, 2);
    const debit = db.lines.reduce((s, l) => s + l.debit, 0);
    const credit = db.lines.reduce((s, l) => s + l.credit, 0);
    assert.equal(debit, credit);
    assert.equal(debit, 1800);
  });

  test("re-posting the same period returns the existing journal", async () => {
    const db = makeDb();
    const first = await postDepreciation(db.client as never, input);
    const second = await postDepreciation(db.client as never, input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.journalId, first.journalId);
    // The double-charge this guards against: one entry, not two.
    assert.equal(db.entries.length, 1);
    assert.equal(db.lines.length, 2);
  });

  test("it throws rather than posting when the accounts are missing", async () => {
    const db = makeDb(false);
    // The tenant-scoped resolver (Exec 64) reports WHICH codes are missing and
    // why, rather than a generic message. Both codes are named.
    await assert.rejects(
      () => postDepreciation(db.client as never, input),
      /14001 .*missing.*52001 .*missing|Cannot resolve chart account/,
    );
    assert.equal(db.entries.length, 0);
  });

  test("resolveDepreciationAccounts finds both fixed codes", async () => {
    const db = makeDb();
    const ids = await resolveDepreciationAccounts(db.client as never);
    assert.equal(ids.accumulatedAccountId, "acc-accum");
    assert.equal(ids.expenseAccountId, "acc-exp");
    assert.equal(DEPRECIATION_ACCOUNT_CODES.accumulated, "14001");
    assert.equal(DEPRECIATION_ACCOUNT_CODES.expense, "52001");
  });
});

// ---------------------------------------------------------------------------
// The accounting outcome: depreciation keeps the books balanced
// ---------------------------------------------------------------------------

describe("posting depreciation leaves the books balanced", () => {
  const ACCOUNTS = [
    { id: "acc-fleet", code: "13001", name_en: "Vehicle Fleet", name_ar: "أسطول المركبات", type: "asset" },
    { id: "acc-accum", code: "14001", name_en: "Accumulated Depreciation", name_ar: "مجمع الإهلاك", type: "asset" },
    { id: "acc-exp", code: "52001", name_en: "Depreciation Expense", name_ar: "مصروف الإهلاك", type: "expense" },
    { id: "acc-cap", code: "30001", name_en: "Capital", name_ar: "رأس المال", type: "equity" },
  ];

  test("a vehicle bought for capital and depreciated once still balances", async () => {
    const db = makeDb();
    // A vehicle acquired for 10,000, funded by capital.
    const acq = (
      await db.client
        .from("journal_entries")
        .insert({
          journal_number: "JV-ACQ",
          entry_date: "2026-01-01",
          entry_type: "vehicle_purchase",
          status: "posted",
          total_debit: 10000,
          total_credit: 10000,
          is_balanced: true,
        })
        .single()
    ).data;
    await db.client
      .from("journal_lines")
      .insert([
        { journal_entry_id: acq.id, account_id: "acc-fleet", debit: 10000, credit: 0 },
        { journal_entry_id: acq.id, account_id: "acc-cap", debit: 0, credit: 10000 },
      ])
      .single();

    // Depreciate it by 1,800.
    await postDepreciation(db.client as never, {
      journalNumber: "JV-DEP",
      reference: "DEP-car-1-2026-12-31",
      date: "2026-12-31",
      description: "Depreciation",
      amount: 1800,
    });

    const entries = db.entries.map((e) => ({ id: e.id, entry_date: e.entry_date }));
    const trial = buildTrialBalance(ACCOUNTS as never, entries as never, db.lines as never, {
      from: "2026-01-01",
      to: "2026-12-31",
    });
    assert.equal(trial.balanced, true, "the ledger must stay balanced after depreciation");
    assert.equal(trial.totals.closingDebit, trial.totals.closingCredit);
  });

  test("the balance sheet carries the asset at cost less accumulated depreciation", async () => {
    const db = makeDb();
    const acq = (
      await db.client
        .from("journal_entries")
        .insert({
          journal_number: "JV-ACQ",
          entry_date: "2026-01-01",
          entry_type: "vehicle_purchase",
          status: "posted",
        })
        .single()
    ).data;
    await db.client
      .from("journal_lines")
      .insert([
        { journal_entry_id: acq.id, account_id: "acc-fleet", debit: 10000, credit: 0 },
        { journal_entry_id: acq.id, account_id: "acc-cap", debit: 0, credit: 10000 },
      ])
      .single();
    await postDepreciation(db.client as never, {
      journalNumber: "JV-DEP",
      reference: "DEP-car-1-2026-12-31",
      date: "2026-12-31",
      description: "Depreciation",
      amount: 1800,
    });

    const entries = db.entries.map((e) => ({ id: e.id, entry_date: e.entry_date }));
    const bs = buildBalanceSheet(ACCOUNTS as never, entries as never, db.lines as never, {
      from: "2026-01-01",
      to: "2026-12-31",
    });

    // Fleet 10000 (Dr) + accumulated 1800 (Cr) = net 8200. The contra-asset is
    // what lets one asset account carry the cost and the write-down separately.
    assert.equal(bs.assets.balance, 8200);
    // Capital is untouched; the 1800 expense is the period's unclosed earnings.
    assert.equal(bs.equity.balance, 10000);
    assert.equal(bs.currentEarnings, -1800);
    assert.equal(bs.totalLiabilitiesAndEquity, 8200);
    assert.equal(bs.balanced, true);
  });
});

// ---------------------------------------------------------------------------
// Wiring: the screen posts through the server, never the browser
// ---------------------------------------------------------------------------

describe("the depreciation screen posts through the API", () => {
  const page = read("src/app/accounting/depreciation/page.tsx");

  test("it calls /api/depreciation/post", () => {
    assert.match(page, /fetch\('\/api\/depreciation\/post'/);
  });

  test("it does not write a journal entry itself", () => {
    assert.doesNotMatch(page, /from\('journal_entries'\)\s*\.insert/);
    assert.doesNotMatch(page, /from\('journal_lines'\)\s*\.insert/);
  });

  test("it sends only the schedule id and date, never an amount", () => {
    const bodyMatch = page.match(/body: JSON\.stringify\(\{([^}]*)\}/);
    assert.ok(bodyMatch, "expected a JSON body");
    assert.doesNotMatch(bodyMatch![1], /amount/);
  });
});

describe("the depreciation route is guarded and derives the amount", () => {
  const route = read("src/app/api/depreciation/post/route.ts");

  test("it requires an authenticated context", () => {
    assert.match(route, /requireContext\(request/);
  });

  test("it never reads a tenant or an amount from the body", () => {
    assert.doesNotMatch(route, /body\.tenant_id/);
    assert.doesNotMatch(route, /body\.amount/);
    assert.doesNotMatch(route, /body\.role/);
  });

  test("it recomputes the charge from the schedule and the ledger", () => {
    assert.match(route, /calculateDepreciation\(/);
    assert.match(route, /accumulatedToDate/);
  });

  test("it scopes the schedule lookup to the session tenant", () => {
    assert.match(route, /scheduleQuery\.eq\("tenant_id", context\.tenantId\)/);
    assert.match(route, /scheduleQuery\.is\("tenant_id", null\)/);
  });

  test("a super admin is the only caller not tenant-scoped (matches scopeToCompany)", () => {
    assert.match(route, /if \(!context\.isSuperAdmin\) \{/);
  });

  test("the accumulated-depreciation lookup is tenant-scoped too", () => {
    // Reading another tenant's depreciation for the same asset id would inflate
    // the accumulated total and wrongly suppress this tenant's charge.
    assert.match(route, /postedQuery\.eq\("tenant_id", context\.tenantId\)/);
    assert.match(route, /postedQuery\.is\("tenant_id", null\)/);
  });

  test("an idempotent re-post does not report a second charge", () => {
    // created:false means nothing was charged, so accumulated/book value are
    // unchanged. Reporting accumulated+amount would imply a charge that did not
    // happen.
    assert.match(route, /created \? round3\(accumulatedToDate \+ amount\) : accumulatedToDate/);
  });

  test("it validates the date against the open financial year", () => {
    assert.match(route, /assertDateInOpenFinancialYear\(/);
  });

  test("it audits the posting", () => {
    assert.match(route, /logAudit\(context/);
  });
});

describe("migration 009 seeds the depreciation accounts", () => {
  const sql = read("supabase/migrations/009_depreciation_accounts.sql");
  const rollback = read("supabase/migrations/009_depreciation_accounts_rollback.sql");

  test("it inserts 14001 and 52001 idempotently", () => {
    assert.match(sql, /'14001'/);
    assert.match(sql, /'52001'/);
    assert.match(sql, /where not exists \(select 1 from public\.accounts a where a\.code = '14001'\)/);
    assert.match(sql, /where not exists \(select 1 from public\.accounts a where a\.code = '52001'\)/);
  });

  test("14001 is an asset (contra-asset) and 52001 an expense", () => {
    assert.match(sql, /'Accumulated Depreciation', 'asset'/);
    assert.match(sql, /'Depreciation Expense', 'expense'/);
  });

  test("it adds the tenant column only when the column is absent", () => {
    assert.match(sql, /column_name = 'tenant_id'/);
    assert.match(sql, /add column tenant_id uuid/);
  });

  test("the rollback is non-destructive to the ledger", () => {
    // It must not delete an account a posted journal may reference.
    assert.doesNotMatch(rollback, /delete from public\.accounts/i);
    assert.match(rollback, /drop index if exists public\.journal_entries_depreciation_ref_idx/);
  });

  // Proving DDL by PARSING is not enough — the repo's rule is to execute it.
  // PGlite is PostgreSQL compiled to WASM, so this runs the real migration.
  test("the migration EXECUTES on real PostgreSQL (apply, re-apply, rollback)", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    await db.exec(`
      create table public.accounts (
        id uuid primary key default gen_random_uuid(),
        code text, name text, name_ar text, name_en text, type text,
        level int default 1, is_active boolean default true, tenant_id uuid
      );
      create table public.journal_entries (
        id uuid primary key default gen_random_uuid(),
        entry_type text, reference_number text, status text default 'posted'
      );
      create table public.depreciation_schedules (
        id uuid primary key default gen_random_uuid(),
        car_id uuid, method text, useful_life_years int, salvage_value numeric,
        annual_rate numeric, start_date date
      );
    `);

    await db.exec(sql);
    const count = async (q: string) =>
      ((await db.query(q)).rows[0] as { c: number }).c;
    const seeded = await count(`select count(*)::int c from public.accounts where code in ('14001','52001')`);
    assert.equal(seeded, 2, "both depreciation accounts must exist after apply");
    const types = (await db.query(`select code,type from public.accounts order by code`)).rows as Array<{ code: string; type: string }>;
    assert.equal(types.find((t) => t.code === "14001")?.type, "asset");
    assert.equal(types.find((t) => t.code === "52001")?.type, "expense");

    // Idempotent: a second run must not duplicate the seeded accounts.
    await db.exec(sql);
    const again = await count(`select count(*)::int c from public.accounts where code in ('14001','52001')`);
    assert.equal(again, 2, "re-apply must not duplicate the accounts");

    // Non-destructive rollback: the index goes, the accounts stay (a posted
    // journal may reference them).
    await db.exec(rollback);
    const idx = await count(`select count(*)::int c from pg_indexes where indexname='journal_entries_depreciation_ref_idx'`);
    assert.equal(idx, 0, "rollback drops the index");
    const kept = await count(`select count(*)::int c from public.accounts where code in ('14001','52001')`);
    assert.equal(kept, 2, "rollback must never delete a seeded account");
  });
});
