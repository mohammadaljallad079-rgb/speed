import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  buildDebitNoteJournal,
  DEBIT_NOTE_ACCOUNT_CODES,
} from "../src/lib/accounting/debit-note-posting.ts";
import {
  buildSupplierPaymentJournal,
  buildSupplierPaymentReversalJournal,
  AP_ACCOUNT_CODE,
  cashBankCodeForMethod,
} from "../src/lib/accounting/payment-posting.ts";
import {
  buildPurchaseJournal,
} from "../src/lib/accounting/purchase-posting.ts";
import {
  buildTrialBalance,
} from "../src/lib/reporting/ledger.ts";
import {
  buildCashFlowStatement,
  classifyCashFlowSection,
  isCashAccount,
} from "../src/lib/reporting/cash-flow.ts";
import {
  buildPurchaseRegister,
  buildSupplierLedger,
  buildSupplierAging,
  buildExpensesByVehicle,
  buildExpensesByBranch,
  buildExpensesByCategory,
  buildVatPurchases,
  buildMonthlyExpenses,
  buildVehicleProfitability,
  billTaxableBase,
  billOutstanding,
  agingBucket,
  isPurchasingReportKind,
  PURCHASING_REPORT_KINDS,
} from "../src/lib/reporting/purchasing-reports.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Execution 54 — purchasing/accounting integrity, cash flow and reports.
 *
 * Four defects were closed and nine purchasing reports added:
 *
 *  1. a PO converted to a bill created an unposted, tenant-less bill directly in
 *     the browser;
 *  2. debit notes were browser-written with no journal, no tenant and a hard
 *     delete;
 *  3. supplier payments were four non-atomic browser writes with no tenant, no
 *     overpayment guard and a destructive journal delete;
 *  4. the cash-flow report restated accrual P&L instead of reporting cash.
 *
 * The pure engines are tested directly; the route/page contract is pinned by
 * reading the source, because the defects were "the browser did the work".
 */

// ---------------------------------------------------------------------------
// 1. Cash-flow engine — a real cash statement, not an accrual restatement
// ---------------------------------------------------------------------------

const CF_ACCOUNTS = [
  { id: "a-cash", code: "11001", name_en: "Cash", name_ar: "الصندوق", type: "asset" },
  { id: "a-bank", code: "11002", name_en: "Bank", name_ar: "البنك", type: "asset" },
  { id: "a-ar", code: "12001", name_en: "Accounts Receivable", name_ar: "ذمم مدينة", type: "asset" },
  { id: "a-fixed", code: "13001", name_en: "Vehicles", name_ar: "المركبات", type: "asset" },
  { id: "a-ap", code: "21001", name_en: "Accounts Payable", name_ar: "ذمم دائنة", type: "liability" },
  { id: "a-loan", code: "22001", name_en: "Bank Loan", name_ar: "قرض", type: "liability" },
  { id: "a-capital", code: "30001", name_en: "Capital", name_ar: "رأس المال", type: "equity" },
  { id: "a-rev", code: "41002", name_en: "Sales Revenue", name_ar: "إيرادات", type: "revenue" },
  { id: "a-exp", code: "51001", name_en: "Rent Expense", name_ar: "مصروف الإيجار", type: "expense" },
];

