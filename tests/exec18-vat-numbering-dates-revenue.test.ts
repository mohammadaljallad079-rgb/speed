import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  summarizeVatSources,
  type VatSourceRow,
} from "../src/lib/reporting/vat.ts";
import { summarizeRevenue, invoiceNetRevenue } from "../src/lib/reporting/revenue.ts";
import { nextDocumentNumber } from "../src/lib/numbering.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("Exec 18 - Item 1: VAT report format & data source", () => {
  test("invoice/purchase totals are VAT-inclusive: taxable = total - vat", () => {
    const rows: VatSourceRow[] = [{ total_amount: 110, vat_amount: 10, status: "paid", invoice_date: "2026-01-05" }];
    const summary = summarizeVatSources({ invoices: rows, purchases: [], expenses: [] });
    assert.equal(summary.breakdown.sales.taxable, 100);
    assert.equal(summary.breakdown.sales.vat, 10);
    assert.equal(summary.outputVat, 10);
  });

  test("expense amounts are pre-VAT: taxable = amount", () => {
    const summary = summarizeVatSources({
      invoices: [],
      purchases: [],
      expenses: [{ amount: 50, vat_amount: 5, expense_date: "2026-01-08" }],
    });
    assert.equal(summary.breakdown.expenses.taxable, 50);
    assert.equal(summary.breakdown.expenses.vat, 5);
    assert.equal(summary.inputVat, 5);
  });

  test("cancelled documents contribute nothing", () => {
    const summary = summarizeVatSources({
      invoices: [{ total_amount: 110, vat_amount: 10, status: "cancelled", invoice_date: "2026-01-05" }],
      purchases: [{ total_amount: 55, vat_amount: 5, status: "cancelled", bill_date: "2026-01-06" }],
      expenses: [],
    });
    assert.equal(summary.outputVat, 0);
    assert.equal(summary.inputVat, 0);
    assert.equal(summary.totalTaxableSales, 0);
  });

  test("input VAT combines purchase invoices and expenses", () => {
    const summary = summarizeVatSources({
      invoices: [],
      purchases: [{ total_amount: 220, vat_amount: 20, status: "paid", bill_date: "2026-02-01" }],
      expenses: [{ amount: 100, vat_amount: 10, expense_date: "2026-02-02" }],
    });
    assert.equal(summary.inputVat, 30);
    assert.equal(summary.breakdown.purchases.vat, 20);
    assert.equal(summary.breakdown.expenses.vat, 10);
  });

  test("net VAT = output - input, and months are sorted", () => {
    const summary = summarizeVatSources({
      invoices: [
        { total_amount: 110, vat_amount: 10, status: "paid", invoice_date: "2026-03-05" },
        { total_amount: 110, vat_amount: 10, status: "paid", invoice_date: "2026-01-05" },
      ],
      purchases: [{ total_amount: 110, vat_amount: 10, status: "paid", bill_date: "2026-02-01" }],
      expenses: [],
    });
    assert.equal(summary.netVat, 10);
    assert.deepEqual(summary.months.map((m) => m.month), ["2026-01", "2026-02", "2026-03"]);
  });

  test("vat report page reads the taxable-base columns and uses the shared aggregator", () => {
    const src = read("src/app/reports/vat/page.tsx");
    assert.match(src, /summarizeVatSources/, "must use the shared pure aggregator");
    assert.match(src, /total_amount, vat_amount, invoice_date, status/, "must fetch the invoice total");
    assert.match(src, /amount, vat_amount, expense_date/, "must fetch the expense pre-VAT amount");
    assert.match(src, /status\s*!==\s*['"]cancelled['"]/, "cancelled documents must be excluded");
  });
});

