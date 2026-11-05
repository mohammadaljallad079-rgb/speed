-- Enumerate the FULL NULL-tenant leak surface for a rental customer.
-- Prints one line per surface: the value read, or PERMITTED/denied for a write.
do $$
declare
  c1  uuid := 'a0000001-0000-0000-0000-000000000001';
  car uuid := 'e0000001-0000-0000-0000-000000000001';
  n int;
  surface text;
  val text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', c1)::text, true);
  set local role authenticated;

  for surface, val in
    select 'invoices: other customer row',       (select count(*)::text from public.invoices where invoice_number='INV-2')
    union all select 'invoices: all null-tenant',  (select count(*)::text from public.invoices)
    union all select 'payments: all null-tenant',  (select count(*)::text from public.payments)
    union all select 'rental_contracts: other',  (select count(*)::text from public.rental_contracts where contract_number='RC-C2')
    union all select 'rental_contracts: own',    (select count(*)::text from public.rental_contracts where contract_number='RC-900020')
    union all select 'customers: other',         (select count(*)::text from public.customers where name='Rental Customer 2')
    union all select 'customers: own',           (select count(*)::text from public.customers where name='Rental Customer 1')
    union all select 'users: super admin row',   (select count(*)::text from public.users where role='super_admin')
    union all select 'financial_years',          (select count(*)::text from public.financial_years)
    union all select 'settings',                 (select count(*)::text from public.settings)
    union all select 'branches',                 (select count(*)::text from public.branches)
    union all select 'employees',                (select count(*)::text from public.employees)
    union all select 'journal_entries',          (select count(*)::text from public.journal_entries)
    union all select 'accounts',                 (select count(*)::text from public.accounts)
    union all select 'suppliers',                (select count(*)::text from public.suppliers)
    union all select 'cars: catalog (want >0)',  (select count(*)::text from public.cars)
  loop
    raise notice 'READ  % => %', rpad(surface, 32), val;
  end loop;

  for surface in
    select 'cars: update daily_rate' union all
    select 'cars: delete'            union all
    select 'cars: insert new'        union all
    select 'invoices: update other'  union all
    select 'invoices: delete other'  union all
    select 'invoices: insert'        union all
    select 'customers: update other' union all
    select 'customers: delete other' union all
    select 'financial_years: delete' union all
    select 'settings: delete'        union all
    select 'journal_entries: delete' union all
    select 'accounts: delete'
  loop
    begin
      if surface = 'cars: update daily_rate' then update public.cars set daily_rate=0 where id=car;
      elsif surface = 'cars: delete' then delete from public.cars where id=car;
      elsif surface = 'cars: insert new' then insert into public.cars (tenant_id, make) values (null, 'Evil');
      elsif surface = 'invoices: update other' then update public.invoices set total_amount=0 where invoice_number='INV-2';
      elsif surface = 'invoices: delete other' then delete from public.invoices where invoice_number='INV-2';
      elsif surface = 'invoices: insert' then insert into public.invoices (tenant_id, customer_id, invoice_number) values (null, 'c0000002-0000-0000-0000-000000000002', 'INV-EVIL');
      elsif surface = 'customers: update other' then update public.customers set name='hacked' where name='Rental Customer 2';
      elsif surface = 'customers: delete other' then delete from public.customers where name='Rental Customer 2';
      elsif surface = 'financial_years: delete' then delete from public.financial_years;
      elsif surface = 'settings: delete' then delete from public.settings;
      elsif surface = 'journal_entries: delete' then delete from public.journal_entries;
      elsif surface = 'accounts: delete' then delete from public.accounts;
      end if;
      get diagnostics n = row_count;
      raise notice 'WRITE % => PERMITTED (% row)', rpad(surface, 32), n;
    exception when others then
      raise notice 'WRITE % => denied', rpad(surface, 32);
    end;
  end loop;
end $$;
