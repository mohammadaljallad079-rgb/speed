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
const OUT_007 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_007.sql");
const OUT_009 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_009.sql");
const OUT_008 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_008.sql");
const OUT_010 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_010.sql");

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const read = (name) => fs.readFileSync(path.join(MIG, name), "utf8");

const b005 = read("005_accounting_integrity.sql");
const b006 = read("006_ai_repair.sql");
const h005 = sha(b005);
const h006 = sha(b006);

const b007 = read("007_purchase_sale_links.sql");
const h007 = sha(b007);

const b009 = read("009_depreciation_accounts.sql");
const h009 = sha(b009);

const b008 = read("008_user_role_hardening.sql");
const h008 = sha(b008);

const b010 = read("010_purchasing_accounts.sql");
const h010 = sha(b010);

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

const header007 = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (007)
-- ============================================================================
-- Purpose : create the analytical purchase <-> credit-sale link table that the
--           /api/purchase-sale-links route (Exec 30, Item 6) reads and writes.
--           REPORTING/ANALYSIS ONLY — no inventory, no warehouse, no stock
--           movement, no cost allocation, no journal entry.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : run PRODUCTION_ACTIVATION_001_002_003.sql, then
--           PRODUCTION_ACTIVATION_004.sql, then
--           PRODUCTION_ACTIVATION_005_006.sql, and ONLY THEN this file.
--           Dependencies:
--             * 007 needs can_read_tenant()/can_write_tenant() (defined in 002);
--             * it references public.purchase_invoices and public.invoices,
--               which already exist on the live project.
--           Do NOT run this file before 001 -> 002.
--
-- SAFETY  : additive, idempotent, forward-only. No DROP TABLE, no DROP COLUMN,
--           no TRUNCATE, no DELETE, no row rewrite. It creates one table, five
--           indexes and four RLS policies. Safe to re-run.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           chlkmdobhvfnldqkgdji (SPEED ERP production) before executing.
--
-- The migration body below is reproduced verbatim from
-- supabase/migrations/007_purchase_sale_links.sql (SHA-256 recorded at its
-- header), so what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT (read-only — visibility only; never aborts the script)
-- ============================================================================
select current_database() as database, current_user as executor_role, now() as at_utc;

-- 007 depends on the 002 helpers and on the two tables it references.
select 'helper can_read_tenant()'  as item, exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='can_read_tenant') as present
union all select 'helper can_write_tenant()', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='can_write_tenant')
union all select 'table public.purchase_invoices', (to_regclass('public.purchase_invoices') is not null)
union all select 'table public.invoices', (to_regclass('public.invoices') is not null)
union all select '007 already applied (purchase_sale_links)', (to_regclass('public.purchase_sale_links') is not null)
order by present, item;

-- ============================================================================
-- BEGIN 007_purchase_sale_links.sql
-- SHA-256 (body): ${h007}
-- ============================================================================

${b007}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'purchase_sale_links table' as item, (to_regclass('public.purchase_sale_links') is not null) as ok
union all select 'RLS enabled', (select relrowsecurity from pg_class where oid='public.purchase_sale_links'::regclass)
union all select 'unique index (tenant)', exists (select 1 from pg_indexes where schemaname='public' and indexname='purchase_sale_links_tenant_pair_uidx')
union all select 'unique index (null tenant)', exists (select 1 from pg_indexes where schemaname='public' and indexname='purchase_sale_links_null_tenant_pair_uidx')
union all select 'anon has no privilege', not has_table_privilege('anon', 'public.purchase_sale_links', 'select')
order by item;

-- The four policies must all exist.
select polname, polpermissive
  from pg_policy
 where polrelid = 'public.purchase_sale_links'::regclass
 order by polname;

-- ============================================================================
-- END OF PACKAGE (007)
-- ============================================================================
`;

fs.writeFileSync(OUT_007, header007, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_007)}`);
console.log(`  007 sha256 ${h007}`);

