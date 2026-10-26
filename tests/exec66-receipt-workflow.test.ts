import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { recordReceipt, reverseReceipt, ReceiptError } from "../src/lib/sales/receipt-service.ts";
import {
  buildReceiptJournal,
  buildReceiptReversalJournal,
  RECEIPT_ACCOUNT_CODES,
} from "../src/lib/accounting/receipt-posting.ts";
import { decideAccountDeletion, hasAccountActivity } from "../src/lib/accounting/invoice-guards.ts";

/**
 * Execution 66 - the customer-receipt workflow is server-authoritative and atomic.
 *
 * THE DEFECT THIS SUITE PINS DOWN
 * ------------------------------
 * Three pages (`rentals/[id]`, `rentals`, `payments/new`) recorded a customer
 * receipt from the BROWSER as three independent writes:
 *
 *   1. insert `payments`              (anon client)
 *   2. update `invoices.paid_amount`  (anon client)
 *   3. post the journal               (anon client, wrapped in try/catch)
 *
 * The journal call's failure was caught and only shown as an `alert`; the page
 * then closed the dialog and said "Payment recorded successfully". A failed
 * posting therefore produced a receipt that existed in the payments list but had
 * NO accounting entry - the cash was never debited and the receivable never
 * settled. The browser also chose the tenant, and could not make three writes
 * atomic.
 *
 * The tests below exercise the real service against a PostgREST-like stub that
 * holds TWO companies, and assert the properties that make the defect
 * impossible: one transaction, server-side tenant, idempotency, and no partial
 * write when the atomic function refuses.
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const T_A = "11111111-1111-1111-1111-111111111111";
const T_B = "22222222-2222-2222-2222-222222222222";

const CUSTOMER_A = "aaaaaaaa-0000-0000-0000-000000000001";
const INVOICE_A = "aaaaaaaa-0000-0000-0000-000000000002";
const CONTRACT_A = "aaaaaaaa-0000-0000-0000-000000000003";
const CUSTOMER_B = "bbbbbbbb-0000-0000-0000-000000000001";
const INVOICE_B = "bbbbbbbb-0000-0000-0000-000000000002";

/** A context shaped the way `resolveAuthContext` returns one for an admin. */
function contextFor(tenantId: string | null) {
  return {
    userId: "u-1",
    tenantId,
    branchId: null,
    financialYearId: null,
    role: "admin",
    permissions: {},
    isSuperAdmin: false,
    isAdmin: true,
  } as never;
}

