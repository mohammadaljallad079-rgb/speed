import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { DATA_CHANGED_EVENT, notifyDataChanged } from "../src/lib/hooks/use-report-refresh.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const REPORT_PAGES: Record<string, string> = {
  vat: "fetchData",
  "profit-loss": "fetchData",
  "cash-flow": "loadData",
  "balance-sheet": "loadData",
  "trial-balance": "loadData",
  analysis: "fetchSales",
  "car-history": "fetchReport",
};

const MUTATING_PAGES = [
  "src/app/sales/new/page.tsx",
  "src/app/invoices/new/page.tsx",
  "src/app/payments/new/page.tsx",
  "src/app/purchases/new/page.tsx",
  "src/app/expenses/new/page.tsx",
  "src/app/invoices/[id]/page.tsx",
  "src/app/sales/returns/page.tsx",
  "src/app/purchases/returns/page.tsx",
];

/**
 * Exec 29 - Item 9 (automatic report freshness).
 *
 * A report must reflect committed transactions without a manual reload. The
 * mechanism re-runs each page's existing loader on an in-app "data changed"
 * signal and on focus/visibility regain; it never writes to the ledger, so it
 * cannot create duplicate entries. These tests prove the signal fires and that
 * every report page and every financial-mutating page is wired to it.
 */

describe("Exec29 Item 9 - data-changed signal", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  before(() => {
    // Minimal browser surface: an EventTarget is all notifyDataChanged needs.
    (globalThis as { window?: unknown }).window = new EventTarget();
  });
  after(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  test("notifyDataChanged dispatches the documented event", () => {
    const win = (globalThis as { window: EventTarget }).window;
    let seen = 0;
    const listener = () => {
      seen += 1;
    };
    win.addEventListener(DATA_CHANGED_EVENT, listener);
    notifyDataChanged();
    win.removeEventListener(DATA_CHANGED_EVENT, listener);
    assert.equal(seen, 1);
  });

  test("notifyDataChanged is a no-op without a window (SSR-safe)", () => {
    const saved = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
    assert.doesNotThrow(() => notifyDataChanged());
    (globalThis as { window?: unknown }).window = saved;
  });

  test("the event name is a stable, namespaced constant", () => {
    assert.equal(DATA_CHANGED_EVENT, "speed:data-changed");
  });
});

describe("Exec29 Item 9 - report pages subscribe to refresh", () => {
  for (const [name, loader] of Object.entries(REPORT_PAGES)) {
    test(`${name} revalidates through useReportRefresh(${loader})`, () => {
      const src = read(`src/app/reports/${name}/page.tsx`);
      assert.match(src, /import \{ useReportRefresh \} from '@\/lib\/hooks\/use-report-refresh'/);
      assert.match(src, new RegExp(`useReportRefresh\\(${loader}\\)`));
      // It still keeps its own loader (no second data path introduced).
      assert.match(src, new RegExp(`(async function ${loader}|const ${loader})`));
    });
  }

  test("the hook revalidates on the event AND on focus/visibility, coalescing bursts", () => {
    const hook = read("src/lib/hooks/use-report-refresh.ts");
    assert.match(hook, /window\.addEventListener\(DATA_CHANGED_EVENT, run\)/);
    assert.match(hook, /window\.addEventListener\("focus", run\)/);
    assert.match(hook, /document\.addEventListener\("visibilitychange", onVisible\)/);
    assert.match(hook, /clearTimeout\(timer\.current\)/);
  });

  test("the hook never writes to the ledger (freshness cannot duplicate entries)", () => {
    const hook = read("src/lib/hooks/use-report-refresh.ts");
    assert.doesNotMatch(hook, /journal_entries|journal_lines|\.insert\(|\.update\(|\.delete\(/);
  });
});

describe("Exec29 Item 9 - mutating pages announce changes", () => {
  for (const p of MUTATING_PAGES) {
    test(`${p} calls notifyDataChanged after a successful write`, () => {
      const src = read(p);
      assert.match(src, /import \{ notifyDataChanged \} from '@\/lib\/hooks\/use-report-refresh'/);
      assert.match(src, /notifyDataChanged\(\)/);
    });
  }
});
