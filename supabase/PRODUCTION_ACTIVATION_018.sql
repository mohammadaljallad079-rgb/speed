-- ============================================================================
-- SPEED ERP — PRODUCTION ACTIVATION PACKAGE (018)
-- Booking time precision: pickup/return TIME, stored as true instants, guarded.
--
-- Apply AFTER 017, as the last step of
--   supabase/PRODUCTION_ACTIVATION_001_002_003.sql -> 004 -> 005_006 -> 007
--   -> 008 -> ... -> 016 -> 017 -> 018
-- on project chlkmdobhvfnldqkgdji.
--
-- This file embeds migration 018 VERBATIM between a read-only PRE-FLIGHT and a
-- read-only POST-FLIGHT. Do not edit the embedded body; edit
-- supabase/migrations/018_booking_time_precision.sql and regenerate this file:
--
--     node scripts/generate-activation-bundle.mjs
--
-- The body is byte-identical to the migration (verified by
-- tests/activation-package-integrity.test.ts, which recomputes this hash).
--
-- NOTE: this migration makes a booking PRECISE. A car that 017 refused at day
-- precision and that is genuinely free at hour precision becomes bookable, which
-- is the point of the change. It refuses nothing that was previously allowed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PRE-FLIGHT (read-only). Run this first and read the output.
-- ----------------------------------------------------------------------------
with cols as (
  select column_name, data_type from information_schema.columns
  where table_schema='public' and table_name='rental_contracts'
),
f as (
  select
    exists (select 1 from cols where column_name='car_id') as has_car,
    (exists (select 1 from cols where column_name='start_date')
       and exists (select 1 from cols where column_name='end_date')) as has_date,
    exists (select 1 from cols where column_name='start_at') as already_precise
)
select item, ok from (
  select 'PRE: rental_contracts exists' as item, 1 as ord,
         (select count(*) from cols) > 0 as ok
  union all
  select 'PRE: a usable date window exists (018 needs it to backfill)', 2,
         has_car and has_date from f
  union all
  select 'PRE: booking_blocks_car exists (017 was applied first)', 3,
         exists (select 1 from pg_proc where proname = 'booking_blocks_car')
  union all
  select 'PRE: not already applied (a re-run is safe either way)', 4,
         not already_precise from f
) t
order by ok, ord;

-- How many rows 018 will backfill, and how many already violate the ordering the
-- new CHECK constraint would impose. A non-zero bad_order only SKIPS the
-- constraint; it never deletes a row.
--
-- Every reference is guarded: this runs BEFORE the columns exist, so naming
-- start_at directly would abort the pre-flight rather than report it.
select
  (select count(*) from public.rental_contracts
     where start_date is not null and end_date is not null) as rows_to_backfill,
  (select count(*) from public.rental_contracts
     where start_date is not null and end_date is not null and end_date < start_date) as bad_order;

-- ==========================================================================
-- BEGIN 018_booking_time_precision.sql
-- SHA-256 (body): 3a3455dbab50f4070230ca515f1e9e5665efe63d58db1c30dee21155f1674d57
-- ==========================================================================