// ---------------------------------------------------------------------------
// A PostgREST-like stub with two companies. It RECORDS every write, so a test
// can prove that a refused receipt wrote nothing.
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function makeDb(opts: { failRpc?: boolean; noRpc?: boolean; preExistingReceipt?: Row } = {}) {
  const accounts: Row[] = [
    { id: "cash-A", code: "11001", tenant_id: T_A, is_active: true, is_postable: true },
    { id: "ar-A", code: "12001", tenant_id: T_A, is_active: true, is_postable: true },
    { id: "cash-B", code: "11001", tenant_id: T_B, is_active: true, is_postable: true },
    { id: "ar-B", code: "12001", tenant_id: T_B, is_active: true, is_postable: true },
  ];
  const invoices: Row[] = [
    { id: INVOICE_A, invoice_number: "INV-A", total_amount: 99, paid_amount: 0, status: "pending", tenant_id: T_A },
    { id: INVOICE_B, invoice_number: "INV-B", total_amount: 99, paid_amount: 0, status: "pending", tenant_id: T_B },
  ];
  const payments: Row[] = opts.preExistingReceipt ? [opts.preExistingReceipt] : [];
  const entries: Row[] = [];
  const lines: Row[] = [];
  const written = { payments: 0, invoices: 0, rpcCalls: 0 };
  let seq = 0;

  class Q {
    table: string;
    op = "select";
    filters: [string, any][] = [];
    isFilters: [string, any][] = [];
    orFilter: string | null = null;
    inVals: any[] | null = null;
    row: any = null;
    constructor(t: string) {
      this.table = t;
    }
    select() {
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
    /** Mirrors the real predicate: `or(tenant_id.eq.X,tenant_id.is.null)`. */
    _tenantOk(r: Row) {
      if (this.orFilter) {
        return this.orFilter.split(",").some((part) => {
          const p = part.trim();
          const eq = /^tenant_id\.eq\.(.+)$/.exec(p);
          if (eq) return r.tenant_id === eq[1];
          if (p === "tenant_id.is.null") return r.tenant_id == null;
          return false;
        });
      }
      if (this.isFilters.length) {
        return this.isFilters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v));
      }
      return this.filters.every(([c, v]) => r[c] === v);
    }
    async _run() {
      const src = this.table === "accounts" ? accounts : this.table === "invoices" ? invoices : this.table === "payments" ? payments : [];
      if (this.op === "select") {
        let rows = src.filter((r) => this.filters.every(([c, v]) => r[c] === v));
        if (this.inVals) rows = rows.filter((r) => this.inVals!.includes(r.code));
        if (this.orFilter) rows = rows.filter((r) => this._tenantOk(r));
        else if (this.isFilters.length) rows = rows.filter((r) => this.isFilters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v)));
        return { data: rows, error: null };
      }
      if (this.op === "insert") {
        written[this.table as "payments" | "invoices"] = (written[this.table as "payments" | "invoices"] ?? 0) + 1;
        const row = { id: `${this.table}-${++seq}`, ...this.row };
        src.push(row);
        return { data: row, error: null };
      }
      if (this.op === "update") {
        for (const r of src) if (this._tenantOk(r)) Object.assign(r, this.row);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    async single() {
      const r = await this._run();
      return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error };
    }
    maybeSingle() {
      return this.single();
    }
    then(f: any, r: any) {
      return this._run().then(f, r);
    }
  }

  /**
   * Models `post_customer_receipt` (migration 015): payment + journal +
   * settlement in ONE call. When `failRpc` is set it refuses BEFORE writing
   * anything - exactly what the real function does when an account is not
   * usable, so the test can prove no partial write survives.
   */
  const rpc = async (fn: string, args: Record<string, any> = {}) => {
    written.rpcCalls++;
    if (fn === "post_customer_receipt_reversal") {
      if (opts.failRpc) {
        return { data: null, error: { code: "23514", message: "account 11001 is not usable by this company" } };
      }
      const pay = payments.find((p) => p.id === args.p_payment_id);
      if (!pay) return { data: null, error: { code: "P0002", message: "payment not found in this company" } };
      if (pay.status === "cancelled") {
        return { data: { payment_id: pay.id, journal_id: null, already_cancelled: true, invoice_paid_amount: null, invoice_status: null }, error: null };
      }
      const header = args.p_header ?? {};
      const jlines = (args.p_lines ?? []) as Row[];
      const debit = jlines.reduce((n, l) => n + (Number(l.debit) || 0), 0);
      const credit = jlines.reduce((n, l) => n + (Number(l.credit) || 0), 0);
      if (Math.round(debit * 1000) !== Math.round(credit * 1000)) {
        return { data: null, error: { code: "23514", message: "journal does not balance" } };
      }
      const entry = { id: `je-${++seq}`, status: "posted", ...header };
      entries.push(entry);
      jlines.forEach((l) => lines.push({ id: `jl-${++seq}`, ...l, journal_entry_id: entry.id }));

      let paidAmount: number | null = null;
      let status: string | null = null;
      if (pay.invoice_id) {
        const inv = invoices.find((i) => i.id === pay.invoice_id);
        if (inv) {
          inv.paid_amount = Math.max(Number(inv.paid_amount || 0) - Number(pay.amount || 0), 0);
          inv.status = inv.paid_amount >= Number(inv.total_amount) ? "paid" : inv.paid_amount > 0 ? "partial" : "pending";
          paidAmount = inv.paid_amount;
          status = inv.status;
        }
      }
      pay.status = "cancelled";
      return { data: { payment_id: pay.id, journal_id: entry.id, already_cancelled: false, invoice_paid_amount: paidAmount, invoice_status: status }, error: null };
    }
    if (fn !== "post_customer_receipt") return { data: null, error: { message: `unknown rpc ${fn}` } };
    if (opts.failRpc) {
      return { data: null, error: { code: "23514", message: "account 11001 is not usable by this company" } };
    }
    const pay = args.p_payment ?? {};
    const header = args.p_header ?? {};
    const jlines = (args.p_lines ?? []) as Row[];
    const debit = jlines.reduce((n, l) => n + (Number(l.debit) || 0), 0);
    const credit = jlines.reduce((n, l) => n + (Number(l.credit) || 0), 0);
    if (Math.round(debit * 1000) !== Math.round(credit * 1000)) {
      return { data: null, error: { code: "23514", message: "journal does not balance" } };
    }
    const payment = { id: `pay-${++seq}`, ...pay };
    payments.push(payment);
    const entry = { id: `je-${++seq}`, status: "posted", ...header };
    entries.push(entry);
    jlines.forEach((l) => lines.push({ id: `jl-${++seq}`, ...l, journal_entry_id: entry.id }));

    let paidAmount: number | null = null;
    let status: string | null = null;
    if (payment.invoice_id) {
      const inv = invoices.find((i) => i.id === payment.invoice_id);
      if (inv) {
        inv.paid_amount = Number(inv.paid_amount || 0) + Number(pay.amount || 0);
        inv.status = inv.paid_amount >= Number(inv.total_amount) ? "paid" : "pending";
        paidAmount = inv.paid_amount;
        status = inv.status;
      }
    }
    return { data: { payment_id: payment.id, journal_id: entry.id, invoice_paid_amount: paidAmount, invoice_status: status }, error: null };
  };

  const base = { from: (t: string) => new Q(t) };
  return {
    db: (opts.noRpc ? base : { ...base, rpc }) as never,
    payments,
    entries,
    lines,
    invoices,
    written,
    accounts,
  };
}

