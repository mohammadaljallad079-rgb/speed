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
const PKG_013 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_013.sql");
const PKG_014 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_014.sql");
const PKG_015 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_015.sql");
const PKG_016 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_016.sql");
const PKG_017 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_017.sql");
const PKG_018 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_018.sql");

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

// ---------------------------------------------------------------------------
// 013 / 014 / 015 — the packages that back the live receipt workflow.
// ---------------------------------------------------------------------------

const LATER_PACKAGES: Array<{
  n: string;
  file: string;
  pkg: string;
  migration: string;
  rollback: string;
  mustMention: RegExp[];
  /**
   * `security definer` is refused by default because a definer function in a
   * package is a privilege boundary that must be reviewed, not waved through.
   * 016 declares the two predicate helpers 002/004 already rely on
   * (`current_customer_id`, `is_erp_user`); both only read the caller's own
   * `users` row, which is why RLS cannot be allowed to filter that read. The
   * exception is stated per-package and asserted below, so any OTHER package
   * that adds a definer function still fails.
   */
  allowsSecurityDefiner?: boolean;
  definerFunctions?: string[];
}> = [
  {
    n: "013",
    file: "013_booking_invoice_idempotency.sql",
    pkg: PKG_013,
    migration: "013_booking_invoice_idempotency.sql",
    rollback: "013_booking_invoice_idempotency_rollback.sql",
    mustMention: [/PRODUCTION_ACTIVATION_001_002_003\.sql/, /012/, /chlkmdobhvfnldqkgdji/, /rental_contract_id/],
  },
  {
    n: "014",
    file: "014_tenant_chart_of_accounts.sql",
    pkg: PKG_014,
    migration: "014_tenant_chart_of_accounts.sql",
    rollback: "014_tenant_chart_of_accounts_rollback.sql",
    mustMention: [/PRODUCTION_ACTIVATION_001_002_003\.sql/, /013/, /chlkmdobhvfnldqkgdji/, /accounts/],
  },
  {
    n: "015",
    file: "015_strict_accounting_integrity.sql",
    pkg: PKG_015,
    migration: "015_strict_accounting_integrity.sql",
    rollback: "015_strict_accounting_integrity_rollback.sql",
    mustMention: [
      /PRODUCTION_ACTIVATION_001_002_003\.sql/,
      /014/,
      /chlkmdobhvfnldqkgdji/,
      /post_customer_receipt/,
      /post_customer_receipt_reversal/,
    ],
  },
  {
    n: "016",
    file: "016_customer_row_isolation.sql",
    pkg: PKG_016,
    migration: "016_customer_row_isolation.sql",
    rollback: "016_customer_row_isolation_rollback.sql",
    mustMention: [
      /PRODUCTION_ACTIVATION_001_002_003\.sql/,
      /015/,
      /chlkmdobhvfnldqkgdji/,
      /current_customer_id/,
      /is_erp_user/,
    ],
    allowsSecurityDefiner: true,
    definerFunctions: ["current_customer_id", "is_erp_user", "prevent_self_privilege_escalation"],
  },
  {
    n: "017",
    file: "017_booking_overlap_guard.sql",
    pkg: PKG_017,
    migration: "017_booking_overlap_guard.sql",
    rollback: "017_booking_overlap_guard_rollback.sql",
    mustMention: [
      /PRODUCTION_ACTIVATION_001_002_003\.sql/,
      /016/,
      /chlkmdobhvfnldqkgdji/,
      /rental_contracts_no_car_overlap/,
    ],
    // `prevent_car_double_booking` is SECURITY DEFINER on purpose: it must see
    // every booking of the car to detect the overlap, and RLS would otherwise
    // filter that read. It reads only `rental_contracts`, returns NEW, and is
    // revoked from anon/authenticated, so it is not a client-reachable probe.
    allowsSecurityDefiner: true,
    definerFunctions: ["prevent_car_double_booking"],
  },
  {
    n: "018",
    file: "018_booking_time_precision.sql",
    pkg: PKG_018,
    migration: "018_booking_time_precision.sql",
    rollback: "018_booking_time_precision_rollback.sql",
    mustMention: [
      /PRODUCTION_ACTIVATION_001_002_003\.sql/,
      /017/,
      /chlkmdobhvfnldqkgdji/,
      /start_at/,
      /company_timezone/,
    ],
    // `company_timezone` is SECURITY DEFINER so it can read `settings` without
    // depending on the caller's RLS, and `prevent_car_double_booking` so it can
    // see every booking of the car. Neither is a client-reachable probe: both are
    // revoked from anon/authenticated and asserted so in the POST-FLIGHT.
    allowsSecurityDefiner: true,
    definerFunctions: ["company_timezone", "prevent_car_double_booking"],
  },
];

