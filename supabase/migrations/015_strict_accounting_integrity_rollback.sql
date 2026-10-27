-- ============================================================================
-- 015_strict_accounting_integrity_rollback.sql
--
-- Undoes migration 015:
--   * drops the two receipt-idempotency indexes,
--   * drops the atomic `post_customer_receipt` and `post_customer_receipt_reversal`,
--   * restores the 011 body of `post_journal_entry` by re-running 011.
--
-- NOT LOSSLESS: restoring the 011 function re-opens the account-ownership hole
-- that 015 closes (a tenanted journal may again reference another company's
-- account). That is stated here so the rollback is a deliberate decision.
--
-- It never touches a row: every journal, payment and invoice written through
-- these functions remains valid.
-- ============================================================================

begin;

drop index if exists public.payments_tenant_receipt_uidx;
drop index if exists public.payments_null_tenant_receipt_uidx;

drop function if exists public.post_customer_receipt(jsonb, jsonb, jsonb);
drop function if exists public.post_customer_receipt_reversal(uuid, uuid, jsonb, jsonb);

commit;

-- ----------------------------------------------------------------------------
-- RESTORING post_journal_entry IS A SEPARATE, DELIBERATE STEP.
--
-- 015 replaces the function with `create or replace`, which is not reversible
-- from here: the previous body lives in 011, not in this file. To restore it,
-- re-run the migration file explicitly:
--
--     \i supabase/migrations/011_atomic_journal_posting.sql
--
-- That is deliberately NOT automated. Re-running 011 silently re-opens the
-- account-ownership hole 015 closes (a tenanted journal may again reference
-- another company's account), so an operator must choose it knowingly.
-- ----------------------------------------------------------------------------
