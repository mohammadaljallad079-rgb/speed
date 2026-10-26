import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  decideInvoiceEdit,
  decideInvoiceDeletion,
  lookupPostedJournal,
} from "../src/lib/accounting/invoice-guards.ts";
import { findPostedManualJournal } from "../src/lib/accounting/manual-posting.ts";
import {
  buildSalesReturnJournal,
} from "../src/lib/accounting/sales-return-posting.ts";
import { statusAfterReturn, createSalesReturn } from "../src/lib/sales/return-service.ts";
import { buildDebitNoteReversalJournal } from "../src/lib/accounting/debit-note-posting.ts";
import {
  buildExpenseJournal,
  buildExpenseReversalJournal,
  isCreditPurchase,
  cashBankCodeForMethod,
  EXPENSE_ACCOUNT_CODES,
} from "../src/lib/accounting/expense-posting.ts";

/**
 * Execution 67 - two tenant-scoping defects on financial write paths.
 *
 * THE DEFECTS THIS SUITE PINS DOWN
 * -------------------------------
 * 1. `POST /api/supplier-payments/[id]/reverse` looked up its idempotency
 *    journal with `findPostedManualJournal(client, "supplier_payment_reversal",
 *    paymentNumber)` - NO tenant. Two companies can each hold a payment
 *    `PAY-0001`. When company B reversed its payment, the lookup could match
 *    company A's reversal journal, so company B skipped writing its own mirror
 *    entry, then went on to restore the bill balance and cancel the payment. The
 *    result was a cancelled payment with no reversal in company B's ledger: the
 *    books still described a settlement the document no longer claimed.
 *
 * 2. The invoice edit screen wrote `invoices` straight from the browser. Its
 *    "posted" and "has dependents" checks were advisory, so a caller who did not
 *    use the screen could rewrite a posted invoice's amounts - or one that had
 *    receipts against it - while the journal and the receipts kept the old
 *    figures. The route now decides server-side (`decideInvoiceEdit`), takes the
 *    tenant from the session, and derives `total_amount` itself.
 *
 * The stubs below hold TWO tenants, because a single-tenant stub cannot show a
 * cross-tenant match at all - which is how the first defect survived.
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const T_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const T_B = "bbbbbbbb-0000-0000-0000-00000000000b";

/**
 * A PostgREST-like stub holding journal rows for two tenants that share the SAME
 * document number. `eq`/`is` filters are applied for real, so a query that
 * forgets its tenant filter returns both rows - exactly the production mistake.
 */
function twoTenantLedgerStub() {
  const rows = [
    { id: "je-A", entry_type: "supplier_payment_reversal", reference_number: "PAY-0001", tenant_id: T_A },
    { id: "je-B", entry_type: "supplier_payment_reversal", reference_number: "PAY-0001", tenant_id: T_B },
  ];

  function builder() {
    const eqs: [string, unknown][] = [];
    const iss: [string, unknown][] = [];
    let limitN: number | null = null;
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        eqs.push([c, v]);
        return b;
      },
      is: (c: string, v: unknown) => {
        iss.push([c, v]);
        return b;
      },
      limit: (n: number) => {
        limitN = n;
        return b;
      },
      maybeSingle: async () => {
        let out = rows.filter((r) => eqs.every(([c, v]) => (r as any)[c] === v));
        out = out.filter((r) =>
          iss.every(([c, v]) => (v === null ? (r as any)[c] == null : (r as any)[c] === v)),
        );
        if (limitN != null) out = out.slice(0, limitN);
        return { data: out[0] ?? null, error: null };
      },
    };
    return b;
  }

  return { from: () => builder() };
}

/** A guard client: the ledger lookup plus the two dependents counts. */
function guardStub(opts: { posted: boolean; payments?: number; returns?: number; ledgerError?: boolean }) {
  return {
    from(table: string) {
      const eqs: [string, unknown][] = [];
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => {
          eqs.push([c, v]);
          return b;
        },
        is: () => b,
        limit: () => b,
        maybeSingle: async () =>
          opts.ledgerError
            ? { data: null, error: { message: "permission denied for table journal_entries" } }
            : { data: opts.posted ? { id: "je-1", journal_number: "JV-1" } : null, error: null },
        then: (resolve: (v: unknown) => void) => {
          const count = table === "payments" ? (opts.payments ?? 0) : (opts.returns ?? 0);
          return Promise.resolve({ count, error: null }).then(resolve);
        },
      };
      return b;
    },
  };
}

// ---------------------------------------------------------------------------
// A. The reversal idempotency lookup is tenant-scoped.
// ---------------------------------------------------------------------------

