-- ============================================================================
-- 017_booking_overlap_guard.sql
-- A car cannot be double-booked, enforced by the DATABASE, at the precision the
-- booking actually has.
--
-- WHY
-- ---
-- `createBooking` (src/lib/rental/booking-service.ts) reads the car's blocking
-- contracts, tests for an overlap in JavaScript, and then inserts. That is a
-- check-then-act: two customers who submit the same car and the same window at
-- the same moment BOTH read "free" and BOTH insert. The application check is
-- correct and stays - it produces the friendly 409 - but it cannot be the only
-- guard.
--
-- THE FIRST VERSION OF THIS MIGRATION DID NOT CLOSE THE RACE
-- ---------------------------------------------------------
-- Its fallback trigger read `select ... from rental_contracts` with no lock. Under
-- READ COMMITTED that select uses the statement snapshot, so it cannot see a row
-- another transaction has inserted but not committed: two sessions still both
-- read "no conflict" and both commit. That is proved, not argued, by
-- `supabase/tests/017_harness/race.py` ("plain SELECT lets BOTH sessions commit").
--
-- The trigger therefore takes a TRANSACTION-LEVEL ADVISORY LOCK keyed on
-- (tenant, car) before it reads. `pg_advisory_xact_lock` blocks a concurrent
-- inserter for the same car until the first transaction ends, so the read and the
-- write become atomic with respect to that car. The lock is released by the
-- transaction, so a failed insert releases it too. This is the guard that works
-- with no extension and on a schema with pre-existing overlaps - the
-- "demonstrably race-safe alternative" that lets activation proceed.
--
-- WHY AN EXCLUSION CONSTRAINT TOO
-- -------------------------------
-- An EXCLUSION constraint is PostgreSQL's declarative "these two rows must not
-- overlap", enforced by the index, so it cannot be bypassed by a session that
-- forgets the trigger. It needs `btree_gist` (for the equality parts). When the
-- extension or clean data is unavailable the constraint is skipped - but the
-- advisory-lock trigger is ALWAYS installed, so the guarantee never depends on an
-- optional extension.
--
-- PRECISION AND TIME
-- ------------------
-- A calendar-date guard is wrong if the booking carries a pickup/return TIME:
-- 09:00-11:00 and 10:00-12:00 on the same day are different bookings, and a
-- date-only range would refuse the second. This migration detects the real
-- columns and builds the window from the highest precision present:
--
--   1. `start_at` / `end_at`   (timestamptz)            -> tstzrange (instants)
--   2. `start_date`+`end_date`+`start_time`+`end_time`  -> tsrange on the combined
--      LOCAL timestamp; a null time is midnight, so a date-only row still works
--   3. `start_date` / `end_date`                        -> tsrange on midnight
--
-- All windows are half-open `[)`, matching `periodsOverlap` in the service: a
-- rental ending when the next begins is a turnover, not a conflict.
--
-- FAIL-CLOSED ACTIVATION
-- ----------------------
-- The old version silently `return`ed when the table lacked the columns, so the
-- package reported success while guarding nothing. Now a `rental_contracts` that
-- exists but offers NO usable window column is a hard error: activation fails
-- and says so. A missing table is still a notice, because there is then nothing
-- to protect.
--
-- A pre-existing overlap is NOT a hard error, deliberately: the advisory-lock
-- trigger is already installed at that point and is race-safe, so aborting would
-- remove a working guard. The skip is a WARNING and the POST-FLIGHT reports which
-- guard is active.
--
-- SAFETY / IDEMPOTENCE
-- --------------------
-- Additive, re-runnable, never deletes a row, never touches a journal. The
-- trigger refuses only a NEW or CHANGED row that conflicts, so applying it on
-- legacy data cannot fail.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Which statuses occupy a car? Mirrors BLOCKING_STATUSES in
--    src/lib/rental/booking-service.ts. One definition shared by the constraint,
--    the trigger and any future reader, instead of three copies that can drift.
--
--    An unrecognised status is NOT blocking: a new status must not make the
--    database refuse a booking the UI offered, and unknown values are far more
--    likely to be terminal (the release states are the ones that grow).
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
-- 2. Detect the booking precision, install the race-safe trigger, and (when the
--    extension and the data allow) the exclusion constraint.
--
--    Everything happens in one block so the range expression is built ONCE and
--    the trigger and the constraint cannot describe different windows.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_car        boolean;
  v_tz         boolean;   -- start_at / end_at are timestamptz
  v_ts         boolean;   -- start_ts / end_ts are timestamp
  v_date       boolean;   -- start_date / end_date
  v_time       boolean;   -- start_time / end_time
  v_tenant     boolean;   -- tenant_id (absent on a tenant-less install)
  v_precision  text;
  v_range_type text;
  v_new_expr   text;
  v_row_expr   text;
  v_col_expr   text;
  v_guard_cols text;
  v_upd_cols   text;
  v_tenant_key text;   -- the caller's tenant, as a lock-key text
  v_tenant_pred text;  -- the conflict predicate's tenant equality (or empty)
  v_fn         text;
  v_gist       boolean;
  v_dupes      int;
  v_sentinel   constant text := '''00000000-0000-0000-0000-000000000000''::uuid';
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema='public' and table_name='rental_contracts') then
    raise notice '017: rental_contracts does not exist; nothing to guard';
    return;
  end if;

  select
    exists (select 1 from information_schema.columns where table_schema='public'
            and table_name='rental_contracts' and column_name='car_id'),
    exists (select 1 from information_schema.columns where table_schema='public'
            and table_name='rental_contracts' and column_name='start_at'
            and data_type = 'timestamp with time zone')
      and exists (select 1 from information_schema.columns where table_schema='public'
            and table_name='rental_contracts' and column_name='end_at'
            and data_type = 'timestamp with time zone'),
    exists (select 1 from information_schema.columns where table_schema='public'
            and table_name='rental_contracts' and column_name='start_ts'
            and data_type = 'timestamp without time zone')
      and exists (select 1 from information_schema.columns where table_schema='public'
            and table_name='rental_contracts' and column_name='end_ts'
            and data_type = 'timestamp without time zone'),
    exists (select 1 from information_schema.columns where table_schema='public'
            and table_name='rental_contracts' and column_name='start_date')
      and exists (select 1 from information_schema.columns where table_schema='public'
            and table_name='rental_contracts' and column_name='end_date'),
    exists (select 1 from information_schema.columns where table_schema='public'
            and table_name='rental_contracts' and column_name='start_time')
      and exists (select 1 from information_schema.columns where table_schema='public'
            and table_name='rental_contracts' and column_name='end_time'),
    exists (select 1 from information_schema.columns where table_schema='public'
            and table_name='rental_contracts' and column_name='tenant_id')
    into v_car, v_tz, v_ts, v_date, v_time, v_tenant;

  -- FAIL CLOSED: a table we cannot express a window for is an activation error,
  -- not a silent success. The old version returned here and guarded nothing.
  if not v_car or not (v_tz or v_ts or v_date) then
    raise exception
      '017: rental_contracts has no usable booking window (need start_at/end_at, or start_ts/end_ts, or start_date+end_date). Refusing to report success while guarding nothing.'
      using errcode = 'invalid_table_definition';
  end if;

  -- Highest precision wins.
  if v_tz then
    v_precision  := 'timestamptz';
    v_range_type := 'tstzrange';
    v_new_expr   := 'tstzrange(new.start_at, new.end_at, ''[)'')';
    v_row_expr   := 'tstzrange(c.start_at, c.end_at, ''[)'')';
    v_guard_cols := 'start_at, end_at';
  elsif v_ts then
    v_precision  := 'timestamp';
    v_range_type := 'tsrange';
    v_new_expr   := 'tsrange(new.start_ts, new.end_ts, ''[)'')';
    v_row_expr   := 'tsrange(c.start_ts, c.end_ts, ''[)'')';
    v_guard_cols := 'start_ts, end_ts';
  elsif v_date and v_time then
    -- The real pickup/return TIME. A null time is midnight, so a date-only row
    -- still participates; `[)` keeps a same-moment turnover non-conflicting.
    v_precision  := 'date+time';
    v_range_type := 'tsrange';
    v_new_expr   := 'tsrange(new.start_date + coalesce(new.start_time, ''00:00''::time), new.end_date + coalesce(new.end_time, ''00:00''::time), ''[)'')';
    v_row_expr   := 'tsrange(c.start_date + coalesce(c.start_time, ''00:00''::time), c.end_date + coalesce(c.end_time, ''00:00''::time), ''[)'')';
    v_guard_cols := 'start_date, end_date, start_time, end_time';
  else
    v_precision  := 'date';
    v_range_type := 'tsrange';
    v_new_expr   := 'tsrange(new.start_date::timestamp, new.end_date::timestamp, ''[)'')';
    v_row_expr   := 'tsrange(c.start_date::timestamp, c.end_date::timestamp, ''[)'')';
    v_guard_cols := 'start_date, end_date';
  end if;

  -- The exclusion constraint references columns unqualified (there is no row
  -- alias inside `exclude using gist`), so the `c.`-qualified expression is
  -- reduced to its bare column form for that one use.
  v_col_expr := replace(v_row_expr, 'c.', '');

  -- The trigger's `update of` list must name only columns that exist. Naming
  -- `tenant_id` on a tenant-less install is a hard error that would abort the
  -- whole migration, so it is added only when the column is really there.
  v_upd_cols := 'car_id, ' || v_guard_cols || ', status'
                || case when v_tenant then ', tenant_id' else '' end;

  -- `new.tenant_id` cannot be referenced at all on a tenant-less install: the
  -- trigger would be created but raise "record new has no field tenant_id" the
  -- first time it fired. The tenant is therefore expressed as a coalesce when
  -- the column exists, and as the bare sentinel when it does not.
  if v_tenant then
    v_tenant_key  := format('coalesce(new.tenant_id, %s)', v_sentinel);
    v_tenant_pred := format('and coalesce(c.tenant_id, %s) = coalesce(new.tenant_id, %s)', v_sentinel, v_sentinel);
  else
    v_tenant_key  := v_sentinel;
    v_tenant_pred := '';
  end if;

  raise notice '017: booking precision = % (guard columns: %)', v_precision, v_guard_cols;

  -- --------------------------------------------------------------------------
  -- 2a. THE GUARD THAT ALWAYS EXISTS: a BEFORE trigger holding a
  --     transaction-level advisory lock keyed on (tenant, car).
  --
  --     The lock is what makes it correct. Without it the select below cannot
  --     see a concurrent uncommitted insert and the race survives (see the
  --     header, and the `plain-select` control in race.py).
  --
  --     The tenant is coalesced to a sentinel so the tenant-less install locks
  --     on the same key as itself; the (tenant:car) text is hashed because
  --     `pg_advisory_xact_lock` takes bigint. A hash collision only serialises
  --     two unrelated cars - it can never let two conflicting inserts through.
  -- --------------------------------------------------------------------------
  v_fn := format($fn$
create or replace function public.prevent_car_double_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $body$
declare
  v_window %1$s;
  v_clash  uuid;
begin
  if not public.booking_blocks_car(new.status) then
    return new;
  end if;

  v_window := %2$s;
  -- A NULL/unbounded or empty window cannot conflict.
  if v_window is null or isempty(v_window)
     or lower_inf(v_window) or upper_inf(v_window) then
    return new;
  end if;

  -- Serialise all bookings for this car in this company. Released when the
  -- transaction ends, so a rolled-back insert releases it too.
  perform pg_advisory_xact_lock(
    hashtextextended(
      %3$s::text || ':' || new.car_id::text,
      0
    )
  );

  select c.id into v_clash
  from public.rental_contracts c
  where c.car_id = new.car_id
    and c.id is distinct from new.id
    %5$s
    and public.booking_blocks_car(c.status)
    and %4$s && v_window
  limit 1;

  if v_clash is not null then
    raise exception
      'rental_contracts: car %% is already booked for the requested period (conflicting contract %%)',
      new.car_id, v_clash
      using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$body$;
$fn$, v_range_type, v_new_expr, v_tenant_key, v_row_expr, v_tenant_pred);

  execute v_fn;

  comment on function public.prevent_car_double_booking() is
    'Exec 72 / migration 017: refuses a NEW or CHANGED rental contract that overlaps a blocking contract for the same car in the same company. Holds a per-(tenant,car) advisory lock so two concurrent inserts cannot both pass. The application check in createBooking produces the friendly 409; this is the race-proof backstop.';

  execute 'drop trigger if exists rental_contracts_no_double_booking on public.rental_contracts';
  execute format($t$
    create trigger rental_contracts_no_double_booking
      before insert or update of %1$s
      on public.rental_contracts
      for each row
      execute function public.prevent_car_double_booking()
  $t$, v_upd_cols);

  -- --------------------------------------------------------------------------
  -- 2b. The declarative guard, when it can exist. Optional by design: the
  --     trigger above is the guarantee.
  -- --------------------------------------------------------------------------
  begin
    create extension if not exists btree_gist;
  exception when others then
    raise notice '017: btree_gist unavailable (%) - the advisory-lock trigger is the guard', sqlerrm;
  end;

  select exists (select 1 from pg_extension where extname = 'btree_gist') into v_gist;
  if not v_gist then
    raise notice '017: btree_gist not installed; exclusion constraint skipped (trigger guard is active)';
    return;
  end if;

  if exists (select 1 from pg_constraint
             where conname = 'rental_contracts_no_car_overlap'
               and conrelid = 'public.rental_contracts'::regclass) then
    raise notice '017: the exclusion constraint already exists';
    return;
  end if;

  -- A pre-existing overlap would make the constraint fail. Report it loudly
  -- rather than aborting: the trigger guard is already in place and working.
  -- The tenant equality is part of the predicate only when the column exists;
  -- on a tenant-less install naming `a.tenant_id` is a hard error.
  execute format($q$
    select count(*) from (
      select 1
      from public.rental_contracts a
      join public.rental_contracts b
        on a.car_id = b.car_id
       and a.id < b.id
       %1$s
       and public.booking_blocks_car(a.status)
       and public.booking_blocks_car(b.status)
       and %2$s && %3$s
    ) x
  $q$, case when v_tenant
            then format('and coalesce(a.tenant_id, %s) = coalesce(b.tenant_id, %s)', v_sentinel, v_sentinel)
            else '' end,
       replace(v_row_expr, 'c.', 'a.'),
       replace(v_row_expr, 'c.', 'b.'))
  into v_dupes;

  if v_dupes > 0 then
    raise warning '017: % pre-existing overlapping rental contract(s) - the exclusion constraint was NOT created; the advisory-lock trigger IS active and closes the race. Reconcile the duplicates to gain the declarative guard.', v_dupes;
    return;
  end if;

  execute format($c$
    alter table public.rental_contracts
      add constraint rental_contracts_no_car_overlap
      exclude using gist (
        car_id with =,
        %1$s
        (%2$s) with &&
      )
      where (public.booking_blocks_car(status))
  $c$,
  case when v_tenant then format('(coalesce(tenant_id, %s)) with =,', v_sentinel) else '' end,
  v_col_expr);

  raise notice '017: rental_contracts_no_car_overlap created';
exception
  when duplicate_object then
    raise notice '017: the exclusion constraint already exists';
end $mig$;

-- ----------------------------------------------------------------------------
-- 3. Privileges. The guard functions are called by the constraint/trigger, not
--    by a client, and must not become a way to probe another company's bookings.
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
-- Run supabase/EXEC72_BOOKING_GUARD_PREFLIGHT.sql first. It is read-only and
-- reports, before anything changes: the detected precision, whether btree_gist
-- is available, and any pre-existing overlap (which would skip the declarative
-- constraint while the advisory-lock trigger still closes the race).
-- ============================================================================