/** The reference check is a real DB read; stub it so the stub owns all state. */
const refsOk = async () => {};
const noYear = async () => null;

// ---------------------------------------------------------------------------
// A. The happy path writes all three things, once.
// ---------------------------------------------------------------------------

describe("exec66 a receipt is one atomic server-side transaction", () => {
  test("payment + journal + settlement are all written, and they agree", async () => {
    const s = makeDb();
    const result = await recordReceipt(
      s.db,
      contextFor(T_A),
      { receipt_number: "REC-1", customer_id: CUSTOMER_A, invoice_id: INVOICE_A, amount: 99, payment_method: "cash", payment_date: "2026-03-10" },
      { assertRefs: refsOk, getYear: noYear },
    );

    assert.equal(result.idempotent, false);
    assert.equal(result.amount, 99);
    assert.ok(result.payment_id, "a payment id is returned");
    assert.ok(result.journal_id, "a journal id is returned");
    assert.equal(result.invoice_status, "paid");

    assert.equal(s.payments.length, 1, "exactly one payment row");
    assert.equal(s.entries.length, 1, "exactly one journal header");
    assert.equal(s.lines.length, 2, "exactly two journal lines");
    assert.equal(s.invoices[0].paid_amount, 99, "the invoice is settled");
  });

  test("the journal debits cash and credits AR, never revenue", async () => {
    const s = makeDb();
    await recordReceipt(
      s.db,
      contextFor(T_A),
      { receipt_number: "REC-1", customer_id: CUSTOMER_A, invoice_id: INVOICE_A, amount: 99, payment_method: "cash", payment_date: "2026-03-10" },
      { assertRefs: refsOk, getYear: noYear },
    );
    const byAcc = Object.fromEntries(s.lines.map((l) => [l.account_id, l]));
    assert.equal(byAcc["cash-A"].debit, 99);
    assert.equal(byAcc["ar-A"].credit, 99);
    assert.equal(s.lines.length, 2, "no revenue line on a collection");
  });

  test("the journal and its lines carry the SESSION company", async () => {
    const s = makeDb();
    await recordReceipt(
      s.db,
      contextFor(T_A),
      { receipt_number: "REC-1", customer_id: CUSTOMER_A, invoice_id: INVOICE_A, amount: 99, payment_method: "cash", payment_date: "2026-03-10" },
      { assertRefs: refsOk, getYear: noYear },
    );
    assert.equal(s.entries[0].tenant_id, T_A);
    assert.deepEqual([...new Set(s.lines.map((l) => l.tenant_id))], [T_A]);
    assert.equal(s.payments[0].tenant_id, T_A);
  });

  test("company B's receipt uses B's accounts, not A's", async () => {
    const s = makeDb();
    await recordReceipt(
      s.db,
      contextFor(T_B),
      { receipt_number: "REC-B", customer_id: CUSTOMER_B, invoice_id: INVOICE_B, amount: 99, payment_method: "cash", payment_date: "2026-03-10" },
      { assertRefs: refsOk, getYear: noYear },
    );
    const ids = s.lines.map((l) => l.account_id);
    assert.ok(ids.includes("cash-B") && ids.includes("ar-B"), `expected B's accounts, got ${ids}`);
    assert.ok(!ids.includes("cash-A") && !ids.includes("ar-A"), "must not touch another company's accounts");
  });
});

