-- ============================================================================
-- 005_accounting_integrity_rollback.sql
--
-- Emergency rollback for 005_accounting_integrity.sql.
--
-- NON-DESTRUCTIVE: removes the two indexes and the integrity view. It drops no
-- column and deletes no row. Rolling back only re-opens the window where a
-- retried request can insert a duplicate posted journal; the application-side
-- guards (invoice-guards.ts, payment-posting.ts) keep working either way.
-- ============================================================================

begin;

drop index if exists public.journal_entries_one_posted_per_doc_uidx;
drop index if exists public.journal_entries_type_ref_idx;
drop view  if exists public.v_journal_integrity_issues;

commit;
