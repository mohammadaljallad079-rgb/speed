-- ============================================================================
-- 005_accounting_integrity.sql
--
-- WHY
-- ---
-- Execution 15 found that the application posts journals from the browser on
-- each document page (there is no shared posting service), and that nothing at
-- the database level prevented the two integrity defects that matter:
--
--   1. A retry (double-click, network resend, or a React re-render) can insert
--      a SECOND posted journal for the same document reference, silently
--      doubling the ledger.
--   2. Duplicate / unbalanced / orphaned journals can accumulate with no way to
--      see them.
--
-- This migration adds the database half of the fix. It is ADDITIVE, FORWARD-ONLY
-- and IDEMPOTENT: it adds two indexes and one read-only view, drops nothing, and
-- rewrites no row. It does NOT recalculate any balance and does NOT touch data.
--
-- The application half is already in place:
--   * `src/lib/accounting/invoice-guards.ts`  - block edit/delete of a posted sale
--   * `src/lib/accounting/payment-posting.ts` - one journal per supplier payment
--
-- SCOPE OF THE UNIQUE INDEX
-- -------------------------
-- One posted journal per document is only true for the two document types that
-- represent a single financial event (`sale_invoice`, `supplier_payment`). A
-- manual `journal_entry` may legitimately reuse a reference, and a future
-- reversal is expected to carry its own type/reference - so the unique index is
-- deliberately limited to those two types, where the invariant is exact.
--
-- APPLY ORDER: after 001 -> 002 -> 003 (and 004 if used). Requires the
-- `journal_entries` table; skips cleanly if it is absent.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Lookup index for the client guard and duplicate scan. Non-unique: it only
--    speeds up `(entry_type, reference_number)` lookups, it constrains nothing.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'journal_entries') then
    execute 'create index if not exists journal_entries_type_ref_idx
             on public.journal_entries (entry_type, reference_number)';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. One posted journal per document, for the two single-event document types.
--    Partial + guarded on column existence so it is safe on any schema state.
--    If a pre-existing duplicate already violates it, `create unique index`
--    fails loudly (that is intended: surface the duplicate, do not hide it).
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'entry_type')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'reference_number')
     and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'journal_entries'
               and column_name = 'status') then
    execute $idx$
      create unique index if not exists journal_entries_one_posted_per_doc_uidx
      on public.journal_entries (entry_type, reference_number)
      where status = 'posted'
        and reference_number is not null
        and reference_number <> ''
        and entry_type in ('sale_invoice', 'supplier_payment')
    $idx$;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Read-only integrity view: duplicate posted journals and unbalanced headers.
--    Never used by a write path; safe to select at any time. Guarded so the
--    migration is a clean no-op on a schema that has no `journal_entries`.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'journal_entries') then
    execute $v$
      create or replace view public.v_journal_integrity_issues as
        select 'duplicate_posted_journal'::text as issue,
               entry_type,
               reference_number,
               count(*)::int as occurrences,
               null::numeric as total_debit,
               null::numeric as total_credit
          from public.journal_entries
         where status = 'posted'
           and reference_number is not null
           and reference_number <> ''
         group by entry_type, reference_number
        having count(*) > 1
        union all
        select 'unbalanced_header'::text as issue,
               entry_type,
               reference_number,
               1::int as occurrences,
               total_debit::numeric,
               total_credit::numeric
          from public.journal_entries
         where total_debit is distinct from total_credit
    $v$;
    execute $c$
      comment on view public.v_journal_integrity_issues is
        'Read-only ledger integrity report. Empty result means no duplicate posted journals and no unbalanced headers.'
    $c$;
  end if;
end $$;

commit;

-- ============================================================================
-- VERIFICATION (read-only; run after applying)
-- ----------------------------------------------------------------------------
--   select * from public.v_journal_integrity_issues;
--   -- expect zero rows on a healthy ledger
--
--   select indexname from pg_indexes
--    where schemaname = 'public'
--      and indexname in ('journal_entries_type_ref_idx',
--                        'journal_entries_one_posted_per_doc_uidx');
--   -- expect both rows
-- ============================================================================