// ---------------------------------------------------------------------------
// B. THE property: a refused receipt leaves NOTHING behind.
// ---------------------------------------------------------------------------

describe("exec66 a refused receipt writes nothing (the release-blocking property)", () => {
  test("a refusal is surfaced, and no payment/invoice/journal is left", async () => {
    const s = makeDb({ failRpc: true });
    await assert.rejects(
      () =>
        recordReceipt(
          s.db,
          contextFor(T_A),
          { receipt_number: "REC-X", customer_id: CUSTOMER_A, invoice_id: INVOICE_A, amount: 99, payment_method: "cash", payment_date: "2026-03-10" },
          { assertRefs: refsOk, getYear: noYear },
        ),
      (e: unknown) => e instanceof ReceiptError && e.code === "posting_failed",
    );

    assert.equal(s.payments.length, 0, "no payment row may survive a refused posting");
    assert.equal(s.entries.length, 0, "no journal may survive a refused posting");
    assert.equal(s.invoices[0].paid_amount, 0, "the invoice must not be settled");
    assert.equal(s.written.payments, 0, "the service must not insert the payment itself");
  });

  test("with no atomic function deployed the receipt is refused, not half-written", async () => {
    const s = makeDb({ noRpc: true });
    await assert.rejects(
      () =>
        recordReceipt(
          s.db,
          contextFor(T_A),
          { receipt_number: "REC-X", customer_id: CUSTOMER_A, invoice_id: INVOICE_A, amount: 99, payment_method: "cash", payment_date: "2026-03-10" },
          { assertRefs: refsOk, getYear: noYear },
        ),
      (e: unknown) => e instanceof ReceiptError && e.code === "rpc_unavailable",
    );
    assert.equal(s.written.payments, 0, "a receipt without its posting is never written");
  });
});

// ---------------------------------------------------------------------------
// C. Idempotency and validation.
// ---------------------------------------------------------------------------

describe("exec66 a receipt is idempotent and validated", () => {
  test("a retried receipt number returns the existing receipt, and writes nothing", async () => {
    const s = makeDb({ preExistingReceipt: { id: "pay-existing", receipt_number: "REC-1", amount: 99, invoice_id: INVOICE_A, tenant_id: T_A } });
    const again = await recordReceipt(
      s.db,
      contextFor(T_A),
      { receipt_number: "REC-1", customer_id: CUSTOMER_A, invoice_id: INVOICE_A, amount: 99, payment_method: "cash", payment_date: "2026-03-10" },
      { assertRefs: refsOk, getYear: noYear },
    );
    assert.equal(again.idempotent, true);
    assert.equal(again.payment_id, "pay-existing");
    assert.equal(s.written.rpcCalls, 0, "a retry must not call the posting function");
    assert.equal(s.entries.length, 0, "a retry must not post a second journal");
  });

  test("another company's receipt number is not treated as ours", async () => {
    const s = makeDb({ preExistingReceipt: { id: "pay-B", receipt_number: "REC-1", amount: 99, tenant_id: T_B } });
    const mine = await recordReceipt(
      s.db,
      contextFor(T_A),
      { receipt_number: "REC-1", customer_id: CUSTOMER_A, invoice_id: INVOICE_A, amount: 99, payment_method: "cash", payment_date: "2026-03-10" },
      { assertRefs: refsOk, getYear: noYear },
    );
    assert.equal(mine.idempotent, false, "company A must still record its own receipt");
    assert.ok(mine.journal_id);
  });

  test("an overpayment is refused", async () => {
    const s = makeDb();
    await assert.rejects(
      () =>
        recordReceipt(
          s.db,
          contextFor(T_A),
          { receipt_number: "REC-OVER", customer_id: CUSTOMER_A, invoice_id: INVOICE_A, amount: 150, payment_method: "cash", payment_date: "2026-03-10" },
          { assertRefs: refsOk, getYear: noYear },
        ),
      (e: unknown) => e instanceof ReceiptError && e.code === "overpayment",
    );
    assert.equal(s.written.payments, 0);
  });

  test("a non-positive amount is refused", async () => {
    const s = makeDb();
    for (const amount of [0, -5]) {
      await assert.rejects(
        () =>
          recordReceipt(s.db, contextFor(T_A), { receipt_number: "R", customer_id: CUSTOMER_A, amount }, { assertRefs: refsOk, getYear: noYear }),
        (e: unknown) => e instanceof ReceiptError && e.code === "bad_request",
        `amount ${amount} must be refused`,
      );
    }
  });

  test("a missing customer is refused before any write", async () => {
    const s = makeDb();
    await assert.rejects(
      () => recordReceipt(s.db, contextFor(T_A), { receipt_number: "R", customer_id: "", amount: 10 }, { assertRefs: refsOk, getYear: noYear }),
      (e: unknown) => e instanceof ReceiptError && e.code === "bad_request",
    );
    assert.equal(s.written.rpcCalls, 0);
  });

  test("the reference check runs before any write (a foreign customer is rejected)", async () => {
    const s = makeDb();
    const refusingRefs = async () => {
      throw new Error("invalid customer_id");
    };
    await assert.rejects(
      () =>
        recordReceipt(
          s.db,
          contextFor(T_A),
          { receipt_number: "R", customer_id: CUSTOMER_B, invoice_id: INVOICE_A, amount: 10, payment_date: "2026-03-10" },
          { assertRefs: refusingRefs as never, getYear: noYear },
        ),
      /invalid customer_id/,
    );
    assert.equal(s.written.rpcCalls, 0, "nothing is written when a reference is foreign");
  });
});

