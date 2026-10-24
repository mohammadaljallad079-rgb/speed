-- ============================================================================
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
--           (guarded by `where not exists` on the code) and adds one nullable
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
-- SHA-256 (body): c3b81087bd74e63c79a6e035c4c1618e5b663dc695d5dd8982c02bf5dc7e97a5
-- ============================================================================

-- ============================================================================
-- 009_depreciation_accounts.sql
-- Seeds the two fixed depreciation accounts and makes the schedule table usable.
--
-- WHY
-- ---
-- `src/lib/accounting/depreciation-posting.ts` posts
--
--     Dr Depreciation expense (52001) / Cr Accumulated depreciation (14001)
--
-- but neither account exists in the shared chart, so every posting would fail
-- with "Cannot post depreciation without the accumulated-depreciation (14001)
-- and depreciation-expense (52001) accounts in the chart." The depreciation
-- screen also reads `depreciation_schedules.tenant_id`, which the legacy table
-- created by `/api/migrate` does not have.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
--   1. Inserts 14001 (contra-asset, credit nature) and 52001 (expense) into the
--      shared chart, in the same shape as their siblings: `tenant_id` null,
--      level 1, active. Guarded by `where not exists` on the code, so re-running
--      never duplicates them and an installation that manages its own chart is
--      left alone.
--   2. Adds `depreciation_schedules.tenant_id` when the table exists and the
--      column does not, so the schedule is tenant-scoped like every other
--      business row. NULL for existing rows keeps the current single-tenant
--      install working (`can_read_tenant` is NULL-tolerant).
--
-- ADDITIVE and IDEMPOTENT. No existing row is modified or deleted.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Depreciation accounts.
--    14001 is type `asset` on purpose: accumulated depreciation is a
--    CONTRA-ASSET. It carries a credit balance, so the balance sheet's
--    `cost − accumulated` is produced by the normal asset arithmetic, without a
--    separate asset account per vehicle.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'accounts') then
    insert into public.accounts (id, code, name, name_ar, name_en, type, level, is_active, tenant_id)
    select gen_random_uuid(), '14001', 'مجمع إهلاك الأصول', 'مجمع إهلاك الأصول', 'Accumulated Depreciation', 'asset', 1, true, null
    where not exists (select 1 from public.accounts a where a.code = '14001');

    insert into public.accounts (id, code, name, name_ar, name_en, type, level, is_active, tenant_id)
    select gen_random_uuid(), '52001', 'مصروف الإهلاك', 'مصروف الإهلاك', 'Depreciation Expense', 'expense', 1, true, null
    where not exists (select 1 from public.accounts a where a.code = '52001');
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Tenant column on the schedule table.
--    Guarded on both the table and the column so the migration is a clean no-op
--    on an installation that has not created the table yet, and so re-running
--    does not error on "column already exists".
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'depreciation_schedules')
     and not exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'depreciation_schedules'
               and column_name = 'tenant_id') then
    execute 'alter table public.depreciation_schedules add column tenant_id uuid';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Index the posting route's lookup: posted depreciation journals for an asset
--    are found by (entry_type, reference_number). Only created when the columns
--    exist, so the migration stays a no-op on a schema without them.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'entry_type')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'reference_number') then
    execute $idx$
      create index if not exists journal_entries_depreciation_ref_idx
      on public.journal_entries (entry_type, reference_number)
      where entry_type = 'depreciation'
    $idx$;
  end if;
end $$;

commit;

-- ============================================================================
-- VERIFICATION (read-only; run after applying)
--
--   select code, name_en, type from public.accounts
--    where code in ('14001', '52001') order by code;
--   -- expect both rows, 14001 as 'asset', 52001 as 'expense'
--
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'depreciation_schedules'
--      and column_name = 'tenant_id';
--   -- expect one row when the schedule table exists
--
--   select indexname from pg_indexes
--    where schemaname = 'public'
--      and indexname = 'journal_entries_depreciation_ref_idx';
--   -- expect one row
-- ============================================================================

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
