/**
 * Exec 68 - account ownership on every posting path, and ONE journal writer.
 *
 * Two defects this closes:
 *
 * 1. `writeJournal` has two paths. The atomic one calls `post_journal_entry`,
 *    which migration 015 makes verify that every account belongs to the
 *    journal's company (or is part of the shared chart). The FALLBACK path -
 *    used before 011 is applied - reaches `journal_entries`/`journal_lines`
 *    directly, so the database performs NO ownership check there. A company
 *    journal posted on a pre-011 database could therefore debit another
 *    company's account and nothing would raise. `assertAccountsUsable` closes
 *    that gap at the application layer.
 *
 * 2. The manual journal screen inserted its header and lines itself, in two
 *    requests, bypassing both the atomic path and migration 015's check. It now
 *    delegates to `writeJournal`.
 *
 * The predicate is deliberately NULL-TOLERANT: a `tenant_id IS NULL` account is
 * the shared chart of the single-tenant installation and is usable by any
 * caller. A check that demanded caller ownership would refuse every posting on
 * a live install whose chart is entirely NULL-tenant.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  AccountResolutionError,
  assertAccountsUsable,
} from "../src/lib/accounting/account-resolution.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

type Row = Record<string, unknown>;

/** A PostgREST-like stub: `.in("id", ids)` returns the seeded rows. */
function makeStub(rows: Row[], opts: { noPostable?: boolean } = {}) {
  let lastSelect = "";
  const client = {
    from() {
      const q = {
        select(cols: string) {
          lastSelect = cols;
          return q;
        },
        in() {
          return q;
        },
        then(res: (v: unknown) => unknown) {
          if (opts.noPostable && lastSelect.includes("is_postable")) {
            return Promise.resolve(
              res({ data: null, error: { code: "42703", message: 'column "is_postable" does not exist' } }),
            );
          }
          return Promise.resolve(res({ data: rows, error: null }));
        },
      };
      return q;
    },
  };
  return client;
}

const shared = { id: "a-shared", code: "11001", tenant_id: null, is_active: true, is_postable: true };

test("a shared (NULL-tenant) account is usable by any company", async () => {
  await assert.doesNotReject(() => assertAccountsUsable(makeStub([shared]) as never, ["a-shared"], "t1"));
  await assert.doesNotReject(() => assertAccountsUsable(makeStub([shared]) as never, ["a-shared"], null));
});

test("a company's own account is usable by that company", async () => {
  const own = { id: "a-own", code: "11001", tenant_id: "t1", is_active: true, is_postable: true };
  await assert.doesNotReject(() => assertAccountsUsable(makeStub([own]) as never, ["a-own"], "t1"));
});

test("another company's account is refused", async () => {
  const foreign = { id: "a-b", code: "11001", tenant_id: "t2", is_active: true, is_postable: true };
  await assert.rejects(
    () => assertAccountsUsable(makeStub([foreign]) as never, ["a-b"], "t1"),
    (e: unknown) => e instanceof AccountResolutionError && e.failures[0].reason === "foreign_tenant",
  );
});

test("a tenant-less caller may not use a company-owned account", async () => {
  const owned = { id: "a-own", code: "11001", tenant_id: "t1", is_active: true, is_postable: true };
  await assert.rejects(
    () => assertAccountsUsable(makeStub([owned]) as never, ["a-own"], null),
    (e: unknown) => e instanceof AccountResolutionError && e.failures[0].reason === "foreign_tenant",
  );
});

test("a missing account is refused", async () => {
  await assert.rejects(
    () => assertAccountsUsable(makeStub([]) as never, ["nope"], "t1"),
    (e: unknown) => e instanceof AccountResolutionError && e.failures[0].reason === "missing",
  );
});

