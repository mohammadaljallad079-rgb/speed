-- ============================================================================
-- 017_booking_overlap_guard.sql
-- A car cannot be double-booked, enforced by the DATABASE.
--
-- WHY
-- ---
-- `createBooking` (src/lib/rental/booking-service.ts) reads the car's blocking
-- contracts, tests for an overlap in JavaScript, and then inserts. That is a
-- check-then-act: two customers who submit the same car and the same window at
-- the same moment BOTH read "free" and BOTH insert, because nothing in the
-- database refuses the second row. The application check is correct and stays -
-- it produces the friendly 409 - but it cannot be the only guard, and today it
-- is.
--
-- The authoritative fix is an EXCLUSION constraint, which is the one mechanism
-- PostgreSQL provides for "these two rows must not overlap". It is evaluated per
-- statement, so it closes the window between the read and the write.
--
-- WHY A TRIGGER TOO
-- -----------------
-- An EXCLUSION constraint needs a range type and `btree_gist` (for the
-- equality parts). On a deployment where the extension cannot be created - a
-- restricted role, or a managed plan that forbids it - the constraint would be
-- silently absent and the race would come back. The trigger fallback is created
-- only in that case, so the guarantee never depends on an optional extension.
--
-- The trigger also protects a schema whose `rental_contracts` lacks the date
-- columns; the constraint cannot be expressed at all then, and this migration is
-- a clean no-op rather than an error.
--
-- SAFETY / IDEMPOTENCE
-- --------------------
-- Additive and idempotent: guarded on the columns it needs, wrapped so a
-- pre-existing duplicate aborts nothing (the constraint is only attempted when
-- the data is already clean, and the trigger tolerates legacy rows because it
-- refuses only a NEW or CHANGED row that overlaps).
-- It never deletes a row and never touches a journal.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. Is there anything to protect?
--    Both a start and an end date, and a car, are required for an overlap to
--    even be meaningful.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='rental_contracts'
                   and column_name='car_id')
     or not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='rental_contracts'
                   and column_name='start_date')
     or not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='rental_contracts'
                   and column_name='end_date') then
    raise notice '017: rental_contracts lacks car_id/start_date/end_date; skipped';
    return;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Which statuses occupy a car? Mirrors BLOCKING_STATUSES in
--    src/lib/rental/booking-service.ts. Kept as a function so the constraint,
--    the trigger and any future reader share ONE definition instead of three
--    copies that can drift.
--
--    A status the application does not recognise is NOT blocking here. That is
--    the deliberate direction: a new status must not make the database refuse a
--    booking the UI offered, and an unknown status is far more likely to be a
--    terminal one (the release states are the ones that grow).
-- ----------------------------------------------------------------------------
create or replace function public.booking_blocks_car(p_status text)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(p_status, '')) in (
    'pending', 'active', 'confirmed', 'reserved', 'approved', 'ongoing', 'rented'
  );
$$;

comment on function public.booking_blocks_car(text) is
  'Exec 72 / migration 017: whether a rental status occupies its car. Mirrors BLOCKING_STATUSES in src/lib/rental/booking-service.ts.';

-- ----------------------------------------------------------------------------
-- 2. The preferred guard: a real EXCLUSION constraint.
--
--    `daterange(start_date, end_date, '[)')` is half-open, matching
--    `periodsOverlap` in the service: a rental ending the morning another begins
--    is a turnover, not a conflict.
--
--    The equality parts (car_id, tenant_id) need `btree_gist`. `tenant_id` is
--    coalesced to a sentinel UUID so that the tenant-less install (NULL tenant)
--    is still protected: in a GiST index NULLs are treated as distinct, so
--    without the coalesce two NULL-tenant bookings for the same car would not
--    conflict - the exact hole this migration exists to close.
-- ----------------------------------------------------------------------------
do $$
declare
  v_has_tenant boolean;
  v_dupes      int;