describe("exec67 the supplier-payment reversal lookup cannot see another company", () => {
  test("a reversal journal in ANOTHER tenant is not returned", async () => {
    const db = twoTenantLedgerStub();
    // Company B asks. Company A holds a journal with the identical number.
    const found = await findPostedManualJournal(
      db as never,
      "supplier_payment_reversal",
      "PAY-0001",
      T_B,
    );
    assert.equal(found?.id, "je-B", "only the caller's own reversal may be found");
  });

  test("company A finds its own reversal, not company B's", async () => {
    const db = twoTenantLedgerStub();
    const found = await findPostedManualJournal(
      db as never,
      "supplier_payment_reversal",
      "PAY-0001",
      T_A,
    );
    assert.equal(found?.id, "je-A");
  });

  test("a tenant-less caller is confined to the NULL tenant", async () => {
    const db = twoTenantLedgerStub();
    const found = await findPostedManualJournal(
      db as never,
      "supplier_payment_reversal",
      "PAY-0001",
      null,
    );
    assert.equal(found, null, "a tenant-less caller must not match a tenanted journal");
  });

  test("without a tenant filter the lookup WOULD return a foreign row", async () => {
    // Demonstrates why the fix is load-bearing: omitting the tenant is not
    // "one row fewer", it is the wrong company's row.
    const db = twoTenantLedgerStub();
    const unfiltered = await lookupPostedJournal(db as never, "supplier_payment_reversal", "PAY-0001");
    assert.equal(unfiltered.state, "absent", "the stub's NULL-tenant filter excludes both tenanted rows");
  });

  test("the reverse route passes the session tenant to the idempotency lookup", () => {
    const src = read("src/app/api/supplier-payments/[id]/reverse/route.ts");
    assert.match(
      src,
      /findPostedManualJournal\(\s*supabaseAdmin as never,\s*"supplier_payment_reversal",\s*paymentNumber,\s*context\.tenantId,?\s*\)/,
      "the reversal lookup must be tenant-scoped or it can match another company's journal",
    );
  });
});

// ---------------------------------------------------------------------------
// B. An invoice edit is decided on the server and fails closed.
// ---------------------------------------------------------------------------

