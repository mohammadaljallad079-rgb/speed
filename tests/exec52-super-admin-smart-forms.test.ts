import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { RECORD_SOURCES, recordLabel, recordMatches, recordSublabel } from "../src/lib/records/sources.ts";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Execution 52 — Stage 1: Super Admin console, Smart Forms and record pickers.
 *
 * Two properties are locked in here.
 *
 * 1. Every record kind maps to a table that really exists. A picker whose
 *    source table does not exist fails the whole PostgREST request, so the
 *    dropdown renders empty and the user silently cannot choose a value. The
 *    `banks` source was exactly that defect. The authoritative table list is
 *    parsed out of the migration harness schema, which mirrors the live project,
 *    so this test fails if a source names a table the schema does not have.
 *
 * 2. The transaction forms that reference a record use the shared picker, and a
 *    petty-cash expense is charged to a real ledger account instead of a
 *    free-text category.
 */

/** Tables the isolation harness creates — the repo's record of the live schema. */
function harnessTables(): Set<string> {
  const sql = read("supabase/tests/isolation_harness/base_schema.sql");
  const names = new Set<string>();
  for (const block of sql.matchAll(/(?:tenant_tables|company_tables|other_tables)\s+text\[\]\s*:=\s*array\[([\s\S]*?)\];/g)) {
    for (const literal of block[1].matchAll(/'([a-z_]+)'/g)) names.add(literal[1]);
  }
  return names;
}