const header009 = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (009)
-- ============================================================================
-- Purpose : seed the two fixed depreciation accounts (14001 accumulated
--           depreciation, 52001 depreciation expense) that
--           src/lib/accounting/depreciation-posting.ts posts to, and give
--           depreciation_schedules a tenant column.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : run PRODUCTION_ACTIVATION_001_002_003.sql, then
--           PRODUCTION_ACTIVATION_004.sql, then
--           PRODUCTION_ACTIVATION_005_006.sql, then
--           PRODUCTION_ACTIVATION_007.sql, and ONLY THEN this file.
--           Dependencies:
--             * 009 needs public.accounts (always present);
--             * the tenant column is only added when depreciation_schedules
--               already exists, so it is a clean no-op otherwise.
--
-- SAFETY  : additive and idempotent. No DROP TABLE, no DROP COLUMN, no
--           TRUNCATE, no DELETE, no row rewrite. It inserts at most two rows
--           (guarded by \`where not exists\` on the code) and adds one nullable
--           column and one index. Safe to re-run.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           chlkmdobhvfnldqkgdji (SPEED ERP production) before executing.
--
-- The migration body below is reproduced verbatim from
-- supabase/migrations/009_depreciation_accounts.sql (SHA-256 recorded at its
-- header), so what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT (read-only — visibility only; never aborts the script)
-- ============================================================================
select current_database() as database, current_user as executor_role, now() as at_utc;

select 'table public.accounts' as item, (to_regclass('public.accounts') is not null) as present
union all select 'account 14001 already present', exists (select 1 from public.accounts where code = '14001')
union all select 'account 52001 already present', exists (select 1 from public.accounts where code = '52001')
union all select 'table public.depreciation_schedules', (to_regclass('public.depreciation_schedules') is not null)
order by present, item;

-- ============================================================================
-- BEGIN 009_depreciation_accounts.sql
-- SHA-256 (body): ${h009}
-- ============================================================================

${b009}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select code, name_en, type
  from public.accounts
 where code in ('14001', '52001')
 order by code;
-- expect exactly two rows: 14001 as 'asset' (contra-asset), 52001 as 'expense'

select 'both depreciation accounts present' as item,
       (select count(*) from public.accounts where code in ('14001','52001')) = 2 as ok;

select 'depreciation reference index' as item,
       exists (select 1 from pg_indexes
                where schemaname = 'public'
                  and indexname = 'journal_entries_depreciation_ref_idx') as ok;

-- ============================================================================
-- END OF PACKAGE (009)
-- ============================================================================
`;

fs.writeFileSync(OUT_009, header009, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_009)}`);
console.log(`  009 sha256 ${h009}`);

const header008 = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (008)
-- ============================================================================
-- Purpose : close the remaining privilege-escalation paths on public.users.
--           008 replaces prevent_role_escalation() so that:
--             * a staff/client row can no longer promote itself to admin;
--             * a user can no longer move itself (or another user) to a
--               different tenant;
--             * the trusted service path is decided by the signed JWT role
--               claim, never by a null auth.uid() alone.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : run PRODUCTION_ACTIVATION_001_002_003.sql, then
--           PRODUCTION_ACTIVATION_004.sql, then
--           PRODUCTION_ACTIVATION_005_006.sql, then
--           PRODUCTION_ACTIVATION_007.sql, then THIS file, then
--           PRODUCTION_ACTIVATION_009.sql.
--           Dependencies:
--             * 008 needs is_admin()/is_super_admin()/current_tenant_id()
--               (defined in 004) and the users_prevent_role_escalation trigger
--               (created by 004). Apply 004 first.
--
-- SAFETY  : additive and idempotent. No table, column or row is touched; no
--           data is modified. It replaces two function bodies and re-creates
--           one trigger (\`drop trigger if exists\` + \`create trigger\`). Safe to
--           re-run.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           chlkmdobhvfnldqkgdji (SPEED ERP production) before executing.
--
-- The migration body below is reproduced verbatim from
-- supabase/migrations/008_user_role_hardening.sql (SHA-256 recorded at its
-- header), so what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT (read-only — visibility only; never aborts the script)
-- ============================================================================
select current_database() as database, current_user as executor_role, now() as at_utc;

-- 008 depends on the 004 helpers and the trigger 004 created.
select 'helper is_super_admin()'    as item, exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='is_super_admin') as present
union all select 'helper is_admin()', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='is_admin')
union all select 'helper current_tenant_id()', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='current_tenant_id')
union all select 'trigger users_prevent_role_escalation', exists (select 1 from pg_trigger where tgname='users_prevent_role_escalation')
union all select '008 already applied (is_trusted_service_context)', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='is_trusted_service_context')
order by present, item;

-- ============================================================================
-- BEGIN 008_user_role_hardening.sql
-- SHA-256 (body): ${h008}
-- ============================================================================

${b008}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'is_trusted_service_context() exists' as item,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='is_trusted_service_context') as ok
union all select 'prevent_role_escalation() exists',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='prevent_role_escalation')
union all select 'trigger is BEFORE INSERT OR UPDATE',
       exists (select 1 from pg_trigger
                where tgname='users_prevent_role_escalation'
                  and (tgtype & 4) = 4)
union all select 'anon cannot execute the guard',
       not has_function_privilege('anon', 'public.prevent_role_escalation()', 'execute')
union all select 'anon cannot execute the predicate',
       not has_function_privilege('anon', 'public.is_trusted_service_context()', 'execute')
order by item;

-- The guard must be SECURITY DEFINER with a pinned search_path, or a caller
-- could shadow public.auth/current_tenant_id with its own objects.
select p.proname, p.prosecdef as security_definer, p.proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('is_trusted_service_context', 'prevent_role_escalation')
 order by p.proname;

-- ============================================================================
-- END OF PACKAGE (008)
-- ============================================================================
`;

