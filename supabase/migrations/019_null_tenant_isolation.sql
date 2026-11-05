-- ============================================================================
-- 019_null_tenant_isolation.sql
-- Close the NULL-tenant authorization hole for SPEED rental customers.
--
-- WHY (the defect, reproduced by execution)
-- -----------------------------------------
-- The platform has two customer categories that share one database:
--
--   * a SPEED rental customer - an individual who books SPEED-owned cars. It has
--     `role = 'client'` and, on this install, `tenant_id IS NULL` (it belongs to
--     no ERP company).
--   * an ERP SaaS company user - `role` in ('admin','staff'), always inside its
--     own tenant.
--
-- 002/004 isolate every table with `can_read_tenant(tenant_id)`, which for a
-- tenant-less caller reduces to `tenant_id IS NULL`. A rental customer is
-- tenant-less, so it satisfied that predicate for EVERY tenant-less row - and on
-- this install most operational rows are tenant-less. Reproduced against a real
-- PostgreSQL 17 with the 001->018 schema and real `authenticated` identities:
--
--   READ  invoices: another customer's row     -> 1
--   READ  invoices: all null-tenant rows       -> 1
--   READ  rental_contracts: another customer's -> 1
--   READ  customers: another customer's PII    -> 1
--   READ  journal_entries / accounts / suppliers / branches / employees -> 1+
--   READ  users: other null-tenant rows        -> 1
--   WRITE cars: UPDATE / DELETE / INSERT       -> PERMITTED
--   WRITE journal_entries: DELETE              -> PERMITTED
--   WRITE accounts: DELETE                     -> PERMITTED
--   WRITE invoices: INSERT for another customer-> PERMITTED
--
-- 016 already fixes the customer-owned tables (`rental_contracts`,
-- `support_tickets`, `documents`, `customers`, `users`) and the self-escalation
-- path. It does NOT cover `invoices`, `payments` or the ERP-only tables, and it
-- does not restrict DELETE. This migration closes what 016 leaves open.
--
-- WHAT THIS DOES
-- --------------
--   1. `is_client_only()` - true for a `client` identity. Fails CLOSED: an
--      unknown / NULL / invalid role is treated as a restricted rental customer,
--      never as an ERP user.
--   2. RESTRICTIVE `_erp_only` policies on the tables that are the ERP itself
--      (`financial_years`, `settings`, `branches`, `employees`, `suppliers`,
--      `expense_accounts`, `tax_settings`, `tax_rates`, ...): an ERP user reads
--      and writes them; a rental customer sees nothing. A RESTRICTIVE policy is
--      ANDed with the permissive tenant policy, so it can only NARROW access and
--      an ERP user keeps exactly the access it had.
--   3. RESTRICTIVE `_client_own` policies on `invoices` and `payments` - a
--      customer sees only rows carrying its own `customer_id`. These are the
--      portal's financial documents and were the worst leak.
--   4. RESTRICTIVE `_erp_write` policies on the destructive verbs of the
--      financial and operational tables: a rental customer may not DELETE (or,
--      where it has no business writing at all, INSERT/UPDATE) another party's
--      ledger. `can_read_tenant` alone was standing in for "may delete", which
--      it never meant.
--   5. `cars` keeps the tenant-scoped SELECT from 016 (so a customer still
--      browses its own company's catalog) but a rental customer may no longer
--      INSERT, UPDATE or DELETE a vehicle - SPEED's fleet is not customer data.
--   6. `reserve_rental_customer_identity()` - a BEFORE trigger that refuses a
--      self-service change to a rental customer's own role, tenant or customer
--      link even where a permissive policy would allow the row update. The
--      provisioning path (`auth.uid() is null`) and administrators are exempt, so
--      signup and user administration keep working.
--
-- DELIBERATELY NOT DONE
-- ---------------------
--   * No row is rewritten, deleted or re-owned. The existing tenant-less SPEED
--     rental customers, their contracts and their cars keep their identity.
--   * 017/018 (booking overlap guard, timestamp precision) are untouched.
--   * A rental customer still reads its own tenant's `cars`; removing that would
--     empty the booking catalog.
--
-- ADDITIVE / IDEMPOTENT: every object is `create or replace` or dropped-then-
-- created, and every block is guarded on the table and column existing, so it is
-- a clean no-op on a schema that predates the column.
--
-- APPLY ORDER: after 001 -> 018 (it depends on 016's `is_erp_user()`).
-- Rollback: 019_null_tenant_isolation_rollback.sql
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. Prerequisite helpers.
--
--    `is_erp_user()` and `current_customer_id()` are introduced by 016. They are
--    (re)created here with identical definitions so that 019 is correct whether
--    or not 016 has been applied yet - an ordering trap in an operator-run
--    migration is a security defect waiting to happen. `create or replace` is a
--    no-op when 016 already ran.
--
--    Both are guarded on `users.customer_id` existing, because the function body
--    is validated at CREATE time for a SQL-language function.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'users'
                   and column_name = 'customer_id') then
    raise exception
      '019 requires public.users.customer_id (the Auth-identity -> customer link)';
  end if;
end $$;

create or replace function public.current_customer_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select customer_id from public.users where id = auth.uid();
$$;

-- ----------------------------------------------------------------------------
-- 1. Is the caller an ERP user, and is the caller a rental customer?
--
--    `client` is the only non-ERP role. Anything that is NOT an ERP user is
--    treated as a rental customer, so an unknown / NULL / invalid role gets the
--    restriction rather than the wide access - the fail-closed direction.
--    `is_client_only()` is the exact complement of `is_erp_user()`.
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

create or replace function public.is_client_only()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and not public.is_erp_user();
$$;

-- ----------------------------------------------------------------------------
-- 2. ERP-only tables: a rental customer sees nothing, writes nothing.
--
--    RESTRICTIVE, so the permissive tenant policy from 002/004 still decides
--    which rows an ERP user may touch; this only excludes the rental customer.
--    `settings` is the sensitive one - it holds company configuration and, on
--    this install, tenant-scoped secrets.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
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
    'oil_service_records', 'activity_logs', 'purchase_sale_links'
  ];
