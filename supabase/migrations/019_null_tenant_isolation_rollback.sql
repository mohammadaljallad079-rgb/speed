-- ============================================================================
-- 019_null_tenant_isolation_rollback.sql
-- Reverses migration 019 exactly: it drops only the objects 019 created.
--
-- SCOPE
-- -----
-- Dropping these policies RESTORES the NULL-tenant leak that 019 closes, so this
-- is an emergency-only step. Run it only to unblock a production incident that
-- 019 caused; re-apply 019 as soon as the cause is understood.
--
-- It deliberately does NOT touch:
--   * the data - no row is deleted, re-owned or modified;
--   * 016's `is_erp_user()` / `current_customer_id()` / `prevent_self_privilege_
--     escalation` / `_customer_own` policies (they belong to 016);
--   * 017/018's booking guards and timestamp columns;
--   * the existing tenant policies from 002/004.
--
-- It DOES drop `is_client_only()` and `reserve_rental_customer_identity()`,
-- because 019 created them and nothing older depends on them.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The RESTRICTIVE policies added by 019.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  suffix text;
  policies text[] := array[
    'financial_years', 'settings', 'branches', 'employees', 'suppliers',
    'accounts', 'journal_entries', 'journal_entry_lines', 'expense_accounts', 'tax_settings', 'tax_rates', 'document_sequences',
    'journal_templates', 'journal_template_lines', 'recurring_journals',
    'recurring_journal_lines', 'alert_rules', 'sidebar_settings',
    'financial_ratios', 'financial_ratio_history', 'financial_health_score',
    'kpi_results', 'ai_recommendations', 'ai_repair_executions',
    'purchase_orders', 'purchase_order_items', 'purchase_requisitions',
    'purchase_requisition_items', 'purchase_invoices', 'purchase_invoice_items',
    'attendance', 'bonuses', 'deductions', 'car_loans',
    'car_loan_installments', 'credits', 'drivers', 'maintenance',
    'oil_service_records', 'activity_logs', 'purchase_sale_links',
    'invoices', 'payments',
    'accounts', 'journal_entries', 'journal_lines', 'journal_entry_lines',
    'journal_attachments', 'expenses', 'quotations', 'debit_notes',
    'supplier_payments', 'sales_returns', 'sales_contracts', 'rentals',
    'rental_contracts', 'cars', 'customers', 'support_tickets', 'documents'
  ];
  suffixes text[] := array[
    '_erp_only', '_client_own', '_erp_delete', '_erp_write', '_erp_update',
    '_erp_insert'
  ];
begin
  foreach t in array policies loop
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      continue;
    end if;
    foreach suffix in array suffixes loop
      execute format('drop policy if exists %I on public.%I', t || suffix, t);
    end loop;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2. The trigger and the function 019 created.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'users') then
    drop trigger if exists users_reserve_client_identity on public.users;
  end if;
  drop function if exists public.reserve_rental_customer_identity();
  drop function if exists public.is_client_only();
end $$;

commit;
