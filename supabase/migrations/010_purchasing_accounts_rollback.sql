-- ============================================================================
-- 010_purchasing_accounts_rollback.sql
-- Reverses 010_purchasing_accounts.sql.
--
-- Removes exactly what 010 created: the two seeded accounts and the debit-note
-- document sequence. It does NOT touch any account that already existed, and it
-- does not delete a debit note or a journal — a document that posted against
-- these accounts keeps its history.
--
-- Run only if the accounts were seeded and no live document depends on them.
-- ============================================================================

begin;

-- 1. Debit-note sequence.
delete from public.document_sequences where doc_type = 'debit_note';

-- 2. Seeded accounts. Guarded on there being no journal line against them, so a
--    rollback can never orphan a posted entry.
delete from public.accounts a
 where a.code in ('24001', '51099')
   and not exists (select 1 from public.journal_lines l where l.account_id = a.id);

commit;

-- ============================================================================
-- VERIFICATION (read-only; run after rollback)
--
--   select code from public.accounts where code in ('24001', '51099');
--   -- expect ZERO rows when neither account is in use
--
--   select doc_type from public.document_sequences where doc_type = 'debit_note';
--   -- expect ZERO rows
-- ============================================================================
