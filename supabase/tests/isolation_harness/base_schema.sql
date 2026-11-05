-- Minimal but faithful base schema for verifying migrations 001 -> 004 with a
-- real PostgreSQL, using two tenants. It reproduces only what the migrations
-- depend on: the roles they target, a GUC-driven `auth.uid()` (matching
-- Supabase), and the application tables the migration table-lists reference.
--
-- Columns are permissive (`tenant_id` on every table the migrations expect it,
-- plus the few columns the tests read). It is NOT a copy of production data.

drop schema if exists auth cascade;
create schema auth;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
alter role service_role bypassrls;

create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), ''
  )::uuid;
$$;

-- Tables migration 003 writes into, with their real shape.
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  code text, name text, name_ar text, name_en text,
  type text, level int, is_active boolean default true, tenant_id uuid,
  -- Migration 014 expresses the "parent belongs to the same company" rule over
  -- (tenant_id, parent_code) and adds the column only if it is absent, so the
  -- base schema provides it for the 014+ harnesses.
  parent_code text
);
create table public.document_sequences (
  id uuid primary key default gen_random_uuid(),
  doc_type text, prefix text, last_number bigint default 0, use_year boolean default false, tenant_id uuid
);

-- Reference/identity tables with their real shape.
create table public.tenants (id uuid primary key default gen_random_uuid(), name text);
create table public.users (
  id uuid primary key,
  email text,
  full_name text,
  role text default 'staff',
  tenant_id uuid,
  is_active boolean default true,
  created_at timestamptz default now()
);
create table public.roles (id uuid primary key default gen_random_uuid(), name text);
create table public.permissions (id uuid primary key default gen_random_uuid(), name text);
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid, role_id uuid);

-- Every table referenced by migrations 001/002/004. `tenant_id` is present so
-- the tenant policies apply; `company_id` is added only where the migration
-- treats a table as company-scoped.
do $$
declare
  t text;
  tenant_tables text[] := array[
    'profiles','journal_entries','journal_entry_lines','journal_lines','journal_attachments',
    'journal_templates','journal_template_lines','recurring_journals','recurring_journal_lines',
    'purchase_invoices','purchase_invoice_items','purchase_orders','purchase_order_items',
    'purchase_requisitions','purchase_requisition_items','quotations','sales_returns',
    'sales_contracts','rentals','rental_contracts','supplier_payments','debit_notes',
    'employees','attendance','bonuses','deductions','financial_years','alert_rules','alert_logs',
    'document_sequences','petty_cash_transactions','sidebar_settings','expense_accounts',
    'accounts','branches','cars','car_loans','car_loan_installments','credits','customers',
    'documents','drivers','expenses','invoices','maintenance','oil_service_records','payments',
    'sales','settings','suppliers','support_tickets','tax_rates','tax_settings'
  ];
  company_tables text[] := array['financial_ratios','financial_health_score','kpi_results','ai_recommendations'];
  other_tables text[] := array['financial_ratio_history'];
begin
  foreach t in array tenant_tables loop
    execute format('create table if not exists public.%I (id uuid primary key default gen_random_uuid(), tenant_id uuid, total numeric default 0, amount numeric default 0, vat_amount numeric default 0, status text, code text, name text, created_at timestamptz default now())', t);
  end loop;
  foreach t in array company_tables loop
    execute format('create table if not exists public.%I (id uuid primary key default gen_random_uuid(), company_id uuid, created_at timestamptz default now())', t);
  end loop;
  foreach t in array other_tables loop
    execute format('create table if not exists public.%I (id uuid primary key default gen_random_uuid(), ratio_id uuid, created_at timestamptz default now())', t);
  end loop;
end $$;
