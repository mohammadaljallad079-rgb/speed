-- ============================================================================
-- 013_booking_invoice_idempotency_rollback.sql
--
-- Emergency rollback for 013_booking_invoice_idempotency.sql.
--
-- NON-DESTRUCTIVE: removes the two indexes and the read-only duplicate view. It
-- drops no column and deletes no row. Rolling back only re-opens the window in
-- which a retried confirmation can invoice a rental twice; the application-side
-- idempotency (`src/lib/rental/confirm-booking.ts`) keeps working either way.
-- ============================================================================

begin;

drop view  if exists public.v_duplicate_rental_invoices;
drop index if exists public.invoices_one_live_per_rental_contract_uidx;
drop index if exists public.invoices_rental_contract_id_idx;

commit;
