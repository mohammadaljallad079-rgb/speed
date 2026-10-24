import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  buildTrialBalance,
  buildAccountStatement,
  buildBalanceSheet,
  netByAccount,
  sectionTotal,
  signedBalance,
  isDebitNature,
  round3,
} from "../src/lib/reporting/ledger.ts";
import {
  postSaleInvoice,
  SALE_ACCOUNT_CODES,
} from "../src/lib/accounting/sales-posting.ts";
import { postCustomerReceipt, RECEIPT_ACCOUNT_CODES } from "../src/lib/accounting/receipt-posting.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Execution 53 — Stage 2: ledger derivation and the BD 99 acceptance scenario.
 *
 * The ledger engine is pure, so it is tested directly. The acceptance scenario
 * runs the REAL posting services (`postSaleInvoice`, `postCustomerReceipt`)
 * against a PostgREST-like recording stub, then feeds the journals they wrote
 * into the SAME ledger engine the reports use. That is the point: the test proves
 * the posting path and the reporting path agree, end to end, in Bahraini Dinar
 * (3 decimals), rather than testing each in isolation.
 */

// ---------------------------------------------------------------------------
// A PostgREST-like stub shared by the posting services and the ledger engine.
// ---------------------------------------------------------------------------

function makeLedgerDb() {
  const accounts = [
    { id: "acc-cash", code: "11001", name: "Cash", name_ar: "الصندوق", type: "asset", is_active: true },
    { id: "acc-bank", code: "11002", name: "Bank", name_ar: "البنك", type: "asset", is_active: true },
    { id: "acc-ar", code: "12001", name: "Accounts Receivable", name_ar: "ذمم مدينة", type: "asset", is_active: true },
    { id: "acc-vat", code: "24000", name: "Output VAT", name_ar: "ضريبة المخرجات", type: "liability", is_active: true },
    { id: "acc-rev", code: "41002", name: "Sales Revenue", name_ar: "إيرادات المبيعات", type: "revenue", is_active: true },
  ];
  const entries: any[] = [];
  const lines: any[] = [];
  let seq = 0;

  class Q {
    table: string;
    op = "select";
    filters: [string, any][] = [];
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
    async _run() {
      if (this.op === "select") {
        if (this.table === "accounts") {
          return { data: accounts.filter((a) => (this.inVals ?? []).includes(a.code)), error: null };
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
      return { data: null, error: null };
    }
    single() {
      return this._single();
    }
    maybeSingle() {
      return this._single();
    }
    /** PostgREST returns a bare object for single()/maybeSingle(). */
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
// The ledger engine
// ---------------------------------------------------------------------------

const ACCOUNTS = [
  { id: "a-cash", code: "11001", name_en: "Cash", name_ar: "الصندوق", type: "asset" },
  { id: "a-ar", code: "12001", name_en: "Accounts Receivable", name_ar: "ذمم مدينة", type: "asset" },
  { id: "a-vat", code: "24000", name_en: "Output VAT", name_ar: "ضريبة المخرجات", type: "liability" },
  { id: "a-rev", code: "41002", name_en: "Sales Revenue", name_ar: "إيرادات المبيعات", type: "revenue" },
  { id: "a-exp", code: "51001", name_en: "Rent Expense", name_ar: "مصروف الإيجار", type: "expense" },
];

const ENTRIES = [
  { id: "e-open", entry_date: "2026-01-01", journal_number: "JV-1", reference_number: "OPEN", status: "posted" },
  { id: "e-sale", entry_date: "2026-03-10", journal_number: "JV-2", reference_number: "INV-1", status: "posted" },
  { id: "e-cancel", entry_date: "2026-03-11", journal_number: "JV-3", reference_number: "INV-X", status: "cancelled" },
];

const LINES = [
  // Opening: Dr Cash 1000 / Cr Revenue 1000
  { id: "l1", journal_entry_id: "e-open", account_id: "a-cash", debit: 1000, credit: 0 },
  { id: "l2", journal_entry_id: "e-open", account_id: "a-rev", debit: 0, credit: 1000 },
  // Period sale: Dr AR 110 / Cr Revenue 100 / Cr VAT 10
  { id: "l3", journal_entry_id: "e-sale", account_id: "a-ar", debit: 110, credit: 0 },
  { id: "l4", journal_entry_id: "e-sale", account_id: "a-rev", debit: 0, credit: 100 },
  { id: "l5", journal_entry_id: "e-sale", account_id: "a-vat", debit: 0, credit: 10 },
  // A cancelled document must contribute nothing.
  { id: "l6", journal_entry_id: "e-cancel", account_id: "a-exp", debit: 999, credit: 0 },
];

describe("ledger engine: balances, signs and periods", () => {
  test("debit-nature classification matches the accounting convention", () => {
    assert.equal(isDebitNature("asset"), true);
    assert.equal(isDebitNature("expense"), true);
    assert.equal(isDebitNature("liability"), false);
    assert.equal(isDebitNature("equity"), false);
    assert.equal(isDebitNature("revenue"), false);
    // An unlabelled account still gets a sign rather than vanishing.
    assert.equal(isDebitNature(null), true);
  });

  test("signedBalance puts the balance on the account's normal side", () => {
    assert.equal(signedBalance("asset", 110, 0), 110);
    assert.equal(signedBalance("asset", 0, 30), -30);
    assert.equal(signedBalance("revenue", 0, 100), 100);
    assert.equal(signedBalance("revenue", 40, 0), -40);
  });

  test("a period separates opening balances from period movements", () => {
    const tb = buildTrialBalance(ACCOUNTS, ENTRIES, LINES, { from: "2026-02-01", to: "2026-03-31" });
    const cash = tb.rows.find((r) => r.accountId === "a-cash")!;
    const ar = tb.rows.find((r) => r.accountId === "a-ar")!;
    const rev = tb.rows.find((r) => r.accountId === "a-rev")!;

    // Cash was opened in January: it is opening, not period movement.
    assert.equal(cash.openingBalance, 1000);
    assert.equal(cash.periodDebit, 0);
    assert.equal(cash.closingBalance, 1000);

    // AR only moved in the period.
    assert.equal(ar.openingBalance, 0);
    assert.equal(ar.periodDebit, 110);
    assert.equal(ar.closingBalance, 110);

    // Revenue: 1000 opening credit + 100 period credit.
    assert.equal(rev.openingBalance, 1000);
    assert.equal(rev.periodCredit, 100);
    assert.equal(rev.closingBalance, 1100);
  });

  test("a cancelled document contributes nothing", () => {
    const tb = buildTrialBalance(ACCOUNTS, ENTRIES, LINES, { from: "2026-01-01", to: "2026-12-31" });
    const expense = tb.rows.find((r) => r.accountId === "a-exp")!;
    assert.equal(expense.periodDebit, 0);
    assert.equal(expense.closingBalance, 0);
  });

  test("the trial balance reports balanced when debits equal credits", () => {
    const tb = buildTrialBalance(ACCOUNTS, ENTRIES, LINES, { from: "2026-01-01", to: "2026-12-31" });
    // Closing: Cash 1000 Dr, AR 110 Dr, Revenue 1100 Cr, VAT 10 Cr.
    assert.equal(tb.totals.closingDebit, 1110);
    assert.equal(tb.totals.closingCredit, 1110);
    assert.equal(tb.balanced, true);
    assert.equal(tb.difference, 0);
  });

  test("an unbalanced ledger is reported, not hidden", () => {
    const broken = [...LINES, { id: "lx", journal_entry_id: "e-sale", account_id: "a-cash", debit: 5, credit: 0 }];
    const tb = buildTrialBalance(ACCOUNTS, ENTRIES, broken, { from: "2026-01-01", to: "2026-12-31" });
    assert.equal(tb.balanced, false);
    assert.equal(tb.difference, 5);
  });

  test("an account statement carries a running balance on the normal side", () => {
    const cash = ACCOUNTS.find((a) => a.id === "a-cash")!;
    const statement = buildAccountStatement(cash, ENTRIES, LINES, { from: "2026-02-01", to: "2026-03-31" });
    assert.equal(statement.openingBalance, 1000);
    assert.equal(statement.rows.length, 0);
    assert.equal(statement.closingBalance, 1000);
  });

  test("netByAccount and sectionTotal agree with the trial balance", () => {
    const movements = netByAccount(ENTRIES, LINES);
    const assets = sectionTotal(ACCOUNTS, movements, ["asset"]);
    // Cash 1000 Dr + AR 110 Dr
    assert.equal(assets.balance, 1110);
    const revenue = sectionTotal(ACCOUNTS, movements, ["revenue"]);
    assert.equal(revenue.balance, 1100);
    const liabilities = sectionTotal(ACCOUNTS, movements, ["liability"]);
    assert.equal(liabilities.balance, 10);
  });

  test("money is rounded to 3 decimals (BHD), never floating-point noise", () => {
    assert.equal(round3(0.1 + 0.2), 0.3);
    assert.equal(round3(1.0005), 1.001);
  });
});

// ---------------------------------------------------------------------------
// BD 99 acceptance: invoice -> collection, through the real posting services
// ---------------------------------------------------------------------------

describe("BD 99 acceptance: a sale is issued, collected and reconciles to the ledger", () => {
  test("issue then collect leaves AR at zero and revenue recognised once", async () => {
    const db = makeLedgerDb();

    // 1. Issue the invoice: subtotal 100.000, VAT 10%, total 110.000, nothing paid up front.
    const sale = await postSaleInvoice(db.client as never, {
      journalNumber: "JV-1001",
      invoiceNumber: "INV-BD99-001",
      entryDate: "2026-04-01",
      description: "BD 99 acceptance sale",
      customerId: "cust-1",
      paymentMethod: "cash",
      amount: 100.0,
      discount: 0,
      vat: 10.0,
      advancePayment: 0,
      remaining: 110.0,
    });
    assert.equal(sale.created, true);

    // 2. Collect the full amount: Dr Cash 110.000 / Cr AR 110.000.
    await postCustomerReceipt(db.client as never, {
      journalNumber: "JV-1002",
      receiptNumber: "REC-BD99-001",
      amount: 110.0,
      paymentDate: "2026-04-02",
      paymentMethod: "cash",
      description: "BD 99 acceptance collection",
    });

    // The issue journal recognises revenue once, net of VAT.
    const issueEntry = db.entries.find((e) => e.entry_type === "sale_invoice")!;
    const issueLines = db.lines.filter((l) => l.journal_entry_id === issueEntry.id);
    assert.deepEqual(
      issueLines.map((l) => [l.account_id, l.debit, l.credit]).sort(),
      [
        ["acc-ar", 110, 0],
        ["acc-rev", 0, 100],
        ["acc-vat", 0, 10],
      ].sort(),
    );

    // The collection settles the receivable and never touches revenue again.
    const receiptEntry = db.entries.find((e) => e.entry_type === "customer_receipt")!;
    const receiptLines = db.lines.filter((l) => l.journal_entry_id === receiptEntry.id);
    assert.deepEqual(
      receiptLines.map((l) => [l.account_id, l.debit, l.credit]).sort(),
      [
        ["acc-cash", 110, 0],
        ["acc-ar", 0, 110],
      ].sort(),
    );
    assert.equal(receiptLines.some((l) => l.account_id === "acc-rev"), false, "a receipt must not credit revenue");

    // 3. Derive the reports from the SAME journals the services wrote.
    const tb = buildTrialBalance(db.accounts as never, db.entries as never, db.lines as never, {
      from: "2026-04-01",
      to: "2026-04-30",
    });

    const byCode = (code: string) => tb.rows.find((r) => r.code === code)!;
    assert.equal(byCode(SALE_ACCOUNT_CODES.ar).closingBalance, 0, "AR must be fully settled");
    assert.equal(byCode(SALE_ACCOUNT_CODES.revenue).closingBalance, 100, "revenue recognised once, net of VAT");
    assert.equal(byCode(SALE_ACCOUNT_CODES.vat).closingBalance, 10, "output VAT of 10.000");
    assert.equal(byCode(SALE_ACCOUNT_CODES.cash).closingBalance, 110, "cash collected");

    assert.equal(tb.balanced, true, "the ledger must balance after the cycle");
    assert.equal(tb.totals.closingDebit, 110);
    assert.equal(tb.totals.closingCredit, 110);

    // 4. The AR account statement shows the invoice then its settlement.
    const arAccount = db.accounts.find((a) => a.code === RECEIPT_ACCOUNT_CODES.ar)!;
    const statement = buildAccountStatement(arAccount as never, db.entries as never, db.lines as never, {
      from: "2026-04-01",
      to: "2026-04-30",
    });
    assert.equal(statement.openingBalance, 0);
    assert.equal(statement.rows.length, 2);
    assert.equal(statement.rows[0].debit, 110);
    assert.equal(statement.rows[0].balance, 110);
    assert.equal(statement.rows[1].credit, 110);
    assert.equal(statement.rows[1].balance, 0, "the running balance returns to zero");
    assert.equal(statement.closingBalance, 0);
  });

  test("a retried issue is idempotent and cannot double revenue", async () => {
    const db = makeLedgerDb();
    const input = {
      journalNumber: "JV-2001",
      invoiceNumber: "INV-BD99-002",
      entryDate: "2026-04-05",
      description: "retry",
      customerId: "cust-2",
      paymentMethod: "bank",
      amount: 50.0,
      discount: 0,
      vat: 5.0,
      advancePayment: 0,
      remaining: 55.0,
    };
    const first = await postSaleInvoice(db.client as never, input);
    const second = await postSaleInvoice(db.client as never, { ...input, journalNumber: "JV-2002" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(db.entries.length, 1, "a retry must not post a second journal");

    const tb = buildTrialBalance(db.accounts as never, db.entries as never, db.lines as never, {
      from: "2026-04-01",
      to: "2026-04-30",
    });
    assert.equal(tb.rows.find((r) => r.code === SALE_ACCOUNT_CODES.revenue)!.closingBalance, 50);
  });

  test("a part-paid sale splits between cash and AR and still balances", async () => {
    const db = makeLedgerDb();
    await postSaleInvoice(db.client as never, {
      journalNumber: "JV-3001",
      invoiceNumber: "INV-BD99-003",
      entryDate: "2026-04-10",
      description: "advance sale",
      customerId: "cust-3",
      paymentMethod: "cash",
      amount: 200.0,
      discount: 0,
      vat: 20.0,
      advancePayment: 50.0,
      remaining: 170.0,
    });
    const tb = buildTrialBalance(db.accounts as never, db.entries as never, db.lines as never, {
      from: "2026-04-01",
      to: "2026-04-30",
    });
    assert.equal(tb.rows.find((r) => r.code === SALE_ACCOUNT_CODES.cash)!.closingBalance, 50);
    assert.equal(tb.rows.find((r) => r.code === SALE_ACCOUNT_CODES.ar)!.closingBalance, 170);
    assert.equal(tb.rows.find((r) => r.code === SALE_ACCOUNT_CODES.revenue)!.closingBalance, 200);
    assert.equal(tb.rows.find((r) => r.code === SALE_ACCOUNT_CODES.vat)!.closingBalance, 20);
    assert.equal(tb.balanced, true);
  });
});

// ---------------------------------------------------------------------------
// The General Ledger page must use the engine and scope its reads
// ---------------------------------------------------------------------------

describe("balance sheet: unclosed earnings belong to equity", () => {
  // Capital 30 Dr bank / Cr equity, sale 100 Cr revenue + 10 Cr VAT / Dr AR,
  // receipt Dr cash / Cr AR, rent 900 Dr expense / Cr bank. Debits = credits.
  const ACCTS = [
    { id: "a-cash", code: "11001", name_en: "Cash", type: "asset" },
    { id: "a-bank", code: "11002", name_en: "Bank", type: "asset" },
    { id: "a-ar", code: "12001", name_en: "AR", type: "asset" },
    { id: "a-vat", code: "24000", name_en: "Output VAT", type: "liability" },
    { id: "a-eq", code: "31001", name_en: "Owner Equity", type: "equity" },
    { id: "a-rev", code: "41002", name_en: "Sales Revenue", type: "revenue" },
    { id: "a-exp", code: "51001", name_en: "Rent Expense", type: "expense" },
  ];
  const ENTRIES = [
    { id: "e1", entry_date: "2026-04-01", status: "posted" },
    { id: "e2", entry_date: "2026-04-05", status: "posted" },
    { id: "e3", entry_date: "2026-04-10", status: "posted" },
    { id: "e4", entry_date: "2026-04-15", status: "posted" },
  ];
  const LINES = [
    { journal_entry_id: "e1", account_id: "a-ar", debit: 110, credit: 0 },
    { journal_entry_id: "e1", account_id: "a-rev", debit: 0, credit: 100 },
    { journal_entry_id: "e1", account_id: "a-vat", debit: 0, credit: 10 },
    { journal_entry_id: "e2", account_id: "a-cash", debit: 110, credit: 0 },
    { journal_entry_id: "e2", account_id: "a-ar", debit: 0, credit: 110 },
    { journal_entry_id: "e3", account_id: "a-exp", debit: 900, credit: 0 },
    { journal_entry_id: "e3", account_id: "a-bank", debit: 0, credit: 900 },
    { journal_entry_id: "e4", account_id: "a-bank", debit: 30, credit: 0 },
    { journal_entry_id: "e4", account_id: "a-eq", debit: 0, credit: 30 },
  ];

  test("current earnings are revenue − expenses for the period", () => {
    const bs = buildBalanceSheet(ACCTS, ENTRIES, LINES, { from: "2026-01-01", to: "2026-12-31" });
    assert.equal(bs.currentEarnings, -800);
  });

  test("assets equal liabilities + equity + unclosed earnings", () => {
    const bs = buildBalanceSheet(ACCTS, ENTRIES, LINES, { from: "2026-01-01", to: "2026-12-31" });
    // Assets: cash 110 + bank 30 - 900 = -760; AR 0.
    assert.equal(bs.totalAssets, -760);
    assert.equal(bs.totalLiabilitiesAndEquity, -760);
    assert.equal(bs.balanced, true, "the balance sheet must balance mid-year");
    assert.equal(bs.difference, 0);
  });

  test("the page folds current earnings into the equity section", () => {
    const page = read("src/app/reports/balance-sheet/page.tsx");
    assert.match(page, /buildBalanceSheet\(/);
    assert.match(page, /Current Earnings/);
    assert.match(page, /'asset', 'liability', 'equity', 'revenue', 'expense'/);
  });

  test("accounts are classified by declared type, not a code prefix", () => {
    const page = read("src/app/reports/balance-sheet/page.tsx");
    assert.match(page, /function getSection\(type: string\)/);
    assert.match(page, /if \(type === 'asset'\) return 'assets'/);
    // The old code-prefix heuristic must be gone.
    assert.doesNotMatch(page, /parseInt\(code\)/);
  });

  test("section totals are signed, so a contra balance reduces the total", () => {
    const page = read("src/app/reports/balance-sheet/page.tsx");
    // `Math.abs` on a section TOTAL makes an overdrawn account add to it instead
    // of reducing it, and the header then disagrees with the ledger engine's
    // balance check. (Per-row display of an absolute amount is still fine.)
    assert.doesNotMatch(page, /reduce\(\(s, r\) => s \+ Math\.abs\(r\.closing\)/);
    assert.match(page, /const totalAssets = assets\.reduce\(\(s, r\) => s \+ r\.closing, 0\)/);
    assert.match(page, /const totalLiabilities = liabilities\.reduce\(\(s, r\) => s \+ r\.closing, 0\)/);
    assert.match(page, /const totalEquity = equity\.reduce\(\(s, r\) => s \+ r\.closing, 0\)/);
  });

  test("revenue and expense accounts are excluded from the balance-sheet lines", () => {
    const page = read("src/app/reports/balance-sheet/page.tsx");
    assert.match(page, /if \(acc\.type === 'asset'\) assetRows\.push\(row\)/);
    assert.doesNotMatch(page, /row\.section === 'assets'\) assetRows\.push/);
  });
});

describe("committed screenshots are real captures, not placeholders", () => {
  const dir = path.join(ROOT, "docs", "screenshots");

  test("every Super Admin and report view has a desktop and a mobile shot", () => {
    for (const name of [
      "super-admin-login",
      "super-admin-overview",
      "super-admin-companies",
      "super-admin-users",
      "super-admin-ai",
      "super-admin-subscriptions",
      "super-admin-settings",
      "report-general-ledger",
      "report-trial-balance",
      "report-profit-loss",
      "report-balance-sheet",
      "report-cash-flow",
      "report-financial-index",
      // Execution 54: the purchasing/expense reports.
      "report-purchase-register",
      "report-supplier-ledger",
      "report-supplier-aging",
      "report-expenses-by-vehicle",
      "report-expenses-by-branch",
      "report-vat-purchases",
      "report-vehicle-profitability",
    ]) {
      for (const vp of ["desktop", "mobile"]) {
        const file = path.join(dir, `${name}-${vp}.png`);
        assert.ok(fs.existsSync(file), `missing screenshot: ${name}-${vp}.png`);
      }
    }
  });

  test("no screenshot is a blank or duplicated frame", () => {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
    const seen = new Map();
    for (const f of files) {
      const buf = fs.readFileSync(path.join(dir, f));
      // A PNG of a blank page compresses to a few KB. Real UI content does not.
      assert.ok(buf.length > 8000, `${f} is suspiciously small (${buf.length} bytes)`);
      const hash = crypto.createHash("sha256").update(buf).digest("hex");
      assert.ok(!seen.has(hash), `${f} is byte-identical to ${seen.get(hash)}`);
      seen.set(hash, f);
    }
    assert.ok(files.length >= 20, `expected the full capture set, found ${files.length}`);
  });
});

describe("the capture script refuses to commit a blank frame", () => {
  const script = read("scripts/dev/capture-screenshots.mjs");

  test("it waits for rendered content instead of a fixed delay", () => {
    assert.match(script, /async function waitForContent/);
    assert.match(script, /innerText\.trim\(\)\.length/);
  });

  test("it fails on duplicate screenshots", () => {
    assert.match(script, /duplicate screenshot/);
  });
});

describe("the local dev harness is reproducible", () => {
  test("run-dev.sh clears the stale .next cache before starting", () => {
    const sh = read("scripts/dev/run-dev.sh");
    assert.match(sh, /rm -rf \.next/);
  });

  test("the stub understands the in.(...) and range filters reports send", () => {
    const stub = read("scripts/dev/local-supabase-stub.mjs");
    assert.match(stub, /in\.\(/);
    assert.match(stub, /"gte\."/);
    assert.match(stub, /is\.null/);
  });
});

describe("the General Ledger report is engine-driven and tenant-scoped", () => {
  const page = read("src/app/reports/general-ledger/page.tsx");

  test("it derives its figures from the shared ledger engine", () => {
    assert.match(page, /from '@\/lib\/reporting\/ledger'/);
    assert.match(page, /buildTrialBalance\(/);
    assert.match(page, /buildAccountStatement\(/);
  });

  test("every journal read is scoped through applyReportScope", () => {
    assert.match(page, /applyReportScope\(/);
    // A raw, unscoped journal read must not exist.
    assert.doesNotMatch(page, /from\('journal_entries'\)\.select\([^)]*\)\s*$/m);
    assert.match(page, /useReportScope/);
  });

  test("a denied scope reads nothing", () => {
    assert.match(page, /currentScope\.kind === 'denied'/);
  });

  test("it is reachable from the financial reports index", () => {
    assert.match(read("src/app/reports/financial/page.tsx"), /href: '\/reports\/general-ledger'/);
  });

  test("it appears in both sidebars", () => {
    assert.match(read("src/components/DashboardLayout.tsx"), /'\/reports\/general-ledger'/);
    assert.match(read("src/app/settings/sidebar/page.tsx"), /'\/reports\/general-ledger'/);
  });
});