for (const p of LATER_PACKAGES) {
  describe(`activation package ${p.n} (${p.file})`, () => {
    const text = fs.readFileSync(p.pkg, "utf8");
    const begin = `-- BEGIN ${p.file}`;

    test("the embedded body is byte-identical to the migration and the banner hash matches", () => {
      const { hash, body } = embedded(text, begin, "-- POST-FLIGHT");
      assert.ok(hash, "no SHA-256 recorded in the banner");
      assert.equal(hash, sha(body));
      assert.equal(body, fs.readFileSync(path.join(MIG, p.migration), "utf8"));
    });

    test("the migration is embedded exactly once and both flights are present", () => {
      const count = (needle: string) => text.split(needle).length - 1;
      assert.equal(count(begin), 1, "the body must be embedded exactly once");
      assert.match(text, /-- PRE-FLIGHT/);
      assert.match(text, /-- POST-FLIGHT/);
      assert.match(text, /END OF PACKAGE/);
    });

    test("the package contains no destructive or privilege-widening statements", () => {
      const nonComment = text
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n");
      const forbidden = [
        /\bdrop\s+table\b/i,
        /\bdrop\s+column\b/i,
        /\btruncate\b/i,
        /\bdelete\s+from\b/i,
        /\bdrop\s+schema\b/i,
        /\bgrant\s+all\b/i,
      ];
      // `security definer` is reviewed, not blanket-banned: it is refused unless
      // this package opts in AND declares exactly which functions may use it.
      if (!p.allowsSecurityDefiner) forbidden.push(/security\s+definer/i);
      for (const re of forbidden) {
        assert.doesNotMatch(nonComment, re, `destructive or unsafe statement: ${re}`);
      }
    });

    if (p.allowsSecurityDefiner) {
      test("a definer function is only the ones this package declares", () => {
        const declared = p.definerFunctions ?? [];
        assert.ok(declared.length > 0, "a definer opt-in must name its functions");
        // Only the embedded body may define a function. Scanning the whole file
        // would also read the PRE-/POST-FLIGHT queries, and `security definer`
        // is then attributed to whichever function is textually nearest - which
        // is how this check used to pass while pointing at the wrong function.
        const { body: embeddedBody } = embedded(text, begin, "-- POST-FLIGHT");
        const defined = [...embeddedBody.matchAll(/create or replace function public\.(\w+)\s*\(/g)].map((m) => m[1]);
        // The property that matters is that no UNDECLARED function is a definer
        // function: that would be a privilege boundary nobody reviewed. A plain
        // (invoker) helper next to a declared definer one is fine and common -
        // 017's `booking_blocks_car` is a pure immutable predicate.
        const functionBody = (fn: string) => {
          const at = embeddedBody.indexOf(`function public.${fn}(`);
          assert.ok(at >= 0, `${fn} is not defined in the embedded body`);
          return embeddedBody.slice(at, embeddedBody.indexOf("$$;", at));
        };
        for (const fn of defined) {
          if (declared.includes(fn)) continue;
          assert.doesNotMatch(
            functionBody(fn),
            /security\s+definer/i,
            `undeclared definer function: ${fn}`,
          );
        }
        // Each declared function must actually be defined, and each definition
        // must carry `security definer` and a pinned search_path.
        for (const fn of declared) {
          assert.ok(defined.includes(fn), `declared but not defined: ${fn}`);
          const fnBody = functionBody(fn);
          assert.match(fnBody, /security\s+definer/i, `${fn} must be security definer`);
          assert.match(fnBody, /set\s+search_path\s*=\s*public/i, `${fn} must pin search_path`);
        }
      });

      test("the definer helpers cannot be called by anon", () => {
        for (const fn of p.definerFunctions ?? []) {
          assert.match(
            text,
            new RegExp(`revoke[^;]*on function public\\.${fn}\\([^)]*\\)[^;]*from[^;]*anon`, "is"),
            `${fn} must be revoked from anon`,
          );
        }
      });
    }

    test("the package documents the apply order and the correct project", () => {
      for (const re of p.mustMention) assert.match(text, re);
    });

    test("a rollback file exists", () => {
      const rb = fs.readFileSync(path.join(MIG, p.rollback), "utf8");
      assert.ok(rb.length > 0, `${p.rollback} is empty`);
    });
  });
}

describe("every migration has a frozen activation package", () => {
  test("no migration from 001 to 015 is missing its package", () => {
    const migrations = fs
      .readdirSync(MIG)
      .filter((f) => /^\d{3}_/.test(f) && !f.includes("rollback"))
      .map((f) => f.slice(0, 3))
      .sort();
    const packaged = new Set(
      fs
        .readdirSync(path.join(ROOT, "supabase"))
        .filter((f) => f.startsWith("PRODUCTION_ACTIVATION_"))
        .join(" ")
        .match(/\d{3}/g) ?? [],
    );
    // 001-003 are bundled into one package, so each of those digits appears.
    for (const n of migrations) {
      assert.ok(packaged.has(n), `migration ${n} has no PRODUCTION_ACTIVATION package`);
    }
  });
});