begin
  foreach t in array tables loop
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t || '_erp_only', t);
    execute format($f$
      create policy %I on public.%I
        as restrictive
        for all to authenticated
        using (public.is_erp_user())
        with check (public.is_erp_user())
    $f$, t || '_erp_only', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. `invoices` and `payments`: a rental customer sees only its own documents.
--
--    These carry `customer_id`, so ownership is a verified relationship rather
--    than an inference from a NULL tenant. A row whose `customer_id` is NULL
--    belongs to no portal account and is visible to the office only - showing it
--    to every tenant-less customer is exactly the leak being closed.
--
--    RESTRICTIVE and `for all`: a customer may also only ever write its own.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array['invoices', 'payments'];
begin
  foreach t in array tables loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = t
                     and column_name = 'customer_id') then
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t || '_client_own', t);
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
    $f$, t || '_client_own', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Destructive verbs are not implied by "may read the tenant".
--
--    002's `_tenant_delete` policy uses `can_read_tenant(tenant_id)`. For a
--    tenant-less caller that is `tenant_id IS NULL`, so a rental customer could
--    delete the SPEED ledger and the chart of accounts. Deletion is an
--    authorization decision in its own right, so it gets its own RESTRICTIVE
--    policy: an ERP user may delete (the permissive policy still decides which
--    rows), a rental customer may not.
--
--    `insert`/`update` are restricted only where a rental customer has no
--    business writing the table at all (`accounts`, `journal_entries`,
--    `journal_lines`); for the transactional tables an office user's writes stay
--    exactly as they were.
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  delete_gated text[] := array[
    'accounts', 'journal_entries', 'journal_lines', 'journal_entry_lines',
    'journal_attachments', 'invoices', 'payments', 'expenses',
    'purchase_invoices', 'purchase_invoice_items', 'purchase_orders',
    'purchase_order_items', 'quotations', 'debit_notes', 'supplier_payments',
    'sales_returns', 'sales_contracts', 'rentals', 'rental_contracts',
    'cars', 'customers',
    'support_tickets', 'documents'
  ];
  full_gated text[] := array[
    'accounts', 'journal_entries', 'journal_lines', 'journal_entry_lines',
    'journal_attachments'
  ];