test("an inactive account is refused", async () => {
  const inactive = { id: "a-x", code: "11001", tenant_id: "t1", is_active: false, is_postable: true };
  await assert.rejects(
    () => assertAccountsUsable(makeStub([inactive]) as never, ["a-x"], "t1"),
    (e: unknown) => e instanceof AccountResolutionError && e.failures[0].reason === "inactive",
  );
});

test("a group heading (not postable) is refused", async () => {
  const heading = { id: "a-h", code: "11000", tenant_id: "t1", is_active: true, is_postable: false };
  await assert.rejects(
    () => assertAccountsUsable(makeStub([heading]) as never, ["a-h"], "t1"),
    (e: unknown) => e instanceof AccountResolutionError && e.failures[0].reason === "not_postable",
  );
});

test("every offender is named at once, not one at a time", async () => {
  const foreign = { id: "a-b", code: "11001", tenant_id: "t2", is_active: true, is_postable: true };
  await assert.rejects(
    () => assertAccountsUsable(makeStub([foreign]) as never, ["a-b", "gone"], "t1"),
    (e: unknown) => {
      assert.ok(e instanceof AccountResolutionError);
      const codes = e.failures.map((f) => f.code).sort();
      assert.deepEqual(codes, ["11001", "gone"]);
      return true;
    },
  );
});

test("a pre-014 schema (no is_postable) does not refuse an account for postability", async () => {
  // The app deploys ahead of the migration. Naming an absent column fails the
  // whole SELECT, so the column list is narrowed instead of assuming the schema.
  const row = { id: "a-shared", code: "11001", tenant_id: null, is_active: true };
  await assert.doesNotReject(() =>
    assertAccountsUsable(makeStub([row], { noPostable: true }) as never, ["a-shared"], "t1"),
  );
});

test("an empty account set is a no-op (nothing to verify)", async () => {
  await assert.doesNotReject(() => assertAccountsUsable(makeStub([]) as never, [], "t1"));
});

test("the shared writer refuses non-atomic fallback posting", () => {
  const src = read("src/lib/accounting/manual-posting.ts");

  assert.match(
    src,
    /Atomic journal posting is required/,
    "the writer must reject posting when the atomic RPC is unavailable",
  );

  assert.doesNotMatch(
    src,
    /\.insert\(journal\.header\)/,
    "the shared writer must not insert journal headers directly",
  );

  assert.doesNotMatch(
    src,
    /\.insert\(journal\.lines\)/,
    "the shared writer must not insert journal lines directly",
  );
});

test("the manual journal screen delegates to the one writer", () => {
  const src = read("src/app/api/journal-entries/route.ts");
  assert.match(src, /import \{ writeJournal \} from "@\/lib\/accounting\/manual-posting"/);
  const post = src.slice(src.indexOf("export async function POST"), src.indexOf("/** Update a manual journal entry"));
  assert.match(post, /await writeJournal\(/, "POST must use the central writer");
  assert.doesNotMatch(post, /\.from\("journal_lines"\)\.insert\(/, "POST must not write lines itself");
  // The inline id-only check is replaced by the shared ownership predicate.
  assert.match(src, /assertAccountsUsable\(/, "must use the shared predicate");
});

test("PUT snapshots lines so a failed replace cannot empty a posted entry", () => {
  const src = read("src/app/api/journal-entries/route.ts");
  assert.match(src, /const \{ data: previousLines \} = await supabaseAdmin/);
  assert.match(src, /await supabaseAdmin\.from\("journal_lines"\)\.insert\(restore\)/);
});

test("purchases and cars resolve accounts through the shared resolver, not a code-only find", () => {
  for (const f of ["src/app/api/purchases/route.ts", "src/app/api/cars/route.ts"]) {
    const src = read(f);
    assert.match(src, /resolveOptionalAccountIds\(/, `${f} must use the shared resolver`);
    assert.doesNotMatch(
      src,
      /rows\.find\(\(r\) => r\.code === code\)\?\.id/,
      `${f} must not pick an arbitrary row by code`,
    );
  }
});
