-- ============================================================================
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

-- ==========================================================================
-- BEGIN 016_customer_row_isolation.sql
-- SHA-256 (body): efa1a9db86529a15f0e3e77ccbedca440754a3f366b049c7dddc2091b53af1b0
-- ==========================================================================

-- ============================================================================
-- 016_customer_row_isolation.sql
-- A rental CUSTOMER may only read the rows that belong to that customer.
--
-- WHY
-- ---
-- 002 isolated every table by TENANT (`can_read_tenant(tenant_id)`). That is the
-- right boundary between companies, but it is NOT a boundary inside one company:
-- a car-rental customer is an `authenticated` user of the tenant, so the tenant
-- predicate is satisfied by every row of that tenant. The customer portal reads
-- its data with the browser client (RLS is the enforcement boundary there), so
-- customer A could read customer B's rental contracts - contract numbers, dates,
-- locations, amounts - and B's support tickets. This was reproduced by execution
-- against a real PostgreSQL 17 with the 001/002/004 schema:
--
--     set role authenticated;  -- claims sub = customer A's auth user id
--     select contract_number from public.rental_contracts;
--     -> RC-1001 / customer A
--        RC-1002 / customer B        <-- another customer's contract
--
-- The customer portal also reads `cars` (its own availability list). A car is a
-- company ASSET with no single owner, so it must stay readable by every customer
-- of the company; that is handled by a separate, car-specific policy below.
--
-- WHAT THIS DOES
-- --------------
--   1. `current_customer_id()` - SECURITY DEFINER, the caller's own
--      `users.customer_id`, the same source `resolveAuthContext` uses.
--   2. `is_erp_user()` - SECURITY DEFINER, true for `admin`/`staff`/`super_admin`.
--      A staff member must keep seeing every contract in the tenant; only a
--      `client` is confined to its own rows.
--   3. Adds a RESTRICTIVE policy to the customer-owned tables
--      (`rental_contracts`, `support_tickets`, `documents`):
--          is_erp_user() OR customer_id = current_customer_id()
--      A RESTRICTIVE policy is ANDed with the permissive tenant policy, so it can
--      only ever NARROW access. A row whose `customer_id` is NULL (an
--      office-created document not yet linked to a portal account) is visible to
--      the office and to NO customer: until a row is linked it has no owner, and
--      showing it to every customer of the company is exactly the leak this
--      migration closes.
--   4. Replaces the `cars` policy with one that lets an ERP user see the whole
--      tenant while a customer sees only its own tenant's cars - never another
--      company's. This is a permissive policy rewrite because the shared-chart
--      style "readable by everyone" default would leak across tenants.
--   5. Two more tables the portal reads with the browser client leak the same
--      way and get the same treatment:
--        * `customers` - the tenant predicate let a customer read every other
--          customer's record (name, phone, CPR, licence, address: PII). A client
--          may read exactly its own row; the office reads the tenant.
--        * `users` - a client could read every user's email and role in the
--          company. A client may read exactly its own row.
--      Both are RESTRICTIVE, so the tenant/administrative permissive policies
--      from 002/004 still apply and this only narrows them.
--
-- It is ADDITIVE, IDEMPOTENT and rewrites no row. It does not change a document,
-- an amount or a journal. A table without the expected column is skipped, so the
-- migration is a clean no-op on a schema that predates the column.
--
-- APPLY ORDER: after 001 -> 015 (it depends on 002's tenant policies and 004's
-- `is_admin()`).
--
-- Rollback: 016_customer_row_isolation_rollback.sql
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The caller's own customer id.
--    SECURITY DEFINER so the lookup of the caller's `users` row is not itself
--    filtered by RLS (the same reason `is_admin()` is definer).
--
--    Guarded on the column existing: `users.customer_id` was added by a later
--    migration, so on a schema that predates it this function would not compile.
--    Creating it only when the column is present keeps 016 a clean no-op there
--    (and the `_customer_own` policies below are skipped for the same reason).
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'users'
               and column_name = 'customer_id') then
    execute $f$
      create or replace function public.current_customer_id()
      returns uuid
      language sql
      stable
      security definer
      set search_path = public
      as $body$
        select customer_id from public.users where id = auth.uid();
      $body$;
    $f$;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Is the caller an ERP user (office side) rather than a rental customer?
--    `client` is the only non-ERP role; anything else that reaches the ERP is
--    treated as an ERP user. A NULL/unmapped role is NOT an ERP user, so an
--    unrecognised identity gets the customer restriction rather than the wide
--    one - the fail-closed direction.
-- ----------------------------------------------------------------------------
create or replace function public.is_erp_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('admin', 'staff', 'super_admin') from public.users where id = auth.uid()),
    false
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. Customer-owned tables: a customer sees only its own rows.
--
--    RESTRICTIVE, deliberately: the permissive `_tenant_select` policy from 002
--    still decides "same company"; this ADDS "and it is mine" for a client. An
--    ERP user is exempt so the office keeps working.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array['rental_contracts', 'support_tickets', 'documents'];
begin
  -- Both helpers must exist for the predicate to compile.
  if to_regprocedure('public.current_customer_id()') is null
     or to_regprocedure('public.is_erp_user()') is null then
    return;
  end if;

  foreach t in array tables loop
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      continue;
    end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = t
                     and column_name = 'customer_id') then
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_customer_own', t);
    execute format($f$
      create policy %I on public.%I
        as restrictive
        for all to authenticated
        using (
          public.is_erp_user()
          or customer_id = public.current_customer_id()
        )
        with check (
          public.is_erp_user()
          or customer_id = public.current_customer_id()
        )
    $f$, t || '_customer_own', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 4. `cars` is a company asset: readable by the whole company, not by one
--    customer. The generic 002 tenant policy already scopes it to the tenant,
--    so this only restores the intent explicitly and keeps a customer confined
--    to its own company's vehicles. No change for an ERP user.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'cars'
               and column_name = 'tenant_id') then
    drop policy if exists cars_tenant_select on public.cars;
    create policy cars_tenant_select on public.cars
      for select to authenticated
      using (public.can_read_tenant(tenant_id));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5. `customers` and `users`: a client may read only its own row.
