-- ============================================================================
-- 001_core_security_rollback.sql
-- Reverts 001_core_security.sql.
--
-- This restores the pre-hardening behaviour (anon key could read/write every
-- table). It exists so the change can be rolled back quickly if it breaks a
-- deployment that still relies on direct browser access to Postgres.
--
-- It does NOT drop the activity_logs table or the tenant_id columns, because
-- data loss is worse than the exposure. Drop those manually if you really need
-- to.
-- ============================================================================

do $$
declare
  t text;
  tables text[] := array[
    'accounts','activity_logs','alert_logs','alert_rules','attendance','bonuses',
    'branches','car_loan_installments','car_loans','cars','credits','customers',
    'debit_notes','deductions','document_sequences','documents','drivers',
    'employees','expense_accounts','expenses','financial_years','invoices',
    'journal_attachments','journal_entries','journal_entry_lines','journal_lines',
    'journal_template_lines','journal_templates','maintenance',
    'oil_service_records','payments','permissions','petty_cash_transactions',
    'profiles','purchase_invoice_items','purchase_invoices',
    'purchase_order_items','purchase_orders','purchase_requisition_items',
    'purchase_requisitions','quotations','recurring_journal_lines',
    'recurring_journals','rental_contracts','rentals','roles','sales',
    'sales_contracts','sales_returns','settings','sidebar_settings',
    'supplier_payments','suppliers','support_tickets','tax_rates','tax_settings',
    'tenants','user_roles','users'
  ];
  company_tables text[] := array[
    'financial_ratios','financial_ratio_history','financial_health_score',
    'kpi_results','ai_recommendations'
  ];
begin
  foreach t in array tables loop
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t || '_tenant_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_tenant_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_tenant_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_tenant_delete', t);
    execute format('alter table public.%I disable row level security', t);
    execute format('grant all on public.%I to anon', t);
    execute format('grant all on public.%I to authenticated', t);
  end loop;

  foreach t in array company_tables loop
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t || '_company_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_company_write', t);
    execute format('alter table public.%I disable row level security', t);
    execute format('grant all on public.%I to anon', t);
    execute format('grant all on public.%I to authenticated', t);
  end loop;
end $$;

drop policy if exists users_self_select on public.users;
drop policy if exists users_self_update on public.users;
drop policy if exists users_admin_insert on public.users;
drop policy if exists tenants_read on public.tenants;
drop policy if exists roles_read on public.roles;
drop policy if exists permissions_read on public.permissions;
drop policy if exists user_roles_read on public.user_roles;
drop policy if exists activity_logs_no_update on public.activity_logs;
drop policy if exists activity_logs_no_delete on public.activity_logs;

drop function if exists public.current_tenant_id();
drop function if exists public.is_admin();
