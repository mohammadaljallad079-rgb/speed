import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isSaleInvoicePosted, findPostedSaleJournal } from "../src/lib/accounting/invoice-guards.ts";
import {
  buildSupplierPaymentJournal,
  postSupplierPayment,
  cashBankCodeForMethod,
  AP_ACCOUNT_CODE,
  CASH_ACCOUNT_CODE,
  BANK_ACCOUNT_CODE,
} from "../src/lib/accounting/payment-posting.ts";
import {
  findDuplicateJournals,
  findOrphanedLines,
  findUnbalancedEntries,
  findUnbalancedLineGroups,
  findStaleInvoiceBalances,
  scanIntegrity,
} from "../src/lib/accounting/integrity.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Minimal PostgREST-like recording stub. Applies the equality filters it is
 * given, records writes, and can be told to fail a line insert so the caller's
 * compensating behaviour can be observed. No live database.
 */
function makeStub(seed: { tables?: Record<string, any[]>; accounts?: any[]; failLines?: boolean } = {}) {
  const tables: Record<string, any[]> = seed.tables ?? {};
  const written = { journal_entries: [] as any[], journal_lines: [] as any[] };
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
        if (this.table === "accounts") return { data: (seed.accounts ?? []).filter((a) => (this.inVals ?? []).includes(a.code)), error: null };
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

  return { client: { from: (t: string) => new Q(t) }, written };
}

