-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE  (001 -> 002 -> 003)
-- ============================================================================
-- Purpose : activate the production security layer on the LIVE Supabase project
--           by pasting this whole file into the Supabase Dashboard SQL Editor.
-- Why SQL Editor: this environment has NO DDL-capable Postgres connection
--           (direct host is IPv6-only; the configured pooler host rejects the
--           tenant; no CLI/token/DB password). The SQL Editor runs as the
--           `postgres` role, which owns the objects and can apply DDL.
--
-- ORDER   : 001_core_security.sql  ->  002_tenant_isolation_hardening.sql
--           ->  003_sales_lifecycle.sql        (do NOT reorder)
--
-- SAFETY  : additive and idempotent. No DROP TABLE, no DROP COLUMN, no
--           TRUNCATE, no DELETE. It does NOT touch existing customers, invoices,
--           users, accounts or any business data. Safe to re-run.
--
-- WARNING : RUN THIS ONLY AGAINST THE CORRECT PROJECT.
--           Confirm the project ref shown in the SQL Editor is
--           `chlkmdobhvfnldqkgdji` (SPEED ERP production) before executing.
--
-- The three migration bodies below are reproduced verbatim from
-- supabase/migrations/ (SHA-256 of each body is recorded at its header), so
-- what runs here is exactly what was reviewed and locally verified.
-- ============================================================================


-- ============================================================================
-- PRE-FLIGHT  (read-only — produces visibility, never aborts the script)
-- ============================================================================
-- Run this section first. It reports the CURRENT state so the operator can see
-- what is about to change. Nothing here modifies data.

select
  current_database() as database,
  current_user       as executor_role,
  now()              as at_utc;

-- Expected tables present?  (query_to_xml counts rows without erroring when a
-- table is absent, so a partial/older schema still lets this section complete.)
select
  e.t as table_name,
  (to_regclass('public.' || e.t) is not null) as present,
  case when to_regclass('public.' || e.t) is null then null
       else (xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from public.%I', e.t),
                           false, true, '')))[1]::text::bigint
  end as row_count
from (values
  ('accounts'),('customers'),('invoices'),('users'),('tenants'),('branches'),
  ('sales_returns'),('journal_entries'),('journal_lines'),('document_sequences')
) as e(t)
order by present, e.t;

-- Current schema gaps (what the migrations are expected to close).
select item, present from (
  select 'activity_logs table'          as item, (to_regclass('public.activity_logs') is not null) as present
  union all select 'sales_returns.tenant_id',      exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales_returns'     and column_name='tenant_id')
  union all select 'sales_returns.return_number',  exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales_returns'     and column_name='return_number')
  union all select 'sales_returns.vat_amount',     exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales_returns'     and column_name='vat_amount')
  union all select 'journal_entries.tenant_id',    exists (select 1 from information_schema.columns where table_schema='public' and table_name='journal_entries'  and column_name='tenant_id')
  union all select 'journal_lines.tenant_id',      exists (select 1 from information_schema.columns where table_schema='public' and table_name='journal_lines'    and column_name='tenant_id')
  union all select 'account 41003',                exists (select 1 from public.accounts a where a.code='41003')
) s
order by present, item;

-- Current RLS state (before).  `rls_enabled = false` means the table is exposed.
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity, c.relname;

-- Current anon privileges (before).  `true` here is the vulnerability.
select t as table_name,
  has_table_privilege('anon', 'public.' || t, 'SELECT') as anon_select,
  has_table_privilege('anon', 'public.' || t, 'INSERT') as anon_insert,
  has_table_privilege('anon', 'public.' || t, 'UPDATE') as anon_update,
  has_table_privilege('anon', 'public.' || t, 'DELETE') as anon_delete
from (values ('customers'),('invoices'),('users'),('accounts'),('journal_entries')) as v(t)
order by t;


-- ==========================================================================
-- BEGIN 001_core_security.sql
-- SHA-256 (body): 3892b9f067e3689bd3208fea9a9c9f84324f2cfd42a22b01a895c82cbeec259e
-- ==========================================================================

-- ============================================================================
-- 001_core_security.sql
-- Core security foundation: audit logging, tenant helper columns, and
-- row-level security for every tenant-owned table.
--
-- Apply with:  psql -f supabase/migrations/001_core_security.sql
--              (or `supabase db push`)
--
-- The browser reaches Postgres through PostgREST with the anon key; server
-- route handlers use the service-role key, which has BYPASSRLS and is therefore
-- unaffected. These policies therefore govern exactly what a browser session
-- (anonymous, or logged in as `authenticated`) may do — which today is
-- everything, on every table.
--
-- The tenant predicate is written as `tenant_id is not distinct from
-- current_tenant_id()` so that it degrades correctly for the current
-- single-tenant deployment (every tenant_id is NULL, every user's tenant_id is
-- NULL → only rows with a NULL tenant match) and becomes strict isolation as
-- soon as tenants are assigned.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Audit / activity log
-- ----------------------------------------------------------------------------
create table if not exists public.activity_logs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid,
  user_id     uuid,
  user_email  text,
  action      text not null,
  entity      text not null,
  entity_id   uuid,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists activity_logs_tenant_created_idx
  on public.activity_logs (tenant_id, created_at desc);
