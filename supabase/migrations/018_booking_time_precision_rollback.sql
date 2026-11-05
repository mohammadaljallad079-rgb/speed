-- ============================================================================
-- 018_booking_time_precision_rollback.sql
-- Non-destructive rollback of migration 018.
--
-- WHAT IT UNDOES
--   * the exclusion constraint rebuilt at instant precision (the trigger remains)
--   * the window-ordering CHECK constraint
--   * the `start_at`/`end_at`/`start_time`/`end_time` columns (and their data)
--   * the `company_timezone` helper
--
-- WHAT IT DOES NOT DO
--   * it never deletes or edits a booking row
--   * it does NOT restore 017's date-precision trigger. After this rollback the
--     guard is whatever 017 left installed - run
--     supabase/migrations/017_booking_overlap_guard.sql again if you need it.
--
-- Dropping `start_at`/`end_at` loses the precise window. Re-applying 018 restores
-- it from the wall-clock columns, so the round trip is safe for any row that still
-- has `start_date`/`end_date`.
-- ============================================================================

begin;

do $rb$
begin
  if to_regclass('public.rental_contracts') is null then
    raise notice '018 rollback: rental_contracts does not exist; nothing to undo';
    return;
  end if;

  -- The declarative guard first: it depends on the columns.
  alter table public.rental_contracts drop constraint if exists rental_contracts_no_car_overlap;
  alter table public.rental_contracts drop constraint if exists rental_contracts_window_ordered;

  -- The trigger stays installed but must not reference columns that are about to
  -- disappear; drop it and let 017 be re-run for the date-precision guard.
  drop trigger if exists rental_contracts_no_double_booking on public.rental_contracts;

  alter table public.rental_contracts drop column if exists start_at;
  alter table public.rental_contracts drop column if exists end_at;
  alter table public.rental_contracts drop column if exists start_time;
  alter table public.rental_contracts drop column if exists end_time;

  raise notice '018 rollback: precise booking columns and the instant-precision guard removed';
end $rb$;

drop function if exists public.company_timezone(uuid);

commit;
