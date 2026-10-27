#!/usr/bin/env bash
# ============================================================================
# Migration 017 harness - the booking overlap guard.
#
# The claim under test is a CONCURRENCY claim ("two simultaneous bookings cannot
# both succeed"), so it is not enough to apply the SQL and read it back. This
# harness proves, on a real PostgreSQL 17:
#
#   1. 017 applies cleanly and is idempotent on re-apply;
#   2. the exclusion constraint exists and refuses an overlapping INSERT;
#   3. a half-open window is respected (a turnover on the same day is allowed);
#   4. a DIFFERENT car, a DIFFERENT company and a non-blocking status are allowed;
#   5. the tenant-less install is protected too (NULL tenant is not a loophole);
#   6. the trigger fallback refuses an overlap even with the constraint dropped;
#   7. the rollback removes the guard and leaves the data intact.
#
# Run:  bash supabase/tests/017_harness/run.sh
# Connection honours PGHOST/PGPORT/PGUSER/PGPASSWORD.
# ============================================================================

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_017

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
if [ -n "$PGHOST" ]; then PSQL+=(-h "$PGHOST"); fi
if [ -n "$PGPORT" ]; then PSQL+=(-p "$PGPORT"); fi
if [ -n "$PGUSER" ]; then PSQL+=(-U "$PGUSER"); fi
q() { "${PSQL[@]}" -d "$DB" -tAc "$1" 2>&1; }

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> got: $2"; fail=$((fail+1)); }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3"; fi; }
expect_refused() {
  local out; out=$(q "$2")
  if echo "$out" | grep -qiE "exclusion_violation|already booked|conflicting|violates exclusion|exclusion constraint"; then
    ok "$1"
  else
    bad "$1" "$out"
  fi
}

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB" >/dev/null

echo "== schema (rental_contracts with the real shape) =="
"${PSQL[@]}" -d "$DB" >/dev/null <<'SQL'
create extension if not exists pgcrypto;
create table public.rental_contracts (
  id uuid primary key default gen_random_uuid(),
  contract_number text,
  car_id uuid,
  customer_id uuid,
  start_date date,
  end_date date,
  -- The real pickup/return TIME. Present here so the harness exercises the
  -- date+time precision 017 selects; a date-only harness would not notice if
  -- the migration silently fell back to calendar dates.
  start_time time,
  end_time time,
  status text default 'pending',
  tenant_id uuid
);
create table public.cars (
  id uuid primary key default gen_random_uuid(),
  make text, model text, category text default 'rental', status text default 'available',
  tenant_id uuid
);
insert into public.cars (id, make, model, tenant_id) values
  ('ca000000-0000-0000-0000-00000000000a','Toyota','Corolla','11111111-1111-1111-1111-111111111111'),
  ('ca000000-0000-0000-0000-00000000000b','Nissan','Sunny',  '11111111-1111-1111-1111-111111111111'),
  ('ca000000-0000-0000-0000-00000000000c','Kia','Sportage',  null);
SQL

echo "== apply 017 =="
if ! out=$("${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/017_booking_overlap_guard.sql" 2>&1); then
  echo " FAIL | 017 did not apply"; echo "$out" | grep -iE "error" | head -3; fail=$((fail+1))
fi
echo "== re-apply 017 (idempotence) =="
if ! out=$("${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/017_booking_overlap_guard.sql" 2>&1); then
  echo " FAIL | 017 re-apply was not idempotent"; echo "$out" | grep -iE "error" | head -3; fail=$((fail+1))
fi

TEN_A=11111111-1111-1111-1111-111111111111
CAR_A=ca000000-0000-0000-0000-00000000000a
CAR_B=ca000000-0000-0000-0000-00000000000b
CAR_N=ca000000-0000-0000-0000-00000000000c

echo
echo "== 1. The guard exists =="
expect_eq "A1 the exclusion constraint exists" "1" \
  "$(q "select count(*) from pg_constraint where conname='rental_contracts_no_car_overlap'")"
expect_eq "A2 the trigger exists" "1" \
  "$(q "select count(*) from pg_trigger where tgname='rental_contracts_no_double_booking'")"
expect_eq "A3 the status helper is not callable by a client" "0" \
  "$(q "select count(*) from information_schema.routine_privileges where routine_name='booking_blocks_car' and grantee in ('anon','authenticated','PUBLIC')")"

echo
echo "== 2. The core claim: an overlapping booking is refused =="
q "insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
   values ('RC-1','$CAR_A','2026-03-01','2026-03-05','pending','$TEN_A');" >/dev/null