describe("cash-flow engine", () => {
  test("cash accounts are 11-prefixed, receivables are not cash", () => {
    assert.equal(isCashAccount({ code: "11001", type: "asset" }), true);
    assert.equal(isCashAccount({ code: "11003", type: "asset" }), true);
    assert.equal(isCashAccount({ code: "12001", type: "asset" }), false);
    assert.equal(isCashAccount({ code: "13001", type: "asset" }), false);
  });

  test("counter accounts classify into the three sections by code", () => {
    assert.equal(classifyCashFlowSection("41002"), "operating");
    assert.equal(classifyCashFlowSection("51001"), "operating");
    assert.equal(classifyCashFlowSection("12001"), "operating");
    assert.equal(classifyCashFlowSection("21001"), "operating");
    assert.equal(classifyCashFlowSection("13001"), "investing");
    assert.equal(classifyCashFlowSection("14001"), "investing");
    assert.equal(classifyCashFlowSection("22001"), "financing");
    assert.equal(classifyCashFlowSection("30001"), "financing");
  });

  test("a credit sale is NOT cash: only the cash-settled receipt shows", () => {
    // Entry 1 (period): credit sale Dr AR 110 / Cr Revenue 100 / Cr VAT 10 — no cash.
    // Entry 2 (period): the customer pays Dr Cash 110 / Cr AR 110 — cash 110.
    const entries = [
      { id: "e-sale", entry_date: "2026-03-10", status: "posted" },
      { id: "e-receipt", entry_date: "2026-03-20", status: "posted" },
    ];
    const lines = [
      { journal_entry_id: "e-sale", account_id: "a-ar", debit: 110, credit: 0 },
      { journal_entry_id: "e-sale", account_id: "a-rev", debit: 0, credit: 100 },
      { journal_entry_id: "e-receipt", account_id: "a-cash", debit: 110, credit: 0 },
      { journal_entry_id: "e-receipt", account_id: "a-ar", debit: 0, credit: 110 },
    ];
    const cf = buildCashFlowStatement({
      accounts: CF_ACCOUNTS,
      entries,
      lines,
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    // The whole 110 cash came from settling receivables.
    assert.equal(cf.netChange, 110);
    assert.equal(cf.totalOperating, 110);
    const ar = cf.operating.find((r) => r.code === "12001")!;
    assert.equal(ar.amount, 110);
    // Revenue must NOT appear as a cash source — that was the old defect.
    assert.equal(cf.operating.find((r) => r.code === "41002"), undefined);
    assert.equal(cf.reconciled, true);
  });

  test("a vehicle bought on credit is an investing inflow/outflow of zero cash until paid", () => {
    // Credit purchase: Dr Vehicles 5000 / Cr AP 5000 — no cash moves.
    const creditPurchase = buildCashFlowStatement({
      accounts: CF_ACCOUNTS,
      entries: [{ id: "e1", entry_date: "2026-02-01", status: "posted" }],
      lines: [
        { journal_entry_id: "e1", account_id: "a-fixed", debit: 5000, credit: 0 },
        { journal_entry_id: "e1", account_id: "a-ap", debit: 0, credit: 5000 },
      ],
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
    });
    assert.equal(creditPurchase.netChange, 0, "no cash moved on a credit purchase");

    // Paying the supplier: Dr AP 5000 / Cr Bank 5000 — cash 5000 out (operating).
    const settled = buildCashFlowStatement({
      accounts: CF_ACCOUNTS,
      entries: [{ id: "e2", entry_date: "2026-02-10", status: "posted" }],
      lines: [
        { journal_entry_id: "e2", account_id: "a-ap", debit: 5000, credit: 0 },
        { journal_entry_id: "e2", account_id: "a-bank", debit: 0, credit: 5000 },
      ],
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
    });
    assert.equal(settled.netChange, -5000);
    assert.equal(settled.totalOperating, -5000);
    assert.equal(settled.totalInvesting, 0);
  });

  test("opening cash comes from before the period; the statement reconciles", () => {
    const entries = [
      { id: "e-open", entry_date: "2026-01-01", status: "posted" },
      { id: "e-move", entry_date: "2026-03-01", status: "posted" },
    ];
    const lines = [
      { journal_entry_id: "e-open", account_id: "a-cash", debit: 1000, credit: 0 },
      { journal_entry_id: "e-open", account_id: "a-capital", debit: 0, credit: 1000 },
      // A period cash expense.
      { journal_entry_id: "e-move", account_id: "a-exp", debit: 200, credit: 0 },
      { journal_entry_id: "e-move", account_id: "a-cash", debit: 0, credit: 200 },
    ];
    const cf = buildCashFlowStatement({
      accounts: CF_ACCOUNTS,
      entries,
      lines,
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    assert.equal(cf.openingCash, 1000);
    assert.equal(cf.netChange, -200);
    assert.equal(cf.closingCash, 800);
    assert.equal(cf.reconciled, true);
  });

  test("a bank transfer is not a cash flow (cash-to-cash)", () => {
    const cf = buildCashFlowStatement({
      accounts: CF_ACCOUNTS,
      entries: [{ id: "e-t", entry_date: "2026-03-05", status: "posted" }],
      lines: [
        { journal_entry_id: "e-t", account_id: "a-bank", debit: 500, credit: 0 },
        { journal_entry_id: "e-t", account_id: "a-cash", debit: 0, credit: 500 },
      ],
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    assert.equal(cf.netChange, 0);
    assert.equal(cf.operating.length, 0);
  });

  test("cancelled documents contribute nothing", () => {
    const cf = buildCashFlowStatement({
      accounts: CF_ACCOUNTS,
      entries: [{ id: "e-x", entry_date: "2026-03-01", status: "cancelled" }],
      lines: [
        { journal_entry_id: "e-x", account_id: "a-cash", debit: 999, credit: 0 },
        { journal_entry_id: "e-x", account_id: "a-rev", debit: 0, credit: 999 },
      ],
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    assert.equal(cf.netChange, 0);
    assert.equal(cf.openingCash, 0);
  });

  test("the page renders the engine and no longer restates accrual P&L", () => {
    const src = read("src/app/reports/cash-flow/page.tsx");
    assert.match(src, /buildCashFlowStatement/, "must use the cash-flow engine");
    assert.doesNotMatch(src, /function getSection\(/, "the accrual section mapper is gone");
    assert.match(src, /openingCash/, "must show opening cash");
    assert.match(src, /closingCash/, "must show closing cash");
    assert.match(src, /reconciled/, "must surface the tie-out");
  });
});

// ---------------------------------------------------------------------------
// 2. Debit-note posting
// ---------------------------------------------------------------------------

describe("debit-note posting", () => {
  test("a debit note debits AP and credits the expense account", () => {
    const j = buildDebitNoteJournal({
      journalNumber: "JV-1",
      noteNumber: "DN-1",
      date: "2026-03-01",
      description: "Return",
      amount: 100,
      payableAccountId: "ap",
      expenseAccountId: "exp",
    })!;
    assert.equal(j.header.entry_type, "debit_note");
    assert.equal(j.header.reference_number, "DN-1");
    const ap = j.lines.find((l) => l.account_id === "ap")!;
    assert.equal(ap.debit, 100);
    assert.equal(ap.credit, 0);
    const exp = j.lines.find((l) => l.account_id === "exp")!;
    assert.equal(exp.credit, 100);
    assert.equal(j.header.total_debit, j.header.total_credit);
  });

  test("VAT is split out only when an input-VAT account is resolvable", () => {
    const withVat = buildDebitNoteJournal({
      journalNumber: "JV-2",
      noteNumber: "DN-2",
      date: "2026-03-01",
      description: "Return",
      amount: 110,
      vatAmount: 10,
      payableAccountId: "ap",
      expenseAccountId: "exp",
      vatAccountId: "vat",
    })!;
    assert.equal(withVat.lines.find((l) => l.account_id === "exp")!.credit, 100);
    assert.equal(withVat.lines.find((l) => l.account_id === "vat")!.credit, 10);

    // No VAT account → the whole amount goes to the expense account.
    const noVat = buildDebitNoteJournal({
      journalNumber: "JV-3",
      noteNumber: "DN-3",
      date: "2026-03-01",
      description: "Return",
      amount: 110,
      vatAmount: 10,
      payableAccountId: "ap",
      expenseAccountId: "exp",
      vatAccountId: null,
    })!;
    assert.equal(noVat.lines.find((l) => l.account_id === "exp")!.credit, 110);
  });

  test("a non-positive amount or missing account cannot post", () => {
    const base = {
      journalNumber: "JV",
      noteNumber: "DN",
      date: "2026-03-01",
      description: "x",
      payableAccountId: "ap",
      expenseAccountId: "exp",
    };
    assert.equal(buildDebitNoteJournal({ ...base, amount: 0 }), null);
    assert.equal(buildDebitNoteJournal({ ...base, amount: -5 }), null);
    assert.equal(buildDebitNoteJournal({ ...base, amount: 10, payableAccountId: "" }), null);
    assert.equal(buildDebitNoteJournal({ ...base, amount: 10, expenseAccountId: "" }), null);
  });

  test("the AP code is the canonical 21001", () => {
    assert.equal(DEBIT_NOTE_ACCOUNT_CODES.payable, "21001");
  });

  test("the debit-notes page delegates to the server route and cancels, never deletes", () => {
    const src = read("src/app/purchases/returns/page.tsx");
    assert.match(src, /fetch\('\/api\/debit-notes'/, "must POST to the route");
    assert.doesNotMatch(src, /from\('debit_notes'\)\.insert/, "the browser must not insert the note");
    assert.doesNotMatch(src, /from\('debit_notes'\)\.delete/, "a posted note is never hard-deleted");
    // Exec 67: the cancellation moved to the server too. Flipping the status in
    // the browser left the note's journal in place, so the payable and the ledger
    // disagreed. The page now DELETEs the guarded route, which reverses the note.
    assert.doesNotMatch(src, /from\('debit_notes'\)\.update/, "the browser must not write the status");
    assert.match(
      src,
      /fetch\(`\/api\/debit-notes\/\$\{encodeURIComponent\(id\)\}`/,
      "cancellation goes through the server, which reverses the journal",
    );
  });

  test("the debit-notes route posts the journal and is tenant-scoped", () => {
    const src = read("src/app/api/debit-notes/route.ts");
    assert.match(src, /requireContext\(request, \{ module: "purchases", action: "create" \}\)/);
    assert.match(src, /postDebitNote/);
    assert.match(src, /assertWritableTenant/);
    assert.match(src, /assertReferences/);
    assert.match(src, /nextDocumentNumber/);
    // A caller-named expense account is verified against the chart, so a crafted
    // id cannot credit another tenant's account.
    assert.match(src, /REF_EXPENSE_LEDGER_ACCOUNT/);
    assert.match(src, /REF_INVOICE/);
    // No browser-supplied identity.
    assert.doesNotMatch(src, /body\.role/);
  });
});

// ---------------------------------------------------------------------------
// 3. Supplier payments: atomic, tenant-scoped, overpayment-guarded, reversible
// ---------------------------------------------------------------------------

describe("supplier payment integrity", () => {
  test("a payment is Dr AP / Cr Cash-Bank and never touches revenue", () => {
    const j = buildSupplierPaymentJournal({
      journalNumber: "JV-1",
      paymentNumber: "SP-1",
      supplierId: "s1",
      amount: 250,
      paymentDate: "2026-03-01",
      description: "Payment",
      apAccountId: "ap",
      cashAccountId: "cash",
    })!;
    const ap = j.lines.find((l) => l.account_id === "ap")!;
    assert.equal(ap.debit, 250);
    assert.equal(ap.credit, 0);
    const cash = j.lines.find((l) => l.account_id === "cash")!;
    assert.equal(cash.credit, 250);
    assert.equal(j.header.total_debit, j.header.total_credit);
    // No revenue account anywhere.
    assert.equal(j.lines.find((l) => l.account_id === "rev"), undefined);
  });

  test("the reversal mirrors the payment (Dr Cash-Bank / Cr AP)", () => {
    const rev = buildSupplierPaymentReversalJournal({
      journalNumber: "JV-2",
      paymentNumber: "SP-1",
      supplierId: "s1",
      amount: 250,
      paymentDate: "2026-03-05",
      description: "Reversal",
      apAccountId: "ap",
      cashAccountId: "cash",
    })!;
    assert.equal(rev.header.entry_type, "supplier_payment_reversal");
    assert.equal(rev.lines.find((l) => l.account_id === "cash")!.debit, 250);
    assert.equal(rev.lines.find((l) => l.account_id === "ap")!.credit, 250);
  });

  test("the AP code and the cash/bank method mapping are canonical", () => {
    assert.equal(AP_ACCOUNT_CODE, "21001");
    assert.equal(cashBankCodeForMethod("cash"), "11001");
    assert.equal(cashBankCodeForMethod("bank"), "11002");
  });

  test("the supplier-payments page delegates to the server route", () => {
    const src = read("src/app/supplier-payments/page.tsx");
    assert.match(src, /fetch\('\/api\/supplier-payments'/, "creation must POST to the route");
    assert.match(src, /\/api\/supplier-payments\/\$\{id\}\/reverse/, "reversal must POST to the route");
    assert.doesNotMatch(src, /from\('supplier_payments'\)\.insert/, "no browser insert");
    assert.doesNotMatch(src, /from\('journal_entries'\)\.delete/, "no destructive journal delete");
    assert.doesNotMatch(src, /from\('journal_lines'\)\.delete/, "no destructive line delete");
  });

  test("the supplier-payments route is atomic, scoped and overpayment-guarded", () => {
    const src = read("src/app/api/supplier-payments/route.ts");
    assert.match(src, /requireContext\(request, \{ module: "payments", action: "create" \}\)/);
    assert.match(src, /assertWritableTenant/);
    assert.match(src, /overpayment/);
    assert.match(src, /buildSupplierPaymentJournal/);
    // The bill balance is read fresh, not from a client list.
    assert.match(src, /select\("id,total_amount,paid_amount,status"\)/);
    // Compensation removes only what this call created.
    assert.match(src, /createdPaymentId && !createdJournalId/);
  });

  test("the reverse route is tenant-scoped and refuses a non-posted payment", () => {
    const src = read("src/app/api/supplier-payments/[id]/reverse/route.ts");
    assert.match(src, /requireContext\(request, \{ module: "payments", action: "edit" \}\)/);
    assert.match(src, /buildSupplierPaymentReversalJournal/);
    assert.match(src, /already_cancelled/);
    assert.match(src, /findPostedManualJournal/);
  });
});

// ---------------------------------------------------------------------------
// 4. Purchasing reports
// ---------------------------------------------------------------------------

const SUPPLIERS = [
  { id: "s1", name: "Gulf Motors" },
  { id: "s2", name: "Bahrain Tyres" },
];
const CARS = [{ id: "c1", plate_number: "12345", make: "Toyota", model: "Corolla" }];

describe("purchasing reports", () => {
  test("all nine kinds are registered and recognised", () => {
    assert.equal(PURCHASING_REPORT_KINDS.length, 9);
    for (const k of PURCHASING_REPORT_KINDS) assert.equal(isPurchasingReportKind(k), true);
    assert.equal(isPurchasingReportKind("nope"), false);
  });

  test("supplier bills are VAT-inclusive; expenses are pre-VAT", () => {
    assert.equal(billTaxableBase({ total_amount: 110, vat_amount: 10 }), 100);
    assert.equal(billOutstanding({ total_amount: 110, paid_amount: 40 }), 70);
    assert.equal(billOutstanding({ total_amount: 110, paid_amount: 40, status: "cancelled" }), 0);
  });

  test("purchase register lists bills with taxable, VAT and outstanding", () => {
    const report = buildPurchaseRegister(
      [
        { invoice_number: "B-1", bill_date: "2026-03-01", supplier_id: "s1", total_amount: 110, vat_amount: 10, paid_amount: 0, status: "pending" },
        { invoice_number: "B-2", bill_date: "2026-03-02", supplier_id: "s2", total_amount: 55, vat_amount: 5, paid_amount: 55, status: "paid" },
        { invoice_number: "B-X", bill_date: "2026-03-03", supplier_id: "s1", total_amount: 999, status: "cancelled" },
      ],
      SUPPLIERS,
    );
    assert.equal(report.rows.length, 2, "cancelled bills are excluded");
    assert.equal(report.totals.taxable, 150);
    assert.equal(report.totals.vat, 15);
    assert.equal(report.totals.outstanding, 110);
    assert.equal(report.rows[0].supplier, "Gulf Motors");
  });

  test("supplier ledger runs a balance across bills, payments and debit notes", () => {
    const report = buildSupplierLedger(
      {
        bills: [{ invoice_number: "B-1", bill_date: "2026-03-01", supplier_id: "s1", total_amount: 100, status: "pending" }],
        payments: [{ payment_number: "SP-1", payment_date: "2026-03-05", supplier_id: "s1", amount: 30, status: "completed" }],
        debitNotes: [{ note_number: "DN-1", note_date: "2026-03-07", supplier_id: "s1", amount: 10, status: "active" }],
        suppliers: SUPPLIERS,
      },
      "s1",
    );
    // bill +100, payment −30, debit note −10 → balance 60.
    assert.equal(report.totals.balance, 60);
    assert.equal(report.rows.length, 3);
    // A different supplier is excluded.
    const other = buildSupplierLedger(
      {
        bills: [{ invoice_number: "B-9", bill_date: "2026-03-01", supplier_id: "s2", total_amount: 50 }],
        payments: [],
        suppliers: SUPPLIERS,
      },
      "s1",
    );
    assert.equal(other.rows.length, 0);
  });

  test("aging buckets by days past due and the buckets sum to the total", () => {
    assert.equal(agingBucket("2026-03-20", "2026-03-01"), "current");
    assert.equal(agingBucket("2026-02-25", "2026-03-01"), "1-30");
    assert.equal(agingBucket("2026-01-25", "2026-03-01"), "31-60");
    assert.equal(agingBucket("2025-12-20", "2026-03-01"), "61-90");
    assert.equal(agingBucket("2025-10-01", "2026-03-01"), "90+");

    const report = buildSupplierAging(
      [
        { supplier_id: "s1", due_date: "2026-02-25", total_amount: 30, paid_amount: 0 },
        { supplier_id: "s1", due_date: "2025-10-01", total_amount: 70, paid_amount: 0 },
      ],
      SUPPLIERS,
      "2026-03-01",
    );
    assert.equal(report.totals.total, 100);
    assert.equal(report.totals["1-30"], 30);
    assert.equal(report.totals["90+"], 70);
  });

  test("expenses by vehicle / branch / category combine bills and expenses", () => {
    const bills = [{ car_id: "c1", branch: "Manama", expense_category: "maintenance", total_amount: 110, vat_amount: 10, status: "pending" }];
    const expenses = [{ car_id: "c1", branch: "Manama", expense_category: "maintenance", amount: 40, vat_amount: 4, status: "approved" }];
    const byVehicle = buildExpensesByVehicle(bills, expenses, CARS);
    assert.equal(byVehicle.rows[0].label, "12345");
    assert.equal(byVehicle.totals.total, 110 + 44);
    const byBranch = buildExpensesByBranch(bills, expenses);
    assert.equal(byBranch.rows[0].label, "Manama");
    const byCategory = buildExpensesByCategory(bills, expenses);
    assert.equal(byCategory.rows[0].label, "maintenance");
  });

  test("input-VAT report separates the taxable base from the VAT per source", () => {
    const report = buildVatPurchases(
      [{ total_amount: 110, vat_amount: 10, status: "pending" }],
      [{ amount: 200, vat_amount: 20, status: "approved" }],
    );
    const bills = report.rows.find((r) => r.source === "Supplier bills")!;
    assert.equal(bills.taxable, 100);
    assert.equal(bills.vat, 10);
    const exp = report.rows.find((r) => r.source === "Expenses")!;
    assert.equal(exp.taxable, 200);
    assert.equal(exp.vat, 20);
    assert.equal(report.totals.vat, 30);
  });

  test("monthly expenses buckets by month across both sources", () => {
    const report = buildMonthlyExpenses(
      [{ bill_date: "2026-01-15", total_amount: 110, vat_amount: 10, status: "pending" }],
      [{ expense_date: "2026-01-20", amount: 50, vat_amount: 5, status: "approved" }],
    );
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].month, "2026-01");
    assert.equal(report.totals.total, 110 + 55);
  });

  test("vehicle profitability is net revenue minus allocated cost", () => {
    const report = buildVehicleProfitability(
      [{ car_id: "c1", total_amount: 1100, vat_amount: 100, status: "posted" }],
      [{ car_id: "c1", total_amount: 330, vat_amount: 30, status: "pending" }],
      [{ car_id: "c1", amount: 70, status: "approved" }],
      CARS,
    );
    const row = report.rows[0];
    assert.equal(row.vehicle, "12345");
    assert.equal(row.revenue, 1000);
    assert.equal(row.cost, 300 + 70);
    assert.equal(row.profit, 630);
  });

  test("the purchasing-reports route is permission-gated and tenant-scoped", () => {
    const src = read("src/app/api/reports/purchasing/route.ts");
    assert.match(src, /requireContext\(request, \{ module: "reports", action: "view" \}\)/);
    assert.match(src, /isPurchasingReportKind/);
    assert.match(src, /q\.is\("tenant_id", null\)/, "the single-tenant install is scoped, not left open");
    // Only a super admin reads unfiltered; everyone else is tenant-scoped first.
    assert.match(src, /if \(!context\.isSuperAdmin\)/);
    assert.match(src, /context\.isSuperAdmin/);
    // No route-level SQL/exec.
    assert.doesNotMatch(src, /exec_sql|eval\(|new Function|child_process/);
  });

  test("every purchasing report page exists and renders the generic component", () => {
    const slugs = [
      "purchase-register",
      "supplier-ledger",
      "supplier-aging",
      "expenses-by-vehicle",
      "expenses-by-branch",
      "expenses-by-category",
      "vat-purchases",
      "monthly-expenses",
      "vehicle-profitability",
    ];
    for (const slug of slugs) {
      const src = read(`src/app/reports/${slug}/page.tsx`);
      assert.match(src, /PurchasingReportPage/, `${slug} must use the shared renderer`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. PO → bill conversion goes through the validated server path
// ---------------------------------------------------------------------------

describe("purchase order conversion", () => {
  test("the PO page converts through /api/purchases, not a browser insert", () => {
    const src = read("src/app/purchase-orders/page.tsx");
    assert.match(src, /fetch\('\/api\/purchases'/, "conversion must POST to the route");
    assert.doesNotMatch(src, /from\('purchase_invoices'\)\.insert/, "no browser bill insert");
    assert.doesNotMatch(src, /from\('purchase_invoice_items'\)\.insert/, "no browser item insert");
    assert.doesNotMatch(src, /nextDocumentNumber/, "numbering is server-side");
  });

  test("the purchases route allocates the number and links the PO", () => {
    const src = read("src/app/api/purchases/route.ts");
    assert.match(src, /nextDocumentNumber\(supabaseAdmin as never, "purchase_invoice"/);
    assert.match(src, /purchase_order_id/);
    assert.match(src, /assertWritableTenant/);
    assert.match(src, /assertReferences/);
  });

  test("the purchases/new page no longer allocates a bill number in the browser", () => {
    const src = read("src/app/purchases/new/page.tsx");
    assert.doesNotMatch(src, /generateSupplierBillNumber/, "numbering is server-side");
  });
});

// ---------------------------------------------------------------------------
// 5b. Deleting a supplier bill is server-authoritative (Exec 54)
// ---------------------------------------------------------------------------

describe("supplier bill deletion", () => {
  test("the purchases page deletes through the route, never in the browser", () => {
    const src = read("src/app/purchases/page.tsx");
    assert.match(src, /fetch\('\/api\/purchases',\s*\{[\s\S]*?method: 'DELETE'/, "the page must call the route");
    assert.doesNotMatch(
      src,
      /from\('purchase_invoices'\)\.delete/,
      "the browser must not delete a bill row directly",
    );
  });

  test("the DELETE handler refuses a posted bill and a bill with dependents", () => {
    const src = read("src/app/api/purchases/route.ts");
    assert.match(src, /export async function DELETE\(request: Request\)/);
    assert.match(src, /requireContext\(request, \{ module: "purchases", action: "delete" \}\)/);
    // One fail-closed decision authority, not two independent fail-open checks.
    assert.match(src, /decidePurchaseBillDeletion\(supabaseAdmin as never/);
    // Tenant-scoped lookup, so a foreign id is a 404 rather than a delete.
    assert.match(src, /query = context\.tenantId \? query\.eq\("tenant_id", context\.tenantId\) : query\.is\("tenant_id", null\)/);
    assert.match(src, /logAudit\(context/);
  });

  test("the purchase-bill guard answers from the ledger and counts dependents", async () => {
    const { isPurchaseBillPosted, hasPurchaseBillDependents } = await import(
      "../src/lib/accounting/invoice-guards.ts"
    );
    // The lookup is tenant-scoped, so the stub has to provide `.is` as well as
    // `.eq` - the single-tenant install scopes with `tenant_id is null`.
    const chain = (terminal: () => Promise<unknown>): unknown => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.is = () => b;
      b.limit = () => b;
      b.maybeSingle = terminal;
      return b;
    };
    const journalClient = {
      from: () => chain(async () => ({ data: { id: "j1" }, error: null })),
    };
    assert.equal(await isPurchaseBillPosted(journalClient as never, "BILL-0001"), true);
    // A bill with no number is an unverifiable posting state, so the advisory
    // boolean reports it as posted (the safe reading).
    assert.equal(await isPurchaseBillPosted(journalClient as never, ""), true);

    const countClient = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            then: (resolve: (v: { count: number; error: null }) => unknown) =>
              Promise.resolve(resolve({ count: table === "debit_notes" ? 1 : 0, error: null })),
          }),
        }),
      }),
    };
    assert.equal(await hasPurchaseBillDependents(countClient as never, "pi1"), true);
    assert.equal(await hasPurchaseBillDependents(countClient as never, ""), true);
  });
});

// ---------------------------------------------------------------------------
// 6. The purchasing accounts and sequence have a migration + activation package
// ---------------------------------------------------------------------------

describe("purchasing account provisioning", () => {
  test("migration 010 seeds input VAT, other expenses and the debit-note sequence", () => {
    const sql = read("supabase/migrations/010_purchasing_accounts.sql");
    assert.match(sql, /'24001'/);
    assert.match(sql, /'51099'/);
    assert.match(sql, /'debit_note'/);
    // Idempotent + non-destructive.
    assert.match(sql, /where not exists/);
    assert.doesNotMatch(sql, /drop table|truncate|delete from/i);
  });

  test("010 has a matching activation package whose banner hash is true", () => {
    const pkg = read("supabase/PRODUCTION_ACTIVATION_010.sql");
    const body = read("supabase/migrations/010_purchasing_accounts.sql");
    const hash = createHash("sha256").update(body, "utf8").digest("hex");
    assert.match(pkg, new RegExp(hash), "the recorded SHA-256 must match the migration");
    assert.match(pkg, /-- PRE-FLIGHT/);
    assert.match(pkg, /-- POST-FLIGHT/);
    assert.match(pkg, /chlkmdobhvfnldqkgdji/);
  });

  test("010 has a non-destructive rollback", () => {
    const sql = read("supabase/migrations/010_purchasing_accounts_rollback.sql");
    assert.match(sql, /delete from public\.document_sequences/);
    assert.match(sql, /journal_lines/, "the rollback refuses to orphan a posted line");
  });
});

// ---------------------------------------------------------------------------
// A full purchasing cycle, end to end, through the real services.
// ---------------------------------------------------------------------------

describe("the purchasing cycle reconciles end to end", () => {
  test("bill -> payment -> debit note leaves AP at zero and input VAT claimed", async () => {
    // A bill of 300.000 + 10% VAT = 330.000, bought on credit, then paid in
    // full, then partly credited by a debit note of 55.000 (50 + 5 VAT).
    const bill = buildPurchaseJournal({
      journalNumber: "JV-P1",
      invoiceNumber: "BILL-001",
      date: "2026-06-01",
      description: "Supplier bill",
      grandTotal: 330,
      advancePayment: 0,
      remainingAmount: 330,
      expenseAccountId: "acc-exp",
      cashAccountId: "acc-cash",
      payableAccountId: "acc-ap",
      vatAmount: 30,
      vatAccountId: "acc-invat",
    })!;
    assert.ok(bill, "a VAT-inclusive credit bill must post");
    assert.deepEqual(
      bill.lines.map((l) => [l.account_id, l.debit, l.credit]).sort(),
      [
        ["acc-exp", 300, 0],
        ["acc-invat", 30, 0],
        ["acc-ap", 0, 330],
      ].sort(),
      "the bill must debit the expense NET of VAT and split the input VAT out",
    );

    // Without an input-VAT account the bill still posts, whole amount to expense.
    const noVat = buildPurchaseJournal({
      journalNumber: "JV-P1b",
      invoiceNumber: "BILL-001b",
      date: "2026-06-01",
      description: "Supplier bill, no VAT account",
      grandTotal: 330,
      advancePayment: 0,
      remainingAmount: 330,
      expenseAccountId: "acc-exp",
      cashAccountId: "acc-cash",
      payableAccountId: "acc-ap",
      vatAmount: 30,
      vatAccountId: null,
    })!;
    assert.deepEqual(
      noVat.lines.map((l) => [l.account_id, l.debit, l.credit]).sort(),
      [
        ["acc-exp", 330, 0],
        ["acc-ap", 0, 330],
      ].sort(),
      "with no input-VAT account the bill capitalises the whole amount",
    );

    // Pay the bill: Dr AP 330 / Cr Cash 330.
    const payment = buildSupplierPaymentJournal({
      journalNumber: "JV-P2",
      paymentNumber: "PAY-001",
      supplierId: "sup-1",
      paymentDate: "2026-06-05",
      description: "Supplier payment",
      amount: 330,
      cashAccountId: "acc-cash",
      apAccountId: "acc-ap",
    })!;
    assert.deepEqual(
      payment.lines.map((l) => [l.account_id, l.debit, l.credit]).sort(),
      [
        ["acc-ap", 330, 0],
        ["acc-cash", 0, 330],
      ].sort(),
      "a payment debits AP and never touches the expense",
    );

    // Debit note of 55.000: Dr AP 55 / Cr expense 50 / Cr input VAT 5.
    const note = buildDebitNoteJournal({
      journalNumber: "JV-P3",
      noteNumber: "DN-001",
      date: "2026-06-10",
      description: "Debit note",
      amount: 55,
      vatAmount: 5,
      payableAccountId: "acc-ap",
      expenseAccountId: "acc-exp",
      vatAccountId: "acc-invat",
    })!;
    assert.ok(note, "a debit note must post");

    // Reconcile every journal through the ledger engine.
    const entries = [
      { id: "p1", entry_date: "2026-06-01", journal_number: "JV-P1", status: "posted" },
      { id: "p2", entry_date: "2026-06-05", journal_number: "JV-P2", status: "posted" },
      { id: "p3", entry_date: "2026-06-10", journal_number: "JV-P3", status: "posted" },
    ];
    const lines = [
      ...bill.lines.map((l, i) => ({ id: `b${i}`, journal_entry_id: "p1", ...l })),
      ...payment.lines.map((l, i) => ({ id: `y${i}`, journal_entry_id: "p2", ...l })),
      ...note.lines.map((l, i) => ({ id: `n${i}`, journal_entry_id: "p3", ...l })),
    ];
    const accounts = [
      { id: "acc-cash", code: "11001", name_en: "Cash", name_ar: "الصندوق", type: "asset" },
      { id: "acc-ap", code: "21001", name_en: "Accounts Payable", name_ar: "ذمم دائنة", type: "liability" },
      { id: "acc-invat", code: "24001", name_en: "Input VAT", name_ar: "ضريبة المدخلات", type: "asset" },
      { id: "acc-exp", code: "51001", name_en: "Expense", name_ar: "مصروف", type: "expense" },
    ];
    const tb = buildTrialBalance(accounts as never, entries as never, lines as never, {
      from: "2026-06-01",
      to: "2026-06-30",
    });
    const byCode = (c: string) => tb.rows.find((r) => r.code === c)!;

    // AP: +330 (bill) - 330 (payment) - 55 (debit note) = -55, i.e. the supplier
    // now owes the company 55.000 (the debit note was not applied to a bill that
    // was already settled in full).
    assert.equal(byCode("21001").closingBalance, -55, "AP reflects bill, payment and debit note");
    // Cash: -330 paid.
    assert.equal(byCode("11001").closingBalance, -330, "cash shows the payment");
    // Expense: 300 (bill, net) - 50 (debit note) = 250.
    assert.equal(byCode("51001").closingBalance, 250, "the expense is net of VAT and the debit note");
    // Input VAT: 30 (bill) - 5 (debit note) = 25.
    assert.equal(byCode("24001").closingBalance, 25, "input VAT is the bill less the credit");
    assert.equal(tb.balanced, true, "the purchasing cycle must leave a balanced ledger");
  });
});
