import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  RECORD_SOURCES,
  isPostableCode,
  isSelectableAccount,
  isSelectablePostableAccount,
} from "../src/lib/records/sources.ts";
import { isPostable, POSTING_CODES_IN_USE, SPEED_CHART } from "../src/lib/accounting/chart.ts";
import {
  buildAccountTree,
  isPostableAccountCode,
  isSelectableJournalAccount,
  selectableAccounts,
  type ChartAccountRow,
} from "../src/lib/accounting/account-tree.ts";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Execution 64 — Stage 1: the account picker must only offer postable accounts.
 *
 * The chart of accounts is a TREE. A group heading ("11000 Cash and Bank") is a
 * reporting node; a journal line may only point at a leaf. The picker used to
 * filter on `is_active` alone, so a user could choose `11000` and the form only
 * failed when they pressed Save — an invalid account id that the server refuses.
 *
 * Two properties are locked in here:
 *   1. The picker's postability rule agrees with the accounting core's, including
 *      the live-chart exceptions (24000 output VAT, 25000 customer deposits) that
 *      end in `00` yet carry real postings.
 *   2. The picker degrades safely BEFORE migration 014 adds `is_postable`: naming
 *      an absent column fails the whole PostgREST SELECT and empties the list.
 */

describe("the picker's postability rule matches the accounting core", () => {
  test("every posting code the core names is postable", () => {
    for (const code of POSTING_CODES_IN_USE) {
      assert.equal(isPostableCode(code), true, `${code} is a posting code but the picker calls it a heading`);
      assert.equal(isPostable(code), true, `${code} disagrees with chart.isPostable`);
    }
  });

  test("group headings are not selectable", () => {
    for (const code of ["10000", "11000", "12000", "20000", "40000", "41000", "50000", "51000"]) {
      assert.equal(isPostableCode(code), false, `${code} is a heading and must not be selectable`);
    }
  });

  test("the live-chart exceptions stay selectable", () => {
    // These end in `00` but carry real postings on the live chart: output VAT and
    // customer deposits. Filtering them out would leave a sale unable to pick the
    // account it posts to.
    assert.equal(isPostableCode("24000"), true);
    assert.equal(isPostableCode("25000"), true);
  });

  test("the picker and the core agree on every catalogue entry", () => {
    for (const account of SPEED_CHART) {
      assert.equal(
        isPostableCode(account.code),
        isPostable(account.code),
        `${account.code}: picker and chart.isPostable disagree`,
      );
    }
  });
});

describe("isSelectablePostableAccount combines active + postable", () => {
  test("an inactive leaf is refused", () => {
    assert.equal(isSelectablePostableAccount({ code: "11001", is_active: false }), false);
  });

  test("an active heading is refused", () => {
    assert.equal(isSelectablePostableAccount({ code: "11000", is_active: true }), false);
  });

  test("an active leaf is accepted", () => {
    assert.equal(isSelectablePostableAccount({ code: "11001", is_active: true }), true);
  });

  test("the stored flag wins once migration 014 is applied", () => {
    // A company may re-shape its own chart; `is_postable` is the authoritative
    // value then, and it carries the deliberate exceptions.
    assert.equal(isSelectablePostableAccount({ code: "99999", is_postable: true }), true);
    assert.equal(isSelectablePostableAccount({ code: "11001", is_postable: false }), false);
  });

  test("a row with no code and no flag is refused rather than offered blindly", () => {
    assert.equal(isSelectablePostableAccount({ is_active: true }), false);
  });
});

describe("the account source degrades safely before migration 014", () => {
  test("the wider list is attempted and the base list is the fallback", () => {
    const source = RECORD_SOURCES.account;
    assert.match(source.listColumnsWithPostable ?? "", /is_postable/);
    assert.doesNotMatch(source.listColumns, /is_postable/, "the fallback list must not name a migration-014 column");
  });

  test("RecordSelect narrows the column list on an undefined-column error", () => {
    const ui = read("src/components/records/RecordSelect.tsx");
    assert.match(ui, /listColumnsWithPostable/, "RecordSelect must attempt the wider list");
    assert.match(ui, /42703|PGRST204|does not exist/, "RecordSelect must detect an undefined column");
  });
});

