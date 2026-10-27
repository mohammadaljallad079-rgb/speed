-- ============================================================================
-- EXEC72_BOOKING_GUARD_PREFLIGHT.sql
-- READ-ONLY. Answers every question migration 017 depends on, BEFORE it runs.
--
-- Run this against the target database first. It writes nothing: every statement
-- is a `select` (or a `with ... select`). It does not create a temp table, does
-- not `set role`, and does not call any function that writes.
--
-- WHY IT MATTERS
-- --------------
-- 017 builds the booking window from whichever columns the live table actually
-- has. If the live table has a pickup/return TIME, a date-only guard would refuse
-- two legitimate same-day bookings; if it does not, a time-aware guard cannot be
-- expressed. This script reports which case applies, so activation is a decision
-- and not a guess.
--
-- It also reports pre-existing overlaps. Those do NOT block activation (the
-- advisory-lock trigger is installed first and is race-safe), but they do mean
-- the declarative exclusion constraint is skipped, and that is worth knowing
-- before you read the POST-FLIGHT output.
-- ============================================================================

\pset pager off

-- ----------------------------------------------------------------------------
-- 1. Does the table exist, and at what precision can a booking window be built?
--    The `precision` value is exactly what 017 will report.
-- ----------------------------------------------------------------------------
with cols as (
  select column_name, data_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'rental_contracts'
),
flags as (
  select
    exists (select 1 from cols where column_name = 'car_id')                                   as has_car,
    exists (select 1 from cols where column_name = 'start_at'
              and data_type = 'timestamp with time zone')                                      as has_tz,
    exists (select 1 from cols where column_name = 'start_ts'
              and data_type = 'timestamp without time zone')                                   as has_ts,
    (exists (select 1 from cols where column_name = 'start_date')
       and exists (select 1 from cols where column_name = 'end_date'))                         as has_date,
    (exists (select 1 from cols where column_name = 'start_time')
       and exists (select 1 from cols where column_name = 'end_time'))                         as has_time
)
select
  (select count(*) from cols) > 0                                         as table_exists,
  has_car                                                                 as has_car_id,
  has_tz                                                                  as has_timestamptz,
  has_ts                                                                  as has_timestamp,
  has_date                                                                as has_date_pair,
  has_time                                                                as has_time_pair,
  case
    when not has_car then 'UNGUARDABLE - no car_id; 017 will refuse activation'
    when has_tz  then 'timestamptz (true instants; timezone-correct)'
    when has_ts  then 'timestamp (local, no zone)'
    when has_date and has_time then 'date+time (pickup/return TIME is honoured)'
    when has_date then 'date-only (NO time support in this schema)'
    else 'UNGUARDABLE - no usable window; 017 will refuse activation'
  end                                                                     as booking_precision,
  -- The decisive fact for requirement "does the schema support pickup/return TIME?"
  (has_tz or has_ts or (has_date and has_time))                           as time_precision_supported
from flags;

-- ----------------------------------------------------------------------------
-- 2. Is `btree_gist` available? Without it the declarative exclusion constraint
--    cannot exist, and the advisory-lock trigger is the only guard. That is still
--    race-safe, but the operator should know which guard they are getting.
-- ----------------------------------------------------------------------------
select
  exists (select 1 from pg_extension where extname = 'btree_gist')            as btree_gist_installed,
  exists (select 1 from pg_available_extensions where name = 'btree_gist')    as btree_gist_available,
  exists (select 1 from pg_available_extensions
          where name = 'btree_gist' and installed_version is null)            as can_be_created;

-- ----------------------------------------------------------------------------
-- 3. Pre-existing overlaps. A non-zero count means 017 will SKIP the exclusion
--    constraint (and say so as a WARNING); the advisory-lock trigger is created
--    regardless, so the race is still closed. Reconcile these to gain the
--    declarative guard.
--
--    The predicate is the same one 017 uses, and it is written out per precision
--    because SQL cannot select a column that may not exist.
-- ----------------------------------------------------------------------------
with cols as (
  select column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'rental_contracts'
),
p as (
  select
    exists (select 1 from cols where column_name = 'start_at')  as tz,
    exists (select 1 from cols where column_name = 'start_ts')  as ts,
    exists (select 1 from cols where column_name = 'start_time') as tm
)
select
  case
    when (select tz from p) then 'timestamptz'
    when (select ts from p) then 'timestamp'
    when (select tm from p) then 'date+time'
    else 'date'
  end as precision_checked,
  case
    when (select tz from p) then (
      select count(*) from public.rental_contracts a
      join public.rental_contracts b
        on a.car_id = b.car_id and a.id < b.id
       and coalesce(a.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(b.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
       and a.status in ('pending','active','confirmed','reserved','approved','ongoing','rented')
       and b.status in ('pending','active','confirmed','reserved','approved','ongoing','rented')
       and tstzrange(a.start_at, a.end_at, '[)') && tstzrange(b.start_at, b.end_at, '[)'))
    when (select ts from p) then (
      select count(*) from public.rental_contracts a
      join public.rental_contracts b
        on a.car_id = b.car_id and a.id < b.id
       and coalesce(a.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(b.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
       and a.status in ('pending','active','confirmed','reserved','approved','ongoing','rented')
       and b.status in ('pending','active','confirmed','reserved','approved','ongoing','rented')
       and tsrange(a.start_ts, a.end_ts, '[)') && tsrange(b.start_ts, b.end_ts, '[)'))
    when (select tm from p) then (
      select count(*) from public.rental_contracts a
      join public.rental_contracts b
        on a.car_id = b.car_id and a.id < b.id
       and coalesce(a.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(b.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
       and a.status in ('pending','active','confirmed','reserved','approved','ongoing','rented')
       and b.status in ('pending','active','confirmed','reserved','approved','ongoing','rented')
       and tsrange(a.start_date + coalesce(a.start_time,'00:00'::time),
                   a.end_date   + coalesce(a.end_time,  '00:00'::time), '[)')
        && tsrange(b.start_date + coalesce(b.start_time,'00:00'::time),
                   b.end_date   + coalesce(b.end_time,  '00:00'::time), '[)'))
    else (
      select count(*) from public.rental_contracts a
      join public.rental_contracts b
        on a.car_id = b.car_id and a.id < b.id
       and coalesce(a.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(b.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
       and a.status in ('pending','active','confirmed','reserved','approved','ongoing','rented')
       and b.status in ('pending','active','confirmed','reserved','approved','ongoing','rented')
       and tsrange(a.start_date::timestamp, a.end_date::timestamp, '[)')
        && tsrange(b.start_date::timestamp, b.end_date::timestamp, '[)'))
  end as pre_existing_overlaps;

-- ----------------------------------------------------------------------------
-- 4. Is 017 already applied? (Idempotence check - re-running is safe either way.)
-- ----------------------------------------------------------------------------
select
  exists (select 1 from pg_trigger
          where tgname = 'rental_contracts_no_double_booking' and not tgisinternal) as trigger_present,
  exists (select 1 from pg_constraint
          where conname = 'rental_contracts_no_car_overlap')                        as constraint_present,
  exists (select 1 from pg_proc where proname = 'booking_blocks_car')             as helper_present;
