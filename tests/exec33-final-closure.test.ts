import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { summarizeRevenue } from "../src/lib/reporting/revenue.ts";
import { buildSaleJournal, SALE_ACCOUNT_CODES } from "../src/lib/accounting/sales-posting.ts";
import { buildReceiptJournal, RECEIPT_ACCOUNT_CODES } from "../src/lib/accounting/receipt-posting.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Exec 33 - final closure of the original 13 items.
 *
 * Each block below pins a defect that was found by auditing the code against the
 * stated requirement, so it cannot silently return. Behavioural assertions run
 * the real pure functions; structural assertions pin the page -> service wiring
 * that cannot be exercised without a database.
 */

describe("Exec 33 Item 2/10 - booking & rental approvals use the single server posting path", () => {
  const bookings = read("src/app/bookings/page.tsx");
  const rentalDetail = read("src/app/rentals/[id]/page.tsx");

  test("bookings/page.tsx compiles: DollarSign is imported where it is used", () => {
    // Regression: <DollarSign /> was used in the detail dialog but never imported
    // (TS2304 Cannot find name 'DollarSign'), so the page failed to typecheck.
    assert.match(bookings, /import\s*\{[^}]*\bDollarSign\b[^}]*\}\s*from\s*['"]lucide-react['"]/);
  });

  for (const [name, src] of [
    ["src/app/bookings/page.tsx", bookings],
    ["src/app/rentals/[id]/page.tsx", rentalDetail],
  ] as const) {
    test(`${name} issues the invoice through a server posting path, not the browser`, () => {
      // The invariant is "the browser does not post the document itself". It may
      // reach the single sales service through either server entry point:
      //   - /api/invoices          (issue a sale or a standalone rental invoice)
      //   - /api/rentals/confirm   (Exec 63: activate the booking AND invoice it
      //                             in one idempotent call, which delegates to
      //                             the same sales service)
      assert.match(
        src,
        /fetch\(['"]\/(api\/invoices|api\/rentals\/confirm)['"]/,
        "must POST to a server posting path",
      );
      assert.doesNotMatch(src, /from\(['"]invoices['"]\)\.insert/, "must not insert the invoice directly");
    });

    test(`${name} does not number the invoice from a row count`, () => {
      assert.doesNotMatch(src, /'INV-'\s*\+\s*\(\(count/, "row-count invoice numbers collide under concurrency");
    });
  }

  test("rentals/[id]/page.tsx takes its receipt number from the numbering RPC", () => {
    assert.match(rentalDetail, /nextDocumentNumber\(supabase,\s*'receipt'/, "receipt number must come from the RPC");
    assert.doesNotMatch(rentalDetail, /'REC-'\s*\+\s*num/, "must not build the receipt number from a count");
  });
});

describe("Exec 33 Item 5/10 - a customer receipt always posts to the ledger", () => {
  const paymentsNew = read("src/app/payments/new/page.tsx");

  test("payments/new posts the receipt through postCustomerReceipt", () => {
    assert.match(paymentsNew, /postCustomerReceipt\(/, "a saved receipt must settle the receivable in the GL");
    assert.match(paymentsNew, /import\s*\{[^}]*postCustomerReceipt[^}]*\}/, "the posting service must be imported");
  });

  test("payments/new numbers the receipt and its journal through the RPC", () => {
    assert.match(paymentsNew, /nextDocumentNumber\([\s\S]*?['"]receipt['"]/, "receipt number from the RPC");
    assert.match(paymentsNew, /nextDocumentNumber\([\s\S]*?['"]journal_entry['"]/, "journal number from the RPC");
    assert.doesNotMatch(paymentsNew, /'REC-'\s*\$\{num\}|`REC-\$\{num\}`/, "must not use the count-based REC number");
  });

  test("the receipt journal settles AR and never credits revenue", () => {
    const j = buildReceiptJournal({
      journalNumber: "JV-1",
      receiptNumber: "REC-1",
      amount: 100,
      paymentDate: "2026-01-01",
      description: "x",
      cashAccountId: "cash",
      arAccountId: "ar",
    });
    assert.ok(j);
    assert.equal(j.header.entry_type, "customer_receipt");
    const byAcc = Object.fromEntries(j.lines.map((l) => [l.account_id, l]));
    assert.equal(byAcc["cash"].debit, 100);
    assert.equal(byAcc["ar"].credit, 100);
    assert.equal(j.lines.length, 2, "a receipt has exactly two lines (no revenue line)");
    assert.equal(RECEIPT_ACCOUNT_CODES.ar, "12001");
  });
});

describe("Exec 33 Item 1/4 - the invoice API stores the subtotal readers expect", () => {
  const route = read("src/app/api/invoices/route.ts") + read("src/lib/sales/service.ts");

  test("the invoice row carries the pre-VAT `amount` subtotal", () => {
    // The print page, the detail form and the Excel export read `invoice.amount`.
    // Without it a server-issued invoice printed a 0.000 line item.
    assert.match(route, /invoiceRow[\s\S]*?\bamount,/, "the insert row must include `amount`");
    assert.match(route, /const revenue = round3\(amount - discount\)/);
  });

  test("the sale journal recognises net revenue and output VAT", () => {
    const journal = buildSaleJournal({
      amount: 100,
      discount: 0,
      vat: 10,
      advancePayment: 0,
      remaining: 110,
      journalNumber: "JV-1",
      invoiceNumber: "SI-1",
      entryDate: "2026-01-01",
      description: "sale",
      customerId: "cust",
      paymentMethod: "cash",
      accounts: {
        cashAccountId: "cash",
        arAccountId: "ar",
        revenueAccountId: "rev",
        vatAccountId: "vat",
      },
      entryType: "sale_invoice",
    });
    assert.ok(journal);
    const byAcc = Object.fromEntries(journal.lines.map((l) => [l.account_id, l]));
    assert.equal(byAcc["ar"].debit, 110, "AR carries the VAT-inclusive total");
    assert.equal(byAcc["rev"].credit, 100, "revenue is recognised net of VAT");
    assert.equal(byAcc["vat"].credit, 10, "output VAT is separated");
    assert.equal(SALE_ACCOUNT_CODES.ar, "12001");
  });

  test("the print page falls back to total - VAT + discount when amount is absent", () => {
    const print = read("src/app/invoices/[id]/print/page.tsx");
    assert.match(print, /const subtotal = amount > 0 \? amount : Math\.max\(0, total - vatAmount \+ discountAmount\)/);
    assert.doesNotMatch(print, /\(amount \+ discountAmount\) \/ days/, "item lines must use the subtotal");
  });
});

describe("Exec 33 Item 4/11 - a posted or dependent invoice is immutable", () => {
  const page = read("src/app/invoices/[id]/page.tsx");

  test("the detail page blocks editing when the invoice has payments or returns", () => {
    assert.match(page, /hasInvoiceDependents\(/, "must load dependents");
    assert.match(page, /if \(hasDependents\)\s*\{[\s\S]*?return/, "must refuse the edit");
    assert.match(page, /if \(isPosted\)\s*\{[\s\S]*?return/, "must refuse the edit when posted");
  });

  test("no page still numbers an invoice or receipt from a row count", () => {
    const files = [
      "src/app/bookings/page.tsx",
      "src/app/rentals/[id]/page.tsx",
      "src/app/payments/new/page.tsx",
    ];
    for (const f of files) {
      const src = read(f);
      assert.doesNotMatch(src, /count\s*\|\|\s*0\)\s*\+\s*1[\s\S]{0,80}padStart\(4/, `${f} still uses a count-based number`);
    }
  });
});

describe("Exec 33 Item 8/12 - dashboard revenue reconciles with the sales documents", () => {
  test("recognised revenue is net of VAT, receipts are never revenue, returns reduce it", () => {
    const summary = summarizeRevenue(
      [
        { total_amount: 110, vat_amount: 10, status: "paid" },
        { total_amount: 220, vat_amount: 20, status: "pending" },
        { total_amount: 50, vat_amount: 5, status: "cancelled" },
      ],
      [{ amount: 30, status: "completed" }],
    );
    assert.equal(summary.gross, 330, "cancelled invoice excluded from gross");
    assert.equal(summary.vat, 30);
    assert.equal(summary.net, 300);
    assert.equal(summary.returns, 30);
    assert.equal(summary.netAfterReturns, 270);
  });

  test("a legacy invoice without total_amount never becomes negative revenue", () => {
    const summary = summarizeRevenue([{ amount: 100, vat_amount: 0, status: "pending" }]);
    assert.equal(summary.net, 100);
  });
});
