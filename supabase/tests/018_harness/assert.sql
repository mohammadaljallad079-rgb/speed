-- ============================================================================
-- 018 harness assertions (behavioural, not structural).
--
-- Every check below asserts what the DATABASE actually does after 018, not that
-- some text exists in a file. The scenarios are the ones a rental business
-- depends on:
--
--   A. the wall-clock reading survives as instants in the COMPANY's timezone
--   B. a same-day booking at a DIFFERENT time is allowed (the point of 018)
--   C. overlapping hours on the same day are refused
--   D. adjacent bookings (11:00 return, 11:00 pickup) are a turnover, allowed
--   E. a booking that still writes only the legacy columns is derived and guarded
--   F. a backwards window is refused by the CHECK constraint
--   G. the tenant boundary holds: another company's booking never conflicts
--   H. a non-blocking status does not occupy the car
--   I. the helper is not callable by a client role
--
-- Run via run.sh. `set ON_ERROR_STOP` is on, so a broken statement fails the run.
-- ============================================================================

\set ON_ERROR_STOP on
\timing off

\echo '== A. the wall-clock reading became instants in the company timezone =='
select
  case
    when start_at = timestamptz '2026-03-10 00:00:00+03'
     and end_at   = timestamptz '2026-03-12 00:00:00+03'
    then 'PASS'
    else 'FAIL'
  end as a_backfill_uses_company_zone
from public.rental_contracts where contract_number = 'RC-LEGACY';

\echo '== A2. the helper resolves the configured zone, and defaults without one =='
select
  case
    when public.company_timezone('11111111-1111-1111-1111-111111111111') = 'Asia/Bahrain'
     and public.company_timezone('99999999-9999-9999-9999-999999999999') = 'Asia/Bahrain'
     and public.company_timezone(null) = 'Asia/Bahrain'
    then 'PASS' else 'FAIL'
  end as a2_zone_resolution;

-- A tenant whose zone is NOT Bahrain must actually be honoured.
insert into public.settings (tenant_id, key, value)
values ('22222222-2222-2222-2222-222222222222', 'company_timezone', 'Europe/London')
on conflict (tenant_id, key) do update set value = excluded.value;

select
  case when public.company_timezone('22222222-2222-2222-2222-222222222222') = 'Europe/London'
       then 'PASS' else 'FAIL' end as a2b_per_tenant_zone;

\echo '== B. a same-day booking at a DIFFERENT time is ALLOWED =='
-- RC-LEGACY occupies the whole of 2026-03-10 (00:00 -> 2026-03-12 00:00).
-- A booking later that same day is free at hour precision; a date-only guard
-- would have refused it. This is the defect 018 exists to fix.
insert into public.rental_contracts
  (tenant_id, car_id, contract_number, start_date, start_time, end_date, end_time, status)
values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'RC-SAMEDAY',
   '2026-03-12', '14:00', '2026-03-12', '16:00', 'pending');

select
  case when start_at = timestamptz '2026-03-12 14:00:00+03'
        and end_at   = timestamptz '2026-03-12 16:00:00+03'
       then 'PASS' else 'FAIL' end as b_same_day_different_time_allowed
from public.rental_contracts where contract_number = 'RC-SAMEDAY';

\echo '== C. overlapping hours on the same day are REFUSED =='
do $$
declare v text;
begin
  begin
    insert into public.rental_contracts
      (tenant_id, car_id, contract_number, start_date, start_time, end_date, end_time, status)
    values
      ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'RC-OVERLAP',
       '2026-03-12', '15:00', '2026-03-12', '17:00', 'pending');
    v := 'NO-ERROR';
  exception when others then
    v := SQLSTATE;
  end;
  raise notice 'PROBE overlapping_hours %', v;
end $$;

\echo '== D. adjacent bookings are a turnover, not a conflict =='
-- RC-SAMEDAY returns 16:00; a 16:00 pickup must be allowed.
insert into public.rental_contracts
  (tenant_id, car_id, contract_number, start_date, start_time, end_date, end_time, status)