describe("record sources map to tables that really exist", () => {
  const tables = harnessTables();

  test("the harness table list was parsed (guards the test itself)", () => {
    // If the parser silently matched nothing, the assertions below would pass
    // vacuously. Pin a few tables that are definitely in the live schema.
    for (const known of ["customers", "suppliers", "accounts", "cars", "expenses"]) {
      assert.ok(tables.has(known), `harness list is missing ${known}`);
    }
    assert.ok(tables.size > 40, `harness list looks truncated: ${tables.size}`);
  });

  test("every record kind's table exists in the live schema", () => {
    for (const source of Object.values(RECORD_SOURCES)) {
      assert.ok(
        tables.has(source.table),
        `record kind "${source.kind}" reads table "${source.table}", which does not exist`,
      );
    }
  });

  test("there is no phantom `banks` source", () => {
    // A bank is a ledger account, not a table. The old source made every bank
    // field read `banks`, which does not exist, and fail open to an empty list.
    assert.doesNotMatch(read("src/lib/records/sources.ts"), /table:\s*["']banks["']/);
    assert.ok(!Object.keys(RECORD_SOURCES).includes("bank"));
    assert.ok(!tables.has("banks"), "the harness schema should not contain a banks table");
  });

  test("a customer is never sourced from the supplier table (and vice versa)", () => {
    assert.equal(RECORD_SOURCES.customer.table, "customers");
    assert.equal(RECORD_SOURCES.supplier.table, "suppliers");
    assert.notEqual(RECORD_SOURCES.customer.table, RECORD_SOURCES.supplier.table);
  });

  test("the chart of accounts is the only source of ledger accounts", () => {
    assert.equal(RECORD_SOURCES.account.table, "accounts");
    assert.match(RECORD_SOURCES.account.listColumns, /code/);
  });
});

describe("record labels and search never depend on a single column", () => {
  test("a missing primary label falls back across known columns", () => {
    const source = RECORD_SOURCES.customer;
    assert.equal(recordLabel(source, { id: "c1", full_name: "Ali Hassan" }), "Ali Hassan");
    assert.equal(recordLabel(source, { id: "c2", name: "Fallback Ltd" }), "Fallback Ltd");
    assert.equal(recordLabel(source, { id: "c3" }), "c3");
  });

  test("search matches code and phone as well as the label", () => {
    const source = RECORD_SOURCES.account;
    assert.equal(recordMatches(source, { name_ar: "الصندوق", code: "11001" }, "11001"), true);
    assert.equal(recordMatches(source, { name_ar: "الصندوق", code: "11001" }, "zzz"), false);
    assert.equal(recordMatches(source, { name_ar: "الصندوق" }, ""), true);
  });

  test("a sublabel prefers phone, then code, then email", () => {
    assert.equal(recordSublabel({ phone: "123", code: "C" }), "123");
    assert.equal(recordSublabel({ code: "C" }), "C");
    assert.equal(recordSublabel({}), null);
  });
});

describe("transaction forms use the shared record picker", () => {
  const formsUsing = (file: string) => read(file);

  test("supplier-payments selects the supplier from the suppliers module", () => {
    const page = formsUsing("src/app/supplier-payments/page.tsx");
    assert.match(page, /import RecordSelect from "@\/components\/records\/RecordSelect"/);
    assert.match(page, /<RecordSelect[\s\S]*?kind="supplier"/);
    // The ad-hoc supplier <select> must be gone from the payment form.
    assert.doesNotMatch(page, /<option value="">\{isRTL \? 'اختر المورد/);
  });

  test("debit notes select the supplier from the suppliers module", () => {
    const page = formsUsing("src/app/purchases/returns/page.tsx");
    assert.match(page, /<RecordSelect[\s\S]*?kind="supplier"/);
  });

  test("a customer receipt selects the customer from the customers module", () => {
    const page = formsUsing("src/app/payments/new/page.tsx");
    assert.match(page, /<RecordSelect[\s\S]*?kind="customer"/);
  });

  test("petty cash charges an expense to a real ledger account", () => {
    const page = formsUsing("src/app/accounting/petty-cash/page.tsx");
    // The form must send the account, and the API must accept it - otherwise the
    // expense posts against cash instead of an expense account.
    assert.match(page, /expense_account_id:\s*modalType === 'expense' \? expenseAccountId : undefined/);
    assert.match(page, /<RecordSelect[\s\S]*?kind="account"/);
    assert.match(read("src/app/api/accounting/petty-cash/route.ts"), /expense_account_id/);
  });

  test("a petty-cash expense cannot be submitted without an account", () => {
    const page = formsUsing("src/app/accounting/petty-cash/page.tsx");
    assert.match(page, /modalType === 'expense' && !expenseAccountId/);
    assert.match(page, /disabled=\{[^}]*expenseAccountId/);
  });
});

describe("the Super Admin console is responsive and evidence-backed", () => {
  const page = read("src/app/super-admin/page.tsx");

  test("the header is sticky and the tabs scroll horizontally on narrow screens", () => {
    assert.match(page, /sticky top-0/);
    assert.match(page, /overflow-x-auto/);
    assert.match(page, /hidden sm:inline/);
  });

  test("the stat grid collapses to two columns before going to four", () => {
    assert.match(page, /grid-cols-2 gap-3[^"]*lg:grid-cols-4/);
  });

  test("the console still reads only the guarded super-admin API", () => {
    assert.match(page, /\/api\/super-admin\/overview/);
    assert.match(page, /\/api\/super-admin\/ai/);
    assert.doesNotMatch(page, /\.from\(['"](users|tenants|activity_logs)['"]\)/);
  });

  test("real browser screenshots are committed for desktop and mobile", () => {
    const dir = path.join(ROOT, "docs/screenshots");
    assert.ok(fs.existsSync(dir), "docs/screenshots must exist");
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "MANIFEST.json"), "utf8"));
    assert.ok(manifest.files.length >= 16, `expected at least 16 screenshots, got ${manifest.files.length}`);
    for (const viewport of ["desktop", "mobile"]) {
      for (const screen of ["super-admin-overview", "super-admin-companies", "super-admin-users", "super-admin-ai"]) {
        const file = path.join(dir, `${screen}-${viewport}.png`);
        assert.ok(fs.existsSync(file), `missing screenshot ${file}`);
        assert.ok(fs.statSync(file).size > 5000, `${file} looks empty`);
      }
    }
  });
});
