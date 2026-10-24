-- ============================================================================
-- 009_depreciation_accounts_rollback.sql
--
-- Emergency rollback for 009_depreciation_accounts.sql.
--
-- NON-DESTRUCTIVE for data: it drops the lookup index and removes the
-- `tenant_id` column it added, but it does NOT delete the two seeded accounts.
-- An account that a posted depreciation journal already references must not be
-- deleted, or the ledger would be left pointing at a missing account. Remove
-- 14001/52001 by hand only after confirming no journal line references them:
--
--   select count(*) from public.journal_lines
--    where account_id in (select id from public.accounts where code in ('14001','52001'));
--   -- expect 0 before deleting
--
-- Dropping `tenant_id` re-opens the case where a schedule is not tenant-scoped;
-- the posting route scopes on the session tenant either way, so no cross-tenant
-- read is introduced.
-- ============================================================================

begin;

drop index if exists public.journal_entries_depreciation_ref_idx;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'depreciation_schedules'
               and column_name = 'tenant_id') then
    execute 'alter table public.depreciation_schedules drop column tenant_id';
  end if;
end $$;

commit;