values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'RC-ADJACENT',
   '2026-03-12', '16:00', '2026-03-12', '18:00', 'pending');
select
  case when start_at = timestamptz '2026-03-12 16:00:00+03'
       then 'PASS' else 'FAIL' end as d_adjacent_allowed
from public.rental_contracts where contract_number = 'RC-ADJACENT';

\echo '== E. a row written with ONLY the legacy columns is derived and guarded =='
-- A legacy screen that never learns about start_at/end_at must still be guarded.
-- RC-DERIVE writes no instants at all; the trigger must derive them AND refuse an
-- overlap against the derived window.
insert into public.rental_contracts
  (tenant_id, car_id, contract_number, start_date, end_date, status)
values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002', 'RC-DERIVE',
   '2026-04-01', '2026-04-03', 'pending');

select
  case when start_at = timestamptz '2026-04-01 00:00:00+03'
        and end_at   = timestamptz '2026-04-03 00:00:00+03'
       then 'PASS' else 'FAIL' end as e_legacy_row_is_derived
from public.rental_contracts where contract_number = 'RC-DERIVE';

do $$
declare v text;
begin
  begin
    insert into public.rental_contracts
      (tenant_id, car_id, contract_number, start_date, end_date, status)
    values
      ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002', 'RC-DERIVE-CLASH',
       '2026-04-02', '2026-04-04', 'pending');
    v := 'NO-ERROR';
  exception when others then
    v := SQLSTATE;
  end;
  raise notice 'PROBE legacy_overlap %', v;
end $$;

\echo '== F. a backwards window is refused by the CHECK constraint =='
do $$
declare v text;
begin
  begin
    insert into public.rental_contracts
      (tenant_id, car_id, contract_number, start_date, start_time, end_date, end_time, status)
    values
      ('11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000003', 'RC-BACKWARDS',
       '2026-05-01', '18:00', '2026-05-01', '09:00', 'pending');
    v := 'NO-ERROR';
  exception when others then
    v := SQLSTATE;
  end;
  raise notice 'PROBE backwards %', v;
end $$;

\echo '== F2. a genuinely free window is still accepted =='
do $$
declare v text;
begin
  begin
    insert into public.rental_contracts
      (tenant_id, car_id, contract_number, start_date, start_time, end_date, end_time, status)
    values
      ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'RC-FREE',
       '2026-03-12', '18:00', '2026-03-12', '20:00', 'pending');
    v := 'NO-ERROR';
  exception when others then
    v := SQLSTATE;
  end;
  raise notice 'PROBE free_window %', v;
end $$;

\echo '== G. another company''s booking on the same car never conflicts =='
insert into public.rental_contracts
  (tenant_id, car_id, contract_number, start_date, start_time, end_date, end_time, status)
values
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001', 'RC-OTHER-CO',
   '2026-03-12', '15:00', '2026-03-12', '17:00', 'pending');
select
  case when count(*) = 1 then 'PASS' else 'FAIL' end as g_cross_tenant_allowed
from public.rental_contracts where contract_number = 'RC-OTHER-CO';

\echo '== G2. the other company''s zone is honoured for ITS rows =='
select
  case when start_at = timestamptz '2026-03-12 15:00:00+00'
       then 'PASS' else 'FAIL' end as g2_other_tenant_zone
from public.rental_contracts where contract_number = 'RC-OTHER-CO';

\echo '== H. a non-blocking status does not occupy the car =='
insert into public.rental_contracts
  (tenant_id, car_id, contract_number, start_date, start_time, end_date, end_time, status)
values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'RC-CANCELLED',
   '2026-03-12', '15:00', '2026-03-12', '17:00', 'cancelled');
select
  case when count(*) = 1 then 'PASS' else 'FAIL' end as h_cancelled_does_not_block
from public.rental_contracts where contract_number = 'RC-CANCELLED';

\echo '== I. the helper is not callable by a client role =='
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as i_helper_not_granted
from information_schema.routine_privileges
where routine_name = 'company_timezone' and grantee in ('anon', 'authenticated', 'PUBLIC');

\echo '== SUMMARY: every row above must read PASS =='
