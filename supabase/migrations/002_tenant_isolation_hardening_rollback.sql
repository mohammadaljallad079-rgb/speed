-- ============================================================================
-- 002_tenant_isolation_hardening_rollback.sql
--
-- Emergency rollback for 002_tenant_isolation_hardening.sql.
--
-- USE ONLY IF the lockdown breaks a legitimate, currently-working flow that
-- cannot be fixed forward quickly. Rolling back re-exposes every tenant's data
-- to the public browser key, so treat it as an incident, not a routine step.
--
-- NON-DESTRUCTIVE: this does NOT drop any column and does NOT delete any row.
-- It only removes the policies and restores the previous (permissive) grants.
-- The `tenant_id` columns added by 002 are left in place, because dropping them
-- would destroy whatever backfill an operator has already performed.
-- ============================================================================

-- 1. Drop every policy this migration created (tenant_* / company_* / *_read /
--    *_no_update / *_no_delete / *_parent_* / users_* / tenants_*).
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and (
        policyname like '%\_tenant\_%'
        or policyname like '%\_company\_%'
        or policyname like '%\_parent\_%'
        or policyname in (
          'users_self_select','users_self_update','users_admin_insert',
          'tenants_read','roles_read','permissions_read','user_roles_read',
          'activity_logs_no_update','activity_logs_no_delete'
        )
      )
  loop
    execute format('drop policy if exists %I on public.%I',
                   r.policyname, r.tablename);
  end loop;
end $$;

-- 2. Restore the permissive default grants the browser key had before.
--    (This is what makes the rollback an incident: anon regains full access.)
do $$
declare
  t text;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('grant all on public.%I to anon', t);
    execute format('grant all on public.%I to authenticated', t);
  end loop;
end $$;

-- 3. Turn RLS back off. Policies are gone, so this only removes the guard rail.
do $$
declare
  t text;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I disable row level security', t);
  end loop;
end $$;

-- 4. Re-grant the helper functions to anon so the pre-002 state is exact.
grant execute on function public.current_tenant_id() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_authenticated() to anon, authenticated;