// ---------------------------------------------------------------------------
// D. The client-side contract.
// ---------------------------------------------------------------------------

describe("exec66 the browser cannot bypass the workflow", () => {
  const PAGES = ["src/app/payments/new/page.tsx", "src/app/rentals/page.tsx", "src/app/rentals/[id]/page.tsx"];

  for (const f of PAGES) {
    test(`${f} writes no financial row itself`, () => {
      const src = read(f);
      assert.match(src, /submitReceipt\(/, `${f} must record the receipt through the server`);
      assert.doesNotMatch(src, /from\(["']payments["']\)\.insert/, `${f} must not insert the payment row`);
      assert.doesNotMatch(src, /from\(["']journal_entries["']\)\.insert/, `${f} must not write a journal header`);
      assert.doesNotMatch(src, /from\(["']journal_lines["']\)\.insert/, `${f} must not write journal lines`);
      assert.doesNotMatch(src, /postCustomerReceipt\(/, `${f} must not post the journal itself`);
      assert.doesNotMatch(src, /useTenantId/, `${f} must not choose the tenant for a financial write`);
    });
  }

  test("the receipt client only reports success when the server confirmed both writes", () => {
    const src = read("src/lib/sales/receipt-client.ts");
    assert.match(src, /!result\.payment_id \|\| !result\.journal_id/, "success requires a payment AND a journal");
    assert.match(src, /ReceiptRequestError/, "a refusal must raise, not be swallowed");
  });

  test("the route takes identity from the session and audits the result", () => {
    const src = read("src/app/api/receipts/route.ts");
    assert.match(src, /requireContext\(request/, "the route must resolve the session");
    assert.match(src, /logAudit\(/, "the receipt must be audited");
    assert.doesNotMatch(src, /body\.tenant_id\s*\|\|/, "the body must not supply the tenant");
  });

  test("the service never inserts the payment or the journal itself", () => {
    const src = read("src/lib/sales/receipt-service.ts");
    // The ONLY write is the atomic RPC: no `.insert(` anywhere.
    assert.doesNotMatch(src, /\.insert\(/, "all writes go through post_customer_receipt");
    assert.match(src, /db\.rpc\("post_customer_receipt"/, "the atomic function is the single write");
  });
});

// ---------------------------------------------------------------------------
// E. The journal shape itself.
// ---------------------------------------------------------------------------

describe("exec66 the receipt journal shape", () => {
  test("cash is debited and AR credited, and the entry type is customer_receipt", () => {
    const j = buildReceiptJournal({
      journalNumber: "JV-1",
      receiptNumber: "REC-1",
      amount: 99,
      paymentDate: "2026-03-10",
      description: "x",
      cashAccountId: "cash",
      arAccountId: "ar",
    });
    assert.ok(j);
    assert.equal(j.header.entry_type, "customer_receipt");
    assert.equal(j.header.reference_number, "REC-1");
    const byAcc = Object.fromEntries(j.lines.map((l) => [l.account_id, l]));
    assert.equal(byAcc["cash"].debit, 99);
    assert.equal(byAcc["ar"].credit, 99);
    assert.equal(RECEIPT_ACCOUNT_CODES.ar, "12001");
  });

  test("a zero or negative amount yields no journal at all", () => {
    for (const amount of [0, -1]) {
      const j = buildReceiptJournal({
        journalNumber: "JV-1",
        receiptNumber: "REC-1",
        amount,
        paymentDate: "2026-03-10",
        description: "x",
        cashAccountId: "cash",
        arAccountId: "ar",
      });
      assert.equal(j, null, `amount ${amount} must not produce a journal`);
    }
  });
});

// ---------------------------------------------------------------------------
// F. Reversal: a collected receipt is mirrored, never deleted.
// ---------------------------------------------------------------------------

describe("exec66 a collected receipt is reversed, never deleted", () => {
  const PAGES_WITH_DELETE = ["src/app/payments/page.tsx"];

  async function issue(s: ReturnType<typeof makeDb>) {
    return recordReceipt(
      s.db,
      contextFor(T_A),
      { receipt_number: "REC-1", customer_id: CUSTOMER_A, invoice_id: INVOICE_A, amount: 99, payment_method: "cash", payment_date: "2026-03-10" },
      { assertRefs: refsOk, getYear: noYear },
    );
  }

  test("the mirror debits AR and credits cash, and un-settles the invoice", async () => {
    const s = makeDb();
    const receipt = await issue(s);
    assert.equal(s.invoices[0].paid_amount, 99);

    const reversal = await reverseReceipt(s.db, contextFor(T_A), { payment_id: receipt.payment_id }, { getYear: noYear });

    assert.equal(reversal.already_cancelled, false);
    assert.ok(reversal.journal_id, "a mirror journal is written");
    assert.equal(reversal.invoice_status, "pending");
    assert.equal(s.invoices[0].paid_amount, 0, "the receivable is restored");
    assert.equal(s.payments[0].status, "cancelled");

    // The mirror: Dr AR / Cr cash, exactly two lines, no revenue.
    const mirror = s.lines.filter((l) => l.journal_entry_id === reversal.journal_id);
    assert.equal(mirror.length, 2);
    const byAcc = Object.fromEntries(mirror.map((l) => [l.account_id, l]));
    assert.equal(byAcc["ar-A"].debit, 99);
    assert.equal(byAcc["cash-A"].credit, 99);
    assert.equal(mirror.find((l) => l.account_id === "41002"), undefined, "a reversal never touches revenue");
  });

  test("a retried reversal is a no-op and does not un-settle twice", async () => {
    const s = makeDb();
    const receipt = await issue(s);
    await reverseReceipt(s.db, contextFor(T_A), { payment_id: receipt.payment_id }, { getYear: noYear });
    const again = await reverseReceipt(s.db, contextFor(T_A), { payment_id: receipt.payment_id }, { getYear: noYear });

    assert.equal(again.already_cancelled, true);
    assert.equal(again.journal_id, null, "a retry writes no second mirror");
    assert.equal(s.invoices[0].paid_amount, 0, "the invoice is not un-settled twice");
    assert.equal(s.entries.length, 2, "one receipt journal + one mirror, no more");
  });

  test("a refused mirror leaves the receipt and the invoice untouched", async () => {
    const s = makeDb();
    const receipt = await issue(s);
    const s2 = makeDb({ failRpc: true });
    // Re-point the failing stub at the same payment row to model a DB refusal.
    s2.payments.push({ id: receipt.payment_id, receipt_number: "REC-1", amount: 99, invoice_id: INVOICE_A, tenant_id: T_A, status: "completed", payment_method: "cash" });
    s2.invoices[0].paid_amount = 99;

    await assert.rejects(
      () => reverseReceipt(s2.db, contextFor(T_A), { payment_id: receipt.payment_id }, { getYear: noYear }),
      (e: unknown) => e instanceof ReceiptError && e.code === "posting_failed",
    );
    assert.equal(s2.payments[0].status, "completed", "the receipt stays live");
    assert.equal(s2.invoices[0].paid_amount, 99, "the invoice stays settled");
    assert.equal(s2.entries.length, 0, "no mirror journal survives a refusal");
  });

  test("another company's payment id is not found", async () => {
    const s = makeDb();
    const receipt = await issue(s);
    await assert.rejects(
      () => reverseReceipt(s.db, contextFor(T_B), { payment_id: receipt.payment_id }, { getYear: noYear }),
      (e: unknown) => e instanceof ReceiptError && e.code === "not_found",
    );
    assert.equal(s.payments[0].status, "completed", "company B cannot cancel company A's receipt");
  });

  test("a missing payment id is refused before any write", async () => {
    const s = makeDb();
    await assert.rejects(
      () => reverseReceipt(s.db, contextFor(T_A), { payment_id: "" }, { getYear: noYear }),
      (e: unknown) => e instanceof ReceiptError && e.code === "bad_request",
    );
    assert.equal(s.written.rpcCalls, 0);
  });

  test("with no atomic function deployed the reversal is refused", async () => {
    const s = makeDb({ noRpc: true });
    s.payments.push({ id: "pay-1", receipt_number: "REC-1", amount: 99, tenant_id: T_A, status: "completed" });
    await assert.rejects(
      () => reverseReceipt(s.db, contextFor(T_A), { payment_id: "pay-1" }, { getYear: noYear }),
      (e: unknown) => e instanceof ReceiptError && e.code === "rpc_unavailable",
    );
  });

  for (const f of PAGES_WITH_DELETE) {
    test(`${f} reverses a receipt instead of deleting the row`, () => {
      const src = read(f);
      assert.match(src, /submitReceiptReversal\(/, `${f} must reverse through the server`);
      assert.doesNotMatch(src, /from\(["']payments["']\)\.delete\(/, `${f} must not hard-delete a payment`);
    });
  }

  test("the receipt journal shape: AR debit / cash credit, entry type marked", () => {
    const j = buildReceiptReversalJournal({
      journalNumber: "JV-R",
      receiptNumber: "REC-1",
      amount: 99,
      reversalDate: "2026-03-12",
      description: "x",
      cashAccountId: "cash",
      arAccountId: "ar",
    });
    assert.ok(j);
    assert.equal(j.header.entry_type, "customer_receipt_reversal");
    assert.equal(j.header.reference_number, "REC-1");
    const byAcc = Object.fromEntries(j.lines.map((l) => [l.account_id, l]));
    assert.equal(byAcc["ar"].debit, 99);
    assert.equal(byAcc["cash"].credit, 99);
  });

  test("a zero or negative amount yields no reversal journal", () => {
    for (const amount of [0, -1]) {
      assert.equal(
        buildReceiptReversalJournal({
          journalNumber: "JV-R",
          receiptNumber: "REC-1",
          amount,
          reversalDate: "2026-03-12",
          description: "x",
          cashAccountId: "cash",
          arAccountId: "ar",
        }),
        null,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// G. The orphan rental payment page.
// ---------------------------------------------------------------------------

describe("exec66 the rental detail payment page posts to the ledger", () => {
  const f = "src/app/rentals/[id]/payment/page.tsx";

  test("it records the receipt through the server, not a bare payment insert", () => {
    const src = read(f);
    assert.match(src, /submitReceipt\(/, `${f} must record the receipt through the server`);
    assert.doesNotMatch(src, /from\(["']payments["']\)\.insert/, `${f} must not insert a payment with no posting`);
  });
});

// ---------------------------------------------------------------------------
// H. Invoice deletion is server-authoritative from EVERY screen.
// ---------------------------------------------------------------------------

describe("exec66 an invoice is never deleted with the browser client", () => {
  // These four screens each used to call `.from('invoices').delete()` directly,
  // bypassing `decideInvoiceDeletion` - a posted invoice, or one with receipts
  // attached, could be deleted and its ledger entry orphaned.
  const PAGES = [
    "src/app/invoices/page.tsx",
    "src/app/invoices/[id]/page.tsx",
    "src/app/sales/page.tsx",
    "src/app/rentals/invoices/page.tsx",
  ];

  for (const f of PAGES) {
    test(`${f} deletes through the guarded endpoint`, () => {
      const src = read(f);
      assert.doesNotMatch(
        src,
        /from\(["']invoices["']\)\.delete\(/,
        `${f} must not delete an invoice with the browser client`,
      );
      assert.match(src, /deleteInvoice\(/, `${f} must use the guarded deleteInvoice helper`);
    });
  }

  test("the invoice detail screen still shows the advisory posted/dependents flags", () => {
    const src = read("src/app/invoices/[id]/page.tsx");
    assert.match(src, /isSaleInvoicePosted\(/, "the posted flag is still read for the UI");
    assert.match(src, /hasInvoiceDependents\(/, "the dependents flag is still read for the UI");
  });

  test("the delete helper targets the guarded route and refuses on a non-ok response", () => {
    const src = read("src/lib/invoices/invoice-client.ts");
    assert.match(src, /\/api\/invoices\/\$\{encodeURIComponent\(invoiceId\)\}/, "the guarded route is used");
    assert.match(src, /if \(!response\.ok\)/, "a refusal is surfaced, not swallowed");
  });
});

// ---------------------------------------------------------------------------
// I. Chart-of-accounts deletion.
// ---------------------------------------------------------------------------

describe("exec66 an account the ledger uses is not deletable", () => {
  /** Count stub: `journal_lines` returns a fixed count, or an error. */
  function stub(count: number | null, error = false) {
    return {
      from() {
        const b: any = {
          select: () => b,
          eq: () => b,
          then: (resolve: (v: unknown) => void) =>
            Promise.resolve(
              error ? { count: null, error: { message: "permission denied" } } : { count, error: null },
            ).then(resolve),
        };
        return b;
      },
    };
  }

  test("an account with journal lines is refused", async () => {
    const d = await decideAccountDeletion(stub(3) as never, { id: "acc-1", code: "11001" });
    assert.equal(d.allowed, false);
    if (!d.allowed) {
      assert.equal(d.code, "dependents");
      assert.match(d.message, /11001/);
      assert.match(d.message, /journal line/);
    }
  });

  test("an account with no journal lines may be deleted", async () => {
    const d = await decideAccountDeletion(stub(0) as never, { id: "acc-1", code: "99999" });
    assert.equal(d.allowed, true);
  });

  test("a check that cannot be completed fails closed", async () => {
    const d = await decideAccountDeletion(stub(null, true) as never, { id: "acc-1", code: "11001" });
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.code, "unverified");
  });

  test("a missing id fails closed", async () => {
    const d = await decideAccountDeletion(stub(0) as never, { id: "" });
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.code, "unverified");
  });

  test("the advisory boolean assumes usage when the count is unknown", async () => {
    assert.equal(await hasAccountActivity(stub(null, true) as never, "acc-1"), true);
    assert.equal(await hasAccountActivity(stub(2) as never, "acc-1"), true);
    assert.equal(await hasAccountActivity(stub(0) as never, "acc-1"), false);
  });

  test("the chart-of-accounts screen deletes through the guarded endpoint", () => {
    const src = read("src/app/accounting/chart-of-accounts/page.tsx");
    assert.doesNotMatch(src, /from\('accounts'\)\.delete\(/, "no direct account delete");
    assert.match(src, /\/api\/accounts\//, "the guarded endpoint is used");
  });

  test("the route decides server-side and never trusts the body", () => {
    const src = read("src/app/api/accounts/[id]/route.ts");
    assert.match(src, /requireContext\(request, \{ module: "accounting", action: "delete" \}\)/);
    assert.match(src, /decideAccountDeletion\(/);
    // Exec 67 added a PUT handler to the same file. The delete path must still
    // take the tenant from the session alone; the edit path uses the shared
    // `assertWritableTenant(context, body.tenant_id)` convention, which REFUSES
    // a caller that names another tenant rather than honouring it.
    const del = /export async function DELETE\(([\s\S]*?)\n\}/.exec(src);
    assert.ok(del, "the DELETE handler must exist");
    assert.doesNotMatch(del![1], /body\?\.tenant_id|body\.tenant_id/, "the delete tenant comes from the session");
    const put = /export async function PUT\(([\s\S]*?)\n\}/.exec(src);
    assert.ok(put, "the PUT handler must exist");
    assert.match(put![1], /assertWritableTenant\(context, body\.tenant_id\)/, "an edit cannot name a foreign tenant");
  });
});
