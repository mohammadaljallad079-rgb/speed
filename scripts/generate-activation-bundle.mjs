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

// ---------------------------------------------------------------------------
// 012 — notifications store. Appended after 011 so the existing outputs stay
// byte-identical.
// ---------------------------------------------------------------------------
const b012 = read("012_notifications.sql");
const h012 = sha(b012);
const OUT_012 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_012.sql");

const header012 = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (012)
-- ============================================================================
-- Purpose : create the operational notification store \`public.notifications\`
--           and its tenant-scoped RLS policies, so bookings, contract expiries
--           and vehicle-document expiries produce a durable, deduped record the
--           user can see (the bell in the app header).
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : after 001 -> 011 (PRODUCTION_ACTIVATION_001_002_003.sql, _004,
--           _005_006, _007, _008, _009, _010, _011). 012 only needs \`tenants\` and the 002 predicates
--           \`can_read_tenant\`/\`can_write_tenant\`; it is a clean no-op if either
--           is absent.
--
-- SAFETY  : additive and idempotent (\`create table if not exists\`,
--           \`create index if not exists\`, \`drop policy if exists\` then create).
--           No DROP TABLE, no DROP COLUMN, no TRUNCATE, no DELETE, no row
--           rewrite of any existing table. Safe to re-run.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           chlkmdobhvfnldqkgdji (SPEED ERP production) before executing.
--
-- The migration body below is reproduced verbatim from
-- supabase/migrations/012_notifications.sql (SHA-256 recorded at its header),
-- so what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT (read-only — visibility only; never aborts the script)
-- ============================================================================
select current_database() as database, current_user as executor_role, now() as at_utc;

select 'table public.tenants' as item, (to_regclass('public.tenants') is not null) as present
union all select 'function can_read_tenant', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'can_read_tenant')
union all select 'table public.notifications already present', (to_regclass('public.notifications') is not null)
order by present, item;

-- ============================================================================
-- BEGIN 012_notifications.sql
-- SHA-256 (body): ${h012}
-- ============================================================================

${b012}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'table public.notifications present' as item,
       (to_regclass('public.notifications') is not null) as ok
union all select 'RLS enabled on notifications',
       coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.notifications')), false) as ok
union all select 'tenant dedupe index present',
       exists (select 1 from pg_class where relname = 'notifications_tenant_dedupe_uidx') as ok
union all select 'null-tenant dedupe index present',
       exists (select 1 from pg_class where relname = 'notifications_null_tenant_dedupe_uidx') as ok
union all select 'anon holds no privilege',
       not has_table_privilege('anon', 'public.notifications', 'select') as ok
order by ok, item;

-- ============================================================================
-- END OF PACKAGE (012)
-- ============================================================================
`;

fs.writeFileSync(OUT_012, header012, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_012)}`);
console.log(`  012 sha256 ${h012}`);

// ---------------------------------------------------------------------------
// 013 — booking invoice idempotency. Appended after 012 so the earlier outputs
// stay byte-identical.
// ---------------------------------------------------------------------------
const b013 = read("013_booking_invoice_idempotency.sql");
const h013 = sha(b013);
const OUT_013 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_013.sql");

const header013 = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (013)
-- ============================================================================
-- Purpose : make a booking's invoice creation idempotent at the database level.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : run PRODUCTION_ACTIVATION_001_002_003.sql, then 004, 005_006,
--           007, 008, 009, 010, 011, 012, and ONLY THEN this file.
-- Project : chlkmdobhvfnldqkgdji
--
-- The body below is byte-identical to
-- supabase/migrations/013_booking_invoice_idempotency.sql (SHA-256 recorded at
-- its header). Do NOT edit it here — regenerate with
--   node scripts/generate-activation-bundle.mjs
-- ============================================================================

-- ============================================================================
-- PRE-FLIGHT (read-only — inspect before applying)
-- ============================================================================
select 'bookings table present' as item,
       (to_regclass('public.bookings') is not null) as ok
union all select 'invoices table present',
       (to_regclass('public.invoices') is not null) as ok
order by ok, item;

${sep}
-- BEGIN 013_booking_invoice_idempotency.sql
-- SHA-256 (body): ${h013}
${sep}

${b013}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'one live invoice per rental contract' as item,
       exists (select 1 from pg_class where relname = 'invoices_one_live_per_rental_contract_uidx') as ok
union all select 'rental-contract lookup index present',
       exists (select 1 from pg_class where relname = 'invoices_rental_contract_id_idx') as ok
order by ok, item;

-- ============================================================================
-- END OF PACKAGE (013)
-- ============================================================================
`;

