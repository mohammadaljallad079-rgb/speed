import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildReceiptJournal,
  cashBankCodeForMethod,
  postCustomerReceipt,
  RECEIPT_ACCOUNT_CODES,
  type ReceiptPostingClient,
} from "../src/lib/accounting/receipt-posting.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("Exec 31 - customer receipt posting (Dr Cash/Bank, Cr AR)", () => {
  test("the journal settles the receivable and never credits revenue", () => {
    const journal = buildReceiptJournal({
      journalNumber: "JV-1",
      receiptNumber: "REC-1",
      amount: 115,
      paymentDate: "2026-01-01",
      description: "receipt",
      cashAccountId: "acc-cash",
      arAccountId: "acc-ar",
    });
    assert.ok(journal);
    assert.equal(journal.header.entry_type, "customer_receipt");
    assert.equal(journal.header.total_debit, 115);
    assert.equal(journal.header.total_credit, 115);
    const byAccount = Object.fromEntries(journal.lines.map((l) => [l.account_id, l]));
    assert.equal(byAccount["acc-cash"].debit, 115, "cash is debited");
    assert.equal(byAccount["acc-cash"].credit, 0);
    assert.equal(byAccount["acc-ar"].credit, 115, "AR is credited");
    assert.equal(byAccount["acc-ar"].debit, 0);
    // No line may hit a revenue account: revenue was recognised at issue.
    assert.equal(journal.lines.length, 2, "a receipt has exactly two lines");
  });

  test("a non-positive amount or missing account yields no journal", () => {
    const base = {
      journalNumber: "JV-1",
      receiptNumber: "REC-1",
      amount: 0,
      paymentDate: "2026-01-01",
      description: "x",
      cashAccountId: "acc-cash",
      arAccountId: "acc-ar",
    };
    assert.equal(buildReceiptJournal(base), null);
    assert.equal(buildReceiptJournal({ ...base, amount: 10, arAccountId: "" }), null);
  });

  test("cash hits 11001; every other method hits 11002", () => {
    assert.equal(cashBankCodeForMethod("cash"), RECEIPT_ACCOUNT_CODES.cash);
    assert.equal(cashBankCodeForMethod("bank_transfer"), RECEIPT_ACCOUNT_CODES.bank);
    assert.equal(cashBankCodeForMethod("card"), RECEIPT_ACCOUNT_CODES.bank);
  });

  test("postCustomerReceipt writes a header and two lines through the client", async () => {
    const entries: any[] = [];
    const lines: any[] = [];
    const accounts = [
      { id: "acc-cash", code: "11001" },
      { id: "acc-ar", code: "12001" },
    ];
    const client = {
      from(table: string) {
        const q: any = {
          _op: "select",
          _filters: [] as [string, any][],
          _in: null as any,
          select() { return q; },
          in(_c: string, v: any[]) { q._in = v; return q; },
          eq(c: string, v: any) { q._filters.push([c, v]); return q; },
          delete() { q._op = "delete"; return q; },
          insert(row: any) { q._op = "insert"; q._row = row; return q; },
          async single() { return q._run(); },
          then(res: any, rej: any) { return q._run().then(res, rej); },
          async _run() {
            if (table === "accounts" && q._op === "select") {
              return { data: accounts.filter((a) => (q._in ?? []).includes(a.code)), error: null };
            }
            if (q._op === "insert" && table === "journal_entries") {
              const row = { id: "je-1", ...q._row };
              entries.push(row);
              return { data: row, error: null };
            }
            if (q._op === "insert" && table === "journal_lines") {
              lines.push(...(q._row as any[]));
              return { data: null, error: null };
            }
            return { data: null, error: null };
          },
        };
        return q;
      },
    };
    const { journalId } = await postCustomerReceipt(client as unknown as ReceiptPostingClient, {
      journalNumber: "JV-9",
      receiptNumber: "REC-9",
      amount: 50,
      paymentDate: "2026-01-01",
      paymentMethod: "cash",
      description: "receipt",
    });
    assert.equal(journalId, "je-1");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].entry_type, "customer_receipt");
    assert.equal(lines.length, 2);
    assert.equal(lines.find((l) => l.account_id === "acc-ar").credit, 50);
  });
});

describe("Exec 31 - rental receipt pages use the AR posting (no revenue double-count)", () => {
  for (const f of ["src/app/rentals/page.tsx", "src/app/rentals/[id]/page.tsx"]) {
    test(`${f} posts receipts through postCustomerReceipt`, () => {
      const src = read(f);
      assert.match(src, /postCustomerReceipt\(/, `${f} must use the receipt posting service`);
      assert.doesNotMatch(src, /from\(["']journal_entries["']\)\.insert/, `${f} must not write journal headers directly`);
      assert.doesNotMatch(src, /entry_number:/, `${f} must not use the non-canonical entry_number column`);
    });
  }

  test("rentals/page.tsx no longer credits a revenue account on collection", () => {
    const src = read("src/app/rentals/page.tsx");
    assert.doesNotMatch(src, /eq\(['"]type['"],\s*['"]revenue['"]\)/, "must not resolve a revenue account for a receipt");
  });
});

describe("Exec 31 - quotation conversion posts a tenant-scoped rental invoice", () => {
  const src = read("src/app/quotations/page.tsx");

  test("creates the invoice through the server, not directly", () => {
    assert.match(src, /fetch\("\/api\/invoices"/, "must post through the server API");
    assert.doesNotMatch(src, /from\(["']invoices["']\)\.insert/, "must not insert the invoice directly");
  });

  test("resolves the tenant from the session, never the body", () => {
    assert.match(src, /auth\.getUser\(\)/, "must read the authenticated user");
    assert.match(src, /tenant_id/, "must set tenant_id on the contract");
  });

  test("does not number the invoice from a row count", () => {
    assert.doesNotMatch(src, /"INV-" \+ \(\(invCount/, "must not build the number from a count");
  });
});

describe("Exec 31 - the invoice API is the single sale/rental posting path", () => {
  const src = read("src/app/api/invoices/route.ts") + read("src/lib/sales/service.ts");
  test("supports a rental invoice that posts to the rental revenue account", () => {
    assert.match(src, /invoice_type/, "must accept the invoice type");
    assert.match(src, /rentalRevenue/, "must post rentals to the rental revenue account");
    assert.match(src, /rental_invoice/, "must tag the rental journal entry type");
  });
});
