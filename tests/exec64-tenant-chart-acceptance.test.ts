import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  resolveAccountIdsForTenant,
  loadUsableAccounts,
  AccountResolutionError,
} from "../src/lib/accounting/account-resolution.ts";
import { postSaleInvoice, SALE_ACCOUNT_CODES } from "../src/lib/accounting/sales-posting.ts";
import { postCustomerReceipt, RECEIPT_ACCOUNT_CODES } from "../src/lib/accounting/receipt-posting.ts";
import { buildTrialBalance, buildAccountStatement, netByAccount } from "../src/lib/reporting/ledger.ts";
import {
  SPEED_CHART,
  REQUIRED_POSTING_CODES,
  POSTING_CODES_IN_USE,
  chartAccount,
  isPostable,
  defaultChartForTenant,
  missingPostingCodes,
} from "../src/lib/accounting/chart.ts";
import { chartRowFor, missingChartCodes } from "../src/lib/accounting/chart-provisioning.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Execution 64 — multi-tenant Chart of Accounts, accounting engine, reports.
 *
 * THE DEFECT THIS SUITE PINS DOWN
 * ------------------------------
 * Before migration 014 every resolver looked an account up by CODE ALONE:
 *
 *     .from("accounts").select("id,code").in("code", ["11001", ...])
 *
 * That is only safe while `accounts.code` is globally unique. Once the chart is
 * per-company, two companies each hold a "11001", the query returns two rows and
 * `rows.find(r => r.code === code)?.id` silently takes whichever row PostgREST
 * returned first. Company B's invoice then debits company A's cash account, and
 * both companies' reports are wrong with no error raised.
 *
 * The tests below run the REAL posting services (`postSaleInvoice`,
 * `postCustomerReceipt`) against a PostgREST-like stub that holds TWO companies
 * with the SAME codes, then feed the journals they wrote into the SAME ledger
 * engine the reports use. That is the acceptance scenario: issue a BD 99 invoice,
 * collect it, and prove each company's ledger reconciles to its OWN accounts.
 */

// ---------------------------------------------------------------------------
// A PostgREST-like stub with two tenants holding identical account codes.
// ---------------------------------------------------------------------------

type AccountRow = {
  id: string;
  code: string;
  tenant_id: string | null;
  is_active?: boolean;
  is_postable?: boolean;
  type?: string;
  name_en?: string;
  name_ar?: string;
};

const T_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const T_B = "bbbbbbbb-0000-0000-0000-00000000000b";

/** Build the shared account list: each company holds its own copy of every code. */
function seedAccounts(): AccountRow[] {
  const rows: AccountRow[] = [];
  const codes: Array<[string, string]> = [
    ["11001", "asset"],
    ["11002", "asset"],
    ["12001", "asset"],
    ["24000", "liability"],
    ["41001", "revenue"],
    ["41002", "revenue"],
  ];
  for (const [code, type] of codes) {
    rows.push({ id: `a-${code}-A`, code, tenant_id: T_A, type, is_active: true, is_postable: true });
    rows.push({ id: `a-${code}-B`, code, tenant_id: T_B, type, is_active: true, is_postable: true });
  }
  return rows;
}