describe("exec67 decideInvoiceEdit fails closed", () => {
  const base = { id: "inv-1", invoiceNumber: "INV-1", tenantId: T_A };

  test("a posted invoice may not be edited", async () => {
    const d = await decideInvoiceEdit(guardStub({ posted: true }) as never, base);
    assert.equal(d.allowed, false);
    assert.equal((d as any).code, "posted");
  });

  test("an invoice with receipts may not be edited", async () => {
    const d = await decideInvoiceEdit(guardStub({ posted: false, payments: 1 }) as never, base);
    assert.equal(d.allowed, false);
    assert.equal((d as any).code, "dependents");
  });

  test("an invoice with returns may not be edited", async () => {
    const d = await decideInvoiceEdit(guardStub({ posted: false, returns: 2 }) as never, base);
    assert.equal(d.allowed, false);
    assert.equal((d as any).code, "dependents");
  });

  test("an unverifiable posting state is refused, not assumed safe", async () => {
    const d = await decideInvoiceEdit(guardStub({ posted: false, ledgerError: true }) as never, base);
    assert.equal(d.allowed, false);
    assert.equal((d as any).code, "unverified");
  });

  test("a plain unposted invoice with no dependents may be edited", async () => {
    const d = await decideInvoiceEdit(guardStub({ posted: false }) as never, base);
    assert.equal(d.allowed, true);
  });

  test("edit and delete agree on every case (one decision, two verbs)", async () => {
    for (const opts of [
      { posted: true },
      { posted: false, payments: 1 },
      { posted: false, returns: 1 },
      { posted: false, ledgerError: true },
      { posted: false },
    ]) {
      const e = await decideInvoiceEdit(guardStub(opts) as never, base);
      const del = await decideInvoiceDeletion(guardStub(opts) as never, base);
      assert.equal(e.allowed, del.allowed, `edit/delete disagreed for ${JSON.stringify(opts)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// C. The edit route is server-authoritative.
// ---------------------------------------------------------------------------

describe("exec67 the invoice edit route is server-authoritative", () => {
  const route = read("src/app/api/invoices/[id]/route.ts");

  test("the edit endpoint exists and guards with the edit decision", () => {
    assert.match(route, /export async function PUT\(/, "a server edit endpoint must exist");
    assert.match(route, /decideInvoiceEdit\(/, "the edit must be decided by the guard");
  });

  test("the tenant comes from the session, never the body", () => {
    assert.match(route, /context\.tenantId/, "the session tenant must scope the lookup");
    assert.doesNotMatch(route, /body\.tenant_id/, "the body must never supply the tenant");
  });

  test("paid_amount and status are NOT writable through the edit endpoint", () => {
    const allowList = /const EDITABLE_FIELDS = \[([\s\S]*?)\] as const;/.exec(route);
    assert.ok(allowList, "the editable allow-list must exist");
    assert.doesNotMatch(allowList![1], /paid_amount/, "paid_amount is derived from receipts");
    assert.doesNotMatch(allowList![1], /status/, "status follows from the receipts");
    assert.doesNotMatch(allowList![1], /tenant_id/, "the tenant is never editable");
  });

  test("total_amount is derived, never taken from the body", () => {
    assert.match(route, /patch\.total_amount = round3\(/, "the total must be computed server-side");
    assert.doesNotMatch(route, /body\.total_amount/, "a client-supplied total must be ignored");
  });

  test("the customer reference is verified against the caller's tenant", () => {
    assert.match(route, /assertReference\(REF_CUSTOMER/, "a foreign customer id must be refused");
  });

  test("the edit is audited", () => {
    assert.match(route, /logAudit\(context, \{[\s\S]*?entity: "invoices"/, "an edit must be audited");
  });
});

// ---------------------------------------------------------------------------
// D. No screen writes a financial document with the browser client.
// ---------------------------------------------------------------------------

describe("exec67 no screen writes a financial row directly", () => {
  const FINANCIAL_TABLES = [
    "accounts",
    "expenses",
    "invoices",
    "payments",
    "journal_entries",
    "journal_lines",
    "supplier_payments",
    "purchase_invoices",
    "sales_returns",
    "debit_notes",
  ];

  test("no app page inserts/updates/deletes a financial table", () => {
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".tsx")) pages.push(p);
      }
    };
    walk(path.join(ROOT, "src/app"));

    const offenders: string[] = [];
    for (const p of pages) {
      const src = fs.readFileSync(p, "utf8");
      for (const t of FINANCIAL_TABLES) {
        const re = new RegExp(`from\\(["']${t}["']\\)\\s*\\.\\s*(insert|update|delete|upsert)\\b`);
        if (re.test(src)) offenders.push(`${path.relative(ROOT, p)} -> ${t}`);
      }
    }
    assert.deepEqual(offenders, [], `financial writes must go through a guarded server route: ${offenders}`);
  });

  test("the invoice edit screen edits through the guarded helper", () => {
    const src = read("src/app/invoices/[id]/page.tsx");
    assert.match(src, /updateInvoice\(/, "the screen must use the guarded update helper");
    assert.doesNotMatch(src, /from\(["']invoices["']\)\.update\(/, "the direct write must be gone");
  });

  test("the edit helper sends no tenant and no total", () => {
    const src = read("src/lib/invoices/invoice-client.ts");
    const fn = /export async function updateInvoice\(([\s\S]*?)\n\}/.exec(src);
    assert.ok(fn, "updateInvoice must exist");
    assert.doesNotMatch(fn![1], /tenant_id/, "the client must not send a tenant");
    assert.doesNotMatch(fn![1], /total_amount/, "the client must not send a total");
  });
});

// ---------------------------------------------------------------------------
// E. A sales return reaches the ledger.
// ---------------------------------------------------------------------------

describe("exec67 a sales return posts a balanced journal", () => {
  test("the journal is Dr revenue / Cr receivable and balances", () => {
    const j = buildSalesReturnJournal({
      journalNumber: "JV-1",
      returnNumber: "SR-1",
      date: "2026-01-10",
      description: "Sales return",
      amount: 99,
      arAccountId: "ar",
      salesRevenueAccountId: "rev",
    });
    assert.ok(j, "a plain return must build");
    assert.equal(j!.header.entry_type, "sales_return");
    assert.equal(j!.header.total_debit, 99);
    assert.equal(j!.header.total_credit, 99);
    const ar = j!.lines.find((l) => l.account_id === "ar")!;
    assert.equal(ar.credit, 99, "the receivable is credited (restored)");
    assert.equal(ar.debit, 0);
    const rev = j!.lines.find((l) => l.account_id === "rev")!;
    assert.equal(rev.debit, 99, "revenue is reversed (debited)");
  });

  test("41003 (contra-revenue) is preferred when it exists", () => {
    const j = buildSalesReturnJournal({
      journalNumber: "JV-1",
      returnNumber: "SR-1",
      date: "2026-01-10",
      description: "Sales return",
      amount: 99,
      arAccountId: "ar",
      salesReturnsAccountId: "contra",
      salesRevenueAccountId: "rev",
    });
    assert.ok(j);
    assert.ok(j!.lines.some((l) => l.account_id === "contra" && l.debit === 99), "the contra account is used");
    assert.ok(!j!.lines.some((l) => l.account_id === "rev"), "revenue is not used when the contra account exists");
  });

  test("VAT is split out only when it leaves a positive taxable remainder", () => {
    const withVat = buildSalesReturnJournal({
      journalNumber: "JV-1",
      returnNumber: "SR-1",
      date: "2026-01-10",
      description: "Return",
      amount: 110,
      vatAmount: 10,
      arAccountId: "ar",
      salesRevenueAccountId: "rev",
      vatAccountId: "vat",
    });
    assert.ok(withVat);
    assert.equal(withVat!.header.total_debit, 110);
    assert.equal(withVat!.header.total_credit, 110);
    assert.ok(withVat!.lines.some((l) => l.account_id === "vat" && l.debit === 10));

    // A VAT that is not smaller than the total is dropped, not posted - the
    // entry still balances against the receivable.
    const badVat = buildSalesReturnJournal({
      journalNumber: "JV-1",
      returnNumber: "SR-1",
      date: "2026-01-10",
      description: "Return",
      amount: 100,
      vatAmount: 100,
      arAccountId: "ar",
      salesRevenueAccountId: "rev",
      vatAccountId: "vat",
    });
    assert.ok(badVat);
    assert.ok(!badVat!.lines.some((l) => l.account_id === "vat"));
    assert.equal(badVat!.header.total_debit, 100);
  });

  test("a return with no receivable account or no debit account cannot post", () => {
    const base = { journalNumber: "JV-1", returnNumber: "SR-1", date: "2026-01-10", description: "R", amount: 10 };
    assert.equal(buildSalesReturnJournal({ ...base, arAccountId: "", salesRevenueAccountId: "rev" }), null);
    assert.equal(buildSalesReturnJournal({ ...base, arAccountId: "ar" }), null);
    assert.equal(
      buildSalesReturnJournal({ ...base, amount: 0, arAccountId: "ar", salesRevenueAccountId: "rev" }),
      null,
      "a zero return must not post",
    );
  });

  test("statusAfterReturn derives returned vs partial_return", () => {
    assert.equal(statusAfterReturn(0), "returned");
    assert.equal(statusAfterReturn(50), "partial_return");
  });
});

describe("exec67 the sales-return path is server-authoritative", () => {
  test("the screen posts to the guarded route and writes nothing itself", () => {
    const src = read("src/app/sales/returns/page.tsx");
    assert.match(src, /fetch\('\/api\/sales-returns'/, "the return must go through the server");
    assert.doesNotMatch(src, /from\('sales_returns'\)\.insert/, "no browser insert");
    assert.doesNotMatch(src, /from\('invoices'\)\s*\.update/, "no browser settlement");
  });

  test("the route requires auth and audits the return", () => {
    const src = read("src/app/api/sales-returns/route.ts");
    assert.match(src, /requireContext\(/, "the route must be session-gated");
    assert.match(src, /logAudit\(context/, "the return must be audited");
    assert.doesNotMatch(src, /body\.tenant_id\s*\?\?/, "the tenant must not come from the body");
  });

  test("the service verifies the invoice belongs to the caller and caps the return", () => {
    const src = read("src/lib/sales/return-service.ts");
    assert.match(src, /assertReference\(REF_INVOICE/, "the invoice reference must be tenant-verified");
    assert.match(src, /cannot exceed the amount the customer has paid/, "over-return must be refused");
    assert.match(src, /postSalesReturn\(/, "the ledger journal must be posted");
  });

  test("the service compensates a failed posting instead of leaving a bare return", () => {
    const src = read("src/lib/sales/return-service.ts");
    assert.match(src, /createdJournalId[\s\S]*?from\("journal_entries"\)\.delete/, "the journal is removed on failure");
    assert.match(src, /createdReturnId[\s\S]*?from\("sales_returns"\)\.delete/, "the return row is removed on failure");
  });
});

// ---------------------------------------------------------------------------
// F. A cancelled debit note is REVERSED in the ledger.
// ---------------------------------------------------------------------------

describe("exec67 cancelling a debit note reverses its journal", () => {
  test("the reversal mirrors the original lines (debit and credit swapped)", () => {
    const original = {
      header: { reference_number: "DN-1" },
      lines: [
        { account_id: "ap", debit: 500, credit: 0, description: "note" },
        { account_id: "exp", debit: 0, credit: 500, description: "note" },
      ],
    } as never;
    const rev = buildDebitNoteReversalJournal(original, {
      journalNumber: "JV-9",
      date: "2026-01-10",
      description: "Reversal",
    });
    assert.ok(rev);
    assert.equal(rev!.header.entry_type, "debit_note_reversal");
    assert.equal(rev!.header.total_debit, 500);
    assert.equal(rev!.header.total_credit, 500);
    const ap = rev!.lines.find((l) => l.account_id === "ap")!;
    assert.equal(ap.credit, 500, "the payable debit is mirrored as a credit");
  });

  test("a journal that cannot be mirrored produces no reversal", () => {
    assert.equal(buildDebitNoteReversalJournal({ header: {}, lines: [] } as never, {
      journalNumber: "JV-9",
      date: "2026-01-10",
      description: "Reversal",
    }), null);
  });

  test("the cancel route reverses rather than only flipping the status", () => {
    const src = read("src/app/api/debit-notes/[id]/route.ts");
    assert.match(src, /writeJournal\(/, "the reversal must be posted");
    assert.match(src, /findPostedDebitNoteJournal\(/, "the original journal must be found");
    assert.match(src, /status: "cancelled"/, "the note is marked cancelled");
    assert.match(src, /already_cancelled/, "a retry must be a no-op");
  });

  test("the cancel route is tenant-scoped", () => {
    const src = read("src/app/api/debit-notes/[id]/route.ts");
    assert.match(src, /context\.tenantId[\s\S]{0,20}\? noteQuery\.eq\("tenant_id"/, "the note lookup must be tenant-scoped");
    assert.match(src, /findPostedDebitNoteJournal\(supabaseAdmin as never, noteNumber, tenantId\)/, "the journal lookup must be tenant-scoped");
  });

  test("the purchases screen cancels through the server", () => {
    const src = read("src/app/purchases/returns/page.tsx");
    assert.match(src, /fetch\(`\/api\/debit-notes\/\$\{encodeURIComponent\(id\)\}`/, "the cancel must go through the route");
    assert.doesNotMatch(src, /from\('debit_notes'\)\.update/, "no browser status write");
  });
});

// ---------------------------------------------------------------------------
// G. An expense reaches the ledger (it used to reach nothing).
// ---------------------------------------------------------------------------

describe("exec67 an expense posts a balanced journal", () => {
  const base = {
    journalNumber: "JV-1",
    referenceNumber: "exp-1",
    date: "2026-01-10",
    description: "Fuel",
    amount: 100,
    expenseAccountId: "exp",
    settlementAccountId: "cash",
  };

  test("a cash expense is Dr expense / Cr cash and balances", () => {
    const j = buildExpenseJournal(base);
    assert.ok(j, "a plain expense must build");
    assert.equal(j!.header.entry_type, "expense");
    assert.equal(j!.header.total_debit, 100);
    assert.equal(j!.header.total_credit, 100);
    assert.equal(j!.lines.find((l) => l.account_id === "exp")!.debit, 100);
    assert.equal(j!.lines.find((l) => l.account_id === "cash")!.credit, 100);
  });

  test("a credit purchase credits the payable, not cash", () => {
    const j = buildExpenseJournal({ ...base, onCredit: true, payableAccountId: "ap" });
    assert.ok(j);
    assert.equal(j!.lines.find((l) => l.account_id === "ap")!.credit, 100);
    assert.ok(!j!.lines.some((l) => l.account_id === "cash"), "cash must not move for a credit purchase");
  });

  test("input VAT is split out only when it leaves a positive taxable remainder", () => {
    const withVat = buildExpenseJournal({ ...base, amount: 110, vatAmount: 10, vatAccountId: "vat" });
    assert.ok(withVat);
    assert.equal(withVat!.header.total_debit, 110);
    assert.equal(withVat!.header.total_credit, 110);
    assert.ok(withVat!.lines.some((l) => l.account_id === "vat" && l.debit === 10));

    const badVat = buildExpenseJournal({ ...base, amount: 100, vatAmount: 100, vatAccountId: "vat" });
    assert.ok(badVat);
    assert.ok(!badVat!.lines.some((l) => l.account_id === "vat"));
  });

  test("an expense with no account to credit, or a zero amount, cannot post", () => {
    assert.equal(buildExpenseJournal({ ...base, settlementAccountId: "" }), null);
    assert.equal(buildExpenseJournal({ ...base, amount: 0 }), null);
    assert.equal(buildExpenseJournal({ ...base, expenseAccountId: "" }), null);
  });

  test("the account codes are the canonical chart codes", () => {
    assert.equal(EXPENSE_ACCOUNT_CODES.cash, "11001");
    assert.equal(EXPENSE_ACCOUNT_CODES.bank, "11002");
    assert.equal(EXPENSE_ACCOUNT_CODES.payable, "21001");
    assert.equal(EXPENSE_ACCOUNT_CODES.inputVat, "24001");
    assert.equal(cashBankCodeForMethod("cash"), "11001");
    assert.equal(cashBankCodeForMethod("bank_transfer"), "11002");
    assert.equal(isCreditPurchase("credit"), true);
    assert.equal(isCreditPurchase("cash"), false);
  });

  test("the reversal mirrors the expense exactly", () => {
    const original = buildExpenseJournal(base)!;
    const rev = buildExpenseReversalJournal(original, {
      journalNumber: "JV-2",
      date: "2026-01-11",
      description: "Reversal",
    });
    assert.ok(rev);
    assert.equal(rev!.header.entry_type, "expense_reversal");
    assert.equal(rev!.lines.find((l) => l.account_id === "exp")!.credit, 100);
    assert.equal(rev!.lines.find((l) => l.account_id === "cash")!.debit, 100);
  });
});

describe("exec67 the expense path is server-authoritative", () => {
  test("the creation route posts the journal and compensates on failure", () => {
    const src = read("src/app/api/expenses/route.ts");
    assert.match(src, /postExpense\(/, "the expense must reach the ledger");
    assert.match(src, /createdExpenseId && !createdJournalId[\s\S]*?from\("expenses"\)\.delete/, "a failed posting removes the row");
  });

  test("the edit/delete route reverses rather than orphaning the journal", () => {
    const src = read("src/app/api/expenses/[id]/route.ts");
    assert.match(src, /reverseExpense\(/, "a delete/edit must reverse the journal");
    assert.match(src, /findPostedExpenseJournal\(supabaseAdmin as never, id, tenantId\)/, "the journal lookup is tenant-scoped");
    assert.match(src, /module: "expenses", action: "edit"/);
    assert.match(src, /module: "expenses", action: "delete"/);
  });

  test("neither expense screen writes the table itself", () => {
    for (const f of ["src/app/expenses/page.tsx", "src/app/accounting/expenses/page.tsx"]) {
      const src = read(f);
      assert.doesNotMatch(src, /from\("expenses"\)\.(insert|update|delete)/, `${f} must not write expenses directly`);
      assert.match(src, /fetch\("\/api\/expenses"/, `${f} must create through the server`);
    }
  });
});

// ---------------------------------------------------------------------------
// H. The sales-return SERVICE, end to end against a two-tenant PostgREST stub.
// ---------------------------------------------------------------------------

describe("exec67 createSalesReturn writes the row, the settlement and the journal", () => {
  const T = "tttttttt-0000-0000-0000-000000000001";
  const INVOICE = "inv-0001";

  /** A stub holding one invoice, the chart, and the journals it is asked to write. */
  function makeDb(opts: { paid?: number; failJournal?: boolean } = {}) {
    const paid = opts.paid ?? 99;
    const invoice: any = {
      id: INVOICE,
      invoice_number: "INV-1",
      customer_id: "cust-0001",
      paid_amount: paid,
      total_amount: 99,
      status: "paid",
      tenant_id: T,
    };
    const returns: any[] = [];
    const entries: any[] = [];
    const lines: any[] = [];
    const accounts = [
      { id: "acct-12001", code: "12001", tenant_id: T, is_active: true, is_postable: true },
      { id: "acct-41002", code: "41002", tenant_id: T, is_active: true, is_postable: true },
      { id: "acct-24000", code: "24000", tenant_id: T, is_active: true, is_postable: true },
    ];
    let seq = 0;

    class Q {
      table: string;
      op = "select";
      eqs: [string, any][] = [];
      iss: [string, any][] = [];
      inVals: any[] | null = null;
      orFilter: string | null = null;
      row: any = null;
      constructor(t: string) {
        this.table = t;
      }
      select() {
        return this;
      }
      eq(c: string, v: any) {
        this.eqs.push([c, v]);
        return this;
      }
      is(c: string, v: any) {
        this.iss.push([c, v]);
        return this;
      }
      in(_c: string, v: any[]) {
        this.inVals = v;
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
      update(r: any) {
        this.op = "update";
        this.row = r;
        return this;
      }
      delete() {
        this.op = "delete";
        return this;
      }
      _match(r: any) {
        if (!this.eqs.every(([c, v]) => r[c] === v)) return false;
        if (this.iss.length) return this.iss.every(([c, v]) => (v === null ? r[c] == null : r[c] === v));
        if (this.orFilter) {
          // The production `or` shape: `tenant_id.eq.<id>,tenant_id.is.null`.
          return this.orFilter.split(",").some((part) => {
            const t = part.trim();
            const eq = /^tenant_id\.eq\.(.+)$/.exec(t);
            if (eq) return r.tenant_id === eq[1];
            if (t === "tenant_id.is.null") return r.tenant_id == null;
            return false;
          });
        }
        return true;
      }
      async _run() {
        if (this.op === "select") {
          if (this.table === "accounts") {
            let rows = accounts.filter((a) => (this.inVals ? this.inVals.includes(a.code) : true));
            rows = rows.filter((a) => this._match(a));
            return { data: rows, error: null };
          }
          if (this.table === "invoices") return { data: invoice, error: null };
          if (this.table === "sales_returns") {
            const found = returns.filter((r) => this._match(r));
            return { data: found.length ? found : null, error: null };
          }
          if (this.table === "journal_entries") {
            return { data: entries.filter((e) => this._match(e)).slice(0, 1), error: null };
          }
          return { data: [], error: null };
        }
        if (this.op === "insert") {
          if (this.table === "sales_returns") {
            const r = { id: `sr-${++seq}`, ...this.row[0] };
            returns.push(r);
            return { data: r, error: null };
          }
          if (this.table === "journal_entries") {
            if (opts.failJournal) return { data: null, error: { message: "ledger unavailable" } };
            const r = { id: `je-${++seq}`, status: "posted", ...this.row[0] };
            entries.push(r);
            return { data: r, error: null };
          }
          if (this.table === "journal_lines") {
            for (const l of this.row) lines.push({ id: `jl-${++seq}`, ...l });
            return { data: null, error: null };
          }
          return { data: null, error: null };
        }
        if (this.op === "update") {
          if (this.table === "invoices") Object.assign(invoice, this.row);
          return { data: null, error: null };
        }
        if (this.op === "delete") {
          if (this.table === "sales_returns") {
            for (let i = returns.length - 1; i >= 0; i--) if (this._match(returns[i])) returns.splice(i, 1);
          }
          if (this.table === "journal_entries") {
            for (let i = entries.length - 1; i >= 0; i--) if (this._match(entries[i])) entries.splice(i, 1);
          }
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
        const res = await this._run();
        const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
        return { data, error: res.error };
      }
      then(f: any, r: any) {
        return this._run().then(f, r);
      }
    }

    // Mirrors the production RPCs: the number generator, and the atomic journal
    // writer that a tenanted install requires (migration 011).
    const rpc = async (fn: string, args: Record<string, any> = {}) => {
      if (fn === "generate_document_number") return { data: `SR-${++seq}`, error: null };
      if (fn === "post_journal_entry") {
        if (opts.failJournal) return { data: null, error: { message: "ledger unavailable" } };
        const header = args.p_header ?? {};
        const jlines = (args.p_lines ?? []) as any[];
        const debit = jlines.reduce((n, l) => n + (Number(l.debit) || 0), 0);
        const credit = jlines.reduce((n, l) => n + (Number(l.credit) || 0), 0);
        if (Math.round(debit * 1000) !== Math.round(credit * 1000)) {
          return { data: null, error: { code: "23514", message: "journal does not balance" } };
        }
        const entry = { id: `je-${++seq}`, status: "posted", ...header };
        entries.push(entry);
        jlines.forEach((l) => lines.push({ id: `jl-${++seq}`, ...l, journal_entry_id: entry.id }));
        return { data: entry.id, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    };

    return { client: { from: (t: string) => new Q(t), rpc }, invoice, returns, entries, lines };
  }

  function ctx(tenantId: string | null) {
    return {
      userId: "u-1",
      tenantId,
      branchId: null,
      financialYearId: null,
      role: "admin",
      permissions: {},
      isSuperAdmin: false,
    } as never;
  }

  test("a return writes one row, settles the invoice and posts a balanced journal", async () => {
    const db = makeDb();
    const result = await createSalesReturn(db.client as never, ctx(T), {
      invoice_id: INVOICE,
      return_number: "SR-1",
      return_date: "2026-03-10",
      amount: 99,
    });

    assert.equal(result.amount, 99);
    assert.equal(db.returns.length, 1, "exactly one return row");
    assert.equal(db.invoice.paid_amount, 0, "the invoice paid amount is reduced");
    assert.equal(db.invoice.status, "returned");

    const journal = db.entries[0];
    assert.ok(journal, "a journal must be posted");
    assert.equal(journal.entry_type, "sales_return");
    assert.equal(journal.tenant_id, T, "the journal must carry the tenant");
    const jlines = db.lines.filter((l) => l.journal_entry_id === journal.id);
    const debit = jlines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = jlines.reduce((s, l) => s + Number(l.credit), 0);
    assert.equal(debit, credit, "the journal must balance");
    assert.equal(jlines.find((l) => l.account_id === "acct-12001")!.credit, 99, "AR is restored");
    assert.equal(jlines.find((l) => l.account_id === "acct-41002")!.debit, 99, "revenue is reversed");
  });

  test("a return larger than the paid amount is refused before any write", async () => {
    const db = makeDb({ paid: 50 });
    await assert.rejects(
      () => createSalesReturn(db.client as never, ctx(T), { invoice_id: INVOICE, amount: 99 }),
      /cannot exceed the amount the customer has paid/,
    );
    assert.equal(db.returns.length, 0, "nothing may be written");
    assert.equal(db.entries.length, 0, "no journal may be posted");
  });

  test("a failed posting compensates: no return row is left behind", async () => {
    const db = makeDb({ failJournal: true });
    await assert.rejects(() =>
      createSalesReturn(db.client as never, ctx(T), { invoice_id: INVOICE, return_number: "SR-9", amount: 99 }),
    );
    assert.equal(db.returns.length, 0, "the return row must be removed");
    assert.equal(db.invoice.paid_amount, 99, "the invoice settlement must not stand");
  });

  test("a repeat of the same return number is idempotent", async () => {
    const db = makeDb();
    const first = await createSalesReturn(db.client as never, ctx(T), {
      invoice_id: INVOICE,
      return_number: "SR-1",
      return_date: "2026-03-10",
      amount: 99,
    });
    assert.equal(first.idempotent, false);
    const second = await createSalesReturn(db.client as never, ctx(T), {
      invoice_id: INVOICE,
      return_number: "SR-1",
      return_date: "2026-03-10",
      amount: 99,
    });
    assert.equal(second.idempotent, true, "a retry must not create a second return");
    assert.equal(db.returns.length, 1);
    assert.equal(db.entries.length, 1, "a retry must not post a second journal");
  });
});


// ---------------------------------------------------------------------------
// I. The chart of accounts is server-authoritative too.
// ---------------------------------------------------------------------------

describe("exec67 the chart of accounts is written server-side", () => {
  test("the chart screen creates and edits through the guarded routes", () => {
    const src = read("src/app/accounting/chart-of-accounts/page.tsx");
    assert.doesNotMatch(src, /from\("accounts"\)\.(insert|update|delete)/, "no direct chart write");
    assert.match(src, /fetch\(url, \{/, "the screen posts to the route");
    assert.match(src, /editingAccount \? 'PUT' : 'POST'/, "create and edit are both delegated");
  });

  test("the create route stamps the tenant from the session and refuses a duplicate code", () => {
    const src = read("src/app/api/accounts/route.ts");
    assert.match(src, /requireContext\(request, \{ module: "accounting", action: "create" \}\)/);
    assert.match(src, /assertWritableTenant\(context, body\.tenant_id\)/);
    assert.match(src, /duplicate_code/, "an ambiguous code would break posting");
    assert.match(src, /tenant_id\.eq\.\$\{tenantId\},tenant_id\.is\.null/, "a parent must be own or shared");
  });

  test("the edit route refuses a self-parent and keeps the code unique", () => {
    const src = read("src/app/api/accounts/[id]/route.ts");
    const put = /export async function PUT\(([\s\S]*?)\n\}/.exec(src);
    assert.ok(put, "PUT must exist");
    assert.match(put![1], /cannot be its own parent/);
    assert.match(put![1], /duplicate_code/);
    assert.match(put![1], /\.neq\("id", id\)/, "the uniqueness check excludes the row being edited");
  });
});

// ---------------------------------------------------------------------------
// Execution 67 (Stage 3) - the customer record is written server-side.
// ---------------------------------------------------------------------------

describe("exec67 the customer record is written server-side", () => {
  test("no customer page inserts, updates or deletes in the browser", () => {
    for (const page of ["src/app/customers/page.tsx", "src/app/customers/new/page.tsx"]) {
      const src = read(page);
      assert.doesNotMatch(
        src,
        /from\(\s*["']customers["']\s*\)\s*\.\s*(insert|update|delete|upsert)/,
        `${page} must not write customers with the browser client`,
      );
      assert.match(src, /fetch\(\s*[`"']\/api\/customers/, `${page} must call the guarded route`);
    }
  });

  test("the create route takes the tenant from the session, never the body", () => {
    const src = read("src/app/api/customers/route.ts");
    assert.match(src, /requireContext\(/, "the route must resolve an authenticated context");
    assert.match(src, /assertWritableTenant\(context, body\.tenant_id\)/, "the tenant must be asserted from the session");
    assert.match(src, /if \(tenantId\) payload\.tenant_id = tenantId/, "the row must be stamped with the session tenant");
    assert.match(src, /CUSTOMER_EDITABLE_FIELDS/, "the body must be filtered through a column whitelist");
  });

  test("the edit and delete routes are tenant-scoped and refuse a referenced customer", () => {
    const src = read("src/app/api/customers/[id]/route.ts");
    // Both the lookup and the write carry the tenant, so a foreign id is a 404.
    assert.equal(
      (src.match(/\.is\("tenant_id", null\)/g) || []).length,
      4,
      "the PUT lookup + update and the DELETE lookup + delete must each scope the NULL tenant",
    );
    assert.match(src, /CUSTOMER_DEPENDENT_TABLES/, "the delete must consult the dependent tables");
    assert.match(src, /has_dependents/, "a referenced customer must be refused, not orphaned");
    assert.match(src, /action: "delete"/, "the delete must be audited");
  });

  test("the customer column whitelist cannot carry tenant_id", () => {
    const src = read("src/lib/customers/fields.ts");
    assert.doesNotMatch(src, /"tenant_id"/, "tenant_id must never be a client-settable field");
    assert.match(src, /"full_name"/);
    assert.match(src, /"phone"/);
  });
});
