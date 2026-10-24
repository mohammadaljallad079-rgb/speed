#!/usr/bin/env node
/**
 * Execute a Supabase migration against a REAL PostgreSQL and report the result.
 *
 * WHY
 * ---
 * This sandbox has no reachable Postgres and no Docker, so the SQL harnesses in
 * `supabase/tests/*_harness/run.sh` cannot run here — which left DDL changes
 * verified only by parsing. PGlite is PostgreSQL compiled to WASM, so it runs a
 * migration for real: the DDL is parsed, executed and its effects inspected by
 * the same engine that would run it in production.
 *
 * This does NOT replace the `run.sh` harnesses (those also exercise RLS with
 * authenticated roles). It is the execution check for a purely additive
 * migration like 009.
 *
 * Usage: node scripts/dev/verify-migration.mjs <migration.sql> [base.sql]
 */

import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const migrationPath = process.argv[2];
if (!migrationPath) {
  console.error("usage: verify-migration.mjs <migration.sql> [base-schema.sql]");
  process.exit(2);
}

const basePath = process.argv[3];
const migration = fs.readFileSync(migrationPath, "utf8");
const rollbackPath = migrationPath.replace(/\.sql$/, "_rollback.sql");
const hasRollback = fs.existsSync(rollbackPath);

let pass = 0;
let fail = 0;
const ok = (m) => { console.log(` PASS | ${m}`); pass++; };
const bad = (m, got) => { console.log(` FAIL | ${m} -> got: ${got}`); fail++; };
const eq = (m, expected, got) => (String(expected) === String(got) ? ok(m) : bad(m, got));

const rows = async (db, sql) => (await db.query(sql)).rows;
const one = async (db, sql) => (await rows(db, sql))[0];

console.log(`== ${path.basename(migrationPath)} on PGlite (PostgreSQL/WASM) ==`);

// --- Scenario 1: apply against a schema that HAS the referenced tables -------
const db = new PGlite();
if (basePath) {
  await db.exec(fs.readFileSync(basePath, "utf8"));
} else {
  await db.exec(`
    create table public.accounts (
      id uuid primary key default gen_random_uuid(),
      code text, name text, name_ar text, name_en text, type text,
      level int default 1, is_active boolean default true, tenant_id uuid
    );
    create table public.journal_entries (
      id uuid primary key default gen_random_uuid(),
      entry_type text, reference_number text, status text default 'posted'
    );
    create table public.depreciation_schedules (
      id uuid primary key default gen_random_uuid(),
      car_id uuid, method text default 'straight_line', useful_life_years int default 5,
      salvage_value numeric default 0, annual_rate numeric default 20, start_date date,
      created_at timestamptz default now()
    );
  `);
}

try {
  await db.exec(migration);
  ok("migration applies cleanly");
} catch (e) {
  bad("migration applies cleanly", e.message);
}

const acc1 = await one(db, `select count(*)::int c from public.accounts where code in ('14001','52001')`);
eq("both depreciation accounts exist after apply", 2, acc1.c);

const t14001 = await one(db, `select type from public.accounts where code = '14001'`);
eq("14001 is an asset (contra-asset)", "asset", t14001?.type);
const t52001 = await one(db, `select type from public.accounts where code = '52001'`);
eq("52001 is an expense", "expense", t52001?.type);

const tcol = await one(db, `select count(*)::int c from information_schema.columns
  where table_schema='public' and table_name='depreciation_schedules' and column_name='tenant_id'`);
eq("depreciation_schedules gained tenant_id", 1, tcol.c);

const idx = await one(db, `select count(*)::int c from pg_indexes
  where schemaname='public' and indexname='journal_entries_depreciation_ref_idx'`);
eq("depreciation reference index created", 1, idx.c);

// --- Scenario 2: idempotent re-apply ----------------------------------------
try {
  await db.exec(migration);
  ok("migration re-applies (idempotent)");
} catch (e) {
  bad("migration re-applies (idempotent)", e.message);
}
const acc2 = await one(db, `select count(*)::int c from public.accounts where code in ('14001','52001')`);
eq("re-apply does not duplicate the accounts", 2, acc2.c);

// --- Scenario 3: no-op on a schema without the schedule table ---------------
const db2 = new PGlite();
await db2.exec(`create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  code text, name text, name_ar text, name_en text, type text,
  level int default 1, is_active boolean default true, tenant_id uuid
);`);
try {
  await db2.exec(migration);
  ok("migration is a no-op without depreciation_schedules");
} catch (e) {
  bad("migration is a no-op without depreciation_schedules", e.message);
}
const acc3 = await one(db2, `select count(*)::int c from public.accounts where code in ('14001','52001')`);
eq("accounts still seeded without the schedule table", 2, acc3.c);

// --- Scenario 4: rollback is non-destructive to the ledger ------------------
if (hasRollback) {
  try {
    await db.exec(fs.readFileSync(rollbackPath, "utf8"));
    ok("rollback applies cleanly");
  } catch (e) {
    bad("rollback applies cleanly", e.message);
  }
  const idxR = await one(db, `select count(*)::int c from pg_indexes
    where schemaname='public' and indexname='journal_entries_depreciation_ref_idx'`);
  eq("rollback drops the index", 0, idxR.c);
  const accR = await one(db, `select count(*)::int c from public.accounts where code in ('14001','52001')`);
  eq("rollback PRESERVES the seeded accounts (ledger safety)", 2, accR.c);
}

console.log("-----------------------------------------");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
