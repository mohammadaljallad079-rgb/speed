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
    'accounts','activity_logs','alert_logs','alert_rules',
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
-- ----------------------------------------------------------------------------
drop policy if exists activity_logs_no_update on public.activity_logs;
create policy activity_logs_no_update on public.activity_logs
  for update to authenticated using (false);

drop policy if exists activity_logs_no_delete on public.activity_logs;
create policy activity_logs_no_delete on public.activity_logs
  for delete to authenticated using (false);