create index if not exists activity_logs_entity_idx
  on public.activity_logs (entity, entity_id);
create index if not exists activity_logs_user_idx
  on public.activity_logs (user_id);

-- ----------------------------------------------------------------------------
-- 2. Tenant linkage for tables that lack it but are tenant-owned
--
--    `tenant_id` is nullable on purpose: existing single-tenant rows keep a
--    NULL tenant and the policies below treat NULL as "the tenant-less
--    installation", which is the current deployment.
-- ----------------------------------------------------------------------------
alter table public.profiles                    add column if not exists tenant_id uuid;
alter table public.journal_entries             add column if not exists tenant_id uuid;
alter table public.journal_entry_lines         add column if not exists tenant_id uuid;
alter table public.journal_lines               add column if not exists tenant_id uuid;
alter table public.journal_attachments         add column if not exists tenant_id uuid;
alter table public.journal_templates           add column if not exists tenant_id uuid;
alter table public.journal_template_lines      add column if not exists tenant_id uuid;
alter table public.recurring_journals          add column if not exists tenant_id uuid;
alter table public.recurring_journal_lines     add column if not exists tenant_id uuid;
alter table public.purchase_invoices           add column if not exists tenant_id uuid;
alter table public.purchase_invoice_items      add column if not exists tenant_id uuid;
alter table public.purchase_orders             add column if not exists tenant_id uuid;
alter table public.purchase_order_items        add column if not exists tenant_id uuid;
alter table public.purchase_requisitions       add column if not exists tenant_id uuid;
alter table public.purchase_requisition_items  add column if not exists tenant_id uuid;
alter table public.quotations                  add column if not exists tenant_id uuid;
alter table public.sales_returns               add column if not exists tenant_id uuid;
alter table public.sales_contracts             add column if not exists tenant_id uuid;
alter table public.rentals                     add column if not exists tenant_id uuid;
alter table public.supplier_payments           add column if not exists tenant_id uuid;
alter table public.debit_notes                 add column if not exists tenant_id uuid;
alter table public.employees                   add column if not exists tenant_id uuid;
alter table public.attendance                  add column if not exists tenant_id uuid;
alter table public.bonuses                     add column if not exists tenant_id uuid;
alter table public.deductions                  add column if not exists tenant_id uuid;
alter table public.financial_years             add column if not exists tenant_id uuid;
alter table public.alert_rules                 add column if not exists tenant_id uuid;
alter table public.alert_logs                  add column if not exists tenant_id uuid;
alter table public.document_sequences          add column if not exists tenant_id uuid;
alter table public.petty_cash_transactions     add column if not exists tenant_id uuid;
alter table public.sidebar_settings            add column if not exists tenant_id uuid;
alter table public.expense_accounts            add column if not exists tenant_id uuid;

-- ----------------------------------------------------------------------------
-- 3. Helper functions used by the RLS policies
--
--    SECURITY DEFINER so the lookup of the caller's tenant/role does not itself
--    recurse through RLS.
-- ----------------------------------------------------------------------------
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.users where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role = 'admin' from public.users where id = auth.uid()), false);
$$;

revoke all on function public.current_tenant_id() from public;
revoke all on function public.is_admin() from public;
grant execute on function public.current_tenant_id() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Enable RLS on every tenant-owned table
--
--    RLS is deny-by-default: once enabled, the `anon` role (the key shipped to
--    the browser) has NO access at all until a policy grants it. Every policy
--    below targets `authenticated` only, so an anonymous request can neither
--    read nor write any of these tables.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'accounts','activity_logs','ai_recommendations','alert_logs','alert_rules',
    'attendance','bonuses','branches','car_loan_installments','car_loans','cars',
    'credits','customers','debit_notes','deductions','document_sequences',
    'documents','drivers','employees','expense_accounts','expenses',
    'financial_health_score','financial_ratio_history','financial_ratios',
    'financial_years','invoices','journal_attachments','journal_entries',
    'journal_entry_lines','journal_lines','journal_template_lines',
    'journal_templates','kpi_results','maintenance','oil_service_records',
    'payments','permissions','petty_cash_transactions','profiles',
    'purchase_invoice_items','purchase_invoices','purchase_order_items',
    'purchase_orders','purchase_requisition_items','purchase_requisitions',
    'quotations','recurring_journal_lines','recurring_journals',
    'rental_contracts','rentals','roles','sales','sales_contracts',
    'sales_returns','settings','sidebar_settings','supplier_payments',
    'suppliers','support_tickets','tax_rates','tax_settings','tenants',
    'user_roles','users'
  ];
