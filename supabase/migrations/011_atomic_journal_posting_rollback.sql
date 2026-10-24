-- ============================================================================
-- 011_atomic_journal_posting_rollback.sql
-- Undo migration 011. Drops only the function it created.
--
-- Safe by construction: `post_journal_entry` writes ordinary
-- journal_entries/journal_lines rows, so dropping it never invalidates a journal
-- that was already posted. After this rollback the application falls back to the
-- two-request write path (`writeJournal`), which still works - it is simply no
-- longer atomic.
-- ============================================================================

begin;

drop function if exists public.post_journal_entry(jsonb, jsonb);

commit;