describe("Priority 2 - posted invoice guard", () => {
  test("detects a posted sale journal by entry_type + reference_number", async () => {
    const { client } = makeStub({
      tables: { journal_entries: [{ id: "je1", entry_type: "sale_invoice", reference_number: "SI-1" }] },
    });
    assert.equal(await isSaleInvoicePosted(client as never, "SI-1"), true);
    assert.equal((await findPostedSaleJournal(client as never, "SI-1"))?.id, "je1");
  });

  test("an unposted invoice (no journal) is editable", async () => {
    const { client } = makeStub({ tables: { journal_entries: [] } });
    assert.equal(await isSaleInvoicePosted(client as never, "SI-2"), false);
  });

  test("a different entry_type does not count as a sale posting", async () => {
    const { client } = makeStub({
      tables: { journal_entries: [{ id: "je1", entry_type: "supplier_payment", reference_number: "SI-1" }] },
    });
    assert.equal(await isSaleInvoicePosted(client as never, "SI-1"), false);
  });

  test("fails closed to not-posted on an empty number", async () => {
    const { client } = makeStub({ tables: { journal_entries: [{ id: "x", entry_type: "sale_invoice", reference_number: "SI-1" }] } });
    assert.equal(await isSaleInvoicePosted(client as never, ""), false);
  });

  test("invoice edit page blocks edit and delete when posted", () => {
    const src = read("src/app/invoices/[id]/page.tsx");
    assert.match(src, /isSaleInvoicePosted/);
    assert.match(src, /if \(isPosted\) \{[\s\S]*?return/);
    assert.match(src, /disabled=\{deleting \|\| isPosted\}/);
    assert.match(src, /disabled=\{loading \|\| isPosted\}/);
  });
});

describe("Priority 3 - supplier payment posting", () => {
  test("cash payment is Dr AP / Cr Cash, balanced", () => {
    const j = buildSupplierPaymentJournal({
      journalNumber: "JV-1",
      paymentNumber: "SP-1",
      supplierId: "sup-1",
      amount: 250,
      paymentDate: "2026-01-01",
      description: "pay",
      apAccountId: "acc-ap",
      cashAccountId: "acc-cash",
    })!;
    assert.equal(j.header.total_debit, 250);
    assert.equal(j.header.total_credit, 250);
    assert.equal(j.header.is_balanced, true);
    assert.equal(j.header.entry_type, "supplier_payment");
    assert.equal(j.lines[0].account_id, "acc-ap");
    assert.equal(j.lines[0].debit, 250);
    assert.equal(j.lines[0].credit, 0);
    assert.equal(j.lines[1].account_id, "acc-cash");
    assert.equal(j.lines[1].credit, 250);
    assert.equal(j.lines[1].debit, 0);
  });

  test("bank payment credits the bank account, not cash", () => {
    assert.equal(cashBankCodeForMethod("cash"), CASH_ACCOUNT_CODE);
    assert.equal(cashBankCodeForMethod("bank_transfer"), BANK_ACCOUNT_CODE);
    assert.equal(cashBankCodeForMethod("cheque"), BANK_ACCOUNT_CODE);
  });

  test("zero or negative amounts cannot produce a journal", () => {
    for (const amount of [0, -5]) {
      assert.equal(
        buildSupplierPaymentJournal({
          journalNumber: "JV", paymentNumber: "SP", supplierId: "s", amount, paymentDate: "d",
          description: "x", apAccountId: "a", cashAccountId: "c",
        }),
        null,
      );
    }
  });

  test("postSupplierPayment writes exactly one header and two balanced lines", async () => {
    const { client, written } = makeStub({
      accounts: [{ id: "acc-ap", code: AP_ACCOUNT_CODE }, { id: "acc-cash", code: CASH_ACCOUNT_CODE }],
    });
    await postSupplierPayment(client as never, {
      journalNumber: "JV-9", paymentNumber: "SP-9", supplierId: "sup-9",
      amount: 100, paymentDate: "2026-02-02", paymentMethod: "cash", description: "pay",
    });
    assert.equal(written.journal_entries.length, 1);
    assert.equal(written.journal_lines.length, 2);
    const debit = written.journal_lines.reduce((s, l) => s + l.debit, 0);
    const credit = written.journal_lines.reduce((s, l) => s + l.credit, 0);
    assert.equal(debit, 100);
    assert.equal(credit, 100);
    assert.ok(written.journal_lines.every((l) => l.journal_entry_id === "je-1"));
  });

  test("a failed line write removes the orphan header and throws", async () => {
    const { client, written } = makeStub({
      accounts: [{ id: "acc-ap", code: AP_ACCOUNT_CODE }, { id: "acc-cash", code: CASH_ACCOUNT_CODE }],
      failLines: true,
    });
    await assert.rejects(() =>
      postSupplierPayment(client as never, {
        journalNumber: "JV", paymentNumber: "SP", supplierId: "s",
        amount: 10, paymentDate: "d", paymentMethod: "cash", description: "x",
      }),
    );
    // Header was written then compensated (deleted) - the stub records the insert.
    assert.equal(written.journal_lines.length, 0);
  });

  test("unresolvable accounts throw instead of posting an empty journal", async () => {
    const { client } = makeStub({ accounts: [] });
    await assert.rejects(() =>
      postSupplierPayment(client as never, {
        journalNumber: "JV", paymentNumber: "SP", supplierId: "s",
        amount: 10, paymentDate: "d", paymentMethod: "cash", description: "x",
      }),
    );
  });

  test("supplier-payments page posts the GL entry and compensates on failure", () => {
    const src = read("src/app/supplier-payments/page.tsx");
    assert.match(src, /postSupplierPayment/);
    assert.match(src, /nextDocumentNumber\(supabase as any, "supplier_payment"/);
    assert.match(src, /createdPaymentId/);
    assert.match(src, /entry_type', 'supplier_payment'|entry_type', 'supplier_payment'/);
    // The bill balance must be read fresh, not from a possibly-stale list.
    assert.match(src, /from\('purchase_invoices'\)[\s\S]*?select\('total_amount, paid_amount'\)/);
  });
});

describe("Priority 4 - ledger integrity detection", () => {
  test("duplicate posted journals for one reference are detected (retry/double-post)", () => {
    const dupes = findDuplicateJournals([
      { id: "a", entry_type: "sale_invoice", reference_number: "SI-1" },
      { id: "b", entry_type: "sale_invoice", reference_number: "SI-1" },
      { id: "c", entry_type: "sale_invoice", reference_number: "SI-2" },
    ]);
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0].length, 2);
  });

  test("manual journals with no reference are not treated as duplicates", () => {
    assert.equal(findDuplicateJournals([
      { id: "a", entry_type: "journal_entry", reference_number: null },
      { id: "b", entry_type: "journal_entry", reference_number: null },
    ]).length, 0);
  });

  test("orphaned lines are detected", () => {
    const orphans = findOrphanedLines(
      [{ id: "l1", journal_entry_id: "je1" }, { id: "l2", journal_entry_id: "jeX" }, { id: "l3", journal_entry_id: null }],
      [{ id: "je1" }],
    );
    assert.deepEqual(orphans.map((o) => o.id), ["l2", "l3"]);
  });

  test("unbalanced headers are detected", () => {
    const bad = findUnbalancedEntries([
      { id: "a", total_debit: 100, total_credit: 100 },
      { id: "b", total_debit: 100, total_credit: 90 },
    ]);
    assert.deepEqual(bad.map((b) => b.id), ["b"]);
  });

  test("unbalanced line groups are detected", () => {
    const groups = findUnbalancedLineGroups([
      { id: "l1", journal_entry_id: "je1", debit: 50, credit: 0 },
      { id: "l2", journal_entry_id: "je1", debit: 0, credit: 40 },
      { id: "l3", journal_entry_id: "je2", debit: 10, credit: 0 },
      { id: "l4", journal_entry_id: "je2", debit: 0, credit: 10 },
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].journal_entry_id, "je1");
  });

  test("stale invoice balances are detected", () => {
    const stale = findStaleInvoiceBalances(
      [{ id: "inv1", invoice_number: "SI-1", total_amount: 100, paid_amount: 100 }],
      [{ invoice_id: "inv1", amount: 40 }],
    );
    assert.equal(stale.length, 1);
    assert.equal(stale[0].storedPaid, 100);
    assert.equal(stale[0].actualPaid, 40);
  });

  test("a healthy ledger scans clean", () => {
    const report = scanIntegrity({
      entries: [{ id: "je1", entry_type: "sale_invoice", reference_number: "SI-1", total_debit: 100, total_credit: 100 }],
      lines: [{ id: "l1", journal_entry_id: "je1", debit: 100, credit: 0 }, { id: "l2", journal_entry_id: "je1", debit: 0, credit: 100 }],
      invoices: [{ id: "inv1", total_amount: 100, paid_amount: 100 }],
      payments: [{ invoice_id: "inv1", amount: 100 }],
    });
    assert.equal(report.ok, true);
  });
});

