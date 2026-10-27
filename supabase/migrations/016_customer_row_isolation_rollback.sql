-- ============================================================================
-- 016_customer_row_isolation_rollback.sql
--
-- Undoes migration 016:
--   * drops the customer-ownership policies (rental_contracts, support_tickets,
--     documents, customers, users),
--   * drops the self-privilege-escalation trigger and function,
--   * restores the plain tenant `cars` select policy,
--   * drops the two helper functions.
--
-- NOT LOSSLESS in two respects, both stated so the rollback is a deliberate
-- decision rather than a surprise:
--   * a rental customer can again read every other customer's contracts, tickets
--     and PII in the same company - the tenant boundary is NOT a customer
--     boundary;
--   * a non-administrator can again set its own `users.role`, which is a
--     privilege escalation into the company ERP.
--
-- It never deletes a row and never touches a journal.
-- ============================================================================

begin;

drop trigger if exists users_prevent_self_privilege_escalation on public.users;
drop function if exists public.prevent_self_privilege_escalation();

drop policy if exists rental_contracts_customer_own on public.rental_contracts;
drop policy if exists support_tickets_customer_own on public.support_tickets;
drop policy if exists documents_customer_own on public.documents;
drop policy if exists customers_customer_own on public.customers;
drop policy if exists users_client_self_only on public.users;

-- Restore the permissive tenant policy the 002 loop would have created.
drop policy if exists cars_tenant_select on public.cars;
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'cars'
               and column_name = 'tenant_id') then
    create policy cars_tenant_select on public.cars
      for select to authenticated
      using (public.can_read_tenant(tenant_id));
  end if;
end $$;

drop function if exists public.current_customer_id();
drop function if exists public.is_erp_user();

commit;
