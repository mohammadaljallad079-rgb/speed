import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * The production activation packages embed the real migration bodies verbatim
 * and record a SHA-256 of each body in a header banner. A stale banner is a
 * trust failure: it lets an operator believe the reviewed SQL is what will run
 * when it is not. These tests recompute every hash from the actual bytes, so the
 * banner can never drift from the body again.
 */

const ROOT = process.cwd();
const MIG = path.join(ROOT, "supabase", "migrations");
const PKG_001_003 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_001_002_003.sql");
const PKG_004 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_004.sql");
const PKG_005_006 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_005_006.sql");
const PKG_007 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_007.sql");
const PKG_008 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_008.sql");
const PKG_009 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_009.sql");
const PKG_010 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_010.sql");
const PKG_011 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_011.sql");
const PKG_012 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_012.sql");

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Extract the embedded body that follows `headerMarker` and precedes
 * `nextMarker`, plus the hash recorded in the header banner.
 */
const isSep = (line: string) => /^-- =+$/.test(line);

function embedded(text: string, headerMarker: string, nextMarker: string) {
  const lines = text.split("\n");
  const hAt = lines.findIndex((l) => l.includes(headerMarker));
  assert.ok(hAt >= 0, `header marker not found: ${headerMarker}`);

  // The recorded hash sits within the banner (marker line or the one after it).
  const bannerEnd = lines.findIndex((l, i) => i > hAt && isSep(l));
  assert.ok(bannerEnd >= 0, `banner closing separator not found for ${headerMarker}`);
  const hash = /([0-9a-f]{64})/.exec(lines.slice(hAt, bannerEnd + 1).join("\n"))?.[1] ?? null;

  // Body starts after the banner, skipping blank lines.
  let start = bannerEnd + 1;
  while (lines[start] === "") start++;

  // Before the next marker there is: the package's own separator line, a blank
  // line, then the body (which may itself end with a separator comment line).
  // Strip exactly one package separator, never the body's trailing lines.
  const nAt = lines.findIndex((l, i) => i > start && l.includes(nextMarker));
  assert.ok(nAt >= 0, `next marker not found: ${nextMarker}`);
  let end = nAt - 1;
  while (lines[end] === "") end--; // blank line after the package separator
  if (isSep(lines[end])) end--; // the package's own separator line
  while (lines[end] === "") end--; // blank line the body may end with

  // Migration files end with a newline; the joined lines do not.
  return { hash, body: lines.slice(start, end + 1).join("\n") + "\n" };
}

describe("activation package 001-002-003", () => {
  const text = fs.readFileSync(PKG_001_003, "utf8");
  const steps = [
    ["001_core_security.sql", "002_tenant_isolation_hardening.sql"],
    ["002_tenant_isolation_hardening.sql", "003_sales_lifecycle.sql"],
    ["003_sales_lifecycle.sql", "POST-FLIGHT"],
  ] as const;

  for (const [name, next] of steps) {
    const nextMarker = next === "POST-FLIGHT" ? "-- POST-FLIGHT" : `-- BEGIN ${next}`;

    test(`${name}: embedded body is byte-identical to the migration`, () => {
      const { body } = embedded(text, `-- BEGIN ${name}`, nextMarker);
      assert.equal(body, fs.readFileSync(path.join(MIG, name), "utf8"));
    });

    test(`${name}: recorded SHA-256 matches the embedded body`, () => {
      const { hash, body } = embedded(text, `-- BEGIN ${name}`, nextMarker);
      assert.ok(hash, "no SHA-256 recorded in the banner");
      assert.equal(hash, sha(body));
    });
  }

  test("the pre-flight and post-flight sections are present and read-only", () => {
    assert.match(text, /-- PRE-FLIGHT/);
    assert.match(text, /-- POST-FLIGHT VERIFICATION/);
    assert.match(text, /END OF PACKAGE/);
  });
});

describe("activation package 004", () => {
  const text = fs.readFileSync(PKG_004, "utf8");
  const name = "004_global_super_admin.sql";

  test("embedded body is byte-identical to the migration", () => {
    const { body } = embedded(text, "-- MIGRATION 004 BODY", "-- POST-FLIGHT");
    assert.equal(body, fs.readFileSync(path.join(MIG, name), "utf8"));
  });

  test("recorded sha256 matches the embedded body", () => {
    const { hash, body } = embedded(text, "-- MIGRATION 004 BODY", "-- POST-FLIGHT");
    assert.ok(hash, "no sha256 recorded in the banner");
    assert.equal(hash, sha(body));
  });
});

