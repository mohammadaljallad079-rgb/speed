import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nextDocumentNumber } from "../src/lib/numbering.ts";

/**
 * Execution 15 regression guards for the financial-correctness remediation.
 *
 * These read the shipped page sources and assert the invariants that were
 * broken (auto-search on date change, timestamp invoice numbering, revenue
 * counted from receipts). They are intentionally source-level: the pages are
 * client components that talk to Supabase directly, so the guarantee we can
 * make in CI is that the defective patterns cannot silently return.
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("Item 3 - date filters require an explicit GO, never auto-search", () => {
  const pages = [
    "src/app/reports/vat/page.tsx",
    "src/app/reports/profit-loss/page.tsx",
    "src/app/reports/cash-flow/page.tsx",
    "src/app/reports/balance-sheet/page.tsx",
    "src/app/reports/trial-balance/page.tsx",
    "src/app/reports/analysis/page.tsx",
    "src/app/reports/car-history/page.tsx",
  ];

  for (const p of pages) {
    test(`${p} binds date inputs to drafts and applies on button press`, () => {
      const src = read(p);
      assert.match(src, /applyDates/, "expected an applyDates handler");
      // The date inputs must not write the applied filter directly.
      assert.doesNotMatch(
        src,
        /<Input[^>]*type="date"[^>]*value=\{(dateFrom|dateTo|fromDate|toDate|startDate|endDate)\}/,
        "date input must bind to a *Draft value, not the applied filter",
      );
      assert.match(src, /value=\{[a-zA-Z]*Draft\}/, "expected a draft-bound date input");
    });
  }
});

describe("Item 2 - sales serial numbers are collision-safe", () => {
  test("invoices/new no longer mints a timestamp invoice number", () => {
    const src = read("src/app/invoices/new/page.tsx");
    assert.doesNotMatch(src, /"INV-"\s*\+\s*Date\.now\(\)/, "timestamp invoice number must be gone");
    assert.match(src, /generate_document_number/, "must use the row-locked numbering RPC");
    assert.match(src, /sale_invoice/, "must request the sale_invoice document type");
  });

  test("nextDocumentNumber uses the RPC result when present", async () => {
    const client = { rpc: async () => ({ data: "SI-2026-000123", error: null }) };
    assert.equal(await nextDocumentNumber(client as never, "sale_invoice", "INV"), "SI-2026-000123");
  });

  test("nextDocumentNumber falls back without throwing when the RPC errors", async () => {
    const client = { rpc: async () => ({ data: null, error: { message: "missing function" } }) };
    const value = await nextDocumentNumber(client as never, "sale_invoice", "INV");
    assert.match(value, /^INV-\d{8}$/);
  });
});

describe("Item 8 - dashboard revenue comes from invoices, not receipts", () => {
  const src = read("src/app/dashboard/page.tsx");

  test("revenue is derived from invoices net of VAT", () => {
    assert.match(src, /invoiceRevenue/, "expected an invoice-based revenue helper");
    assert.match(src, /total_amount[^)]*vat_amount|vat_amount[^)]*total_amount/, "revenue must exclude VAT");
    assert.match(
      src,
      /revenue:\s*(invoices\.reduce|revenueSummary\.net)/,
      "revenue must come from invoices (inline reduce or the shared reconciler)",
    );
  });

  test("receipts are not summed into revenue", () => {
    assert.doesNotMatch(
      src,
      /revenue:\s*payments\.reduce/,
      "cash receipts settle receivables and must not be counted as revenue",
    );
  });
});

describe("Item 1 - VAT report excludes cancelled documents", () => {
  const src = read("src/app/reports/vat/page.tsx");

  test("cancelled invoices and purchases are filtered out", () => {
    assert.match(src, /status\s*!==\s*['"]cancelled['"]/, "cancelled documents must be excluded");
    assert.match(src, /vat_amount/, "VAT is read from the vat_amount column");
  });
});
