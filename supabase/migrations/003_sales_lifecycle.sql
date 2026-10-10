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