describe("every account picker uses the postable filter", () => {
  const pages = [
    "src/app/purchases/returns/page.tsx",
    "src/app/rentals/new/page.tsx",
    "src/app/cars/new/page.tsx",
    "src/app/accounting/petty-cash/page.tsx",
  ];

  test("no picker filters on is_active alone", () => {
    for (const page of pages) {
      const src = read(page);
      assert.match(src, /isSelectablePostableAccount/, `${page} must use the postable filter`);
      assert.doesNotMatch(
        src,
        /filter=\{isSelectableAccount\}/,
        `${page} still filters on is_active alone, which offers group headings`,
      );
    }
  });

  test("a page that composes the postable rule imports it", () => {
    for (const page of pages) {
      const src = read(page);
      assert.match(
        src,
        /import\s*\{[^}]*isSelectablePostableAccount[^}]*\}\s*from\s*["']@\/lib\/records\/sources["']/,
        `${page} uses isSelectablePostableAccount without importing it`,
      );
    }
  });
});

describe("isSelectableAccount is unchanged for callers that only want active", () => {
  test("active and inactive", () => {
    assert.equal(isSelectableAccount({ is_active: true }), true);
    assert.equal(isSelectableAccount({ is_active: false }), false);
    assert.equal(isSelectableAccount({}), true);
  });
});

// ---------------------------------------------------------------------------
// The manual journal editor's account tree.
// ---------------------------------------------------------------------------

/** The flat chart the live install uses: every account has no parent. */
const FLAT: ChartAccountRow[] = [
  { id: "a1", code: "11001", name: "Cash", parent_code: null },
  { id: "a2", code: "11002", name: "Bank", parent_code: null },
  { id: "a3", code: "24000", name: "Output VAT", parent_code: null },
  { id: "a4", code: "41002", name: "Sales Revenue", parent_code: null },
  { id: "a5", code: "41000", name: "Operating Revenue", parent_code: null },
];

/** A hierarchical chart: headings with real leaves beneath them. */
const HIERARCHICAL: ChartAccountRow[] = [
  { id: "h1", code: "11000", name: "Cash and Bank", parent_code: null },
  { id: "l1", code: "11001", name: "Cash", parent_code: "11000" },
  { id: "l2", code: "11002", name: "Bank", parent_code: "11000" },
  { id: "h2", code: "41000", name: "Operating Revenue", parent_code: null },
  { id: "l3", code: "41002", name: "Sales Revenue", parent_code: "41000" },
  { id: "h3", code: "50000", name: "Expenses", parent_code: null },
];