--
--    `customers` holds PII (name, phone, CPR, licence, address); `users` holds
--    every colleague's email and role. Both are tenant-scoped, which is the
--    company boundary but not a personal one, so a portal customer could read
--    every other customer and every staff account in the company.
--
--    The client's own `customers` row is resolved through its own `users` row
--    (`current_customer_id()`), which is the same link the portal and
--    `resolveAuthContext` use. A client reads its own `users` row by `id`.
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.current_customer_id()') is null
     or to_regprocedure('public.is_erp_user()') is null then
    return;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'customers'
               and column_name = 'tenant_id') then
    drop policy if exists customers_customer_own on public.customers;
    create policy customers_customer_own on public.customers
      as restrictive
      for all to authenticated
      using (
        public.is_erp_user()
        or id = public.current_customer_id()
      )
      with check (
        public.is_erp_user()
        or id = public.current_customer_id()
      );
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'users'
               and column_name = 'tenant_id') then
    drop policy if exists users_client_self_only on public.users;
    create policy users_client_self_only on public.users
      as restrictive
      for all to authenticated
      using (
        public.is_erp_user()
        or id = auth.uid()
      )
      with check (
        public.is_erp_user()
        or id = auth.uid()
      );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 6. A non-administrator may not change its OWN identity columns.
--
--    004's `prevent_role_escalation` blocks only the `super_admin` grant, and
--    `users_self_update` permits `id = auth.uid()` with no column restriction.
--    Together they let a rental CUSTOMER write its own row and set
--    `role = 'admin'`, which is a full privilege escalation into the company ERP.
--    Reproduced by execution (real PostgreSQL 17, 001/002/004 schema):
--
--        set role authenticated;   -- claims sub = a `client` auth user
--        update public.users set role = 'admin' where id = auth.uid();
--        -> UPDATE 1
--
--    A trigger (not a policy) is required for the same reason 004 states: a
--    `with check` sees only the NEW row, so it cannot tell "changed role" from
--    "already was admin". The comparison is done through `to_jsonb` so a column
--    that does not exist on a given install is simply absent rather than a
--    compile error.
--
--    Allowed through, deliberately:
--      * `auth.uid() is null` - the service-role connection; provisioning is an
--        operator action (`scripts/provision-admin-accounts.mjs`, signup).
--      * an administrator / the global operator - the ERP user-management path.
--    A non-admin editing its own NON-privileged fields (full name, email) is
--    still allowed; only role, tenant, customer link, permissions and active
--    state are protected.
-- ----------------------------------------------------------------------------
create or replace function public.prevent_self_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n jsonb := to_jsonb(new);
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
begin
  if auth.uid() is null then
    return new;
  end if;
  if public.is_admin() then
    return new;
  end if;

  if n->'role' is distinct from o->'role'
     and coalesce(n->>'role', 'client') <> 'client' then
    raise exception 'Only an administrator may change a role'
      using errcode = '42501';
  end if;

  if n->'tenant_id' is distinct from o->'tenant_id' then
    raise exception 'Only an administrator may change a tenant'
      using errcode = '42501';
  end if;

  if n->'customer_id' is distinct from o->'customer_id' then
    raise exception 'Only an administrator may change a customer link'
      using errcode = '42501';
  end if;

  if n->'permissions' is distinct from o->'permissions' then
    raise exception 'Only an administrator may change permissions'
      using errcode = '42501';
  end if;

  if n->'is_active' is distinct from o->'is_active' then
    raise exception 'Only an administrator may change the active state'
      using errcode = '42501';
  end if;

  return new;
end $$;

do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'users') then
    drop trigger if exists users_prevent_self_privilege_escalation on public.users;
    create trigger users_prevent_self_privilege_escalation
      before insert or update on public.users
      for each row execute function public.prevent_self_privilege_escalation();
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Grants. A predicate helper is an authorization primitive, so it is not
--    callable by `anon` (the same posture 004 takes for `is_admin()` /
--    `can_read_tenant`), and `authenticated` keeps EXECUTE so the policies can
--    evaluate their predicates.
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.current_customer_id()') is not null then
    revoke all on function public.current_customer_id() from public;
    revoke all on function public.current_customer_id() from anon;
    grant execute on function public.current_customer_id() to authenticated;
  end if;
  if to_regprocedure('public.is_erp_user()') is not null then
    revoke all on function public.is_erp_user() from public;
    revoke all on function public.is_erp_user() from anon;
    grant execute on function public.is_erp_user() to authenticated;
  end if;
  if to_regprocedure('public.prevent_self_privilege_escalation()') is not null then
    revoke all on function public.prevent_self_privilege_escalation() from public;
    revoke all on function public.prevent_self_privilege_escalation() from anon;
  end if;
end $$;

commit;

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