describe("Priority 4b - document numbering has one mechanism", () => {
  const files = [
    "src/app/purchases/new/page.tsx",
    "src/app/purchases/returns/page.tsx",
    "src/app/purchase-orders/page.tsx",
    "src/app/purchase-orders/requisitions/page.tsx",
  ];

  test("no Date.now()-based document numbers remain", () => {
    for (const f of files) {
      const src = read(f);
      assert.doesNotMatch(src, /(receipt_number|note_number|invoice_number|po_number)\s*:\s*[`'"]?(PAY-|DN-|INV-|PO-)?\$\{?Date\.now|(PAY-|DN-|INV-|PO-)' \+ Date\.now/, `${f} still builds a document number from Date.now()`);
    }
  });

  test("each converted site takes its number from nextDocumentNumber", () => {
    for (const f of files) {
      assert.match(read(f), /nextDocumentNumber\(supabase as any, '(receipt|debit_note|purchase_invoice|purchase_order)'/, `${f} must use nextDocumentNumber`);
    }
  });
});

describe("Priority 4c - one canonical journal-line table", () => {
  const journalLineWriters = [
    "src/app/accounting/bank-transfer/page.tsx",
    "src/app/accounting/petty-cash/page.tsx",
    "src/app/hr/payroll/page.tsx",
    "src/app/rentals/[id]/refund-deposit/page.tsx",
    "src/app/sales/new/page.tsx",
    "src/app/accounting/journal-entries/page.tsx",
    "src/lib/accounting/payment-posting.ts",
  ];

  test("no module writes journal lines to the orphaned journal_entry_lines table", () => {
    for (const f of journalLineWriters) {
      assert.doesNotMatch(read(f), /from\(["']journal_entry_lines["']\)/, `${f} writes to journal_entry_lines, which no report reads`);
    }
  });

  test("every module that posts a journal writes its lines to journal_lines", () => {
    for (const f of journalLineWriters) {
      assert.match(read(f), /from\(["']journal_lines["']\)/, `${f} must write lines to journal_lines`);
    }
  });

  test("no Date.now()-based journal numbers remain in the posting modules", () => {
    for (const f of journalLineWriters) {
      assert.doesNotMatch(read(f), /journal_number:\s*'[A-Z-]*'\s*\+\s*Date\.now/, `${f} still builds a journal number from Date.now()`);
    }
  });
});

describe("Priority 5 - migration 005 structure", () => {
  const migration = read("supabase/migrations/005_accounting_integrity.sql");
  const rollback = read("supabase/migrations/005_accounting_integrity_rollback.sql");

  test("adds the two integrity indexes and the read-only view", () => {
    assert.match(migration, /journal_entries_type_ref_idx/);
    assert.match(migration, /journal_entries_one_posted_per_doc_uidx/);
    assert.match(migration, /create or replace view public\.v_journal_integrity_issues/);
  });

  test("is additive and guarded - no drop/delete/update of data", () => {
    assert.doesNotMatch(migration, /\bdrop\s+(table|column)\b/i);
    assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
    assert.doesNotMatch(migration, /\bupdate\s+public\./i);
    assert.match(migration, /information_schema\.columns/);
  });

  test("unique index is scoped to single-event document types", () => {
    assert.match(migration, /entry_type in \('sale_invoice', 'supplier_payment'\)/);
    assert.match(migration, /where status = 'posted'/);
  });

  test("rollback removes exactly what the migration added", () => {
    assert.match(rollback, /drop index if exists public\.journal_entries_one_posted_per_doc_uidx/);
    assert.match(rollback, /drop index if exists public\.journal_entries_type_ref_idx/);
    assert.match(rollback, /drop view\s+if exists public\.v_journal_integrity_issues/);
  });
});
