-- Minimal but faithful mirror of the live SPEED schema for verifying migration
-- 004 with real PostgreSQL. It reproduces only what 004 depends on: the roles it
-- targets, the GUC-driven `auth.uid()`, a JWT-claims helper (matching Supabase's
-- auth implementation used by `auth.uid()`), and the tables 004 touches.
-- It is NOT a copy of production data.

drop schema if exists auth cascade;
create schema auth;

do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
-- Supabase's service_role bypasses RLS; re-assert on an already-existing role.
alter role service_role bypassrls;

-- Supabase derives auth.uid() from the request JWT claims stored in the
-- transaction-local GUC `request.jwt.claims`.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

-- ----------------------------------------------------------------------------
-- Application tables 004 references.
-- ----------------------------------------------------------------------------
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text
);

create table if not exists public.users (
  id uuid primary key,
  email text,
  role text default 'staff',
  tenant_id uuid,
  is_active boolean default true,
  created_at timestamptz default now()
);

create or replace function public.is_authenticated()
returns boolean
language sql
stable
as $$ select auth.uid() is not null; $$;

-- ----------------------------------------------------------------------------
-- Migration 002 semantics (the parts 004 builds on): session helpers, the
-- isolation predicates, and the `users` policies. Copied to match 002 so that
-- 004 is verified against the same starting point it will meet in production.
-- ----------------------------------------------------------------------------
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select tenant_id from public.users where id = auth.uid(); $$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select coalesce((select role = 'admin' from public.users where id = auth.uid()), false); $$;

create or replace function public.can_read_tenant(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select candidate is not distinct from public.current_tenant_id(); $$;

create or replace function public.can_write_tenant(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
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
as $$ select candidate is not distinct from public.current_tenant_id(); $$;

create or replace function public.can_write_company(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.current_tenant_id() is null then candidate is null
    else candidate = public.current_tenant_id()
  end;
$$;

alter table public.users enable row level security;
alter table public.tenants enable row level security;

drop policy if exists users_self_select on public.users;
create policy users_self_select on public.users
  for select to authenticated
  using (
    id = auth.uid()
    or public.is_admin()
    or (tenant_id is not null and tenant_id is not distinct from public.current_tenant_id())
  );

drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (
    (id = auth.uid() or public.is_admin())
    and tenant_id is not distinct from public.current_tenant_id()
  );

drop policy if exists users_admin_insert on public.users;
create policy users_admin_insert on public.users
  for insert to authenticated
  with check (public.is_admin() or id = auth.uid());

drop policy if exists tenants_read on public.tenants;
create policy tenants_read on public.tenants
  for select to authenticated
  using (id is not distinct from public.current_tenant_id() or public.is_admin());

-- Authenticated requests must be able to call auth.uid(), as in Supabase.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
