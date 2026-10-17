-- ============================================================================
-- EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql
-- ============================================================================
-- READ-ONLY. Safe to run at any time, on any ledger. It changes nothing.
--
-- WHY
-- ---
-- Migration 005 creates a PARTIAL UNIQUE index:
--
--   create unique index journal_entries_one_posted_per_doc_uidx
--     on public.journal_entries (entry_type, reference_number)
--     where status = 'posted'
--       and reference_number is not null
--       and reference_number <> ''
--       and entry_type in ('sale_invoice','supplier_payment')
--
-- 005 runs inside ONE transaction (`begin; ... commit;`). If the live ledger
-- already contains a duplicate that this index forbids, `create unique index`
-- fails and the WHOLE of 005 rolls back (no partial index, no view). This query
-- uses the EXACT SAME predicate, so it finds precisely the rows that would make
-- 005 fail — and nothing else.
--
-- HOW TO USE
-- ----------
-- Run BLOCK 1 before applying PRODUCTION_ACTIVATION_005_006.sql.
--   * ZERO rows  -> safe to apply the package.
--   * ANY rows   -> resolve those journals first (they are genuine duplicate
--                   postings from before the application guard existed), then
--                   re-run BLOCK 1 until it returns zero rows.
--
-- These queries only READ. They never insert, update, delete or lock rows.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BLOCK 1 (THE GATE): the conflicts that would abort 005.
-- MUST RETURN ZERO ROWS before applying the package.
-- ----------------------------------------------------------------------------
select entry_type,
       reference_number,
       count(*)                       as posted_copies,
       min(created_at)                as first_posted_at,
       max(created_at)                as last_posted_at
  from public.journal_entries
 where status = 'posted'
   and reference_number is not null
   and reference_number <> ''
   and entry_type in ('sale_invoice', 'supplier_payment')
 group by entry_type, reference_number
having count(*) > 1
 order by posted_copies desc, entry_type, reference_number;

-- ----------------------------------------------------------------------------
-- BLOCK 2 (context): the full id list of every conflicting posted journal, so
-- the operator can see exactly which rows to review. READ-ONLY.
-- ----------------------------------------------------------------------------
with dupes as (
  select entry_type, reference_number
    from public.journal_entries
   where status = 'posted'
     and reference_number is not null
     and reference_number <> ''
     and entry_type in ('sale_invoice', 'supplier_payment')
   group by entry_type, reference_number
  having count(*) > 1
)
select j.id, j.entry_type, j.reference_number, j.status, j.created_at,
       j.total_debit, j.total_credit
  from public.journal_entries j
  join dupes d
    on d.entry_type = j.entry_type
   and d.reference_number = j.reference_number
 order by j.entry_type, j.reference_number, j.created_at;

-- ----------------------------------------------------------------------------
-- BLOCK 3 (sanity): is 005 already applied? (view present => yes)
-- ----------------------------------------------------------------------------
select 'v_journal_integrity_issues present' as item,
       (to_regclass('public.v_journal_integrity_issues') is not null) as present;
