import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * Exec 42 regression guard: the dashboard "monthly earnings" chart aggregated
 * invoices with an inner callback parameter that shadowed the outer month index
 * (`months.map((m, i) => ... filter((i) => ...getMonth() === i)`), comparing an
 * invoice object to a month number). The predicate was therefore never true and
 * every bar rendered 0.
 *
 * The behavioural proof (a standalone reproduction showing all-zero output before
 * the fix and correct monthly totals after) is recorded in the Exec 42 report.
 * This test is the durable guard so the shadowing cannot reappear.
 */
test("dashboard monthly earnings does not shadow the month index with an invoice", () => {
  const src = read("src/app/dashboard/page.tsx");

  // The outer month index must be used in the filter, not an invoice callback arg.
  assert.match(
    src,
    /months\.map\(\(m,\s*monthIdx\)\s*=>/,
    "the month index must be named monthIdx to avoid shadowing the invoice",
  );
  assert.match(
    src,
    /getMonth\(\)\s*===\s*monthIdx/,
    "the filter must compare the invoice month to the outer month index",
  );

  // The buggy form (a filter callback named `i` compared to itself) must be gone.
  assert.doesNotMatch(
    src,
    /filter\(\(i:?any?\)\s*=>[\s\S]*?getMonth\(\)\s*===\s*i\s*\)/,
    "an invoice callback must not shadow the month index",
  );
});
