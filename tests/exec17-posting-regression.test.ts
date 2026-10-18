import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildBankTransferJournal,
  buildPayrollJournal,
  buildPettyCashJournal,
  buildDepositRefundJournal,
  isJournalBalanced,
  type ManualJournal,
} from "../src/lib/accounting/manual-postings.ts";
import { applyAccountBalanceDelta } from "../src/lib/accounting/account-balance.ts";

/**
 * Execution 17 - regression verification of the manual posting screens.
 *
 * Bank transfer, petty cash, payroll and deposit refund now build their journals
 * through pure builders and post to the canonical `journal_lines` table. These
 * tests assert the invariants that matter for correctness: every entry balances,
 * the header totals equal the line totals, a non-positive amount cannot post,
 * the canonical table is the only target, and the balance-cache call path is the
 * only balance side effect.
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const PAGES = {
  bank: "src/app/accounting/bank-transfer/page.tsx",
  petty: "src/app/accounting/petty-cash/page.tsx",
  payroll: "src/app/hr/payroll/page.tsx",
  deposit: "src/app/rentals/[id]/refund-deposit/page.tsx",
};

function lineTotals(j: ManualJournal) {
  return {
    debit: j.lines.reduce((s, l) => s + l.debit, 0),
    credit: j.lines.reduce((s, l) => s + l.credit, 0),
  };
}

describe("bank transfer journal", () => {
  const j = buildBankTransferJournal({
    journalNumber: "BT-1",
    date: "2026-02-01",
    description: "move",
    amount: 500,
    fromAccountId: "cash",
    toAccountId: "bank",
    reference: "REF-1",
  })!;

  test("debits the destination and credits the source", () => {
    assert.equal(j.lines[0].account_id, "bank");
    assert.equal(j.lines[0].debit, 500);
    assert.equal(j.lines[1].account_id, "cash");
    assert.equal(j.lines[1].credit, 500);
  });

  test("balances and header totals match the lines", () => {
    const t = lineTotals(j);
    assert.equal(t.debit, t.credit);
    assert.equal(j.header.total_debit, t.debit);
    assert.equal(j.header.total_credit, t.credit);
    assert.equal(isJournalBalanced(j), true);
  });

  test("a zero or negative amount cannot post", () => {
    const base = { journalNumber: "BT-2", date: "d", description: "x", fromAccountId: "a", toAccountId: "b" };
    assert.equal(buildBankTransferJournal({ ...base, amount: 0 }), null);
    assert.equal(buildBankTransferJournal({ ...base, amount: -1 }), null);
  });

  test("a missing account cannot post", () => {
    assert.equal(
      buildBankTransferJournal({ journalNumber: "BT-3", date: "d", description: "x", amount: 1, fromAccountId: "", toAccountId: "b" }),
      null,
    );
  });
});

describe("payroll journal", () => {
  const j = buildPayrollJournal({
    journalNumber: "PAY-1",
    date: "2026-02-28",
    description: "salaries",
    amount: 1200,
    salaryAccountId: "sal-exp",
    cashAccountId: "cash",
  })!;

  test("debits the salary expense and credits cash", () => {
    assert.deepEqual(
      j.lines.map((l) => [l.account_id, l.debit, l.credit]),
      [["sal-exp", 1200, 0], ["cash", 0, 1200]],
    );
    assert.equal(isJournalBalanced(j), true);
  });

  test("non-positive payroll cannot post", () => {
    assert.equal(
      buildPayrollJournal({ journalNumber: "PAY-2", date: "d", description: "x", amount: 0, salaryAccountId: "a", cashAccountId: "b" }),
      null,
    );
  });
});

describe("petty cash journal", () => {
  test("funding debits petty cash and credits main cash", () => {
    const j = buildPettyCashJournal({
      journalNumber: "PC-1",
      date: "d",
      description: "fund",
      amount: 300,
      kind: "fund",
      pettyAccountId: "petty",
      expenseAccountId: "cash",
      fundDescription: "fund petty",
      expenseDescription: "expense",
    })!;
    assert.deepEqual(
      j.lines.map((l) => [l.account_id, l.debit, l.credit]),
      [["petty", 300, 0], ["cash", 0, 300]],
    );
    assert.equal(j.header.entry_type, "petty_cash_fund");
    assert.equal(isJournalBalanced(j), true);
  });

  test("an expense debits the expense account and credits petty cash", () => {
    const j = buildPettyCashJournal({
      journalNumber: "PC-2",
      date: "d",
      description: "expense",
      amount: 75,
      kind: "expense",
      pettyAccountId: "petty",
      expenseAccountId: "exp",
      fundDescription: "fund petty",
      expenseDescription: "expense",
    })!;
    assert.deepEqual(
      j.lines.map((l) => [l.account_id, l.debit, l.credit]),
      [["exp", 75, 0], ["petty", 0, 75]],
    );
    assert.equal(j.header.entry_type, "petty_cash_expense");
    assert.equal(isJournalBalanced(j), true);
  });
});

describe("deposit refund journal", () => {
  const j = buildDepositRefundJournal({
    journalNumber: "DEP-REF-1",
    date: "d",
    description: "refund",
    amount: 200,
    depositAccountId: "dep-liab",
    cashAccountId: "cash",
    reference: "CON-1",
  })!;

  test("debits the deposit liability and credits cash", () => {
    assert.deepEqual(
      j.lines.map((l) => [l.account_id, l.debit, l.credit]),
      [["dep-liab", 200, 0], ["cash", 0, 200]],
    );
    assert.equal(j.header.reference_number, "CON-1");
    assert.equal(isJournalBalanced(j), true);
  });
});

const ROUTES = {
  bank: "src/app/api/accounting/bank-transfer/route.ts",
  petty: "src/app/api/accounting/petty-cash/route.ts",
  payroll: "src/app/api/payroll/route.ts",
  deposit: "src/app/api/rentals/deposit-refund/route.ts",
};

describe("posting screens delegate to the server and never write the ledger", () => {
  for (const [name, p] of Object.entries(PAGES)) {
    test(`${name} page posts to its API route`, () => {
      const src = read(p);
      assert.match(src, /fetch\('\/api\//, "must call the server API");
    });

    test(`${name} page does not write journals, lines or balances itself`, () => {
      const src = read(p);
      assert.doesNotMatch(src, /from\(['"]journal_entries['"]\)/, "no browser journal_entries writes");
      assert.doesNotMatch(src, /from\(['"]journal_lines['"]\)/, "no browser journal_lines writes");
      assert.doesNotMatch(src, /applyAccountBalanceDelta/, "no browser balance writes");
      assert.doesNotMatch(src, /nextDocumentNumber/, "numbers are allocated server-side");
      assert.doesNotMatch(src, /journal_entry_lines/, "must not touch the orphaned table");
    });
  }

  for (const [name, p] of Object.entries(ROUTES)) {
    test(`${name} route posts through the shared service`, () => {
      const src = read(p);
      assert.match(src, /from "@\/lib\/accounting\/manual-posting"/, "must import the posting service");
      assert.doesNotMatch(src, /journal_entry_lines/, "must not touch the orphaned table");
      // The route itself never writes the ledger; the service owns the write.
      assert.doesNotMatch(src, /from\(['"]journal_lines['"]\)/, "lines are written by the service, not the route");
    });
  }

  test("the manual posting service writes to the canonical journal_lines table", () => {
    const src = read("src/lib/accounting/manual-posting.ts");
    assert.match(src, /from\("journal_lines"\)/, "the service writes the canonical table");
    assert.doesNotMatch(src, /journal_entry_lines/, "must not touch the orphaned table");
  });

  test("every built journal is balanced for a representative amount", () => {
    const journals: ManualJournal[] = [
      buildBankTransferJournal({ journalNumber: "n", date: "d", description: "x", amount: 1, fromAccountId: "a", toAccountId: "b" })!,
      buildPayrollJournal({ journalNumber: "n", date: "d", description: "x", amount: 1, salaryAccountId: "a", cashAccountId: "b" })!,
      buildPettyCashJournal({ journalNumber: "n", date: "d", description: "x", amount: 1, kind: "fund", pettyAccountId: "a", expenseAccountId: "b", fundDescription: "f", expenseDescription: "e" })!,
      buildDepositRefundJournal({ journalNumber: "n", date: "d", description: "x", amount: 1, depositAccountId: "a", cashAccountId: "b" })!,
    ];
    for (const j of journals) {
      assert.equal(isJournalBalanced(j), true, `${j.header.entry_type} must balance`);
      assert.equal(j.lines.length, 2);
    }
  });
});

describe("balance side effect is single, non-fatal and tenant-neutral", () => {
  test("a failing balance update does not prevent a successful return", async () => {
    const client = { rpc: async () => ({ error: { message: "boom" } }) };
    const res = await applyAccountBalanceDelta(client as never, "acc", 10);
    assert.equal(res.ok, false);
    // The function resolves (does not throw), so the caller's posting stands.
  });

  test("the server routes do not set tenant_id from the request body", () => {
    for (const p of Object.values(ROUTES)) {
      const src = read(p);
      assert.doesNotMatch(
        src,
        /journal_entries'\s*\)[\s\S]{0,400}tenant_id/,
        "the posting routes must not set tenant_id from client state",
      );
    }
  });
});