fs.writeFileSync(OUT_013, header013, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_013)}`);
console.log(`  013 sha256 ${h013}`);

// ---------------------------------------------------------------------------
// 014 — per-tenant chart of accounts. Appended after 013.
// ---------------------------------------------------------------------------
const b014 = read("014_tenant_chart_of_accounts.sql");
const h014 = sha(b014);
const OUT_014 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_014.sql");

const header014 = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (014)
-- ============================================================================
-- Purpose : give each tenant its own chart of accounts, so a code-only account
--           lookup cannot settle another company's account.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : run PRODUCTION_ACTIVATION_001_002_003.sql, then 004, 005_006,
--           007, 008, 009, 010, 011, 012, 013, and ONLY THEN this file.
-- Project : chlkmdobhvfnldqkgdji
--
-- The body below is byte-identical to
-- supabase/migrations/014_tenant_chart_of_accounts.sql (SHA-256 recorded at its
-- header). Do NOT edit it here — regenerate with
--   node scripts/generate-activation-bundle.mjs
-- ============================================================================

-- ============================================================================
-- PRE-FLIGHT (read-only — inspect before applying)
-- ============================================================================
select 'accounts table present' as item,
       (to_regclass('public.accounts') is not null) as ok
union all select 'accounts.tenant_id present',
       exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='accounts' and column_name='tenant_id') as ok
order by ok, item;

${sep}
-- BEGIN 014_tenant_chart_of_accounts.sql
-- SHA-256 (body): ${h014}
${sep}

${b014}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'accounts.tenant_id present' as item,
       exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='accounts' and column_name='tenant_id') as ok
union all select 'tenant + code uniqueness present',
       exists (select 1 from pg_class where relname = 'accounts_tenant_code_uidx') as ok
union all select 'null-tenant code uniqueness present',
       exists (select 1 from pg_class where relname = 'accounts_null_tenant_code_uidx') as ok
order by ok, item;

-- ============================================================================
-- END OF PACKAGE (014)
-- ============================================================================
`;

fs.writeFileSync(OUT_014, header014, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_014)}`);
console.log(`  014 sha256 ${h014}`);

// ---------------------------------------------------------------------------
// 015 — strict accounting integrity + the atomic customer receipt (and its
// reversal). Appended after 014.
// ---------------------------------------------------------------------------
const b015 = read("015_strict_accounting_integrity.sql");
const h015 = sha(b015);
const OUT_015 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_015.sql");

const header015 = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (015)
-- ============================================================================
-- Purpose : harden post_journal_entry (a tenanted journal may only reference
--           accounts its own company may use) and add the ATOMIC customer
--           receipt — post_customer_receipt — plus its mirror,
--           post_customer_receipt_reversal. A receipt, its ledger posting and
--           the invoice settlement are written in ONE transaction; a reversal
--           mirrors the journal, restores the invoice balance and cancels the
--           payment in ONE transaction.
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : run PRODUCTION_ACTIVATION_001_002_003.sql, then 004, 005_006,
--           007, 008, 009, 010, 011, 012, 013, 014, and ONLY THEN this file.
-- Project : chlkmdobhvfnldqkgdji
--
-- The body below is byte-identical to
-- supabase/migrations/015_strict_accounting_integrity.sql (SHA-256 recorded at
-- its header). Do NOT edit it here — regenerate with
--   node scripts/generate-activation-bundle.mjs
-- ============================================================================

-- ============================================================================
-- PRE-FLIGHT (read-only — inspect before applying)
-- ============================================================================
select 'journal_entries table present' as item,
       (to_regclass('public.journal_entries') is not null) as ok
union all select 'payments table present',
       (to_regclass('public.payments') is not null) as ok
union all select 'invoices table present',
       (to_regclass('public.invoices') is not null) as ok
order by ok, item;

${sep}
-- BEGIN 015_strict_accounting_integrity.sql
-- SHA-256 (body): ${h015}
${sep}

${b015}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'post_journal_entry present' as item,
       exists (select 1 from pg_proc where proname = 'post_journal_entry') as ok
union all select 'post_customer_receipt present',
       exists (select 1 from pg_proc where proname = 'post_customer_receipt') as ok
union all select 'post_customer_receipt_reversal present',
       exists (select 1 from pg_proc where proname = 'post_customer_receipt_reversal') as ok
union all select 'tenant receipt index present',
       exists (select 1 from pg_class where relname = 'payments_tenant_receipt_uidx') as ok
union all select 'null-tenant receipt index present',
       exists (select 1 from pg_class where relname = 'payments_null_tenant_receipt_uidx') as ok
order by ok, item;

-- ============================================================================
-- END OF PACKAGE (015)
-- ============================================================================
`;