begin
  foreach t in array tables loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      execute format('alter table public.%I enable row level security', t);
      -- Belt and braces: revoke table privileges from anon so a future policy
      -- mistake cannot silently re-expose the table.
      execute format('revoke all on public.%I from anon', t);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 5. Tenant isolation policies for every table carrying `tenant_id`
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'accounts','activity_logs','alert_logs','alert_rules',
    'attendance','bonuses','branches','car_loan_installments','car_loans','cars',
    'credits','customers','debit_notes','deductions','document_sequences',
    'documents','drivers','employees','expense_accounts','expenses',
    'financial_years','invoices','journal_attachments','journal_entries',
    'journal_entry_lines','journal_lines','journal_template_lines',
    'journal_templates','maintenance','oil_service_records',
    'payments','petty_cash_transactions','profiles','purchase_invoice_items',
    'purchase_invoices','purchase_order_items','purchase_orders',
    'purchase_requisition_items','purchase_requisitions','quotations',
    'recurring_journal_lines','recurring_journals','rental_contracts','rentals',
    'sales','sales_contracts','sales_returns','settings','sidebar_settings',
    'supplier_payments','suppliers','support_tickets','tax_rates','tax_settings'
  ];
begin
  foreach t in array tables loop
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      continue;
    end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = t
                     and column_name = 'tenant_id') then
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_tenant_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_tenant_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_tenant_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_tenant_delete', t);

    execute format($f$
      create policy %I on public.%I
        for select to authenticated
        using (tenant_id is not distinct from public.current_tenant_id())
    $f$, t || '_tenant_select', t);

    execute format($f$
      create policy %I on public.%I
        for insert to authenticated
        with check (tenant_id is not distinct from public.current_tenant_id())
    $f$, t || '_tenant_insert', t);

    execute format($f$
      create policy %I on public.%I
        for update to authenticated
        using (tenant_id is not distinct from public.current_tenant_id())
        with check (tenant_id is not distinct from public.current_tenant_id())
    $f$, t || '_tenant_update', t);

    execute format($f$
      create policy %I on public.%I
        for delete to authenticated
        using (tenant_id is not distinct from public.current_tenant_id())
    $f$, t || '_tenant_delete', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 5b. Financial analytics tables are scoped by `company_id`, not `tenant_id`.
--     They hold derived financial intelligence (ratios, KPIs, health scores,
--     AI recommendations) so they get the same isolation semantics.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'financial_ratios','financial_ratio_history','financial_health_score',
    'kpi_results','ai_recommendations'
  ];
begin
  foreach t in array tables loop
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      continue;
    end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = t
                     and column_name = 'company_id') then
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_company_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_company_write', t);

    execute format($f$
      create policy %I on public.%I
        for select to authenticated
        using (company_id is not distinct from public.current_tenant_id())
    $f$, t || '_company_select', t);

    execute format($f$
      create policy %I on public.%I
        for all to authenticated
        using (company_id is not distinct from public.current_tenant_id())
        with check (company_id is not distinct from public.current_tenant_id())
    $f$, t || '_company_write', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 6. `users` — a member reads/updates only their own row; admins see the tenant
-- ----------------------------------------------------------------------------
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
  with check (id = auth.uid() or public.is_admin());

drop policy if exists users_admin_insert on public.users;
create policy users_admin_insert on public.users
  for insert to authenticated
  with check (public.is_admin() or id = auth.uid());

-- ----------------------------------------------------------------------------
-- 7. Reference data — read-only for authenticated callers
-- ----------------------------------------------------------------------------
drop policy if exists tenants_read on public.tenants;
create policy tenants_read on public.tenants
  for select to authenticated
  using (id is not distinct from public.current_tenant_id() or public.is_admin());

drop policy if exists roles_read on public.roles;
create policy roles_read on public.roles
  for select to authenticated using (true);

drop policy if exists permissions_read on public.permissions;
create policy permissions_read on public.permissions
  for select to authenticated using (true);

drop policy if exists user_roles_read on public.user_roles;
create policy user_roles_read on public.user_roles
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- ----------------------------------------------------------------------------
-- 8. activity_logs is append-only from the application
--
--    These MUST be RESTRICTIVE. The generic tenant loop above creates
--    permissive `activity_logs_tenant_update` / `_delete` policies; PostgreSQL
--    ORs permissive policies together, so a permissive `using (false)` deny
--    would be a no-op and a tenant could rewrite its own audit trail. A
--    RESTRICTIVE policy is ANDed with every permissive policy, so `false` here
--    removes UPDATE and DELETE for all authenticated callers. The service role
--    (BYPASSRLS) is unaffected.
-- ----------------------------------------------------------------------------
drop policy if exists activity_logs_no_update on public.activity_logs;
create policy activity_logs_no_update on public.activity_logs
  as restrictive for update to authenticated using (false);

drop policy if exists activity_logs_no_delete on public.activity_logs;
create policy activity_logs_no_delete on public.activity_logs
  as restrictive for delete to authenticated using (false);

-- ==========================================================================
-- BEGIN 002_tenant_isolation_hardening.sql
-- SHA-256 (body): 9e4351243445445f81187add893e48bfc96ea79f7f2bf4ecc1e049dbe7ca7b90
-- ==========================================================================

-- ============================================================================
-- 002_tenant_isolation_hardening.sql
-- Execution 03 — Security & Tenant Isolation hardening.
--
-- Apply with:  psql "$DATABASE_URL" -f supabase/migrations/002_tenant_isolation_hardening.sql
--              (or `supabase db push`)
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- 001_core_security.sql was never applied to the live database. A live probe
-- with the public anon key (the key shipped to every browser) returned HTTP 200
-- for SELECT on `users`, `customers`, `invoices`, `journal_entries`,
-- `journal_lines`, `payments` and `accounts`, and HTTP 201/204 for
-- INSERT/UPDATE/DELETE. Row Level Security is not enabled, so the browser key
-- currently has full read/write access to every tenant's data.
--
-- This migration is the single, complete, idempotent statement of the intended
-- isolation model. It supersedes 001 (which may or may not have been applied);
-- running it on a database where 001 already ran is a no-op beyond re-creating
-- the same policies.
--
-- DESIGN RULES
-- ------------
--  * Deny-by-default: RLS is enabled on every application table and the `anon`
--    role is stripped of every table privilege and function grant. A browser
--    that is not logged in can read and write nothing.
--  * Tenant identity is derived from the session (`auth.uid()`), never from the
--    request. `current_tenant_id()` reads `public.users.tenant_id` for the
--    authenticated user only.
--  * NULL-tolerant read predicate (`is not distinct from`) so the current
--    single-tenant installation — where every tenant_id is NULL — keeps working
--    unchanged, while strict isolation engages the moment tenants are assigned.
--  * Strict write predicate (`= current_tenant_id()`), so a caller can never
--    plant a row in another tenant or in the tenant-less bucket.
--  * Non-destructive: no DROP TABLE, no DELETE, no TRUNCATE, no data reset.
--    Backfill is left to the operator because ownership cannot be inferred.
--  * Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Ensure the session helper functions exist (they may be missing entirely on
--    a database where 001 was never applied).
-- ----------------------------------------------------------------------------
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.users where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role = 'admin' from public.users where id = auth.uid()), false);
$$;