expect_refused "B1 a fully overlapping window is refused" \
  "insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
   values ('RC-2','$CAR_A','2026-03-03','2026-03-07','confirmed','$TEN_A');"
expect_refused "B2 a containing window is refused" \
  "insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
   values ('RC-3','$CAR_A','2026-02-25','2026-03-10','active','$TEN_A');"
expect_refused "B3 a contained window is refused" \
  "insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
   values ('RC-4','$CAR_A','2026-03-02','2026-03-03','rented','$TEN_A');"
expect_refused "B4 a window starting on the last day is refused" \
  "insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
   values ('RC-5','$CAR_A','2026-03-04','2026-03-09','pending','$TEN_A');"

echo
echo "== 3. Half-open semantics: a turnover is allowed =="
expect_eq "C1 a rental starting the day the previous ends is allowed" "1" \
  "$(q "with t as (insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
       values ('RC-6','$CAR_A','2026-03-05','2026-03-09','pending','$TEN_A') returning 1) select count(*) from t")"
expect_eq "C2 a rental ending the day another begins is allowed" "1" \
  "$(q "with t as (insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
       values ('RC-7','$CAR_A','2026-02-20','2026-03-01','pending','$TEN_A') returning 1) select count(*) from t")"

echo
echo "== 4. Scope: what must NOT be blocked =="
expect_eq "D1 a different car is allowed" "1" \
  "$(q "with t as (insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
       values ('RC-8','$CAR_B','2026-03-01','2026-03-05','pending','$TEN_A') returning 1) select count(*) from t")"
expect_eq "D2 another company may book the same window on its own car" "1" \
  "$(q "with t as (insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
       values ('RC-9','$CAR_A','2026-03-01','2026-03-05','pending','22222222-2222-2222-2222-222222222222') returning 1) select count(*) from t")"
expect_eq "D3 a non-blocking status does not conflict" "1" \
  "$(q "with t as (insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
       values ('RC-10','$CAR_A','2026-03-01','2026-03-05','cancelled','$TEN_A') returning 1) select count(*) from t")"
expect_eq "D4 the same car in the other company is a DIFFERENT booking, so overlap is allowed" "1" \
  "$(q "with t as (insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
       values ('RC-11','$CAR_B','2026-03-02','2026-03-06','pending','22222222-2222-2222-2222-222222222222') returning 1) select count(*) from t")"

echo
echo "== 5. The tenant-less install is protected (NULL is not a loophole) =="
q "insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status)
   values ('RC-N1','$CAR_N','2026-04-01','2026-04-05','pending');" >/dev/null
expect_refused "E1 a NULL-tenant overlap is refused (the constraint coalesces the tenant)" \
  "insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status)
   values ('RC-N2','$CAR_N','2026-04-03','2026-04-08','pending');"

echo
echo "== 6. The trigger fallback stands alone =="
q "alter table public.rental_contracts drop constraint rental_contracts_no_car_overlap;" >/dev/null
expect_eq "F1 the exclusion constraint is gone" "0" \
  "$(q "select count(*) from pg_constraint where conname='rental_contracts_no_car_overlap'")"
expect_refused "F2 the trigger still refuses an overlap without the constraint" \
  "insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
   values ('RC-12','$CAR_B','2026-03-03','2026-03-04','pending','$TEN_A');"
expect_eq "F3 the trigger still allows a non-overlapping window" "1" \
  "$(q "with t as (insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
       values ('RC-13','$CAR_B','2026-03-05','2026-03-06','pending','$TEN_A') returning 1) select count(*) from t")"
expect_refused "F4 the trigger refuses MOVING a booking onto a taken window" \
  "update public.rental_contracts set start_date='2026-03-01', end_date='2026-03-04' where contract_number='RC-13';"
expect_eq "F5 the trigger allows cancelling a booking (status leaves the blocking set)" "1" \
  "$(q "with t as (update public.rental_contracts set status='cancelled' where contract_number='RC-1' returning 1) select count(*) from t")"

echo
echo "== 7. The guard is race-safe BY CONSTRUCTION (advisory lock in the trigger) =="
# The concurrency behaviour itself is proved by race.py (two real sessions).
# Here we assert the property that makes it work, so a future edit that removes
# the lock fails this harness even if race.py were not run.
expect_eq "H1 the trigger body takes a transaction-level advisory lock" "1" \
  "$(q "select count(*) from pg_proc where proname='prevent_car_double_booking' and prosrc like '%pg_advisory_xact_lock%'")"