fs.writeFileSync(OUT_015, header015, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_015)}`);
console.log(`  015 sha256 ${h015}`);

// ---------------------------------------------------------------------------
// 016 — customer row isolation. Appended after 015: it depends on 002's tenant
// policies and 004's `is_admin()`.
// ---------------------------------------------------------------------------
const b016 = read("016_customer_row_isolation.sql");
const h016 = sha(b016);
const OUT_016 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_016.sql");

const header016 = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (016)
-- ============================================================================
-- Purpose : a rental CUSTOMER may read only its own rows.
--
--           Migrations 001/002 isolate every table by TENANT. That is the
--           boundary between companies, but it is NOT a boundary inside one
--           company: a rental customer is an authenticated user of the tenant,
--           so the tenant predicate is satisfied by every row of that tenant.
--           The customer portal reads its data with the browser client (RLS is
--           the enforcement boundary there), so customer A could read customer
--           B's rental contracts, tickets, PII and every colleague's account.
--
--           It also closes a privilege escalation: a 'client' could set its own
--           users.role to 'admin' (004 only blocked the super_admin grant).
--
--           Reproduced by execution on a real PostgreSQL 17 with the
--           001/002/004 schema, before this migration:
--             set role authenticated;   -- claims sub = customer A
--             select contract_number from public.rental_contracts;
--             -> RC-1001 (A), RC-1002 (B)     <-- another customer's contract
--             update public.users set role='admin' where id = auth.uid();
--             -> UPDATE 1                     <-- self-promotion
--
-- How     : paste this whole file into the Supabase Dashboard SQL Editor.
--           (This dev environment has NO DDL-capable Postgres connection; the
--           SQL Editor runs as the postgres role, which owns the objects.)
--
-- ORDER   : run the earlier packages first:
--             PRODUCTION_ACTIVATION_001_002_003.sql -> 004 -> 005/006 -> 007
--             -> ... -> 015, then THIS one.
--           It depends on 002 (tenant policies, can_read_tenant) and 004
--           (is_admin()).
--
-- SAFE    : additive and idempotent. It rewrites no row, changes no document,
--           amount or journal, and is a clean no-op where a column is absent.
--           Every object it creates is dropped by
--           supabase/migrations/016_customer_row_isolation_rollback.sql.
--
-- Project : chlkmdobhvfnldqkgdji
--
-- The body below is byte-identical to
-- supabase/migrations/016_customer_row_isolation.sql (SHA-256 recorded at
-- its header). Do NOT edit it here — regenerate with
--   node scripts/generate-activation-bundle.mjs
-- ============================================================================

-- ============================================================================
-- PRE-FLIGHT (read-only — inspect before applying)
-- ============================================================================
-- The three customer-owned tables must exist and carry customer_id, and the
-- two identity tables must be present. A false below means the matching part
-- of 016 is skipped (it is guarded), not that the migration failed.

select 'rental_contracts.customer_id present' as item,
       exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='rental_contracts'
                 and column_name='customer_id') as ok
union all select 'support_tickets.customer_id present',
       exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='support_tickets'
                 and column_name='customer_id')
union all select 'documents.customer_id present',
       exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='documents'
                 and column_name='customer_id')
union all select 'users.customer_id present',
       exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='users'
                 and column_name='customer_id')
union all select 'customers table present',
       (to_regclass('public.customers') is not null)
union all select 'users table present',
       (to_regclass('public.users') is not null)
order by ok, item;

${sep}
-- BEGIN 016_customer_row_isolation.sql
-- SHA-256 (body): ${h016}
${sep}

${b016}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only — proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'current_customer_id() present' as item,
       exists (select 1 from pg_proc where proname = 'current_customer_id') as ok
union all select 'is_erp_user() present',
       exists (select 1 from pg_proc where proname = 'is_erp_user')
union all select 'prevent_self_privilege_escalation() present',
       exists (select 1 from pg_proc where proname = 'prevent_self_privilege_escalation')
union all select 'rental_contracts_customer_own policy present',
       exists (select 1 from pg_policies
               where schemaname='public' and tablename='rental_contracts'
                 and policyname='rental_contracts_customer_own')
union all select 'support_tickets_customer_own policy present',
       exists (select 1 from pg_policies
               where schemaname='public' and tablename='support_tickets'
                 and policyname='support_tickets_customer_own')
union all select 'documents_customer_own policy present',
       exists (select 1 from pg_policies
               where schemaname='public' and tablename='documents'
                 and policyname='documents_customer_own')
union all select 'customers_customer_own policy present',
       exists (select 1 from pg_policies
               where schemaname='public' and tablename='customers'
                 and policyname='customers_customer_own')
union all select 'users_client_self_only policy present',
       exists (select 1 from pg_policies
               where schemaname='public' and tablename='users'
                 and policyname='users_client_self_only')
union all select 'the customer policies are RESTRICTIVE',
       (select count(*) from pg_policies
        where schemaname='public'
          and policyname in ('rental_contracts_customer_own',
                             'support_tickets_customer_own',
                             'documents_customer_own',
                             'customers_customer_own',
                             'users_client_self_only')
          and permissive = 'RESTRICTIVE') = 5
union all select 'the escalation trigger is installed',
       exists (select 1 from pg_trigger
               where tgname='users_prevent_self_privilege_escalation')
order by ok, item;

-- ============================================================================
-- END OF PACKAGE (016)
-- ============================================================================
`;