begin
  foreach t in array delete_gated loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = t
                     and column_name = 'tenant_id') then
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t || '_erp_delete', t);
    execute format($f$
      create policy %I on public.%I
        as restrictive
        for delete to authenticated
        using (public.is_erp_user())
    $f$, t || '_erp_delete', t);
  end loop;

  foreach t in array full_gated loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = t
                     and column_name = 'tenant_id') then
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t || '_erp_write', t);
    execute format($f$
      create policy %I on public.%I
        as restrictive
        for insert to authenticated
        with check (public.is_erp_user())
    $f$, t || '_erp_write', t);
    execute format('drop policy if exists %I on public.%I', t || '_erp_update', t);
    execute format($f$
      create policy %I on public.%I
        as restrictive
        for update to authenticated
        using (public.is_erp_user())
        with check (public.is_erp_user())
    $f$, t || '_erp_update', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 5. `cars`: a rental customer may browse, never modify.
--
--    016 already replaced `cars_tenant_select` with the tenant-scoped read a
--    customer needs (its own company's fleet). This adds the write side: the
--    fleet is SPEED's asset, so INSERT/UPDATE/DELETE is an ERP operation.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'cars'
                   and column_name = 'tenant_id') then
    return;
  end if;

  drop policy if exists cars_erp_insert on public.cars;
  create policy cars_erp_insert on public.cars
    as restrictive for insert to authenticated
    with check (public.is_erp_user());

  drop policy if exists cars_erp_update on public.cars;
  create policy cars_erp_update on public.cars
    as restrictive for update to authenticated
    using (public.is_erp_user())
    with check (public.is_erp_user());
end $$;

-- ----------------------------------------------------------------------------
-- 6. A rental customer may not change its own identity.
--
--    016's `prevent_self_privilege_escalation` already protects role, tenant,
--    customer link, permissions and active state for a non-admin. This trigger
--    states the same rule for the rental-customer case explicitly, so the
--    guarantee does not depend on 016 being present, and so an unknown role
--    (treated as `client` by `is_client_only()`) is covered too.
--
--    The comparison uses `to_jsonb` so a column that does not exist on a given
--    install is simply absent rather than a compile error.
-- ----------------------------------------------------------------------------
create or replace function public.reserve_rental_customer_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n jsonb := to_jsonb(new);
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
begin
  -- Direct/service-role connection: provisioning (signup, operator scripts).
  if auth.uid() is null then
    return new;
  end if;
  -- An ERP administrator manages users inside its own tenant.
  if public.is_admin() then
    return new;
  end if;
  -- Only a rental customer is confined here.
  if not public.is_client_only() then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if n->'role' is distinct from o->'role' then
      raise exception 'A rental customer may not change its own role'
        using errcode = '42501';
    end if;
    if n->'tenant_id' is distinct from o->'tenant_id' then
      raise exception 'A rental customer may not change its own tenant'
        using errcode = '42501';
    end if;
    if n->'customer_id' is distinct from o->'customer_id' then
      raise exception 'A rental customer may not change its own customer link'
        using errcode = '42501';
    end if;
    if n->'permissions' is distinct from o->'permissions' then
      raise exception 'A rental customer may not change its own permissions'
        using errcode = '42501';
    end if;
    if n->'is_active' is distinct from o->'is_active' then
      raise exception 'A rental customer may not change its own active state'
        using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'users') then
    drop trigger if exists users_reserve_client_identity on public.users;
    create trigger users_reserve_client_identity
      before insert or update on public.users
      for each row execute function public.reserve_rental_customer_identity();
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 7. Grants. An authorization predicate is not an anon-callable endpoint.
-- ----------------------------------------------------------------------------
-- Every helper 019 creates or replaces. A `create or replace` keeps an existing
-- ACL, but on a schema where 016 never ran these would sit at the PUBLIC-execute
-- default, so 019 states the revoke itself rather than depending on 016.
-- `authenticated` keeps EXECUTE on the predicates the policies evaluate in the
-- caller's session; `anon` gets none, so they are not an unauthenticated probe.
do $$
begin
  if to_regprocedure('public.is_client_only()') is not null then
    revoke all on function public.is_client_only() from public;
    revoke all on function public.is_client_only() from anon;
    grant execute on function public.is_client_only() to authenticated;
  end if;
  if to_regprocedure('public.is_erp_user()') is not null then
    revoke all on function public.is_erp_user() from public;
    revoke all on function public.is_erp_user() from anon;
    grant execute on function public.is_erp_user() to authenticated;
  end if;
  if to_regprocedure('public.current_customer_id()') is not null then
    revoke all on function public.current_customer_id() from public;
    revoke all on function public.current_customer_id() from anon;
    grant execute on function public.current_customer_id() to authenticated;
  end if;
  if to_regprocedure('public.reserve_rental_customer_identity()') is not null then
    revoke all on function public.reserve_rental_customer_identity() from public;
    revoke all on function public.reserve_rental_customer_identity() from anon;
  end if;
end $$;

commit;