expect_eq "H2 the lock is keyed on the tenant AND the car (not a global lock)" "1" \
  "$(q "select count(*) from pg_proc where proname='prevent_car_double_booking' and prosrc like '%new.car_id%' and prosrc like '%new.tenant_id%'")"
expect_eq "H3 the guard is SECURITY DEFINER with a pinned search_path" "1" \
  "$(q "select count(*) from pg_proc where proname='prevent_car_double_booking' and prosecdef and proconfig::text like '%search_path=public%'")"

echo
echo "== 8. Booking precision: the guard honours the real pickup/return TIME =="
# A date-only guard is WRONG when the booking has a time: two same-day windows
# that do not overlap must both be accepted. This schema has date+time columns,
# so 017 must have selected the date+time window.
expect_eq "I1 017 detected the date+time precision" "1" \
  "$(q "select count(*) from pg_proc where proname='prevent_car_double_booking' and prosrc like '%start_time%' and prosrc like '%end_time%'")"
q "insert into public.rental_contracts (contract_number, car_id, start_date, end_date, start_time, end_time, status, tenant_id)
   values ('RC-T1','$CAR_A','2026-06-01','2026-06-01','09:00','11:00','pending','$TEN_A');" >/dev/null
expect_eq "I2 a same-day window at a LATER time is accepted (date-only would refuse it)" "1" \
  "$(q "with t as (insert into public.rental_contracts (contract_number, car_id, start_date, end_date, start_time, end_time, status, tenant_id)
       values ('RC-T2','$CAR_A','2026-06-01','2026-06-01','11:00','13:00','pending','$TEN_A') returning 1) select count(*) from t")"
expect_refused "I3 a same-day window that DOES overlap is refused" \
  "insert into public.rental_contracts (contract_number, car_id, start_date, end_date, start_time, end_time, status, tenant_id)
   values ('RC-T3','$CAR_A','2026-06-01','2026-06-01','10:30','11:30','pending','$TEN_A');"
expect_refused "I4 a date-only row at midnight conflicts with a timed window on the same day" \
  "insert into public.rental_contracts (contract_number, car_id, start_date, end_date, status, tenant_id)
   values ('RC-T4','$CAR_A','2026-06-01','2026-06-02','pending','$TEN_A');"

echo
echo "== 9. Fail-closed activation: a table it cannot guard is a HARD ERROR =="
"${PSQL[@]}" -c "drop database if exists ${DB}_nw" -c "create database ${DB}_nw" >/dev/null
"${PSQL[@]}" -d "${DB}_nw" >/dev/null <<'SQL'
create table public.rental_contracts (id uuid primary key, car_id uuid, status text);
SQL
out=$("${PSQL[@]}" -d "${DB}_nw" -f - < "$ROOT/supabase/migrations/017_booking_overlap_guard.sql" 2>&1)
if echo "$out" | grep -qiE "no usable booking window"; then
  ok "J1 017 refuses activation when it cannot guard (no silent success)"
else
  bad "J1 017 refuses activation when it cannot guard (no silent success)" "$(echo "$out" | grep -iE 'error|notice' | head -2)"
fi
"${PSQL[@]}" -c "drop database if exists ${DB}_nw" >/dev/null 2>&1

echo
echo "== 10. Rollback =="
before=$(q "select count(*) from public.rental_contracts")
if ! out=$("${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/017_booking_overlap_guard_rollback.sql" 2>&1); then
  echo " FAIL | the rollback did not apply"; echo "$out" | grep -iE "error" | head -3; fail=$((fail+1))
fi
expect_eq "G1 the trigger is gone" "0" \
  "$(q "select count(*) from pg_trigger where tgname='rental_contracts_no_double_booking'")"
expect_eq "G2 the guard function is gone" "0" \
  "$(q "select count(*) from pg_proc where proname='prevent_car_double_booking'")"
expect_eq "G3 the status helper is gone" "0" \
  "$(q "select count(*) from pg_proc where proname='booking_blocks_car'")"
expect_eq "G4 the rollback deleted no row" "$before" \
  "$(q "select count(*) from public.rental_contracts")"

echo
echo "========================================="
echo "RESULT: $pass passed, $fail failed"
if [ "$fail" -eq 0 ]; then echo "MIGRATION 017: PASS"; else echo "MIGRATION 017: FAIL"; fi
echo "========================================="

"${PSQL[@]}" -c "drop database if exists $DB" >/dev/null 2>&1
[ "$fail" -eq 0 ]