function makeDb(accounts: AccountRow[] = seedAccounts()) {
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
    limitN: number | null = null;
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
    in(_c: string, v: any[]) {
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
    limit(n: number) {
      this.limitN = n;
      return this;
    }
    /** `IS NULL` must match a missing field too: a row with no tenant_id IS the NULL tenant. */
    _tenantMatch(a: any): boolean {
      if (this.isFilters.length) {
        return this.isFilters.every(([c, v]) => (v === null ? a[c] == null : a[c] === v));
      }
      if (this.orFilter) {
        return this.orFilter.split(",").some((part) => {
          const m = /^tenant_id\.eq\.(.+)$/.exec(part.trim());
          if (m) return a.tenant_id === m[1];
          if (part.includes("tenant_id.is.null")) return a.tenant_id == null;
          return false;
        });
      }
      return true;
    }
    _eqMatch(r: any): boolean {
      return this.filters.every(([c, v]) => r[c] === v);
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
          let rows = accounts.slice();
          if (this.inVals) rows = rows.filter((a) => this.inVals!.includes(a.code));
          if (this.filters.length) rows = rows.filter((a) => this._eqMatch(a));
          rows = rows.filter((a) => this._tenantMatch(a));
          if (this.limitN != null) rows = rows.slice(0, this.limitN);
          return { data: rows, error: null };
        }
        if (this.table === "journal_entries") {
          let rows = entries.filter((r) => this._eqMatch(r));
          if (this.limitN != null) rows = rows.slice(0, this.limitN);
          return { data: rows, error: null };
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
        if (this.table === "journal_entries") {
          for (let i = entries.length - 1; i >= 0; i--) {
            if (this._eqMatch(entries[i])) entries.splice(i, 1);
          }
          return { data: null, error: null };
        }
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
    then(onFulfilled: any, onRejected: any) {
      return this._run().then(onFulfilled, onRejected);
    }
  }

  return { client: { from: (t: string) => new Q(t) }, accounts, entries, lines };
}

// ---------------------------------------------------------------------------
// A. The resolver itself: tenant-safe by construction.
// ---------------------------------------------------------------------------

describe("exec64 account resolution is tenant-safe", () => {
  test("company A resolves ITS OWN 11001, not company B's", async () => {
    const db = makeDb();
    const ids = await resolveAccountIdsForTenant(db.client as never, ["11001"], T_A);
    assert.equal(ids["11001"], "a-11001-A");
  });

  test("company B resolves its own 11001, not company A's", async () => {
    const db = makeDb();
    const ids = await resolveAccountIdsForTenant(db.client as never, ["11001"], T_B);
    assert.equal(ids["11001"], "a-11001-B");
  });

  test("two companies never resolve the same account id", async () => {
    const db = makeDb();
    const a = await resolveAccountIdsForTenant(db.client as never, ["11001", "12001", "41002"], T_A);
    const b = await resolveAccountIdsForTenant(db.client as never, ["11001", "12001", "41002"], T_B);
    for (const code of ["11001", "12001", "41002"]) {
      assert.notEqual(a[code], b[code], `code ${code} resolved to one shared row`);
    }
  });

  test("a company may still use the shared (tenant-less) chart", async () => {
    const accounts = [{ id: "shared-11001", code: "11001", tenant_id: null, is_active: true, is_postable: true }];
    const db = makeDb(accounts);
    const ids = await resolveAccountIdsForTenant(db.client as never, ["11001"], T_A);
    assert.equal(ids["11001"], "shared-11001");
  });

  test("a company's own account is preferred over the shared one", async () => {
    const accounts = [
      { id: "shared-11001", code: "11001", tenant_id: null, is_active: true, is_postable: true },
      { id: "own-11001", code: "11001", tenant_id: T_A, is_active: true, is_postable: true },
    ];
    const db = makeDb(accounts);
    const ids = await resolveAccountIdsForTenant(db.client as never, ["11001"], T_A);
    assert.equal(ids["11001"], "own-11001");
  });

  test("another company's account is REFUSED, and named as foreign_tenant", async () => {
    const accounts = [{ id: "b-only", code: "11001", tenant_id: T_B, is_active: true, is_postable: true }];
    const db = makeDb(accounts);
    await assert.rejects(
      () => resolveAccountIdsForTenant(db.client as never, ["11001"], T_A),
      (e: unknown) => {
        assert.ok(e instanceof AccountResolutionError);
        assert.equal((e as AccountResolutionError).failures[0].reason, "foreign_tenant");
        return true;
      },
    );
  });

  test("a code that exists nowhere is reported as missing", async () => {
    const db = makeDb([]);
    await assert.rejects(
      () => resolveAccountIdsForTenant(db.client as never, ["99999"], T_A),
      (e: unknown) => {
        assert.equal((e as AccountResolutionError).failures[0].reason, "missing");
        return true;
      },
    );
  });

  test("two rows for one code in the SAME scope are refused as ambiguous", async () => {
    const accounts = [
      { id: "dupe-1", code: "11001", tenant_id: T_A, is_active: true, is_postable: true },
      { id: "dupe-2", code: "11001", tenant_id: T_A, is_active: true, is_postable: true },
    ];
    const db = makeDb(accounts);
    await assert.rejects(
      () => resolveAccountIdsForTenant(db.client as never, ["11001"], T_A),
      (e: unknown) => {
        assert.equal((e as AccountResolutionError).failures[0].reason, "ambiguous");
        return true;
      },
    );
  });

  test("an inactive account is refused rather than posted to", async () => {
    const accounts = [{ id: "x", code: "11001", tenant_id: T_A, is_active: false, is_postable: true }];
    const db = makeDb(accounts);
    await assert.rejects(
      () => resolveAccountIdsForTenant(db.client as never, ["11001"], T_A),
      (e: unknown) => {
        assert.equal((e as AccountResolutionError).failures[0].reason, "inactive");
        return true;
      },
    );
  });

  test("a group heading (is_postable = false) is refused", async () => {
    const accounts = [{ id: "h", code: "11000", tenant_id: T_A, is_active: true, is_postable: false }];
    const db = makeDb(accounts);
    await assert.rejects(
      () => resolveAccountIdsForTenant(db.client as never, ["11000"], T_A),
      (e: unknown) => {
        assert.equal((e as AccountResolutionError).failures[0].reason, "not_postable");
        return true;
      },
    );
  });

  test("every failure is reported at once, not one per attempt", async () => {
    const db = makeDb([]);
    await assert.rejects(
      () => resolveAccountIdsForTenant(db.client as never, ["11001", "12001", "41002"], T_A),
      (e: unknown) => {
        assert.equal((e as AccountResolutionError).failures.length, 3);
        return true;
      },
    );
  });

  test("the tenant filter is applied in the QUERY, not after it", async () => {
    const src = read("src/lib/accounting/account-resolution.ts");
    // The filter must be part of the request; a post-fetch filter would still
    // transfer another company's rows to this process.
    assert.match(src, /tenant_id\.eq\.\$\{tenantId\},tenant_id\.is\.null/);
    assert.match(src, /\.is\("tenant_id", null\)/);
  });

  test("no resolver resolves by code alone any more", () => {
    const files = [
      "src/lib/accounting/sales-posting.ts",
      "src/lib/accounting/receipt-posting.ts",
      "src/lib/accounting/debit-note-posting.ts",
      "src/lib/accounting/depreciation-posting.ts",
      "src/lib/accounting/payment-posting.ts",
      "src/lib/accounting/manual-posting.ts",
    ];
    for (const f of files) {
      const src = read(f);
      assert.match(src, /account-resolution/, `${f} does not use the central resolver`);
      // A raw code-only lookup is the defect: select id by code with no tenant.
      assert.doesNotMatch(
        src,
        /from\("accounts"\)\s*\.select\("id,code"\)/,
        `${f} still contains a code-only account lookup`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// B. BD 99 acceptance: issue -> collect -> reconcile, per company.
// ---------------------------------------------------------------------------

const BD99 = { net: 90, vat: 9, gross: 99 };

describe("exec64 BD 99 acceptance: each company's ledger reconciles to its own accounts", () => {
  async function issueAndCollect(db: ReturnType<typeof makeDb>, tenantId: string, suffix: string) {
    const sale = await postSaleInvoice(db.client as never, {
      journalNumber: `JV-S-${suffix}`,
      invoiceNumber: `INV-BD99-${suffix}`,
      entryDate: "2026-03-10",
      description: `BD 99 acceptance sale ${suffix}`,
      customerId: `cust-${suffix}`,
      paymentMethod: "cash",
      // The real SaleAmounts shape: a pre-discount amount, the VAT, and how the
      // total is split between an immediate advance and the remaining AR.
      amount: BD99.net,
      discount: 0,
      vat: BD99.vat,
      advancePayment: 0,
      remaining: BD99.gross,
      tenantId,
    } as never);
    const receipt = await postCustomerReceipt(db.client as never, {
      journalNumber: `JV-R-${suffix}`,
      receiptNumber: `REC-BD99-${suffix}`,
      amount: BD99.gross,
      paymentDate: "2026-03-12",
      paymentMethod: "cash",
      description: `BD 99 acceptance collection ${suffix}`,
      tenantId,
    });
    return { sale, receipt };
  }

  test("company A's sale debits A's AR and credits A's revenue + VAT", async () => {
    const db = makeDb();
    await issueAndCollect(db, T_A, "A");

    const saleEntry = db.entries.find((e) => e.reference_number === "INV-BD99-A")!;
    const saleLines = db.lines.filter((l) => l.journal_entry_id === saleEntry.id);
    const byAccount = new Map(saleLines.map((l) => [l.account_id, l]));

    assert.equal(byAccount.get("a-12001-A")?.debit, BD99.gross, "AR must be debited on A's own account");
    assert.equal(byAccount.get("a-41002-A")?.credit, BD99.net, "revenue must be credited on A's own account");
    assert.equal(byAccount.get("a-24000-A")?.credit, BD99.vat, "VAT must be credited on A's own account");

    // Not one line may touch company B.
    for (const l of saleLines) assert.ok(!String(l.account_id).endsWith("-B"), "leaked into company B");
  });

  test("company B's sale touches only company B's accounts", async () => {
    const db = makeDb();
    await issueAndCollect(db, T_B, "B");

    const saleEntry = db.entries.find((e) => e.reference_number === "INV-BD99-B")!;
    const saleLines = db.lines.filter((l) => l.journal_entry_id === saleEntry.id);
    assert.equal(saleLines.length, 3);
    for (const l of saleLines) assert.ok(String(l.account_id).endsWith("-B"), "company B used a foreign account");
  });

  test("both companies post in the SAME database without contaminating each other", async () => {
    const db = makeDb();
    await issueAndCollect(db, T_A, "A");
    await issueAndCollect(db, T_B, "B");

    const aAccounts = new Set(db.lines.filter((l) => l.journal_entry_id.startsWith("je-")).map((l) => l.account_id));
    const aSale = db.entries.find((e) => e.reference_number === "INV-BD99-A")!;
    const bSale = db.entries.find((e) => e.reference_number === "INV-BD99-B")!;
    assert.notEqual(aSale.id, bSale.id, "the two companies' journals must be distinct");
    assert.ok(aAccounts.size > 0);

    const aLines = db.lines.filter((l) => l.journal_entry_id === aSale.id);
    const bLines = db.lines.filter((l) => l.journal_entry_id === bSale.id);
    const aIds = new Set(aLines.map((l) => l.account_id));
    for (const l of bLines) assert.ok(!aIds.has(l.account_id), "the two companies share an account row");
  });

  test("the receipt settles AR: Dr cash / Cr AR, never revenue", async () => {
    const db = makeDb();
    await issueAndCollect(db, T_A, "A");

    const recEntry = db.entries.find((e) => e.reference_number === "REC-BD99-A")!;
    const recLines = db.lines.filter((l) => l.journal_entry_id === recEntry.id);
    const byAccount = new Map(recLines.map((l) => [l.account_id, l]));

    assert.equal(byAccount.get("a-11001-A")?.debit, BD99.gross);
    assert.equal(byAccount.get("a-12001-A")?.credit, BD99.gross);
    // Revenue must not be credited a second time by the collection.
    for (const l of recLines) {
      assert.ok(!["a-41001-A", "a-41002-A"].includes(l.account_id), "the receipt credited revenue again");
    }
  });

  test("after collection the company's AR nets to ZERO — the invoice is settled", async () => {
    const db = makeDb();
    await issueAndCollect(db, T_A, "A");

    const net = netByAccount(db.entries, db.lines);
    const ar = net.get("a-12001-A")!;
    assert.equal(ar.debit - ar.credit, 0, "AR was not fully settled by the collection");
  });

  test("the trial balance reconciles: debits equal credits", async () => {
    const db = makeDb();
    await issueAndCollect(db, T_A, "A");

    const ledgerAccounts = db.accounts.map((a) => ({ id: a.id, code: a.code, type: a.type }));
    const tb = buildTrialBalance(ledgerAccounts as never, db.entries as never, db.lines as never, {
      from: "2026-03-01",
      to: "2026-03-31",
    });
    const totalDebit = tb.rows.reduce((s, r) => s + r.periodDebit, 0);
    const totalCredit = tb.rows.reduce((s, r) => s + r.periodCredit, 0);
    assert.equal(Number(totalDebit.toFixed(3)), Number(totalCredit.toFixed(3)));
  });

  test("cash ends at BD 99 and revenue at BD 90 — the BD 99 flow reconciles", async () => {
    const db = makeDb();
    await issueAndCollect(db, T_A, "A");

    const ledgerAccounts = db.accounts.map((a) => ({ id: a.id, code: a.code, type: a.type }));
    const tb = buildTrialBalance(ledgerAccounts as never, db.entries as never, db.lines as never, {});
    const cash = tb.rows.find((r) => r.accountId === "a-11001-A")!;
    const rev = tb.rows.find((r) => r.accountId === "a-41002-A")!;
    const vat = tb.rows.find((r) => r.accountId === "a-24000-A")!;

    assert.equal(Number(cash.closingBalance.toFixed(3)), BD99.gross);
    assert.equal(Number(rev.closingBalance.toFixed(3)), BD99.net);
    assert.equal(Number(vat.closingBalance.toFixed(3)), BD99.vat);
    // Net + VAT = gross, the invariant the invoice itself must satisfy.
    assert.equal(Number((rev.closingBalance + vat.closingBalance).toFixed(3)), BD99.gross);
  });

  test("the account statement for cash shows exactly the collection", async () => {
    const db = makeDb();
    await issueAndCollect(db, T_A, "A");
    const cashAccount = db.accounts.find((a) => a.id === "a-11001-A")!;
    const st = buildAccountStatement(
      { id: cashAccount.id, code: cashAccount.code, type: cashAccount.type } as never,
      db.entries as never,
      db.lines as never,
      {},
    );
    assert.equal(st.rows.length, 1, "cash moved exactly once");
    assert.equal(Number(st.rows[0].debit.toFixed(3)), BD99.gross);
  });

  test("a retried issue does not double-post revenue", async () => {
    const db = makeDb();
    await issueAndCollect(db, T_A, "A");
    const second = await postSaleInvoice(db.client as never, {
      journalNumber: "JV-S-A-again",
      invoiceNumber: "INV-BD99-A",
      entryDate: "2026-03-10",
      description: "retry",
      customerId: "cust-A",
      paymentMethod: "cash",
      amount: BD99.net,
      discount: 0,
      vat: BD99.vat,
      advancePayment: 0,
      remaining: BD99.gross,
      tenantId: T_A,
    } as never);
    assert.equal(second.created, false, "the retry must return the existing journal");
    const sales = db.entries.filter((e) => e.reference_number === "INV-BD99-A");
    assert.equal(sales.length, 1, "a retry posted a second sale journal");
  });

  test("the journal records the company it belongs to", async () => {
    const db = makeDb();
    await issueAndCollect(db, T_A, "A");
    const saleEntry = db.entries.find((e) => e.reference_number === "INV-BD99-A")!;
    assert.equal(saleEntry.tenant_id, T_A);
    const saleLines = db.lines.filter((l) => l.journal_entry_id === saleEntry.id);
    for (const l of saleLines) assert.equal(l.tenant_id, T_A, "a journal line was left tenant-less");
  });
});

// ---------------------------------------------------------------------------
// C. The code-owned chart catalogue.
// ---------------------------------------------------------------------------

describe("exec64 the chart catalogue is the single definition of the codes", () => {
  test("every code the posting services name is defined in the catalogue", () => {
    assert.deepEqual(missingPostingCodes(), []);
  });

  test("every posting code in use is postable", () => {
    for (const code of POSTING_CODES_IN_USE) {
      const acc = chartAccount(code);
      assert.ok(acc, `posting code ${code} is not in the catalogue`);
      assert.equal(isPostable(code), true, `posting code ${code} is not postable`);
    }
  });

  test("every code in the catalogue is a unique five-digit number", () => {
    const seen = new Set<string>();
    for (const a of SPEED_CHART) {
      assert.match(a.code, /^\d{5}$/, `bad code ${a.code}`);
      assert.ok(!seen.has(a.code), `duplicate code ${a.code}`);
      seen.add(a.code);
    }
  });

  test("each account carries both names and a valid class", () => {
    for (const a of SPEED_CHART) {
      assert.ok(a.nameEn && a.nameAr, `account ${a.code} is not bilingual`);
      assert.ok(["asset", "liability", "equity", "revenue", "expense"].includes(a.type), `bad class on ${a.code}`);
    }
  });

  test("a parent, when named, exists and is a heading", () => {
    const byCode = new Map(SPEED_CHART.map((a) => [a.code, a]));
    for (const a of SPEED_CHART) {
      if (!a.parentCode) continue;
      const parent = byCode.get(a.parentCode);
      assert.ok(parent, `account ${a.code} names a missing parent ${a.parentCode}`);
      assert.equal(isPostable(parent!.code), false, `parent ${a.parentCode} of ${a.code} is postable`);
    }
  });

  test("the sale, receipt and VAT codes the services use are all present", () => {
    const required = [
      SALE_ACCOUNT_CODES.cash,
      SALE_ACCOUNT_CODES.bank,
      SALE_ACCOUNT_CODES.ar,
      SALE_ACCOUNT_CODES.revenue,
      SALE_ACCOUNT_CODES.rentalRevenue,
      SALE_ACCOUNT_CODES.vat,
      RECEIPT_ACCOUNT_CODES.cash,
      RECEIPT_ACCOUNT_CODES.bank,
      RECEIPT_ACCOUNT_CODES.ar,
    ];
    for (const c of required) assert.ok(chartAccount(c), `missing ${c}`);
    for (const c of REQUIRED_POSTING_CODES) assert.ok(chartAccount(c), `missing required ${c}`);
  });

  test("the default chart for a company is the catalogue, tagged with the company", () => {
    const rows = defaultChartForTenant(T_A);
    assert.equal(rows.length, SPEED_CHART.length);
    for (const r of rows) assert.equal(r.tenantId, T_A);
  });

  test("provisioning builds a row per account with the company's id", () => {
    const row = chartRowFor(chartAccount("11001")!, T_B);
    assert.equal(row.tenant_id, T_B);
    assert.equal(row.code, "11001");
  });

  test("a company missing codes is reported, an intact one is not", async () => {
    const full = seedAccounts()
      .filter((a) => a.tenant_id === T_A)
      .map((a) => ({ code: a.code, tenant_id: a.tenant_id }));
    const chain: any = {
      select: () => chain,
      or: () => chain,
      is: () => chain,
      eq: () => chain,
      then: (ok: any) => Promise.resolve({ data: full, error: null }).then(ok),
    };
    const db = { from: () => chain };
    const catalogue = [
      { code: "11001", nameEn: "Cash", nameAr: "الصندوق", type: "asset", parentCode: null, level: 3, category: "cash" },
      { code: "41002", nameEn: "Sales Revenue", nameAr: "إيرادات المبيعات", type: "revenue", parentCode: null, level: 3, category: "operating_revenue" },
    ] as never;
    const missing = await missingChartCodes(db as never, T_A, catalogue);
    assert.deepEqual(missing, []);
  });
});

// ---------------------------------------------------------------------------
// D. Migration 014 static contract.
// ---------------------------------------------------------------------------

describe("exec64 migration 014 defines a per-company chart safely", () => {
  const sql = read("supabase/migrations/014_tenant_chart_of_accounts.sql");

  test("it is wrapped in a transaction", () => {
    assert.match(sql, /begin;/i);
    assert.match(sql, /commit;/i);
  });

  test("it is idempotent (guarded adds, if not exists)", () => {
    assert.match(sql, /if not exists/i);
  });

  test("it refuses a duplicate code WITHIN a company, for a real and the NULL tenant", () => {
    // A plain UNIQUE treats NULLs as distinct, so the NULL tenant needs its own
    // partial index or the single-tenant install can hold 11001 twice.
    assert.match(sql, /tenant_id is null/i);
    assert.match(sql, /unique index/i);
  });

  test("it does NOT reassign historical NULL-tenant accounts", () => {
    assert.doesNotMatch(sql, /update\s+public\.accounts\s+set\s+tenant_id\s*=/i);
  });

  test("it requires a parent to live in the same company", () => {
    assert.match(sql, /parent/i);
  });

  test("it never writes a ledger row", () => {
    assert.doesNotMatch(sql, /insert into public\.journal_(entries|lines)/i);
    assert.doesNotMatch(sql, /update\s+public\.journal_/i);
  });
});

// ---------------------------------------------------------------------------
// E. The resolvers must not regress to a code-only lookup.
// ---------------------------------------------------------------------------

describe("exec64 no posting path resolves an account by code alone", () => {
  test("the five resolvers pass the company into resolution", () => {
    const checks: Array<[string, RegExp]> = [
      ["src/lib/accounting/sales-posting.ts", /resolveAccountIdsForTenant\(\s*[\s\S]{0,200}?tenantId/],
      ["src/lib/accounting/receipt-posting.ts", /resolveAccountIdsForTenant\([\s\S]{0,200}?params\.tenantId/],
      ["src/lib/accounting/debit-note-posting.ts", /resolveAccountIdsForTenant\([\s\S]{0,200}?tenantId/],
      ["src/lib/accounting/depreciation-posting.ts", /resolveAccountIdsForTenant\([\s\S]{0,200}?tenantId/],
      ["src/lib/accounting/payment-posting.ts", /resolveAccountIdsForTenant\([\s\S]{0,200}?tenantId/],
    ];
    for (const [f, re] of checks) {
      assert.match(read(f), re, `${f} does not pass the tenant into resolution`);
    }
  });

  test("the shared writer stamps the company on the journal it writes", () => {
    const src = read("src/lib/accounting/manual-posting.ts");
    assert.match(src, /tenantId\?: string \| null/);
    assert.match(src, /tenant_id: journal\.header\.tenant_id \?\? tenantId/);
  });

  test("the direct route writers pass the session tenant", () => {
    for (const f of [
      "src/app/api/purchases/route.ts",
      "src/app/api/supplier-payments/route.ts",
      "src/app/api/cars/route.ts",
      "src/app/api/supplier-payments/[id]/reverse/route.ts",
    ]) {
      assert.match(read(f), /writeJournal\(supabaseAdmin as never, journal, context\.tenantId\)/, `${f} omits the tenant`);
    }
  });

  test("the browser receipt callers take the tenant from the session, not a form", () => {
    for (const f of ["src/app/payments/new/page.tsx", "src/app/rentals/page.tsx", "src/app/rentals/[id]/page.tsx"]) {
      const src = read(f);
      assert.match(src, /useTenantId\(\)/, `${f} does not resolve the tenant from the session`);
      assert.match(src, /tenantId,/, `${f} does not pass the tenant to the receipt`);
    }
  });
});

// ---------------------------------------------------------------------------
// F. Deploy-order safety: the app ships BEFORE the operator applies 014.
// ---------------------------------------------------------------------------

describe("exec64 posting works on a schema that has not yet been migrated", () => {
  /** A chart whose `accounts` table has NO `is_postable` column (pre-014). */
  function makePreMigrationDb() {
    const accounts = [
      { id: "a-11001-A", code: "11001", tenant_id: T_A, type: "asset", is_active: true },
      { id: "a-11002-A", code: "11002", tenant_id: T_A, type: "asset", is_active: true },
      { id: "a-12001-A", code: "12001", tenant_id: T_A, type: "asset", is_active: true },
      { id: "a-24000-A", code: "24000", tenant_id: T_A, type: "liability", is_active: true },
      { id: "a-41002-A", code: "41002", tenant_id: T_A, type: "revenue", is_active: true },
    ];
    const entries: any[] = [];
    const lines: any[] = [];
    let seq = 0;
    class Q {
      table: string;
      op = "select";
      cols = "";
      filters: [string, any][] = [];
      isFilters: [string, any][] = [];
      orFilter: string | null = null;
      inVals: any[] | null = null;
      row: any = null;
      constructor(t: string) {
        this.table = t;
      }
      select(c?: string) {
        this.cols = c ?? "";
        return this;
      }
      eq(c: string, v: any) {
        this.filters.push([c, v]);
        return this;
      }
      in(_c: string, v: any[]) {
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
      limit() {
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
        if (this.op === "select" && this.table === "accounts") {
          // The database rejects a column it does not have — exactly what
          // PostgREST does (42703).
          if (this.cols.includes("is_postable")) {
            return {
              data: null,
              error: { code: "42703", message: 'column accounts.is_postable does not exist' },
            };
          }
          let rows = accounts.filter((a) => (this.inVals ?? []).includes(a.code));
          rows = rows.filter((a) => this.filters.every(([c, v]) => (a as any)[c] === v));
          if (this.orFilter) {
            rows = rows.filter((a) =>
              this.orFilter!.split(",").some((p) => {
                const m = /^tenant_id\.eq\.(.+)$/.exec(p.trim());
                return m ? a.tenant_id === m[1] : p.includes("is.null") && a.tenant_id == null;
              }),
            );
          } else if (this.isFilters.length) {
            rows = rows.filter((a) => this.isFilters.every(([c, v]) => (v === null ? (a as any)[c] == null : (a as any)[c] === v)));
          }
          return { data: rows, error: null };
        }
        if (this.op === "select" && this.table === "journal_entries") {
          return { data: entries.filter((e) => this.filters.every(([c, v]) => e[c] === v)), error: null };
        }
        if (this.op === "select" && this.table === "journal_lines") {
          const vals = this.inVals ?? [];
          return { data: lines.filter((l) => vals.includes(l.journal_entry_id)), error: null };
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
    return { client: { from: (t: string) => new Q(t) }, entries, lines };
  }

  test("the resolver falls back to a narrower column list instead of failing", async () => {
    const db = makePreMigrationDb();
    const ids = await resolveAccountIdsForTenant(db.client as never, ["11001"], T_A);
    assert.equal(ids["11001"], "a-11001-A");
  });

  test("a sale still posts on the un-migrated schema", async () => {
    const db = makePreMigrationDb();
    const res = await postSaleInvoice(db.client as never, {
      journalNumber: "JV-PRE",
      invoiceNumber: "INV-PRE-001",
      entryDate: "2026-03-10",
      description: "pre-migration sale",
      customerId: "cust-1",
      paymentMethod: "cash",
      amount: BD99.net,
      discount: 0,
      vat: BD99.vat,
      advancePayment: 0,
      remaining: BD99.gross,
      tenantId: T_A,
    } as never);
    assert.equal(res.created, true);
    const sale = db.entries.find((e) => e.reference_number === "INV-PRE-001")!;
    assert.equal(db.lines.filter((l) => l.journal_entry_id === sale.id).length, 3);
  });

  test("only an undefined-column error triggers the fallback", () => {
    const src = read("src/lib/accounting/account-resolution.ts");
    assert.match(src, /isUndefinedColumn/);
    assert.match(src, /42703/);
    // A different failure must not be silently swallowed by a retry.
    assert.match(src, /if \(error\) throw new Error\("Could not load the chart of accounts: "/);
  });
});