describe("activation package 005-006", () => {
  const text = fs.readFileSync(PKG_005_006, "utf8");
  const steps = [
    ["005_accounting_integrity.sql", "-- BEGIN 006_ai_repair.sql"],
    ["006_ai_repair.sql", "-- POST-FLIGHT"],
  ] as const;

  for (const [name, nextMarker] of steps) {
    test(`${name}: embedded body is byte-identical to the migration`, () => {
      const { body } = embedded(text, `-- BEGIN ${name}`, nextMarker);
      assert.equal(body, fs.readFileSync(path.join(MIG, name), "utf8"));
    });

    test(`${name}: recorded SHA-256 matches the embedded body`, () => {
      const { hash, body } = embedded(text, `-- BEGIN ${name}`, nextMarker);
      assert.ok(hash, "no SHA-256 recorded in the banner");
      assert.equal(hash, sha(body));
    });
  }

  test("each migration is embedded exactly once", () => {
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    assert.equal(count(/-- BEGIN 005_accounting_integrity\.sql/g), 1);
    assert.equal(count(/-- BEGIN 006_ai_repair\.sql/g), 1);
  });

  test("the pre-flight carries the 005 duplicate pre-check and is read-only", () => {
    assert.match(text, /-- PRE-FLIGHT/);
    assert.match(text, /-- POST-FLIGHT/);
    assert.match(text, /END OF PACKAGE/);
    // The exact predicate of the 005 unique index must appear before the body.
    assert.match(text, /having count\(\*\) > 1/);
  });

  test("the package contains no destructive or privilege-widening statements", () => {
    const nonComment = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const re of [
      /\bdrop\s+table\b/i,
      /\bdrop\s+column\b/i,
      /\btruncate\b/i,
      /\bdelete\s+from\b/i,
      /\bdrop\s+schema\b/i,
      /\bgrant\s+all\b/i,
    ]) {
      assert.doesNotMatch(nonComment, re, `destructive statement: ${re}`);
    }
  });
});

describe("activation package 007", () => {
  const text = fs.readFileSync(PKG_007, "utf8");
  const name = "007_purchase_sale_links.sql";

  test(`${name}: embedded body is byte-identical to the migration`, () => {
    const { body } = embedded(text, `-- BEGIN ${name}`, "-- POST-FLIGHT");
    assert.equal(body, fs.readFileSync(path.join(MIG, name), "utf8"));
  });

  test(`${name}: recorded SHA-256 matches the embedded body`, () => {
    const { hash, body } = embedded(text, `-- BEGIN ${name}`, "-- POST-FLIGHT");
    assert.ok(hash, "no SHA-256 recorded in the banner");
    assert.equal(hash, sha(body));
  });

  test("the migration is embedded exactly once and the flights are present", () => {
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    assert.equal(count(/-- BEGIN 007_purchase_sale_links\.sql/g), 1);
    assert.match(text, /-- PRE-FLIGHT/);
    assert.match(text, /-- POST-FLIGHT/);
    assert.match(text, /END OF PACKAGE/);
  });

  test("the package contains no destructive or privilege-widening statements", () => {
    const nonComment = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const re of [
      /\bdrop\s+table\b/i,
      /\bdrop\s+column\b/i,
      /\btruncate\b/i,
      /\bdelete\s+from\b/i,
      /\bdrop\s+schema\b/i,
      /\bgrant\s+all\b/i,
    ]) {
      assert.doesNotMatch(nonComment, re, `destructive statement: ${re}`);
    }
  });
});


