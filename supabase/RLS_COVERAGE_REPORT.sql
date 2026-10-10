-- ============================================================================
-- SPEED ERP — RLS COVERAGE REPORT  (read-only)
-- ============================================================================
-- Paste into the Supabase SQL Editor after applying
-- PRODUCTION_ACTIVATION_001_002_003.sql.
--
-- Reports, for every important tenant-owned table:
--   table_name | rls_enabled | policy_count
-- plus the two global safety checks that must both come back clean:
--   * no policy-bearing table left with RLS disabled;
--   * the activity_logs append-only policies are RESTRICTIVE.
-- ============================================================================

-- 1. Per-table coverage for the critical tenant-owned tables.
select
  c.relname            as table_name,
  c.relrowsecurity     as rls_enabled,
  count(p.oid)         as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public' and c.relkind = 'r'
  and c.relname in (
    'tenants','users','profiles','customers','customer_contacts','invoices',
    'invoice_items','invoices_items','payments','sales_returns','journal_entries',
    'journal_lines','journal_entry_lines','accounts','branches','financial_years',
    'suppliers','expenses','quotations','rentals','bookings','employees',
    'activity_logs'
  )
group by c.relname, c.relrowsecurity
order by c.relrowsecurity, c.relname;

-- 2. Any table in public WITHOUT RLS (must return ZERO rows).
select c.relname as table_missing_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
order by c.relname;

-- 3. Every table that has a policy must also have RLS enabled (must be ZERO).
select c.relname as table_with_policy_but_no_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
  and exists (select 1 from pg_policy p where p.polrelid = c.oid)
order by c.relname;

-- 4. activity_logs append-only policies (both MUST be permissive = false).
select
  p.polname        as policy_name,
  case p.polcmd when 'w' then 'UPDATE' when 'd' then 'DELETE' else p.polcmd::text end as command,
  p.polpermissive  as permissive,
  (p.polpermissive = false) as is_restrictive_ok
from pg_policy p
where p.polrelid = 'public.activity_logs'::regclass
  and p.polname in ('activity_logs_no_update','activity_logs_no_delete')
order by p.polname;