-- ============================================================================
-- 018_booking_time_precision.sql
-- A booking carries a pickup and a return TIME, stored as true instants in the
-- rental company's timezone, and the double-booking guard compares at that
-- precision.
--
-- WHY
-- ---
-- Migration 017 installed a correct, race-safe guard - but only at whatever
-- precision the schema offered. On a schema with `start_date`/`end_date` alone
-- that is a whole DAY, and a day is the wrong unit for a rental:
--
--   * 09:00-11:00 and 10:00-12:00 on the same day are DIFFERENT rentals that a
--     date-only window calls identical, so the second is refused;
--   * a car returned at 09:00 cannot be re-let at 09:00 the same day, because the
--     date-only window is still "occupied" until midnight.
--
-- This migration gives the booking a real time window, so the guard refuses
-- exactly the overlapping hours and nothing else.
--
-- THE ZONE IS THE COMPANY'S, NOT THE BROWSER'S
-- -------------------------------------------
-- The customer picks a wall-clock reading ("2026-03-01 09:00") meaning the
-- BRANCH's local time - a customer abroad still books the branch's opening
-- hours. That reading is only meaningful with a zone, so it is resolved to a
-- `timestamptz` instant. Storing a naive `timestamp` instead would silently
-- reinterpret itself if the server's `TimeZone` setting changed, and would
-- compare wrongly across a DST boundary.
--
-- The zone lives in the existing key/value `settings` store under
-- `company_timezone` (per tenant), read by `public.company_timezone(uuid)`.
-- `Asia/Bahrain` is the fallback: the home market, and a zone with no DST, so a
-- misconfigured company still behaves predictably.
--
-- BOTH REPRESENTATIONS ARE KEPT, DELIBERATELY
-- -------------------------------------------
-- `start_date`/`end_date`/`start_time`/`end_time` keep the wall-clock reading the
-- customer chose (readable in the row, and what every existing report and screen
-- already reads); `start_at`/`end_at` are the authoritative instants the guard
-- compares. Neither is derived on read, so a report never has to know the zone.
--
-- THE HOLE THIS CLOSES
-- --------------------
-- A screen that still inserts only `start_date`/`end_date` would leave
-- `start_at` NULL, and a NULL window cannot conflict - the guard would silently
-- stop protecting that row. The trigger therefore DERIVES `start_at`/`end_at`
-- from the legacy columns before it checks anything, so every row has a window
-- however it was written. This is why the function is replaced rather than a
-- second trigger added: one trigger, one ordering, no way to skip the derive.
--
-- FAIL-CLOSED ACTIVATION
-- ----------------------
-- `rental_contracts` exists but has no usable window column -> hard error, the
-- same refusal 017 makes. A missing table is a notice (nothing to protect).
-- Pre-existing overlaps are NOT fatal: the advisory-lock trigger is already
-- installed at that point, so the exclusion constraint is skipped with a WARNING
-- and the trigger remains the guarantee. A pre-existing row whose `end_at` is not
-- after `start_at` is reported and the CHECK constraint is skipped, never deleted.
--
-- SAFETY / IDEMPOTENCE
-- --------------------
-- Additive and re-runnable. Never deletes a row, never touches a journal. The
-- backfill only fills a NULL `start_at`, so a re-run changes nothing.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The company's timezone, from the existing settings store.
--
--    Never throws: a missing table, a missing row or an unparseable value all
--    fall back to the default, because a booking must not fail on a setting.
-- ----------------------------------------------------------------------------
create or replace function public.company_timezone(p_tenant uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_raw text;
  v_zone text;
begin
  if to_regclass('public.settings') is null then
    return 'Asia/Bahrain';
  end if;

  begin
    execute 'select value::text from public.settings where key = ''company_timezone''
               and tenant_id is not distinct from $1 limit 1'
      into v_raw using p_tenant;
  exception when others then
    return 'Asia/Bahrain';
  end;

  if v_raw is null then
    return 'Asia/Bahrain';
  end if;

  v_zone := trim(v_raw);
  -- The store holds JSON for structured settings; accept both a bare zone and
  -- {"timezone": "..."}.
  if v_zone like '{%' then
    begin
      v_zone := trim(both '"' from (v_zone::jsonb ->> 'timezone'));
    exception when others then
      return 'Asia/Bahrain';
    end;
  end if;

  if v_zone is null or v_zone = '' then
    return 'Asia/Bahrain';
  end if;

  -- A zone PostgreSQL does not recognise would make `at time zone` raise; probe
  -- it rather than trusting the value.
  begin
    perform now() at time zone v_zone;
  exception when others then
    return 'Asia/Bahrain';
  end;

  return v_zone;
end;
$$;

comment on function public.company_timezone(uuid) is
  'Exec 74 / migration 018: the rental company''s IANA timezone, from settings.company_timezone (per tenant), defaulting to Asia/Bahrain. Mirrors src/lib/rental/company-timezone.ts.';

-- ----------------------------------------------------------------------------
-- 2. Add the columns, backfill, and install the guard at instant precision.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_exists   boolean;
  v_tenant   boolean;
  v_dupes    int;
  v_badorder int;
  v_gist     boolean;
  v_sentinel constant text := '''00000000-0000-0000-0000-000000000000''::uuid';
begin
  select exists (select 1 from information_schema.tables
                 where table_schema='public' and table_name='rental_contracts')
    into v_exists;
  if not v_exists then
    raise notice '018: rental_contracts does not exist; nothing to do';
    return;
  end if;

  -- FAIL CLOSED: without a window column there is nothing to make precise, and
  -- reporting success would hide that.
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='rental_contracts'
                   and column_name='start_date') then
    raise exception
      '018: rental_contracts has no start_date/end_date; refusing to report success while making no window precise.'
      using errcode = 'invalid_table_definition';
  end if;

  select exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='rental_contracts'
                   and column_name='tenant_id')
    into v_tenant;

  -- 2a. The precise instants.
  alter table public.rental_contracts add column if not exists start_at timestamptz;
  alter table public.rental_contracts add column if not exists end_at   timestamptz;

  -- 2b. The wall-clock reading. Added so the row remains self-describing and the
  --     customer's chosen times are readable without knowing the zone.
  alter table public.rental_contracts add column if not exists start_time time;
  alter table public.rental_contracts add column if not exists end_time   time;

  comment on column public.rental_contracts.start_at is
    'Exec 74 / 018: precise pickup instant (company timezone). The authoritative window; the double-booking guard compares this.';
  comment on column public.rental_contracts.end_at is
    'Exec 74 / 018: precise return instant (company timezone), exclusive - a car returned at 09:00 may go out at 09:00.';
  comment on column public.rental_contracts.start_time is
    'Exec 74 / 018: the pickup wall-clock time in the company timezone, kept for readability alongside start_at.';
  comment on column public.rental_contracts.end_time is
    'Exec 74 / 018: the return wall-clock time in the company timezone, kept for readability alongside end_at.';

  -- 2c. Backfill existing rows. Only a NULL `start_at` is filled, so a re-run is
  --     a no-op and an already-precise row is never rewritten.
  update public.rental_contracts rc
     set start_at = ((rc.start_date + coalesce(rc.start_time, '00:00'::time))
                     at time zone public.company_timezone(rc.tenant_id)),
         end_at   = ((rc.end_date + coalesce(rc.end_time, '00:00'::time))
                     at time zone public.company_timezone(rc.tenant_id))
   where rc.start_at is null
     and rc.start_date is not null
     and rc.end_date is not null;

  raise notice '018: backfilled % booking window(s) to precise instants',
    (select count(*) from public.rental_contracts where start_at is not null);

  -- --------------------------------------------------------------------------
  -- 2d. THE GUARD, at instant precision. This REPLACES 017's function: the
  --     derive happens first, so a row written by a legacy screen still gets a
  --     window and cannot slip past the check with a NULL one.
  --
  --     The advisory lock is unchanged and remains the reason this is race-safe:
  --     a plain select cannot see a concurrent uncommitted insert.
  -- --------------------------------------------------------------------------
  execute format($fn$
create or replace function public.prevent_car_double_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $body$
declare
  v_window tstzrange;
  v_clash  uuid;
begin
  -- DERIVE FIRST. A caller that supplies only the wall-clock columns still gets
  -- a precise window, so the check below can never be bypassed by a NULL one.
  if new.start_at is null and new.start_date is not null then
    new.start_at := (new.start_date + coalesce(new.start_time, '00:00'::time))
                    at time zone public.company_timezone(new.tenant_id);
  end if;
  if new.end_at is null and new.end_date is not null then
    new.end_at := (new.end_date + coalesce(new.end_time, '00:00'::time))
                  at time zone public.company_timezone(new.tenant_id);
  end if;

  -- A window that runs backwards is not a rental. Checked EXPLICITLY and before
  -- the range is built: `tstzrange` would raise a generic data_exception
  -- ("range lower bound must be less than or equal to range upper bound"), which
  -- tells a customer nothing. This also does not depend on the CHECK constraint,
  -- which is skipped when legacy data already violates it.
  if new.start_at is not null and new.end_at is not null and new.end_at <= new.start_at then
    raise exception
      'rental_contracts: the return (%%) must be after the pickup (%%)',
      new.end_at, new.start_at
      using errcode = 'check_violation';
  end if;

  if not public.booking_blocks_car(new.status) then
    return new;
  end if;

  v_window := tstzrange(new.start_at, new.end_at, '[)');
  -- A window with no bounds cannot conflict; a zero-length one is rejected by the
  -- CHECK constraint instead.
  if v_window is null or isempty(v_window)
     or lower_inf(v_window) or upper_inf(v_window) then
    return new;
  end if;

  -- Serialise all bookings for this car in this company. Released when the
  -- transaction ends, so a rolled-back insert releases it too.
  perform pg_advisory_xact_lock(
    hashtextextended(
      %1$s::text || ':' || new.car_id::text,
      0
    )
  );

  select c.id into v_clash
  from public.rental_contracts c
  where c.car_id = new.car_id
    and c.id is distinct from new.id
    %2$s
    and public.booking_blocks_car(c.status)
    and tstzrange(c.start_at, c.end_at, '[)') && v_window
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
$fn$,
  case when v_tenant then format('coalesce(new.tenant_id, %s)', v_sentinel) else v_sentinel end,
  case when v_tenant then format('and coalesce(c.tenant_id, %s) = coalesce(new.tenant_id, %s)', v_sentinel, v_sentinel) else '' end);

  comment on function public.prevent_car_double_booking() is
    'Exec 74 / migration 018: derives the precise booking window from the wall-clock columns when absent, then refuses a NEW or CHANGED rental contract that overlaps a blocking contract for the same car in the same company. Holds a per-(tenant,car) advisory lock so two concurrent inserts cannot both pass. Supersedes the date-precision version installed by 017.';

  execute 'drop trigger if exists rental_contracts_no_double_booking on public.rental_contracts';
  execute format($t$
    create trigger rental_contracts_no_double_booking
      before insert or update of car_id, start_date, end_date, start_time, end_time, start_at, end_at, status%1$s
      on public.rental_contracts
      for each row
      execute function public.prevent_car_double_booking()
  $t$, case when v_tenant then ', tenant_id' else '' end);

  -- A window that runs backwards is not a rental. Guarded: legacy data is
  -- reported, never deleted, and a violation only skips this one constraint.
  select count(*) into v_badorder
  from public.rental_contracts
  where start_at is not null and end_at is not null and end_at <= start_at;

  if v_badorder > 0 then
    raise warning '018: % booking(s) have end_at <= start_at - the ordering CHECK was NOT created; correct those rows and re-run to gain it.', v_badorder;
  elsif not exists (select 1 from pg_constraint
                    where conname = 'rental_contracts_window_ordered'
                      and conrelid = 'public.rental_contracts'::regclass) then
    alter table public.rental_contracts
      add constraint rental_contracts_window_ordered
      check (start_at is null or end_at is null or end_at > start_at);
    raise notice '018: rental_contracts_window_ordered created';
  end if;

  -- --------------------------------------------------------------------------
  -- 2e. The declarative guard, when it can exist. Optional by design: the
  --     advisory-lock trigger above is the guarantee.
  -- --------------------------------------------------------------------------
  begin
    create extension if not exists btree_gist;
  exception when others then
    raise notice '018: btree_gist unavailable (%) - the advisory-lock trigger is the guard', sqlerrm;
  end;

  select exists (select 1 from pg_extension where extname = 'btree_gist') into v_gist;
  if not v_gist then
    raise notice '018: btree_gist not installed; exclusion constraint skipped (trigger guard is active)';
    return;
  end if;

  -- Rebuild at the new precision: the 017 constraint (if any) describes a
  -- different window expression, so it is replaced rather than left in place.
  execute 'alter table public.rental_contracts drop constraint if exists rental_contracts_no_car_overlap';

  -- The tenant equality is part of the predicate only when the column exists;
  -- on a tenant-less install naming `a.tenant_id` is a hard error. Built with
  -- format() so the placeholder is never parsed as SQL.
  execute format($q$
    select count(*)
    from (
      select 1
      from public.rental_contracts a
      join public.rental_contracts b
        on a.car_id = b.car_id
       and a.id < b.id
       %1$s
       and public.booking_blocks_car(a.status)
       and public.booking_blocks_car(b.status)
       and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(b.start_at, b.end_at, '[)')
    ) x
  $q$,
  case when v_tenant then format('and coalesce(a.tenant_id, %s) = coalesce(b.tenant_id, %s)', v_sentinel, v_sentinel) else '' end)
  into v_dupes;

  if v_dupes > 0 then
    raise warning '018: % pre-existing overlapping rental contract(s) - the exclusion constraint was NOT created; the advisory-lock trigger IS active and closes the race. Reconcile the duplicates to gain the declarative guard.', v_dupes;
    return;
  end if;

  execute format($c$
    alter table public.rental_contracts
      add constraint rental_contracts_no_car_overlap
      exclude using gist (
        car_id with =,
        %1$s
        (tstzrange(start_at, end_at, '[)')) with &&
      )
      where (public.booking_blocks_car(status))
  $c$,
  case when v_tenant then format('(coalesce(tenant_id, %s)) with =,', v_sentinel) else '' end);

  raise notice '018: rental_contracts_no_car_overlap created at instant precision';
end $mig$;

-- ----------------------------------------------------------------------------
-- 3. Privileges. The helpers are called by the trigger, not by a client, and
--    must not become a way to probe another company's bookings.
-- ----------------------------------------------------------------------------
revoke all on function public.company_timezone(uuid) from public;
revoke all on function public.company_timezone(uuid) from anon;
revoke all on function public.company_timezone(uuid) from authenticated;
revoke all on function public.prevent_car_double_booking() from public;
revoke all on function public.prevent_car_double_booking() from anon;
revoke all on function public.prevent_car_double_booking() from authenticated;

commit;

-- ============================================================================
-- OPERATOR NOTE
-- Apply AFTER 017 (017 installs `booking_blocks_car`, which this file uses).
-- This migration widens no window: a booking that 017 refused at day precision
-- and that is genuinely free at hour precision is now ALLOWED, which is the
-- point of the change. Run supabase/EXEC72_BOOKING_GUARD_PREFLIGHT.sql first.
-- ============================================================================

-- ============================================================================
-- POST-FLIGHT VERIFICATION (read-only - proves the migration took effect)
-- ============================================================================
-- Every row below must read true.

select 'the time columns exist' as item,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='rental_contracts'
           and column_name in ('start_at','end_at','start_time','end_time')) = 4 as ok
union all select 'the company-timezone helper exists',
       exists (select 1 from pg_proc where proname = 'company_timezone') as ok
union all select 'the race-safe trigger is installed (this is the guarantee)',
       exists (select 1 from pg_trigger
               where tgname = 'rental_contracts_no_double_booking' and not tgisinternal) as ok
union all select 'the trigger derives the window from the wall-clock columns',
       (select prosrc like '%new.start_at :=%'
        from pg_proc where proname = 'prevent_car_double_booking') is true as ok
union all select 'the trigger still takes the advisory lock (race safety kept)',
       (select prosrc like '%pg_advisory_xact_lock%'
        from pg_proc where proname = 'prevent_car_double_booking') is true as ok
union all select 'every booking has a precise window (no NULL left)',
       (select count(*) from public.rental_contracts where start_at is null) = 0 as ok
union all select 'the helpers are not callable by a client',
       (select count(*) from information_schema.routine_privileges
        where routine_name in ('company_timezone','prevent_car_double_booking')
          and grantee in ('anon','authenticated','PUBLIC')) = 0 as ok
order by ok, item;

-- Which guard is active at which precision.
select
  case when exists (select 1 from pg_constraint where conname = 'rental_contracts_no_car_overlap')
         then 'exclusion constraint + advisory-lock trigger, at INSTANT precision (strongest)'
       else 'advisory-lock trigger, at INSTANT precision (the trigger is the guarantee)'
  end as active_guard;

-- ============================================================================
-- END OF PACKAGE (018)
-- ============================================================================