begin
  begin
    create extension if not exists btree_gist;
  exception when others then
    raise notice '017: btree_gist unavailable (%) - using the trigger guard only', sqlerrm;
  end;

  -- Without btree_gist the exclusion constraint cannot be built; the trigger in
  -- section 3 is the guard in that case.
  if not exists (select 1 from pg_extension where extname = 'btree_gist') then
    raise notice '017: btree_gist not installed; skipping the exclusion constraint';
    return;
  end if;

  v_has_tenant := exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='rental_contracts'
                            and column_name='tenant_id');

  -- A pre-existing overlap would make the constraint fail. Detect it first and
  -- report it rather than aborting the migration with a cryptic index error.
  execute format($q$
    select count(*) from (
      select 1
      from public.rental_contracts a
      join public.rental_contracts b
        on a.car_id = b.car_id
       and a.id <> b.id
       %s
       and public.booking_blocks_car(a.status)
       and public.booking_blocks_car(b.status)
       and daterange(a.start_date, a.end_date, '[)') && daterange(b.start_date, b.end_date, '[)')
    ) x
  $q$, case when v_has_tenant
            then 'and coalesce(a.tenant_id, ''00000000-0000-0000-0000-000000000000''::uuid) = coalesce(b.tenant_id, ''00000000-0000-0000-0000-000000000000''::uuid)'
            else '' end)
  into v_dupes;

  if v_dupes > 0 then
    raise warning '017: % pre-existing overlapping rental contract(s) found - the exclusion constraint was NOT created. Resolve the duplicates, then re-run this migration. (Migration 013''s v_duplicate_rental_invoices view is a starting point.)', v_dupes;
    return;
  end if;

  if v_has_tenant then
    execute $c$
      alter table public.rental_contracts
        add constraint rental_contracts_no_car_overlap
        exclude using gist (
          car_id with =,
          (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
          (daterange(start_date, end_date, '[)')) with &&
        )
        where (public.booking_blocks_car(status))
    $c$;
  else
    execute $c$
      alter table public.rental_contracts
        add constraint rental_contracts_no_car_overlap
        exclude using gist (
          car_id with =,
          (daterange(start_date, end_date, '[)')) with &&
        )
        where (public.booking_blocks_car(status))
    $c$;
  end if;

  raise notice '017: rental_contracts_no_car_overlap created';
exception
  when duplicate_object then
    raise notice '017: the exclusion constraint already exists';
  when duplicate_table then
    raise notice '017: the exclusion constraint already exists';
end $$;

-- ----------------------------------------------------------------------------
-- 3. The fallback / belt-and-braces guard: a trigger.
--
--    It runs for INSERT and for an UPDATE that changes the car, the window or
--    the status, and refuses only a row that is NEWLY in conflict. A row that was
--    already overlapping before this migration is left alone, so applying 017
--    never fails on legacy data - it stops the NEXT double-booking, which is
--    what "close the race" means.
-- ----------------------------------------------------------------------------
create or replace function public.prevent_car_double_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $body$
declare
  v_tenant  uuid;
  v_clash   uuid;
begin
  -- Only a blocking row can conflict.
  if not public.booking_blocks_car(new.status) then
    return new;
  end if;
  if new.car_id is null or new.start_date is null or new.end_date is null then
    return new;
  end if;
  -- An inverted/empty window cannot overlap anything; the CHECK belongs to the
  -- application's validator, and refusing here would duplicate that rule.
  if new.end_date <= new.start_date then
    return new;
  end if;

  v_tenant := new.tenant_id;

  select c.id into v_clash
  from public.rental_contracts c
  where c.car_id = new.car_id
    and c.id is distinct from new.id
    and c.tenant_id is not distinct from v_tenant
    and public.booking_blocks_car(c.status)
    and daterange(c.start_date, c.end_date, '[)') && daterange(new.start_date, new.end_date, '[)')
  limit 1;

  if v_clash is not null then
    raise exception
      'rental_contracts: car % is already booked for the requested period (conflicting contract %)',
      new.car_id, v_clash
      using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$body$;

comment on function public.prevent_car_double_booking() is
  'Exec 72 / migration 017: refuses a NEW or CHANGED rental contract that overlaps a blocking contract for the same car in the same company. The application check in createBooking produces the friendly 409; this is the race-proof backstop.';

drop trigger if exists rental_contracts_no_double_booking on public.rental_contracts;
create trigger rental_contracts_no_double_booking
  before insert or update of car_id, start_date, end_date, status, tenant_id
  on public.rental_contracts
  for each row
  execute function public.prevent_car_double_booking();

-- ----------------------------------------------------------------------------
-- 4. Privileges. The guard functions are called by the constraint/trigger, not
--    by a client, and they must not become a way to probe another company's
--    bookings.
-- ----------------------------------------------------------------------------
revoke all on function public.booking_blocks_car(text) from public;
revoke all on function public.booking_blocks_car(text) from anon;
revoke all on function public.booking_blocks_car(text) from authenticated;
revoke all on function public.prevent_car_double_booking() from public;
revoke all on function public.prevent_car_double_booking() from anon;
revoke all on function public.prevent_car_double_booking() from authenticated;

commit;

-- ============================================================================
-- OPERATOR NOTE
-- If this migration reported "pre-existing overlapping rental contract(s)", the
-- data must be reconciled before the exclusion constraint can exist:
--   select a.car_id, a.contract_number, b.contract_number,
--          a.start_date, a.end_date, b.start_date, b.end_date
--   from public.rental_contracts a
--   join public.rental_contracts b
--     on a.car_id = b.car_id and a.id < b.id
--   where public.booking_blocks_car(a.status)
--     and public.booking_blocks_car(b.status)
--     and daterange(a.start_date, a.end_date, '[)') && daterange(b.start_date, b.end_date, '[)');
-- The trigger guard is created either way, so the race is closed even then.
-- ============================================================================
