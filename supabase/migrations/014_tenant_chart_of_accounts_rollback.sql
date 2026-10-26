-- ============================================================================
-- 014_tenant_chart_of_accounts_rollback.sql
--
-- Undoes migration 014:
--   * drops the two per-tenant account-code uniqueness indexes,
--   * drops the tenant-scoped chart-provisioning function, if 014 created one.
--
-- NOT LOSSLESS in one respect: a per-tenant account row that 014 provisioned
-- keeps existing. Dropping the indexes does not merge it back into the shared
-- chart, so a code may then appear more than once (once per company). That is
-- stated here so the rollback is a deliberate decision, not a surprise.
--
-- It never deletes an account: journal lines reference accounts, and removing
-- one would make the entries vanish from every report.
-- ============================================================================

begin;

drop index if exists public.accounts_tenant_code_uidx;
drop index if exists public.accounts_null_tenant_code_uidx;

drop function if exists public.provision_tenant_chart(uuid);

commit;
