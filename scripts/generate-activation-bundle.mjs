#!/usr/bin/env node
/**
 * Regenerate supabase/PRODUCTION_ACTIVATION_005_006.sql from the source
 * migrations, verbatim.
 *
 * The activation package must never be hand-edited: its embedded bodies have to
 * stay byte-identical to supabase/migrations/005_accounting_integrity.sql and
 * 006_ai_repair.sql, and its SHA-256 banners have to stay true. Run this script
 * after any change to those two migrations, then run
 * `npm test` (tests/activation-package-integrity.test.ts recomputes every hash).
 *
 *   node scripts/generate-activation-bundle.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIG = path.join(ROOT, "supabase", "migrations");
const OUT = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_005_006.sql");

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const read = (name) => fs.readFileSync(path.join(MIG, name), "utf8");

const b005 = read("005_accounting_integrity.sql");
const b006 = read("006_ai_repair.sql");
const h005 = sha(b005);
const h006 = sha(b006);

const sep = "-- " + "=".repeat(74);

const header = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (005 -> 006)
-- ============================================================================
-- Purpose : apply the accounting-integrity index/view (005) and the durable AI
--           repair ledger (006) on the LIVE Supabase project.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : run PRODUCTION_ACTIVATION_001_002_003.sql, then
--           PRODUCTION_ACTIVATION_004.sql, and ONLY THEN this file.
--           Dependencies:
--             * 005 needs journal_entries with entry_type/reference_number/
--               status/total_debit/total_credit (added by 003).
--             * 006 needs can_read_tenant()/can_write_tenant() (defined in 002).
--           Do NOT run this file before 001 -> 002 -> 003 -> 004.
--
-- SAFETY  : additive and idempotent. No DROP TABLE, no DROP COLUMN, no TRUNCATE,
--           no DELETE, no row rewrite. It only:
--             * adds two indexes and one read-only view (005);
--             * creates one append-only table with RLS + three indexes (006).
--           Safe to re-run. It does NOT modify customer/invoice/account data.
--
-- IMPORTANT — 005 CAN ABORT BY DESIGN
--           The unique index in 005 fails if the live ledger ALREADY contains
--           duplicate posted journals for the same (entry_type, reference_number)
--           among ('sale_invoice','supplier_payment'). Because 005 is wrapped in
--           a single transaction, a failure rolls the WHOLE 005 back (no partial
--           index/view). RUN THE PRE-FLIGHT DUPLICATE QUERY BELOW FIRST (or
--           supabase/EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql); if it returns any
--           row, resolve those journals before running this file.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           chlkmdobhvfnldqkgdji (SPEED ERP production) before executing.
--
-- The two migration bodies below are reproduced verbatim from
-- supabase/migrations/ (SHA-256 of each body is recorded at its header), so
-- what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT (read-only — visibility only; never aborts the script)
-- ============================================================================
select current_database() as database, current_user as executor_role, now() as at_utc;

-- Prior migrations must be present for 005/006 to be meaningful.
select 'helper can_read_tenant()'  as item, exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='can_read_tenant') as present
union all select 'table public.journal_entries', (to_regclass('public.journal_entries') is not null)
union all select '005 already applied (integrity view)', (to_regclass('public.v_journal_integrity_issues') is not null)
union all select '006 already applied (ai_repair_executions)', (to_regclass('public.ai_repair_executions') is not null)
order by present, item;

-- CRITICAL: conflicts that would make 005 fail. MUST return ZERO rows.
-- This uses the SAME predicate as the 005 unique index.
select entry_type, reference_number, count(*) as duplicate_rows
  from public.journal_entries
 where status = 'posted'
   and reference_number is not null
   and reference_number <> ''
   and entry_type in ('sale_invoice', 'supplier_payment')
 group by entry_type, reference_number
having count(*) > 1
 order by duplicate_rows desc, entry_type, reference_number;

-- ============================================================================
-- BEGIN 005_accounting_integrity.sql
-- SHA-256 (body): ${h005}
-- ============================================================================

${b005}
${sep}
-- BEGIN 006_ai_repair.sql
-- SHA-256 (body): ${h006}
${sep}

${b006}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migrations took effect)
-- ============================================================================
-- Every row below must read true (or return ZERO rows where noted).

-- 005: both indexes exist.
select indexname, (indexdef like '%WHERE%') as is_partial
  from pg_indexes
 where schemaname = 'public'
   and indexname in ('journal_entries_type_ref_idx',
                     'journal_entries_one_posted_per_doc_uidx')
 order by indexname;

-- 005: the integrity view exists and reports no duplicates on a healthy ledger.
--      On a healthy ledger this returns ZERO rows.
select * from public.v_journal_integrity_issues;

-- 006: table + unique indexes exist.
select 'ai_repair_executions table' as item, (to_regclass('public.ai_repair_executions') is not null) as ok
union all select '006 unique index (tenant)', exists (select 1 from pg_indexes where schemaname='public' and indexname='ai_repair_executions_tenant_key_uidx')
union all select '006 unique index (null tenant)', exists (select 1 from pg_indexes where schemaname='public' and indexname='ai_repair_executions_null_tenant_key_uidx')
union all select '006 RLS enabled', (select relrowsecurity from pg_class where oid='public.ai_repair_executions'::regclass)
order by item;

-- 006: the delete policy is RESTRICTIVE (permissive = false), and anon holds
--      no privilege on the table.
select p.polname, p.polpermissive, (p.polpermissive = false) as is_restrictive_ok
  from pg_policy p
 where p.polrelid = 'public.ai_repair_executions'::regclass
 order by p.polname;

select 'anon has no privilege on ai_repair_executions' as item,
       not has_table_privilege('anon', 'public.ai_repair_executions', 'select') as ok;

-- ============================================================================
-- END OF PACKAGE (005 -> 006)
-- ============================================================================
`;

fs.writeFileSync(OUT, header, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT)}`);
console.log(`  005 sha256 ${h005}`);
console.log(`  006 sha256 ${h006}`);
