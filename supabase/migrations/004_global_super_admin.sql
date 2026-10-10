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
-- 4. Privilege-escalation guard.
--
--    `users_self_update` (migration 002) lets an authenticated administrator
--    update any row in their own tenant with no column restriction, so a company
--    `admin` could set their own `role` to `super_admin` and gain global access.
--    RLS cannot express this rule: a `with check` sees only the NEW row, never the
--    OLD one, so it cannot tell "granted super_admin" from "already was".
--    A BEFORE trigger can, and it fires for the service role too, which is why
--    the direct/service path (`auth.uid()` is null) is explicitly allowed.
-- ----------------------------------------------------------------------------
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.role is not distinct from old.role then
    return new;
  end if;

  -- No JWT context means a direct/service-role connection: provisioning is an
  -- operator action and must be allowed through.
  if auth.uid() is null then
    return new;
  end if;

  -- Granting or revoking the global role (insert or update) is super-admin only.
  if new.role = 'super_admin'
     or (tg_op = 'UPDATE' and old.role = 'super_admin') then
    if not public.is_super_admin() then
      raise exception 'Only a super administrator may grant or revoke the super_admin role'
        using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists users_prevent_role_escalation on public.users;
create trigger users_prevent_role_escalation
  before insert or update on public.users
  for each row execute function public.prevent_role_escalation();

-- ----------------------------------------------------------------------------
-- 5. RLS hardening for identity tables (004 closes holes 002 left open).
--
--    The executable harness (supabase/tests/004_harness) proved that 002's
--    policies for `tenants` and `users` were too broad for an *authenticated*
--    caller:
--      * `tenants_read` used `or public.is_admin()`, so a company admin could
--        read EVERY tenant row.
--      * `users_self_update` used `or public.is_admin()` in its WITH CHECK, so a
--        company admin could move a user row INTO ANOTHER tenant, and combine
--        with INSERT to create a row in a victim tenant.
--    These are the only two tables whose policies need to change; every other
--    policy already uses the (now super-admin-aware) isolation predicates.
--
--    Privileged administration (listing/creating tenant users) runs through the
--    service-role API (`src/app/api/users/route.ts`), which bypasses RLS, so
--    tightening these policies does not remove any legitimate capability.
-- ----------------------------------------------------------------------------

-- tenants: a company admin sees only its own tenant; the global operator sees all.
drop policy if exists tenants_read on public.tenants;
create policy tenants_read on public.tenants
  for select to authenticated
  using (
    public.is_super_admin()
    or id is not distinct from public.current_tenant_id()
  );

-- users: a member reads their own row; an admin reads within its own tenant; the
-- global operator reads everything.
drop policy if exists users_self_select on public.users;
create policy users_self_select on public.users
  for select to authenticated
  using (
    id = auth.uid()
    or public.is_super_admin()
    or (tenant_id is not null and tenant_id is not distinct from public.current_tenant_id())
  );

-- users UPDATE: an admin may edit users in its OWN tenant and may never move a
-- row into another tenant. The super admin may edit anywhere.
drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (
    (id = auth.uid() or public.is_admin())
    and (
      public.is_super_admin()
      or tenant_id is not distinct from public.current_tenant_id()
    )
  );

-- users INSERT: new rows must land in the caller's own tenant (or be the caller's
-- own row). Prevents "insert into tenant B" — confirmed exploitable on 002.
drop policy if exists users_admin_insert on public.users;
create policy users_admin_insert on public.users
  for insert to authenticated
  with check (
    id = auth.uid()
    or public.is_super_admin()
    or (
      public.is_admin()
      and tenant_id is not distinct from public.current_tenant_id()
    )
  );

-- ----------------------------------------------------------------------------
-- 6. Grants. `create or replace function` preserves existing grants, but they are
--    re-asserted so a fresh install and an upgraded install converge.
-- ----------------------------------------------------------------------------
revoke all on function public.is_admin() from public;
revoke all on function public.is_super_admin() from public;
revoke all on function public.prevent_role_escalation() from public;
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
