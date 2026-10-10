-- ============================================================================
-- 004_global_super_admin.sql
-- Adds the explicit, global operator role (`super_admin`) to the authorization
-- model.
--
-- WHY
-- ---
-- A genuine global administrator must be an explicit, auditable principal — not
-- an email address that the browser happens to send. Until now the only
-- administrator role was `admin`, which is company-scoped: `is_admin()` is used
-- to allow cross-tenant reads/writes for administrators, which is correct for a
-- company owner but wrong for a platform operator. This migration separates the
-- two:
--
--   * `admin`       — company administrator. Sees/writes only its own tenant.
--   * `super_admin` — global operator. Explicitly allowed across tenants.
--
-- The application already resolves the role server-side from `public.users`
-- (never from request input) and exposes `isSuperAdmin` on the AuthContext. This
-- migration makes the database agree with that model.
--
-- DESIGN
-- ------
--  * No new tables, no data reset, no column drops. Additive and idempotent.
--  * The isolation predicates are *extended*, not rewritten: every existing RLS
--    policy that calls `can_read_tenant` / `can_write_tenant` (or the company
--    equivalents) inherits the super-admin behaviour automatically, so there is
--    exactly one isolation model.
--  * `is_super_admin()` is SECURITY DEFINER, like `current_tenant_id()` /
--    `is_admin()`, so the lookup of the caller's own role is not itself filtered
--    by RLS.
--  * A super administrator is intentionally NOT placed in a tenant (tenant_id is
--    null); it must never be scoped to the SPEED company as a shortcut.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Allow the role value. Remove any pre-existing check constraint on
--    `users.role` that would reject `super_admin`, then install a canonical one.
-- ----------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'users'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%role%'
  loop
    execute format('alter table public.users drop constraint %I', c.conname);
  end loop;

  if not exists (
    select 1
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'users'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%super_admin%'
  ) then
    execute $ddl$
      alter table public.users
        add constraint users_role_check
        check (role in ('super_admin', 'admin', 'staff', 'client'))
    $ddl$;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Role predicates. `is_admin()` becomes true for both administrator roles so
--    that the administrative policies (users/tenants/settings) treat the global
--    operator as an administrator. `is_super_admin()` is the global-only check.
-- ----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('admin', 'super_admin') from public.users where id = auth.uid()),
    false
  );
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role = 'super_admin' from public.users where id = auth.uid()),
    false
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. Extend the tenant/company isolation predicates so the global operator may
--    act across every tenant. `admin`/`staff`/`client` are unchanged.
-- ----------------------------------------------------------------------------
create or replace function public.can_read_tenant(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin()
      or candidate is not distinct from public.current_tenant_id();
$$;

create or replace function public.can_write_tenant(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.is_super_admin() then true
    when public.current_tenant_id() is null then candidate is null
    else candidate = public.current_tenant_id()
  end;
$$;

create or replace function public.can_read_company(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin()
      or candidate is not distinct from public.current_tenant_id();
$$;

create or replace function public.can_write_company(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.is_super_admin() then true
    when public.current_tenant_id() is null then candidate is null
    else candidate = public.current_tenant_id()
  end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Grants. `create or replace function` preserves existing grants, but they are
--    re-asserted so a fresh install and an upgraded install converge.
-- ----------------------------------------------------------------------------
revoke all on function public.is_admin() from public;
revoke all on function public.is_super_admin() from public;
revoke all on function public.can_read_tenant(uuid) from public;
revoke all on function public.can_write_tenant(uuid) from public;
revoke all on function public.can_read_company(uuid) from public;
revoke all on function public.can_write_company(uuid) from public;

revoke all on function public.is_admin() from anon;
revoke all on function public.is_super_admin() from anon;
revoke all on function public.can_read_tenant(uuid) from anon;
revoke all on function public.can_write_tenant(uuid) from anon;
revoke all on function public.can_read_company(uuid) from anon;
revoke all on function public.can_write_company(uuid) from anon;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_super_admin() to authenticated;
grant execute on function public.can_read_tenant(uuid) to authenticated;
grant execute on function public.can_write_tenant(uuid) to authenticated;
grant execute on function public.can_read_company(uuid) to authenticated;
grant execute on function public.can_write_company(uuid) to authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual): re-run the predicate definitions from migration 002 and
-- drop the constraint added above. This migration adds no data, so no data
-- rollback is required.
-- ============================================================================