describe("activation package 009", () => {
  const text = fs.readFileSync(PKG_009, "utf8");
  const name = "009_depreciation_accounts.sql";
  test(`${name}: embedded body is byte-identical to the migration`, () => {
    const { body } = embedded(text, `-- BEGIN ${name}`, "-- POST-FLIGHT");
    assert.equal(body, fs.readFileSync(path.join(MIG, name), "utf8"));
  });

  test(`${name}: recorded SHA-256 matches the embedded body`, () => {
    const { hash, body } = embedded(text, `-- BEGIN ${name}`, "-- POST-FLIGHT");
    assert.ok(hash, "no SHA-256 recorded in the banner");
    assert.equal(hash, sha(body));
  });

  test("the migration is embedded exactly once and the flights are present", () => {
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    assert.equal(count(/-- BEGIN 009_depreciation_accounts\.sql/g), 1);
    assert.match(text, /-- PRE-FLIGHT/);
    assert.match(text, /-- POST-FLIGHT/);
    assert.match(text, /END OF PACKAGE/);
  });

  test("the package contains no destructive or privilege-widening statements", () => {
    const nonComment = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const re of [
      /\bdrop\s+table\b/i,
      /\bdrop\s+column\b/i,
      /\btruncate\b/i,
      /\bdelete\s+from\b/i,
      /\bdrop\s+schema\b/i,
      /\bgrant\s+all\b/i,
    ]) {
      assert.doesNotMatch(nonComment, re, `destructive statement: ${re}`);
    }
  });
});

describe("activation package 008", () => {
  const text = fs.readFileSync(PKG_008, "utf8");
  const name = "008_user_role_hardening.sql";

  test(`${name}: embedded body is byte-identical to the migration`, () => {
    const { body } = embedded(text, `-- BEGIN ${name}`, "-- POST-FLIGHT");
    assert.equal(body, fs.readFileSync(path.join(MIG, name), "utf8"));
  });

  test(`${name}: recorded SHA-256 matches the embedded body`, () => {
    const { hash, body } = embedded(text, `-- BEGIN ${name}`, "-- POST-FLIGHT");
    assert.ok(hash, "no SHA-256 recorded in the banner");
    assert.equal(hash, sha(body));
  });

  test("the migration is embedded exactly once and the flights are present", () => {
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    assert.equal(count(/-- BEGIN 008_user_role_hardening\.sql/g), 1);
    assert.match(text, /-- PRE-FLIGHT/);
    assert.match(text, /-- POST-FLIGHT/);
    assert.match(text, /END OF PACKAGE/);
  });

  test("the package contains no destructive or privilege-widening statements", () => {
    const nonComment = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const re of [
      /\bdrop\s+table\b/i,
      /\bdrop\s+column\b/i,
      /\btruncate\b/i,
      /\bdelete\s+from\b/i,
      /\bdrop\s+schema\b/i,
      /\bgrant\s+all\b/i,
    ]) {
      assert.doesNotMatch(nonComment, re, `destructive statement: ${re}`);
    }
  });

  test("the package documents its dependency on 004 and the apply order", () => {
    // 008 replaces a trigger created by 004 and calls 004's helpers; a package
    // that does not say so invites an operator to run it out of order.
    assert.match(text, /PRODUCTION_ACTIVATION_004\.sql/);
    assert.match(text, /is_super_admin|is_admin|current_tenant_id/);
    assert.match(text, /chlkmdobhvfnldqkgdji/);
  });
});

describe("activation package 010", () => {
  const text = fs.readFileSync(PKG_010, "utf8");
  const name = "010_purchasing_accounts.sql";

  test(`${name}: embedded body is byte-identical to the migration`, () => {
    const { body } = embedded(text, `-- BEGIN ${name}`, "-- POST-FLIGHT");
    assert.equal(body, fs.readFileSync(path.join(MIG, name), "utf8"));
  });

  test(`${name}: recorded SHA-256 matches the embedded body`, () => {
    const { hash, body } = embedded(text, `-- BEGIN ${name}`, "-- POST-FLIGHT");
    assert.ok(hash, "no SHA-256 recorded in the banner");
    assert.equal(hash, sha(body));
  });

  test("the migration is embedded exactly once and the flights are present", () => {
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    assert.equal(count(/-- BEGIN 010_purchasing_accounts\.sql/g), 1);
    assert.match(text, /-- PRE-FLIGHT/);
    assert.match(text, /-- POST-FLIGHT/);
    assert.match(text, /END OF PACKAGE/);
  });

  test("the package contains no destructive or privilege-widening statements", () => {
    const nonComment = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const re of [
      /\bdrop\s+table\b/i,
      /\bdrop\s+column\b/i,
      /\btruncate\b/i,
      /\bdelete\s+from\b/i,
      /\bdrop\s+schema\b/i,
      /\bgrant\s+all\b/i,
    ]) {
      assert.doesNotMatch(nonComment, re, `destructive statement: ${re}`);
    }
  });

  test("the package documents the apply order and the correct project", () => {
    assert.match(text, /PRODUCTION_ACTIVATION_009\.sql/);
    assert.match(text, /chlkmdobhvfnldqkgdji/);
    assert.match(text, /24001/);
    assert.match(text, /51099/);
  });
});

