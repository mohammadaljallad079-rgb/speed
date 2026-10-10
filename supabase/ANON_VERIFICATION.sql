-- ============================================================================
-- SPEED ERP — ANON SECURITY VERIFICATION  (read-only / non-destructive)
-- ============================================================================
-- Paste this whole file into the Supabase SQL Editor AFTER applying
-- PRODUCTION_ACTIVATION_001_002_003.sql.
--
-- It proves the `anon` role (the key shipped to every browser) can neither read
-- nor write production data. It is SAFE TO RUN AT ANY TIME:
--   * no rows are inserted, updated or deleted;
--   * every write probe is guarded with `where false`, so even if a privilege
--     were (wrongly) still granted the statement changes nothing;
--   * SELECT probes only count rows.
--
-- EXPECTED RESULT after activation: every row shows `allowed = false`.
-- If any row shows `allowed = true`, the migration did not take effect — STOP
-- and re-check PRODUCTION_ACTIVATION_001_002_003.sql.
--
-- The final query in this file is a plain SELECT so the result is visible in the
-- SQL Editor's result grid.
-- ============================================================================

drop table if exists anon_probe_results;
create temp table anon_probe_results (
  table_name text,
  operation  text,
  allowed    boolean
);

do $$
declare
  t        text;
  allowed  boolean;
  tables   text[] := array[
    'customers','invoices','users','accounts','journal_entries','journal_lines',
    'sales_returns','activity_logs','payments','suppliers','expenses','tenants'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    -- SELECT ----------------------------------------------------------------
    allowed := true;
    execute 'set role anon';
    begin
      execute format('select count(*) from public.%I', t);
    exception when insufficient_privilege then allowed := false;
    end;
    execute 'reset role';
    insert into anon_probe_results values (t, 'SELECT', allowed);

    -- INSERT (guarded: `where false` inserts nothing even if permitted) ------
    allowed := true;
    execute 'set role anon';
    begin
      execute format(
        'insert into public.%I select * from public.%I where false', t, t);
    exception when insufficient_privilege then allowed := false;
             when others then allowed := false;   -- NOT NULL etc. => not denied
    end;
    execute 'reset role';
    insert into anon_probe_results values (t, 'INSERT', allowed);

    -- UPDATE (guarded: `where false` updates nothing even if permitted) ------
    allowed := true;
    execute 'set role anon';
    begin
      execute format('update public.%I set ctid = ctid where false', t);
    exception when insufficient_privilege then allowed := false;
             when others then allowed := false;
    end;
    execute 'reset role';
    insert into anon_probe_results values (t, 'UPDATE', allowed);

    -- DELETE (guarded: `where false` deletes nothing even if permitted) ------
    allowed := true;
    execute 'set role anon';
    begin
      execute format('delete from public.%I where false', t);
    exception when insufficient_privilege then allowed := false;
             when others then allowed := false;
    end;
    execute 'reset role';
    insert into anon_probe_results values (t, 'DELETE', allowed);
  end loop;
end $$;

-- Authoritative privilege check (independent of the behavioural probes above).
select table_name, operation, allowed from anon_probe_results order by table_name, operation;

-- Cross-check with the catalogue: every column MUST be false after activation.
select t as table_name,
  has_table_privilege('anon', 'public.' || t, 'SELECT') as anon_select,
  has_table_privilege('anon', 'public.' || t, 'INSERT') as anon_insert,
  has_table_privilege('anon', 'public.' || t, 'UPDATE') as anon_update,
  has_table_privilege('anon', 'public.' || t, 'DELETE') as anon_delete
from (values
  ('customers'),('invoices'),('users'),('accounts'),('journal_entries'),
  ('journal_lines'),('sales_returns'),('activity_logs'),('payments'),('suppliers')
) as v(t)
order by t;

-- Summary: must be `0` (zero anon-permitted operations).
select count(*) as anon_permitted_operations
from anon_probe_results
where allowed = true;
