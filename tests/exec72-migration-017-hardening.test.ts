/**
 * Exec 72 - Item 3 (hardening): migration 017 must be RACE-SAFE BY CONSTRUCTION,
 * must honour the booking's real precision, and must fail closed.
 *
 * The first version of 017 guarded the race with a trigger whose body was a plain
 * `select ... from rental_contracts`. Under READ COMMITTED that cannot see a
 * concurrent uncommitted insert, so two simultaneous bookings BOTH committed -
 * the exact race the migration claimed to close, and a single-session test could
 * not see it. These tests pin the properties that fix it:
 *
 *   1. the trigger takes a transaction-level advisory lock keyed on (tenant, car);
 *   2. it does NOT fall back to a bare, unlocked select;
 *   3. the window is built from the highest precision the table offers, so a
 *      booking that carries a pickup/return TIME is not treated as a whole day;
 *   4. activation FAILS when the table cannot be guarded (never a silent success);
 *   5. the frozen activation package and its hash stay consistent.
 *
 * The concurrency behaviour itself is proved by EXECUTION against a real
 * PostgreSQL, because no unit test can observe two sessions racing:
 *   python3 supabase/tests/017_harness/race.py    (15 assertions, two sessions)
 *   bash supabase/tests/017_harness/run.sh        (31 assertions)
 */

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

import { REQUIREMENTS, checkRequirement, tableColumns } from "../scripts/verify-live-schema.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const MIGRATION = "supabase/migrations/017_booking_overlap_guard.sql";
const PACKAGE = "supabase/PRODUCTION_ACTIVATION_017.sql";
const PREFLIGHT = "supabase/EXEC72_BOOKING_GUARD_PREFLIGHT.sql";

/** Strip `--` comments only, keeping string literals (for literal checks). */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

/** Strip `--` comments and string literals, leaving executable SQL. */
function executableSql(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .replace(/'(?:[^']|'')*'/g, "''");
}

// ---------------------------------------------------------------------------
// 1. Race safety by construction
// ---------------------------------------------------------------------------
test("017's trigger takes a transaction-level advisory lock", () => {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /pg_advisory_xact_lock\s*\(/,
    "the trigger must take a transaction-level advisory lock, or the plain select cannot see a concurrent insert",
  );
});

test("017's trigger does NOT rely on an unlocked select (the original defect)", () => {
  const sql = read(MIGRATION);
  // The lock must be taken BEFORE the conflict select, otherwise it serialises
  // nothing: the read would still use the pre-lock snapshot.
  const lockAt = sql.indexOf("pg_advisory_xact_lock");
  const selectAt = sql.indexOf("select c.id into v_clash");
  assert.ok(lockAt > 0, "no advisory lock found");
  assert.ok(selectAt > lockAt, "the lock must be taken before the conflict read");
});

