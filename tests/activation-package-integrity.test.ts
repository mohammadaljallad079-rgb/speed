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