-- True only when the caller presents a valid Supabase session. Used by the
-- reference-table policies so a logged-in user can read shared lookups while an
-- anonymous visitor cannot.
create or replace function public.is_authenticated()
returns boolean
language sql
stable
as $$
  select auth.uid() is not null;
$$;

-- ----------------------------------------------------------------------------
-- Tenant predicates.
--
-- `can_read_tenant` is NULL-tolerant: in the current single-tenant install every
-- tenant_id is NULL and every user's tenant_id is NULL, so `NULL is not distinct
-- from NULL` is true and the application keeps working unchanged. The moment a
-- tenant is assigned, a row in another tenant stops matching.
--
-- `can_write_tenant` is STRICT. It refuses to create a tenant-less ("orphan")
-- row when the caller belongs to a tenant, and it refuses to write into any
-- tenant other than the caller's. When the caller is tenant-less (single-tenant
-- install) only tenant-less rows may be written, which is the coherent state
-- today. This is what makes cross-tenant INSERT/UPDATE impossible while keeping
-- the 129 existing browser write paths functional.
-- ----------------------------------------------------------------------------
create or replace function public.can_read_tenant(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select candidate is not distinct from public.current_tenant_id();
$$;

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

-- Company-scoped equivalent for the financial-analytics tables.
create or replace function public.can_read_company(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select candidate is not distinct from public.current_tenant_id();
$$;

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

revoke all on function public.current_tenant_id() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.is_authenticated() from public;
revoke all on function public.can_read_tenant(uuid) from public;
revoke all on function public.can_write_tenant(uuid) from public;
revoke all on function public.can_read_company(uuid) from public;
revoke all on function public.can_write_company(uuid) from public;

grant execute on function public.current_tenant_id() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_authenticated() to authenticated;
grant execute on function public.can_read_tenant(uuid) to authenticated;
grant execute on function public.can_write_tenant(uuid) to authenticated;
grant execute on function public.can_read_company(uuid) to authenticated;
grant execute on function public.can_write_company(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 1. Audit log table (created here too, so this migration stands alone).
-- ----------------------------------------------------------------------------
create table if not exists public.activity_logs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid,
  user_id     uuid,
  user_email  text,
  action      text not null,
  entity      text not null,
  entity_id   uuid,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists activity_logs_tenant_created_idx
  on public.activity_logs (tenant_id, created_at desc);
create index if not exists activity_logs_entity_idx
  on public.activity_logs (entity, entity_id);
create index if not exists activity_logs_user_idx
  on public.activity_logs (user_id);

-- ----------------------------------------------------------------------------
-- 2. Add `tenant_id` to tenant-owned tables that lack it.
--
--    Nullable on purpose: existing rows keep NULL and stay readable under the
--    NULL-tolerant read predicate. NOT NULL is intentionally NOT enforced here,
--    because enforcing it on a populated table would fail; the operator should
--    backfill first (section 9 documents the procedure).
--
--    The list is deliberately exhaustive and guarded: a missing table is
--    skipped rather than aborting the migration.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'profiles',
    -- Accounting core
    'journal_entries','journal_lines','journal_entry_lines','journal_attachments',
    'journal_templates','journal_template_lines','recurring_journals',
    'recurring_journal_lines',
    -- Purchasing
    'purchase_invoices','purchase_invoice_items','purchase_orders',
    'purchase_order_items','purchase_requisitions','purchase_requisition_items',
    -- Sales / rental
    'quotations','sales_returns','sales_contracts','rentals',
    -- Payables / receivables
    'supplier_payments','debit_notes',
    -- HR
    'employees','attendance','bonuses','deductions',
    -- Configuration
    'financial_years','alert_rules','alert_logs','document_sequences',
    'petty_cash_transactions','sidebar_settings','expense_accounts'
  ];
begin
  foreach t in array tables loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      execute format('alter table public.%I add column if not exists tenant_id uuid', t);
      execute format(
        'create index if not exists %I on public.%I (tenant_id)',
        t || '_tenant_id_idx', t);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Enable RLS on EVERY application table.
--
--    This list is the union of the live schema (63 tables) plus activity_logs.
--    RLS is deny-by-default, so enabling it removes all access until a policy
--    grants it. `tenants` is included: it is filtered by its own policy below.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'accounts','activity_logs','ai_recommendations','alert_logs','alert_rules',
    'attendance','bonuses','branches','car_loan_installments','car_loans','cars',
    'credits','customers','debit_notes','deductions','document_sequences',
    'documents','drivers','employees','expense_accounts','expenses',
    'financial_health_score','financial_ratio_history','financial_ratios',
    'financial_years','invoices','journal_attachments','journal_entries',
    'journal_entry_lines','journal_lines','journal_template_lines',
    'journal_templates','kpi_results','maintenance','oil_service_records',
    'payments','permissions','petty_cash_transactions','profiles',
    'purchase_invoice_items','purchase_invoices','purchase_order_items',
    'purchase_orders','purchase_requisition_items','purchase_requisitions',
    'quotations','recurring_journal_lines','recurring_journals',
    'rental_contracts','rentals','roles','sales','sales_contracts',
    'sales_returns','settings','sidebar_settings','supplier_payments',
    'suppliers','support_tickets','tax_rates','tax_settings','tenants',
    'user_roles','users'
  ];
begin
  foreach t in array tables loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 4. THE CRITICAL FIX — strip the `anon` role of every table privilege.
--
--    Before this migration the browser key could read and write everything.
--    `revoke all` removes both the default grants Supabase issues and any
--    privilege a previous state left behind. RLS then blocks the `authenticated`
--    role except where a policy below grants access.
--
--    The service-role key (used by server route handlers) has BYPASSRLS and is
--    unaffected — which is exactly why every privileged route must perform its
--    own authorization, as the API guards in src/lib/auth do.
-- ----------------------------------------------------------------------------
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
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from public', t);
  end loop;
end $$;

-- Anonymous visitors must not be able to call the helper functions either.
revoke all on function public.current_tenant_id() from anon;
revoke all on function public.is_admin() from anon;
revoke all on function public.is_authenticated() from anon;

-- ----------------------------------------------------------------------------
-- 5. Tenant isolation policies for every table carrying `tenant_id`.
--
--    SELECT  : row.tenant_id IS NOT DISTINCT FROM caller's tenant (NULL-safe)
--    INSERT  : new row.tenant_id MUST equal the caller's tenant (strict)
--    UPDATE  : row readable AND new value stays in the caller's tenant
--    DELETE  : row readable
--
--    The write predicate is strict so a caller cannot create a tenant-less row
--    (which would then be visible to the NULL-tenant installation) or move a
--    row into another tenant.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'accounts','activity_logs','alert_logs','alert_rules',
    'attendance','bonuses','branches','car_loan_installments','car_loans','cars',
    'credits','customers','debit_notes','deductions','document_sequences',
    'documents','drivers','employees','expense_accounts','expenses',
    'financial_years','invoices','journal_attachments','journal_entries',
    'journal_entry_lines','journal_lines','journal_template_lines',
    'journal_templates','maintenance','oil_service_records',
    'payments','petty_cash_transactions','profiles','purchase_invoice_items',
    'purchase_invoices','purchase_order_items','purchase_orders',
    'purchase_requisition_items','purchase_requisitions','quotations',
    'recurring_journal_lines','recurring_journals','rental_contracts','rentals',
    'sales','sales_contracts','sales_returns','settings','sidebar_settings',
    'supplier_payments','suppliers','support_tickets','tax_rates','tax_settings'
  ];
begin
  foreach t in array tables loop
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      continue;
    end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = t
                     and column_name = 'tenant_id') then
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_tenant_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_tenant_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_tenant_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_tenant_delete', t);

    execute format($f$
      create policy %I on public.%I
        for select to authenticated
        using (public.can_read_tenant(tenant_id))
    $f$, t || '_tenant_select', t);

    execute format($f$
      create policy %I on public.%I
        for insert to authenticated
        with check (public.can_write_tenant(tenant_id))
    $f$, t || '_tenant_insert', t);

    execute format($f$
      create policy %I on public.%I
        for update to authenticated
        using (public.can_read_tenant(tenant_id))
        with check (public.can_write_tenant(tenant_id))
    $f$, t || '_tenant_update', t);

    execute format($f$
      create policy %I on public.%I
        for delete to authenticated
        using (public.can_read_tenant(tenant_id))
    $f$, t || '_tenant_delete', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Financial analytics tables are scoped by `company_id`, not `tenant_id`.
--    They hold derived financial intelligence (ratios, KPIs, health scores, AI
--    recommendations, alerts) so they get the same isolation semantics.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'financial_ratios','financial_health_score','kpi_results',
    'ai_recommendations','alert_rules','alert_logs'
  ];
begin
  foreach t in array tables loop
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      continue;
    end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = t
                     and column_name = 'company_id') then
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_company_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_company_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_company_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_company_delete', t);

    execute format($f$
      create policy %I on public.%I
        for select to authenticated
        using (public.can_read_company(company_id))
    $f$, t || '_company_select', t);

    execute format($f$
      create policy %I on public.%I
        for insert to authenticated
        with check (public.can_write_company(company_id))
    $f$, t || '_company_insert', t);

    execute format($f$
      create policy %I on public.%I
        for update to authenticated
        using (public.can_read_company(company_id))
        with check (public.can_write_company(company_id))
    $f$, t || '_company_update', t);

    execute format($f$
      create policy %I on public.%I
        for delete to authenticated
        using (public.can_read_company(company_id))
    $f$, t || '_company_delete', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 7. `financial_ratio_history` has NO tenant/company column. Its ownership is
--    INDIRECT: each row belongs to a `financial_ratios` row via `ratio_id`.
--    The policy therefore resolves the parent's company rather than inventing a
--    new ownership column. This is the "use the correct parent relationship"
--    case required by the audit.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'financial_ratio_history')
     and exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'financial_ratio_history'
                   and column_name = 'ratio_id') then

    execute 'drop policy if exists financial_ratio_history_parent_select on public.financial_ratio_history';
    execute 'drop policy if exists financial_ratio_history_parent_write on public.financial_ratio_history';

    execute $f$
      create policy financial_ratio_history_parent_select on public.financial_ratio_history
        for select to authenticated
        using (
          exists (
            select 1 from public.financial_ratios fr
            where fr.id = financial_ratio_history.ratio_id
              and public.can_read_company(fr.company_id)
          )
        )
    $f$;

    execute $f$
      create policy financial_ratio_history_parent_write on public.financial_ratio_history
        for all to authenticated
        using (
          exists (
            select 1 from public.financial_ratios fr
            where fr.id = financial_ratio_history.ratio_id
              and public.can_read_company(fr.company_id)
          )
        )
        with check (
          exists (
            select 1 from public.financial_ratios fr
            where fr.id = financial_ratio_history.ratio_id
              and public.can_write_company(fr.company_id)
          )
        )
    $f$;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Identity, reference and membership tables.
-- ----------------------------------------------------------------------------

-- users: a member reads their own row; an admin reads their tenant; a member may
-- update only their own row and cannot move it to another tenant.
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
  -- Nobody — not even an admin — may move a user row OUT of their own tenant.
  -- Without this clause an admin could set tenant_id to a victim tenant and
  -- thereby widen their own access. `current_tenant_id()` reads the pre-update
  -- row, so this compares the new value against the caller's existing tenant.
  -- Tenant (re)assignment across tenants is a provisioning task and must go
  -- through the service-role route, not a browser session.
  with check (
    (id = auth.uid() or public.is_admin())
    and tenant_id is not distinct from public.current_tenant_id()
  );

drop policy if exists users_admin_insert on public.users;
create policy users_admin_insert on public.users
  for insert to authenticated
  with check (public.is_admin() or id = auth.uid());

-- tenants: a member may read only their own tenant row.
drop policy if exists tenants_read on public.tenants;
create policy tenants_read on public.tenants
  for select to authenticated
  using (id is not distinct from public.current_tenant_id() or public.is_admin());

-- Shared reference data: readable by any authenticated user, never by anon.
-- These tables carry no tenant column and are global lookups by design; writes
-- happen only through service-role routes that enforce `users.create` etc.
drop policy if exists roles_read on public.roles;
create policy roles_read on public.roles
  for select to authenticated using (public.is_authenticated());

drop policy if exists permissions_read on public.permissions;
create policy permissions_read on public.permissions
  for select to authenticated using (public.is_authenticated());

drop policy if exists user_roles_read on public.user_roles;
create policy user_roles_read on public.user_roles
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ----------------------------------------------------------------------------
-- 9. activity_logs is append-only from the application.
--
--    RESTRICTIVE on purpose: the generic tenant loop above also creates
--    permissive `activity_logs_tenant_update` / `_delete` policies, and
--    PostgreSQL ORs permissive policies. A permissive `using (false)` would
--    therefore be a no-op and a tenant could rewrite its own audit trail. As a
--    RESTRICTIVE policy it is ANDed with every permissive policy, removing
--    UPDATE and DELETE for all authenticated callers. Service role (BYPASSRLS)
--    is unaffected.
-- ----------------------------------------------------------------------------
drop policy if exists activity_logs_no_update on public.activity_logs;
create policy activity_logs_no_update on public.activity_logs
  as restrictive for update to authenticated using (false);

drop policy if exists activity_logs_no_delete on public.activity_logs;
create policy activity_logs_no_delete on public.activity_logs
  as restrictive for delete to authenticated using (false);

-- ============================================================================
-- 10. POST-APPLY VERIFICATION (run manually; not part of the migration effect)
--
--   -- must return 0 rows: no policy-bearing table left without RLS
--   select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
--   where n.nspname='public' and c.relkind='r' and c.relrowsecurity = false;
--
--   -- must return no rows for anon:
--   --   curl "$URL/rest/v1/customers?select=id&limit=1" -H "apikey: $ANON"
--
-- 11. BACKFILL (operator task — ownership CANNOT be inferred, so it is NOT
--     guessed here).
--
--   The current installation has every tenant_id NULL, which is a coherent
--   single-tenant state and needs no backfill. When tenants are introduced:
--
--     -- 1. create the tenant, then point every existing row at it
--     update public.users      set tenant_id = :tenant where tenant_id is null;
--     update public.customers  set tenant_id = :tenant where tenant_id is null;
--     ... repeat per table ...
--
--     -- 2. only after a clean backfill, tighten the columns
--     alter table public.customers alter column tenant_id set not null;
--
--   Records that cannot be attributed to a tenant (e.g. rows whose owning user
--   is unknown) MUST be resolved manually. Do not blanket-assign them.
-- ============================================================================

-- ==========================================================================
-- BEGIN 003_sales_lifecycle.sql
-- SHA-256 (body): c2afccecc856f553fe715f6a4e5c56ee679b8bfdace27688551d9805a73a8bee
-- ==========================================================================

-- ============================================================================
-- 003_sales_lifecycle.sql
-- Columns the sales lifecycle (invoices → payments → returns → accounting)
-- needs, plus the document-number sequences for receipts and sales returns.
--
-- This migration is **additive and idempotent**: every statement is guarded with
-- `if not exists` / `where not exists`, and the application code is written to
-- keep working when these columns are absent (`src/lib/db/columns.ts`). It
-- closes the gap between what Exec 01/03 declared (their `alter table ... add
-- column if not exists` statements never ran against this database) and what
-- the live schema actually has.
--
-- It is non-destructive: no DROP, no DELETE, no TRUNCATE, no data rewrite.
--
-- Apply with:  psql "$DATABASE_URL" -f supabase/migrations/003_sales_lifecycle.sql
--              (or `supabase db push`)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Sales returns: tenant, the return's own number, and the VAT it reverses.
--    `tenant_id` was declared in 001/002 but never applied to this table.
--    Each column is added only when its table exists, so the migration never
--    aborts on an installation that lacks an optional table.
-- ----------------------------------------------------------------------------
do $$
declare
  spec text;
  cols text[] := array['tenant_id uuid', 'return_number text', 'vat_amount numeric(15,3) default 0'];
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'sales_returns') then
    foreach spec in array cols loop
      execute format('alter table public.sales_returns add column if not exists %s', spec);
    end loop;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Journal tenant linkage. `postJournalEntry` writes `tenant_id` when the
--    caller has one; without the column that insert fails, so posting (and
--    therefore every sale, payment and return) could not complete on a
--    tenant-aware installation. `journal_entry_lines` is the legacy sibling
--    table, included for parity with 001/002.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array['journal_entries', 'journal_lines', 'journal_entry_lines'];
begin
  foreach t in array tables loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      execute format('alter table public.%I add column if not exists tenant_id uuid', t);
      execute format(
        'create index if not exists %I on public.%I (tenant_id)',
        t || '_tenant_id_idx', t);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Document-number sequences for receipts and sales returns, so both are
--    allocated under the same row-locked mechanism as invoices and journals.
--    `where not exists` (rather than `on conflict`) is used so the statement
--    does not depend on a unique constraint being present on `doc_type`.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'document_sequences') then
    insert into public.document_sequences (doc_type, prefix, last_number, use_year)
    select v.doc_type, v.prefix, v.last_number, v.use_year
    from (values
      ('receipt',      'REC', 0, true),
      ('sales_return', 'SR',  0, true)
    ) as v(doc_type, prefix, last_number, use_year)
    where not exists (
      select 1 from public.document_sequences d where d.doc_type = v.doc_type
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Sales-returns contra-revenue account (41003).
--
--    `postJournalEntry` maps a sales return to `ACCOUNT_CODES.salesReturns`
--    (41003). The live shared chart has 41001/41002 but not 41003, so a return
--    currently falls back to debiting 41002. This inserts the missing system
--    account once, in the same shape as its sibling 41002 (shared chart:
--    `tenant_id` null, level 1, active), so returns post to the intended
--    contra-revenue account instead of netting against sales revenue.
--
--    Guarded by `where not exists` on the code, so re-running never duplicates
--    it, and skipped entirely on installations that manage their own chart.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'accounts') then
    insert into public.accounts (id, code, name, name_ar, name_en, type, level, is_active, tenant_id)
    select gen_random_uuid(), '41003', 'مرتجع المبيعات', 'مرتجع المبيعات', 'Sales Returns', 'revenue', 1, true, null
    where not exists (
      select 1 from public.accounts a where a.code = '41003'
    );
  end if;
end $$;

-- ============================================================================
-- POST-FLIGHT VERIFICATION  (read-only)
-- ============================================================================
-- Confirms the activation actually took effect. Every row must read `true`
-- (or, for the RLS "tables without RLS" query, return ZERO rows).

-- 1. SCHEMA ------------------------------------------------------------------
select item, ok from (
  select 'activity_logs exists'            as item, (to_regclass('public.activity_logs') is not null) as ok
  union all select 'sales_returns.tenant_id',      exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales_returns'     and column_name='tenant_id')
  union all select 'sales_returns.return_number',  exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales_returns'     and column_name='return_number')
  union all select 'sales_returns.vat_amount',     exists (select 1 from information_schema.columns where table_schema='public' and table_name='sales_returns'     and column_name='vat_amount')
  union all select 'journal_entries.tenant_id',    exists (select 1 from information_schema.columns where table_schema='public' and table_name='journal_entries'  and column_name='tenant_id')
  union all select 'journal_lines.tenant_id',      exists (select 1 from information_schema.columns where table_schema='public' and table_name='journal_lines'    and column_name='tenant_id')
  union all select 'journal_entry_lines.tenant_id',exists (select 1 from information_schema.columns where table_schema='public' and table_name='journal_entry_lines' and column_name='tenant_id')
  union all select 'account 41003 exists',         exists (select 1 from public.accounts a where a.code='41003')
  union all select 'doc sequence receipt',         exists (select 1 from public.document_sequences d where d.doc_type='receipt')
  union all select 'doc sequence sales_return',    exists (select 1 from public.document_sequences d where d.doc_type='sales_return')
) s
order by ok, item;

-- NOTE: expenses.branch_id is NOT added by 001-003 (the expense branch is a
-- free-text `branch` column in this schema). Recorded here for transparency.
select 'expenses.branch_id (not added by 001-003)' as item,
       exists (select 1 from information_schema.columns where table_schema='public' and table_name='expenses' and column_name='branch_id') as present;

-- 2. RLS ENABLED ON EVERY TABLE ----------------------------------------------
-- Must return ZERO rows.
select c.relname as table_missing_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
order by c.relname;

-- 3. RLS COVERAGE REPORT (table_name | rls_enabled | policy_count) ------------
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       count(p.oid) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public' and c.relkind = 'r'
  and c.relname in (
    'tenants','users','profiles','customers','invoices','payments','sales_returns',
    'journal_entries','journal_lines','accounts','branches','financial_years',
    'suppliers','expenses','quotations','rentals','bookings','employees',
    'activity_logs'
  )
group by c.relname, c.relrowsecurity
order by c.relrowsecurity, c.relname;

-- 4. REQUIRED POLICIES EXIST -------------------------------------------------
select p.polname as policy_name,
       c.relname as table_name,
       p.polcmd as command,            -- r=select a=insert w=update d=delete *=all
       p.polpermissive as permissive   -- false = RESTRICTIVE
from pg_policy p
join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and (
    (c.relname = 'activity_logs' and p.polname in ('activity_logs_no_update','activity_logs_no_delete'))
    or p.polname like '%_tenant_select'
    or p.polname like '%_tenant_insert'
  )
order by c.relname, p.polname;

-- 5. ACTIVITY LOG IS APPEND-ONLY ---------------------------------------------
-- Both rows MUST show permissive = false (RESTRICTIVE) for commands w and d.
select p.polname as policy_name,
       case p.polcmd when 'w' then 'UPDATE' when 'd' then 'DELETE' else p.polcmd::text end as command,
       p.polpermissive as permissive,
       (p.polpermissive = false) as is_restrictive_ok
from pg_policy p
where p.polrelid = 'public.activity_logs'::regclass
  and p.polname in ('activity_logs_no_update','activity_logs_no_delete')
order by p.polname;

-- 6. ACCOUNTING: 41003 -------------------------------------------------------
select id, code, name, name_ar, name_en, type, level, is_active, tenant_id
from public.accounts
where code = '41003';

-- 7. ANON LOCKDOWN (authoritative, non-destructive) --------------------------
-- Every column MUST read false after activation.
select t as table_name,
  has_table_privilege('anon', 'public.' || t, 'SELECT') as anon_select,
  has_table_privilege('anon', 'public.' || t, 'INSERT') as anon_insert,
  has_table_privilege('anon', 'public.' || t, 'UPDATE') as anon_update,
  has_table_privilege('anon', 'public.' || t, 'DELETE') as anon_delete
from (values
  ('customers'),('invoices'),('users'),('accounts'),('journal_entries'),
  ('journal_lines'),('sales_returns'),('activity_logs')
) as v(t)
order by t;

-- 8. NO DATA WAS LOST (compare against the pre-flight counts) ----------------
select
  e.t as table_name,
  (xpath('/row/c/text()',
     query_to_xml(format('select count(*) as c from public.%I', e.t),
                  false, true, '')))[1]::text::bigint as row_count
from (values ('accounts'),('customers'),('invoices'),('users')) as e(t)
order by e.t;

-- ============================================================================
-- END OF PACKAGE
-- ============================================================================