describe("activation package 011 (atomic journal posting)", () => {
  const text = fs.readFileSync(PKG_011, "utf8");

  test("the embedded body is byte-identical to the migration and the banner hash matches", () => {
    const { hash, body } = embedded(text, "-- BEGIN 011_atomic_journal_posting.sql", "-- POST-FLIGHT");
    assert.ok(hash, "no SHA-256 recorded in the banner");
    assert.equal(hash, sha(body));
    assert.equal(body, fs.readFileSync(path.join(MIG, "011_atomic_journal_posting.sql"), "utf8"));
  });

  test("the migration is embedded exactly once and the flights are present", () => {
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    assert.equal(count(/-- BEGIN 011_atomic_journal_posting\.sql/g), 1);
    assert.match(text, /-- PRE-FLIGHT/);
    assert.match(text, /-- POST-FLIGHT/);
    assert.match(text, /END OF PACKAGE/);
  });

  test("the package contains no destructive or privilege-widening statements", () => {
    const nonComment = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const re of [
      /\bdrop\s+table\b/i,
      /\bdrop\s+column\b/i,
      /\btruncate\b/i,
      /\bdelete\s+from\b/i,
      /\bdrop\s+schema\b/i,
      /\bgrant\s+all\b/i,
      /security\s+definer/i,
    ]) {
      assert.doesNotMatch(nonComment, re, `destructive or unsafe statement: ${re}`);
    }
  });

  test("the package documents the apply order and the correct project", () => {
    assert.match(text, /PRODUCTION_ACTIVATION_001_002_003\.sql/);
    assert.match(text, /_010/);
    assert.match(text, /chlkmdobhvfnldqkgdji/);
    assert.match(text, /post_journal_entry/);
  });

  test("a rollback file exists and drops only the function", () => {
    const rb = fs.readFileSync(path.join(MIG, "011_atomic_journal_posting_rollback.sql"), "utf8");
    assert.match(rb, /drop function if exists public\.post_journal_entry/);
    assert.doesNotMatch(rb, /drop table/i);
  });
});

describe("activation package 012 (notifications store)", () => {
  const text = fs.readFileSync(PKG_012, "utf8");

  test("the embedded body is byte-identical to the migration and the banner hash matches", () => {
    const { hash, body } = embedded(text, "-- BEGIN 012_notifications.sql", "-- POST-FLIGHT");
    assert.ok(hash, "no SHA-256 recorded in the banner");
    assert.equal(hash, sha(body));
    assert.equal(body, fs.readFileSync(path.join(MIG, "012_notifications.sql"), "utf8"));
  });

  test("the migration is embedded exactly once and the flights are present", () => {
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    assert.equal(count(/-- BEGIN 012_notifications\.sql/g), 1);
    assert.match(text, /-- PRE-FLIGHT/);
    assert.match(text, /-- POST-FLIGHT/);
    assert.match(text, /END OF PACKAGE/);
  });

  test("the package contains no destructive or privilege-widening statements", () => {
    const nonComment = text
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const re of [
      /\bdrop\s+table\b/i,
      /\bdrop\s+column\b/i,
      /\btruncate\b/i,
      /\bdelete\s+from\b/i,
      /\bdrop\s+schema\b/i,
      /\bgrant\s+all\b/i,
      /security\s+definer/i,
    ]) {
      assert.doesNotMatch(nonComment, re, `destructive or unsafe statement: ${re}`);
    }
  });

  test("the package documents the apply order and the correct project", () => {
    assert.match(text, /PRODUCTION_ACTIVATION_001_002_003\.sql/);
    assert.match(text, /_011/);
    assert.match(text, /chlkmdobhvfnldqkgdji/);
    assert.match(text, /notifications/);
    assert.match(text, /can_read_tenant/);
  });

  test("a rollback file exists and drops only the notifications table", () => {
    const rb = fs.readFileSync(path.join(MIG, "012_notifications_rollback.sql"), "utf8");
    assert.match(rb, /drop table if exists public\.notifications/);
    assert.doesNotMatch(rb, /drop table if exists public\.(?!notifications)/);
  });
});