fs.writeFileSync(OUT_008, header008, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_008)}`);
console.log(`  008 sha256 ${h008}`);

const header010 = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (010)
-- ============================================================================
-- Purpose : seed the input-VAT account (24001) and the "other expenses" account
--           (51099) that the purchasing flows post to, plus the debit_note
--           document-number sequence.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : run PRODUCTION_ACTIVATION_001_002_003.sql, then
--           PRODUCTION_ACTIVATION_004.sql, then
--           PRODUCTION_ACTIVATION_005_006.sql, then
--           PRODUCTION_ACTIVATION_007.sql, then
--           PRODUCTION_ACTIVATION_008.sql, then
--           PRODUCTION_ACTIVATION_009.sql, and ONLY THEN this file.
--           Dependencies:
--             * 010 needs public.accounts (always present);
--             * the sequence insert is only attempted when
--               document_sequences exists, so it is a clean no-op otherwise.
--
-- SAFETY  : additive and idempotent. No DROP TABLE, no DROP COLUMN, no
--           TRUNCATE, no DELETE, no row rewrite. It inserts at most three rows,
--           each guarded by \`where not exists\`. Safe to re-run.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           chlkmdobhvfnldqkgdji (SPEED ERP production) before executing.
--
-- The migration body below is reproduced verbatim from
-- supabase/migrations/010_purchasing_accounts.sql (SHA-256 recorded at its
-- header), so what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT (read-only — visibility only; never aborts the script)
-- ============================================================================
select current_database() as database, current_user as executor_role, now() as at_utc;

select 'table public.accounts' as item, (to_regclass('public.accounts') is not null) as present
union all select 'account 24001 already present', exists (select 1 from public.accounts where code = '24001')
union all select 'account 51099 already present', exists (select 1 from public.accounts where code = '51099')
union all select 'table public.document_sequences', (to_regclass('public.document_sequences') is not null)
union all select 'sequence debit_note already present', exists (select 1 from public.document_sequences where doc_type = 'debit_note')
order by present, item;

-- ============================================================================
-- BEGIN 010_purchasing_accounts.sql
-- SHA-256 (body): ${h010}
-- ============================================================================

${b010}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select code, name_en, type
  from public.accounts
 where code in ('24001', '51099')
 order by code;
-- expect exactly two rows: 24001 'liability' (Input VAT), 51099 'expense'

select 'both purchasing accounts present' as item,
       (select count(*) from public.accounts where code in ('24001','51099')) = 2 as ok;

select 'purchasing document sequences' as item,
       (select count(*) from public.document_sequences
         where doc_type in ('debit_note','supplier_payment','purchase_invoice','journal_entry')) = 4 as ok;

-- ============================================================================
-- END OF PACKAGE (010)
-- ============================================================================
`;

fs.writeFileSync(OUT_010, header010, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_010)}`);
console.log(`  010 sha256 ${h010}`);

// ---------------------------------------------------------------------------
// 011 — atomic journal posting (post_journal_entry). Appended after 010 so the
// existing outputs stay byte-identical.
// ---------------------------------------------------------------------------
const b011 = read("011_atomic_journal_posting.sql");
const h011 = sha(b011);
const OUT_011 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_011.sql");

const header011 = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (011)
-- ============================================================================
-- Purpose : install the atomic journal-posting function \`post_journal_entry\`,
--           so a journal header and its lines are written in ONE transaction.
--           Before this, they were two separate PostgREST calls and a crash
--           between them left a header with no lines - invisible to every report
--           but counted in journal_entries.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : after PRODUCTION_ACTIVATION_001_002_003.sql, then _004, _005_006,
--           _007, _008, _009 and _010. 011 only needs public.journal_entries and
--           public.journal_lines (created/updated by 003); it is a clean no-op
--           if they are absent.
--
-- SAFETY  : additive and idempotent (\`create or replace function\`). No DROP
--           TABLE, no DROP COLUMN, no TRUNCATE, no DELETE, no row rewrite.
--           Safe to re-run.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           chlkmdobhvfnldqkgdji (SPEED ERP production) before executing.
--
-- The migration body below is reproduced verbatim from
-- supabase/migrations/011_atomic_journal_posting.sql (SHA-256 recorded at its
-- header), so what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT (read-only — visibility only; never aborts the script)
-- ============================================================================
select current_database() as database, current_user as executor_role, now() as at_utc;

select 'table public.journal_entries' as item, (to_regclass('public.journal_entries') is not null) as present
union all select 'table public.journal_lines', (to_regclass('public.journal_lines') is not null)
union all select 'function post_journal_entry already present',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'post_journal_entry')
order by present, item;

-- ============================================================================
-- BEGIN 011_atomic_journal_posting.sql
-- SHA-256 (body): ${h011}
-- ============================================================================

${b011}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'function post_journal_entry present' as item,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'post_journal_entry') as ok;

select 'no orphan journal header exists' as item,
       not exists (select 1 from public.journal_entries e
                    where not exists (select 1 from public.journal_lines l
                                       where l.journal_entry_id = e.id)) as ok;

-- ============================================================================
-- END OF PACKAGE (011)
-- ============================================================================
`;

fs.writeFileSync(OUT_011, header011, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_011)}`);
console.log(`  011 sha256 ${h011}`);
