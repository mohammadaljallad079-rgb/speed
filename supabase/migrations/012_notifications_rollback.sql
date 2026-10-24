-- ============================================================================
-- 012_notifications_rollback.sql
-- Non-destructive rollback for 012_notifications.sql.
--
-- It removes ONLY the objects 012 created (the table, its policies and its
-- indexes). It never touches another table, another tenant's data or the ledger.
-- Run it only if 012 must be withdrawn.
-- ============================================================================

begin;

drop table if exists public.notifications;

commit;