describe("the journal account tree works on the flat chart", () => {
  test("a parentless ledger account is selectable, not a heading", () => {
    // The regression: every account was rendered as a heading, so the dropdown
    // offered only "(No sub-accounts)" placeholders and nothing could be posted.
    const items = buildAccountTree(FLAT).filter((e) => e.type === "item");
    const ids = items.map((e) => e.id);
    for (const id of ["a1", "a2", "a4"]) assert.ok(ids.includes(id), `${id} is not selectable`);
  });

  test("the group heading on the flat chart is still excluded", () => {
    const ids = buildAccountTree(FLAT)
      .filter((e) => e.type === "item")
      .map((e) => e.id);
    assert.ok(!ids.includes("a5"), "41000 is a heading and must not be selectable");
  });

  test("the VAT exception stays selectable on the flat chart", () => {
    const ids = buildAccountTree(FLAT)
      .filter((e) => e.type === "item")
      .map((e) => e.id);
    assert.ok(ids.includes("a3"), "24000 output VAT carries real postings");
  });

  test("a (No sub-accounts) placeholder appears only for a real heading", () => {
    const tree = buildAccountTree(FLAT);
    const placeholders = tree.filter((e) => /no sub-accounts/i.test(e.label));
    // The only `00`-suffixed account in the fixture is 41000, so it is the only
    // legitimate heading; every ledger account must be an item instead.
    assert.equal(placeholders.length, 1, "only the real heading should be empty");
    const items = tree.filter((e) => e.type === "item").map((e) => e.id);
    for (const ledger of ["a1", "a2", "a3", "a4"]) {
      assert.ok(items.includes(ledger), `${ledger} is a ledger account but was hidden behind a placeholder`);
    }
  });

  test("each account is classified consistently with the postable-code rule", () => {
    for (const entry of buildAccountTree(FLAT)) {
      const code = entry.label.trim().split(" ")[0];
      const expectedItem = isPostableAccountCode(code);
      assert.equal(
        entry.type === "item",
        expectedItem,
        `${code} is ${expectedItem ? "postable" : "a heading"} but was rendered as ${entry.type}`,
      );
    }
  });
});

describe("the journal account tree works on a hierarchical chart", () => {
  test("a heading with children is a header, its leaves are items", () => {
    const tree = buildAccountTree(HIERARCHICAL);
    const headers = tree.filter((e) => e.type === "header").map((e) => e.id);
    const items = tree.filter((e) => e.type === "item").map((e) => e.id);
    assert.ok(headers.includes("hdr-h1"), "11000 has children, so it is a heading");
    assert.ok(items.includes("l1") && items.includes("l2"), "11001/11002 are leaves");
  });

  test("a heading with no children is a header and gets a placeholder", () => {
    const tree = buildAccountTree(HIERARCHICAL);
    assert.ok(tree.some((e) => e.type === "header" && e.id === "hdr-h3"));
    assert.ok(tree.some((e) => e.type === "header" && /no sub-accounts/i.test(e.label)));
  });

  test("the heading itself is never selectable", () => {
    const items = buildAccountTree(HIERARCHICAL)
      .filter((e) => e.type === "item")
      .map((e) => e.id);
    assert.ok(!items.includes("h1"));
    assert.ok(!items.includes("h2"));
  });
});

describe("the journal account rule agrees with the picker and the core", () => {
  test("isPostableAccountCode agrees with chart.isPostable on every catalogue entry", () => {
    for (const account of SPEED_CHART) {
      assert.equal(
        isPostableAccountCode(account.code),
        isPostable(account.code),
        `${account.code}: journal tree and chart disagree`,
      );
    }
  });

  test("inactive accounts are never selectable", () => {
    assert.equal(isSelectableJournalAccount({ id: "x", code: "11001", name: "Cash", is_active: false }, false), false);
  });

  test("the stored is_postable flag wins when present", () => {
    assert.equal(isSelectableJournalAccount({ id: "x", code: "99999", name: "Custom", is_postable: true }, false), true);
    assert.equal(isSelectableJournalAccount({ id: "x", code: "11001", name: "Cash", is_postable: false }, false), false);
  });

  test("selectableAccounts never returns a heading from the real catalogue", () => {
    const rows: ChartAccountRow[] = SPEED_CHART.map((a) => ({
      id: a.code,
      code: a.code,
      name: a.nameEn,
      parent_code: a.parentCode,
    }));
    for (const row of selectableAccounts(rows)) {
      assert.equal(isPostable(row.code), true, `${row.code} is a heading but selectableAccounts offered it`);
    }
  });
});

describe("the journal page uses the shared, tested tree module", () => {
  test("the page imports the module rather than re-implementing the rule", () => {
    const src = read("src/app/accounting/journal-entries/page.tsx");
    assert.match(src, /from\s*["']@\/lib\/accounting\/account-tree["']/);
    assert.doesNotMatch(src, /function buildAccountTree/, "the rule must live in the tested module");
  });
});