test("017's advisory lock is keyed on both the tenant and the car", () => {
  const sql = read(MIGRATION);
  const lockBlock = sql.slice(sql.indexOf("pg_advisory_xact_lock"), sql.indexOf("select c.id into v_clash"));
  assert.match(lockBlock, /new\.car_id/, "the lock must be per-car");
  assert.match(lockBlock, /new\.tenant_id/, "the lock must be per-tenant");
  // A global lock would serialise every booking on every car - correct but
  // needlessly destructive to throughput, and a sign the key was not thought
  // through.
  assert.match(lockBlock, /coalesce\s*\(\s*new\.tenant_id/, "the tenant must be coalesced so a NULL-tenant install locks on itself");
});

test("the guard is SECURITY DEFINER with a pinned search_path and revoked from clients", () => {
  const sql = read(MIGRATION);
  assert.match(sql, /security\s+definer/i);
  assert.match(sql, /set\s+search_path\s*=\s*public/i);
  for (const role of ["public", "anon", "authenticated"]) {
    assert.match(
      sql,
      new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.prevent_car_double_booking\\(\\)\\s+from\\s+${role}`, "i"),
      `the guard function must be revoked from ${role}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Precision: a TIME-bearing booking must not be treated as a whole day
// ---------------------------------------------------------------------------
test("017 detects the booking precision from the live columns", () => {
  const sql = read(MIGRATION);
  for (const col of ["start_at", "end_at", "start_ts", "end_ts", "start_date", "end_date", "start_time", "end_time"]) {
    assert.match(sql, new RegExp(`'${col}'`), `017 must probe for ${col}`);
  }
});

test("017 builds a timestamp range, not a calendar-date range, when a time exists", () => {
  const sql = read(MIGRATION);
  assert.match(sql, /tstzrange\s*\(/, "a timestamptz window must use tstzrange");
  assert.match(sql, /tsrange\s*\(/, "a local/timed window must use tsrange");
  // The date+time branch must combine the date and the time; a bare
  // `daterange(start_date, end_date)` is the bug (two same-day windows at
  // different times would collide).
  assert.match(
    sql,
    /start_date\s*\+\s*coalesce\s*\(\s*new\.start_time/,
    "the date+time window must combine the date with the pickup time",
  );
  assert.doesNotMatch(
    executableSql(sql),
    /daterange\s*\(/,
    "017 must not fall back to a calendar-date range",
  );
});

test("every window is half-open so a turnover is not a conflict", () => {
  // Comments stripped, literals KEPT: the half-open bound is itself a literal.
  const sql = stripComments(read(MIGRATION));
  const constructors = sql.match(/(tstzrange|tsrange)\s*\(/g) ?? [];
  assert.ok(constructors.length > 0, "no range expression found");
  // PL/pgSQL escapes a quote inside a quoted string by doubling it, so the
  // literal appears as ''[)'' rather than '[)'.
  const halfOpen = sql.match(/'+\[\)'+'/g) ?? [];
  assert.equal(
    halfOpen.length,
    constructors.length,
    `every one of the ${constructors.length} range constructors must use the half-open '[)' bound (found ${halfOpen.length})`,
  );
  // A closed or other bound would make a turnover a conflict, contradicting
  // `periodsOverlap` in the service.
  assert.doesNotMatch(sql, /'+\[\]'+|'+\(\]'+|'+\([\)]'+'/);
});

test("the fallback window is built with the same expression the constraint uses", () => {
  const sql = read(MIGRATION);
  // One expression, reduced to bare columns for the constraint (which has no row
  // alias). If these ever diverge, the trigger and the constraint would disagree
  // about what "overlap" means.
  assert.match(sql, /v_col_expr\s*:=\s*replace\s*\(\s*v_row_expr\s*,\s*'c\.'\s*,\s*''\s*\)/);
});

// ---------------------------------------------------------------------------
// 2b. A tenant-LESS install (the live shape today) must still be guarded
// ---------------------------------------------------------------------------
test("017 never names a tenant column unconditionally", () => {
  // `new.tenant_id` / `a.tenant_id` cannot be referenced on a schema without the
  // column. Doing so either aborts the migration (the trigger's `update of`
  // list, the constraint, the dupes query) or creates a trigger that raises the
  // first time it fires - which is how the tenant-less case shipped broken.
  const sql = read(MIGRATION);
  const exec = executableSql(sql);
  const offenders: string[] = [];
  // Every literal reference to a tenant column must be inside a format() string
  // (built only when v_tenant), never in the outer SQL that always runs.
  for (const m of exec.matchAll(/(new|a|b|c)\.tenant_id/g)) {
    const line = exec.slice(exec.lastIndexOf("\n", m.index) + 1, exec.indexOf("\n", m.index));
    if (!/format\(|%s|v_tenant/.test(line)) offenders.push(line.trim());
  }
  assert.deepEqual(offenders, [], `unguarded tenant reference: ${offenders.join(" | ")}`);
  assert.match(sql, /column_name='tenant_id'/, "017 must probe for tenant_id");
  assert.match(sql, /v_tenant\s+boolean/, "017 must record whether tenant_id exists");
});

test("017's trigger column list is built, not hardcoded", () => {
  const sql = read(MIGRATION);
  assert.match(sql, /v_upd_cols\s*:=\s*'car_id, '\s*\|\|\s*v_guard_cols/);
  assert.match(sql, /case when v_tenant then ', tenant_id' else '' end/);
  // The trigger must consume the built list, not a literal column list.
  assert.match(sql, /before insert or update of %1\$s/);
  assert.doesNotMatch(executableSql(sql), /update of car_id, start_date/);
});

test("017 omits the tenant equality from the constraint when there is no column", () => {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /case when v_tenant then format\('\(coalesce\(tenant_id, %s\)\) with =,'[\s\S]{0,40}?else '' end/,
    "the constraint's tenant equality must be emitted only when tenant_id exists",
  );
});

test("017's duplicate scan omits the tenant join when there is no column", () => {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /case when v_tenant\s+then format\('and coalesce\(a\.tenant_id, %s\)/,
    "the dupes query must add the tenant equality only when tenant_id exists",
  );
});

// ---------------------------------------------------------------------------
// 3. Fail closed
// ---------------------------------------------------------------------------
test("017 REFUSES activation when the table cannot be guarded", () => {
  const sql = read(MIGRATION);
  assert.match(
    sql,
    /raise exception[\s\S]{0,200}no usable booking window/i,
    "a table with no usable window must abort the migration, not skip it silently",
  );
  // The old defect: `return` on a missing column, which reported success while
  // guarding nothing.
  const beforeGuard = sql.slice(0, sql.indexOf("raise notice '017: booking precision"));
  assert.doesNotMatch(
    beforeGuard,
    /if not exists \(select 1 from information_schema\.columns[\s\S]{0,400}?return;/,
    "017 must not silently return when the guard columns are missing",
  );
});

test("017 reports which guard is active rather than implying the strongest one", () => {
  const sql = read(MIGRATION);
  assert.match(sql, /advisory-lock trigger IS active/, "a skipped constraint must say the trigger still guards");
  const pkg = read(PACKAGE);
  assert.match(pkg, /active_guard/, "the POST-FLIGHT must report the active guard");
});

test("the preflight inspects the tenant-less shape it exists to report on", () => {
  const sql = read(PREFLIGHT);
  // The preflight runs BEFORE 017, so `booking_blocks_car` does not exist yet and
  // must not be called; and a plain statement cannot name a tenant column that may
  // be absent, so the overlap predicate is assembled dynamically.
  assert.doesNotMatch(
    executableSql(sql),
    /public\.booking_blocks_car\s*\(/,
    "the preflight must not call a helper that 017 has not created yet",
  );
  assert.match(sql, /execute\s+format\(/, "the overlap predicate must be assembled dynamically");
  assert.match(sql, /v_ten/, "the preflight must detect whether tenant_id exists");
  assert.match(sql, /case when v_ten[\s\S]{0,40}then 'and coalesce\(a\.tenant_id/,
    "the tenant equality must be emitted only when the column exists");
  assert.match(sql, /else '' end/, "and must be empty when it does not");
  // Still read-only after the rewrite.
  const exec = executableSql(sql);
  for (const re of [/\binsert\b/i, /\bupdate\b/i, /\bdelete\b/i, /\bdrop\b/i, /\balter\b/i, /\btruncate\b/i]) {
    assert.doesNotMatch(exec, re, `the preflight must stay read-only: ${re}`);
  }
});

// ---------------------------------------------------------------------------
// 3b. The live-schema verifier's SUCCESS path (proved against a local stub)
// ---------------------------------------------------------------------------
/** Serve a PostgREST-shaped OpenAPI document so the verifier has something real to read. */
function stubPostgrest(definitions: Record<string, unknown>): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/rest/v1/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ swagger: "2.0", definitions }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/**
 * Run the verifier against a base URL, returning its exit code and output.
 *
 * ASYNC on purpose: the stub server lives in THIS process, so a synchronous
 * spawn would block the event loop and the stub could never answer - the child
 * would hang until the test timed out.
 */
function runVerifier(url: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      ["scripts/verify-live-schema.mjs"],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          NEXT_PUBLIC_SUPABASE_URL: url,
          SUPABASE_SERVICE_ROLE_KEY: "local-stub-service-role-key-long-enough",
          NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-stub-anon-key",
        },
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? -1) : 0;
        resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
      },
    );
  });
}

test("the verifier reports a SATISFIED schema with exit 0 when the columns exist", async () => {
  // A date+time live shape: 017 must be reported effective (not merely present).
  const stub = await stubPostgrest({
    rental_contracts: {
      properties: { id: {}, car_id: {}, start_date: {}, end_date: {}, start_time: {}, end_time: {}, status: {}, tenant_id: {} },
    },
    users: { properties: { id: {}, customer_id: {}, role: {} } },
    invoices: { properties: { id: {}, rental_contract_id: {}, total_amount: {} } },
  });
  try {
    const { code, out } = await runVerifier(`http://127.0.0.1:${stub.port}`);
    assert.equal(code, 0, `expected exit 0 (satisfied), got ${code}: ${out}`);
    assert.match(out, /Live schema read: 3 tables/);
    assert.match(out, /OK\s+\| 017 rental_contracts: guard is effective/);
    assert.match(out, /OK\s+\| 016 users/);
    assert.match(out, /OK\s+\| 013 invoices/);
  } finally {
    await stub.close();
  }
});

test("the verifier reports a MISSING column with exit 1 and names what is absent", async () => {
  const stub = await stubPostgrest({
    rental_contracts: { properties: { id: {}, car_id: {}, start_date: {}, end_date: {}, status: {} } },
    users: { properties: { id: {}, role: {} } },
    invoices: { properties: { id: {}, total_amount: {} } },
  });
  try {
    const { code, out } = await runVerifier(`http://127.0.0.1:${stub.port}`);
    assert.equal(code, 1, `expected exit 1 (unsatisfied), got ${code}: ${out}`);
    assert.match(out, /FAIL\s+\| 016 users/);
    assert.match(out, /customer_id/, "the missing column must be named");
    // And it must still say the tenant-less 017 guard is effective.
    assert.match(out, /017 rental_contracts: guard is effective/);
  } finally {
    await stub.close();
  }
});

test("an explicit environment variable beats the .env.local placeholder", () => {
  // The tool must be pointable at a project without editing the file; the
  // placeholder in .env.local used to win, which made the success path
  // untestable and an operator override impossible.
  const src = readFileSync(join(ROOT, "scripts/verify-live-schema.mjs"), "utf8");
  assert.match(src, /if \(process\.env\[k\]\) out\[k\] = process\.env\[k\]/, "env vars must take precedence");
});

// ---------------------------------------------------------------------------
// 4. The frozen package
// ---------------------------------------------------------------------------
test("the activation package embeds 017 verbatim and declares the advisory lock", () => {
  const pkg = read(PACKAGE);
  assert.match(pkg, /pg_advisory_xact_lock/, "the package must carry the race-safe guard");
  assert.match(pkg, /-- PRE-FLIGHT/);
  assert.match(pkg, /-- POST-FLIGHT/);
  assert.match(pkg, /advisory lock/i, "the POST-FLIGHT must assert the lock is present");
});

test("the package's pre-flight reports the detected precision", () => {
  const pkg = read(PACKAGE);
  assert.match(pkg, /detected_booking_precision/, "the operator must be told which precision applies");
  for (const label of ["date-only", "date+time", "timestamptz"]) {
    assert.match(pkg, new RegExp(label.replace("+", "\\+")), `the pre-flight must name the ${label} case`);
  }
});

test("the read-only preflight writes nothing", () => {
  const sql = read(PREFLIGHT);
  const exec = executableSql(sql);
  for (const re of [/\binsert\b/i, /\bupdate\b/i, /\bdelete\b/i, /\bdrop\b/i, /\balter\b/i, /\bcreate\b/i, /\btruncate\b/i]) {
    assert.doesNotMatch(exec, re, `the preflight must be read-only: ${re}`);
  }
  // Executable SQL only: the header comment says "does not `set role`", which
  // is the opposite of the property being checked.
  assert.doesNotMatch(exec, /set\s+role/i, "the preflight must not change role");
});

// ---------------------------------------------------------------------------
// 5. Live-schema verification (answers "what precision does the live DB have?")
// ---------------------------------------------------------------------------
test("the live-schema verifier reports the precision it finds, per migration", () => {
  // A date-only live table: the guard is effective but has no time support.
  const dateOnly = tableColumns({
    definitions: {
      rental_contracts: { properties: { id: {}, car_id: {}, start_date: {}, end_date: {}, status: {}, tenant_id: {} } },
      users: { properties: { id: {}, customer_id: {} } },
      invoices: { properties: { id: {}, rental_contract_id: {} } },
    },
  });
  const req017 = REQUIREMENTS.find((r) => r.id === "017")!;
  const dateResult = checkRequirement(req017, dateOnly);
  assert.equal(dateResult.status, "satisfied");
  assert.equal(dateResult.precision, "date-only window");

  // A live table WITH the pickup/return time: the time-aware guard applies.
  const withTime = tableColumns({
    definitions: {
      rental_contracts: {
        properties: { id: {}, car_id: {}, start_date: {}, end_date: {}, start_time: {}, end_time: {}, status: {}, tenant_id: {} },
      },
    },
  });
  const timeResult = checkRequirement(req017, withTime);
  assert.equal(timeResult.status, "satisfied");
  assert.equal(timeResult.precision, "date + time window");
});

test("the live-schema verifier fails a table that cannot be guarded", () => {
  const tables = tableColumns({
    definitions: { rental_contracts: { properties: { id: {}, car_id: {}, status: {} } } },
  });
  const result = checkRequirement(REQUIREMENTS.find((r) => r.id === "017")!, tables);
  assert.equal(result.status, "unsatisfied");
  assert.match(result.detail, /none of:/);
});

test("the live-schema verifier distinguishes a missing table from a missing column", () => {
  const tables = tableColumns({ definitions: { users: { properties: { id: {} } } } });
  const result = checkRequirement(REQUIREMENTS.find((r) => r.id === "013")!, tables);
  assert.equal(result.status, "table_missing");
});

test("the live-schema verifier refuses to claim success without credentials", () => {
  // The tool must exit 2 (NOT VERIFIED) rather than 0 when it cannot read the
  // live schema - an unreadable schema is not a verified one.
  let code = 0;
  let out = "";
  try {
    out = execFileSync("node", ["scripts/verify-live-schema.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "" },
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? -1;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.equal(code, 2, `expected exit 2 (NOT VERIFIED), got ${code}: ${out}`);
  assert.match(out, /NOT VERIFIED/);
});