fs.writeFileSync(OUT_016, header016, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_016)}`);
console.log(`  016 sha256 ${h016}`);

// ---------------------------------------------------------------------------
// 017 — booking overlap guard. Appended after 016: it is independent of the
// policy work, but it is applied LAST because it refuses new overlapping rental
// contracts, and an operator should have the reconciliation query from 013
// available first.
// ---------------------------------------------------------------------------
const b017 = read("017_booking_overlap_guard.sql");
const h017 = sha(b017);
const OUT_017 = path.join(ROOT, "supabase", "PRODUCTION_ACTIVATION_017.sql");

const header017 = `-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (017)
-- Booking overlap guard: a car cannot be double-booked.
--
-- Apply AFTER 016, as the last step of
--   supabase/PRODUCTION_ACTIVATION_001_002_003.sql -> 004 -> 005_006 -> 007
--   -> 008 -> ... -> 016 -> 017
-- on project chlkmdobhvfnldqkgdji.
--
-- This file embeds migration 017 VERBATIM between a read-only PRE-FLIGHT and a
-- read-only POST-FLIGHT. Do not edit the embedded body; edit
-- supabase/migrations/017_booking_overlap_guard.sql and regenerate this file:
--
--     node scripts/generate-activation-bundle.mjs
--
-- The body is byte-identical to the migration (verified by
-- tests/activation-package-integrity.test.ts, which recomputes this hash).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PRE-FLIGHT (read-only). Run this first and read the output.
-- ----------------------------------------------------------------------------
select 'PRE: rental_contracts has car_id/start_date/end_date' as item,
       (select count(*) from information_schema.columns
        where table_schema='public' and table_name='rental_contracts'
          and column_name in ('car_id','start_date','end_date')) = 3 as ok
union all select 'PRE: btree_gist available (optional - the trigger covers it)',
       exists (select 1 from pg_available_extensions where name='btree_gist')
union all select 'PRE: no overlapping blocking contracts yet',
       not exists (
         select 1 from public.rental_contracts a
         join public.rental_contracts b
           on a.car_id = b.car_id and a.id < b.id
          and coalesce(a.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(b.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
         where lower(coalesce(a.status,'')) in ('pending','active','confirmed','reserved','approved','ongoing','rented')
           and lower(coalesce(b.status,'')) in ('pending','active','confirmed','reserved','approved','ongoing','rented')
           and daterange(a.start_date, a.end_date, '[)') && daterange(b.start_date, b.end_date, '[)')
       )
order by ok, item;

${sep}
-- BEGIN 017_booking_overlap_guard.sql
-- SHA-256 (body): ${h017}
${sep}

${b017}
-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only - proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'the status helper exists' as item,
       exists (select 1 from pg_proc where proname = 'booking_blocks_car') as ok
union all select 'the double-booking trigger is installed',
       exists (select 1 from pg_trigger where tgname = 'rental_contracts_no_double_booking') as ok
union all select 'the exclusion constraint exists OR btree_gist was unavailable',
       exists (select 1 from pg_constraint where conname = 'rental_contracts_no_car_overlap')
       or not exists (select 1 from pg_extension where extname = 'btree_gist') as ok
union all select 'the guard functions are not callable by a client',
       (select count(*) from information_schema.routine_privileges
        where routine_name in ('booking_blocks_car', 'prevent_car_double_booking')
          and grantee in ('anon', 'authenticated', 'PUBLIC')) = 0 as ok
order by ok, item;

-- ============================================================================
-- END OF PACKAGE (017)
-- ============================================================================
`;

fs.writeFileSync(OUT_017, header017, "utf8");
console.log(`wrote ${path.relative(ROOT, OUT_017)}`);
console.log(`  017 sha256 ${h017}`);