describe("Exec 18 - Item 4: dashboard revenue reconciles with sales", () => {
  test("revenue is net of VAT, gross is inclusive", () => {
    const summary = summarizeRevenue([{ total_amount: 110, vat_amount: 10, status: "paid" }]);
    assert.equal(summary.gross, 110);
    assert.equal(summary.vat, 10);
    assert.equal(summary.net, 100);
  });

  test("receipts never appear in the revenue inputs", () => {
    const src = read("src/app/dashboard/page.tsx");
    assert.doesNotMatch(src, /revenue:\s*payments\.reduce/, "receipts must not be counted as revenue");
    assert.match(src, /summarizeRevenue/, "revenue must use the shared reconciler");
  });

  test("returns reduce revenue (contra-revenue)", () => {
    const summary = summarizeRevenue(
      [{ total_amount: 110, vat_amount: 10, status: "paid" }],
      [{ amount: 30, status: "completed" }],
    );
    assert.equal(summary.returns, 30);
    assert.equal(summary.netAfterReturns, 70);
  });

  test("cancelled invoices and returns are ignored", () => {
    assert.equal(invoiceNetRevenue({ total_amount: 110, vat_amount: 10, status: "cancelled" }), 0);
    const summary = summarizeRevenue(
      [{ total_amount: 110, vat_amount: 10, status: "cancelled" }],
      [{ amount: 30, status: "cancelled" }],
    );
    assert.equal(summary.net, 0);
    assert.equal(summary.returns, 0);
  });

  test("a legacy row missing total_amount falls back to the pre-VAT amount", () => {
    const summary = summarizeRevenue([{ amount: 100, vat_amount: 0, status: "paid" }]);
    assert.equal(summary.net, 100);
    assert.equal(summary.netAfterReturns, 100);
  });
});

describe("Exec 18 - Item 2: sales serial numbers are collision-safe", () => {
  test("sales/new issues through the server, which allocates the number", () => {
    const src = read("src/app/sales/new/page.tsx");
    // Exec 31: sales/new must not write the invoice or its journal directly
    // (that path had no tenant_id, no idempotency guard and no financial-year
    // check). It now posts to the single server-side service.
    assert.match(src, /fetch\("\/api\/invoices"/, "must post through the server API");
    assert.doesNotMatch(src, /from\(["']invoices["']\)\.insert/, "must not insert the invoice directly");
    assert.doesNotMatch(src, /from\(["']journal_entries["']\)\.insert/, "must not post the journal directly");
  });

  test("the server allocates the sale number and never inserts an empty one", () => {
    const src = read("src/app/api/invoices/route.ts") + read("src/lib/sales/service.ts");
    assert.match(src, /nextDocumentNumber\([^)]*"sale_invoice"/, "server must allocate the sale number");
    assert.match(src, /invoice_number: invoiceNumber/, "must insert the allocated number");
  });

  test("nextDocumentNumber prefers the RPC result", async () => {
    const client = { rpc: async () => ({ data: "SI-2026-000042", error: null }) };
    assert.equal(await nextDocumentNumber(client as never, "sale_invoice", "SI"), "SI-2026-000042");
  });

  test("fallback is collision-safe under same-millisecond calls", async () => {
    const client = { rpc: async () => ({ data: null, error: { message: "missing" } }) };
    const a = await nextDocumentNumber(client as never, "sale_invoice", "SI");
    const b = await nextDocumentNumber(client as never, "sale_invoice", "SI");
    assert.match(a, /^SI-\d{8}$/);
    assert.match(b, /^SI-\d{8}$/);
    assert.notEqual(a, b, "two fallbacks in the same millisecond must differ");
  });
});

describe("Exec 18 - Item 3: date filters require an explicit GO, never auto-search", () => {
  const pages = [
    "src/app/reports/vat/page.tsx",
    "src/app/reports/profit-loss/page.tsx",
    "src/app/reports/cash-flow/page.tsx",
    "src/app/reports/balance-sheet/page.tsx",
    "src/app/reports/trial-balance/page.tsx",
    "src/app/reports/analysis/page.tsx",
    "src/app/reports/car-history/page.tsx",
    "src/app/accounting/journal-entries/page.tsx",
    "src/app/hr/attendance/page.tsx",
    "src/app/sales/returns/page.tsx",
    "src/app/accounting/expenses/page.tsx",
    "src/app/expenses/page.tsx",
    "src/app/payments/page.tsx",
    "src/app/invoices/page.tsx",
    "src/app/purchases/page.tsx",
    "src/app/rentals/invoices/page.tsx",
  ];

  for (const p of pages) {
    test(`${p} binds date inputs to drafts and applies on button press`, () => {
      const src = read(p);
      assert.match(src, /(applyDates|applyFilters)/, "expected an explicit apply handler");
      assert.doesNotMatch(
        src,
        /<Input[^>]*type="date"[^>]*value=\{(dateFrom|dateTo|fromDate|toDate|startDate|endDate|filterDateFrom|filterDateTo)\}/,
        "date input must bind to a *Draft value, not the applied filter",
      );
      assert.match(src, /value=\{[a-zA-Z]*(Draft|From|To)[a-zA-Z]*\}/, "expected a draft-bound date input");
    });
  }
});
