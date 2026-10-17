import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Execution 19 is a read-only reconciliation preparation. These tests guard the
 * invariant that the query pack ships for the operator can never contain a write
 * or a DDL statement, and that it does not invoke a side-effecting function.
 *
 * They also pin the finding that `ANON_VERIFICATION.sql`, although labelled
 * "read-only", actually creates a temp table, switches role and issues guarded
 * INSERT/UPDATE/DELETE probes - so it is NOT safe under Execution 19's
 * "no writes, no DDL" constraint and must not be run.
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const EXEC19 = "supabase/EXEC19_READONLY_RECONCILIATION.sql";

/** Strip line/block comments and single-quoted string literals before scanning. */
function strip(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .toLowerCase();
}

const FORBIDDEN =
  /\b(insert|update|delete|alter|drop|truncate|create|grant|revoke|merge|copy|comment|vacuum|refresh|call|do)\b/;

describe("Exec 19 - the reconciliation pack is strictly read-only", () => {
  const raw = read(EXEC19);
  const sql = strip(raw);

  test("contains no write or DDL statement", () => {
    const m = FORBIDDEN.exec(sql);
    assert.equal(m, null, `forbidden statement keyword present: ${m?.[0]}`);
  });

  test("does not switch role or create a temporary table", () => {
    assert.doesNotMatch(sql, /set\s+role/);
    assert.doesNotMatch(sql, /temp\s+table|temporary\s+table/);
  });

  test("does not invoke a side-effecting function", () => {
    // It may READ the definition of update_account_balance via pg_proc, but must
    // never call it, nor the numbering RPC.
    assert.doesNotMatch(sql, /update_account_balance\s*\(/);
    assert.doesNotMatch(sql, /generate_document_number\s*\(/);
  });

  test("every statement is a select or a with...select", () => {
    // Statements are split on ';'. After stripping, each non-empty statement
    // must begin with select/with/union and contain 'select'.
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    assert.ok(statements.length >= 7, "expected the full block set");
    for (const s of statements) {
      assert.match(s, /^(select|with)\b/, `statement is not a select: ${s.slice(0, 40)}`);
      assert.match(s, /select/, `statement has no select: ${s.slice(0, 40)}`);
    }
  });

  test("selects identifiers/amounts only - no personal-data columns", () => {
    for (const pii of ["phone", "email", "full_name", "address", "national_id"]) {
      assert.doesNotMatch(sql, new RegExp(`\\b${pii}\\b`), `must not read PII column ${pii}`);
    }
  });

  test("covers every required reconciliation block", () => {
    assert.match(sql, /document_sequences/, "sale_invoice sequence block");
    assert.match(sql, /from\s+public\.invoices/, "last-five invoices block");
    assert.match(sql, /having\s+count\(\*\)\s*>\s*1/, "duplicate-number block");
    assert.match(sql, /taxable_base/, "VAT taxable-base block");
    assert.match(sql, /net_after_returns/, "revenue reconciliation block");
    assert.match(sql, /journal_lines/, "account-vs-ledger block");
    assert.match(sql, /tenant_id/, "tenant isolation block");
  });
});

describe("Exec 19 - ANON_VERIFICATION.sql is NOT read-only (finding)", () => {
  // Scanned raw (not stripped): the role switch and probes are emitted via
  // `execute '<sql>'` string literals, so they are invisible to the stripper.
  const sql = read("supabase/ANON_VERIFICATION.sql").toLowerCase();

  test("it creates a temp table and issues guarded write probes", () => {
    assert.match(sql, /create\s+temp\s+table/, "documents the temp-table creation");
    assert.match(sql, /set\s+role\s+anon/, "documents the role switch");
    assert.match(sql, /insert\s+into/, "documents the guarded INSERT probe");
    assert.match(sql, /update\s+public/, "documents the guarded UPDATE probe");
    assert.match(sql, /delete\s+from/, "documents the guarded DELETE probe");
  });
});
