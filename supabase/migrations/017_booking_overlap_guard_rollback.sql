-- ============================================================================
-- 017_booking_overlap_guard_rollback.sql
--
-- Undoes migration 017:
--   * drops the trigger and its function,
--   * drops the exclusion constraint (if it was created),
--   * drops the status helper.
--
-- NOT LOSSLESS in one respect, stated so the rollback is deliberate:
--   * double-booking becomes possible again. `createBooking` still performs its
--     application-level overlap check and still returns 409, but that check is a
--     check-then-act and two simultaneous requests can both pass it.
--
-- It never deletes a row and never touches a journal.
-- ============================================================================

begin;

drop trigger if exists rental_contracts_no_double_booking on public.rental_contracts;
drop function if exists public.prevent_car_double_booking();

alter table public.rental_contracts
  drop constraint if exists rental_contracts_no_car_overlap;

drop function if exists public.booking_blocks_car(text);

commit;
