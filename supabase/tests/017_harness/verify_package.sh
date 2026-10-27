#!/usr/bin/env bash
# Apply the frozen 017 activation package (PRE-FLIGHT + embedded body + POST-FLIGHT)
# to a throwaway database and report every POST-FLIGHT row.
set -u
DB=speed_pkg017
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
[ -n "${PGHOST:-}" ] && PSQL+=(-h "$PGHOST")
[ -n "${PGPORT:-}" ] && PSQL+=(-p "$PGPORT")
[ -n "${PGUSER:-}" ] && PSQL+=(-U "$PGUSER")

"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB" >/dev/null
"${PSQL[@]}" -d "$DB" >/dev/null <<'SQL'
create extension if not exists pgcrypto;
create table public.rental_contracts (
  id uuid primary key default gen_random_uuid(), contract_number text, car_id uuid,
  customer_id uuid, start_date date, end_date date, status text default 'pending', tenant_id uuid);
SQL

echo "== apply the ACTIVATION PACKAGE 017 (PRE + body + POST) =="
if "${PSQL[@]}" -d "$DB" -f supabase/PRODUCTION_ACTIVATION_017.sql >/tmp/pkg017.out 2>&1; then
  echo " apply: OK"
else
  echo " apply: FAILED"; grep -iE "error" /tmp/pkg017.out | head -5
fi
echo
echo "== POST-FLIGHT (every row must read t) =="
"${PSQL[@]}" -d "$DB" -c "
select 'status helper' as item, exists (select 1 from pg_proc where proname='booking_blocks_car') as ok
union all select 'trigger', exists (select 1 from pg_trigger where tgname='rental_contracts_no_double_booking')
union all select 'exclusion constraint OR no btree_gist',
  exists (select 1 from pg_constraint where conname='rental_contracts_no_car_overlap')
  or not exists (select 1 from pg_extension where extname='btree_gist')
union all select 'guards not client-callable',
  (select count(*) from information_schema.routine_privileges
   where routine_name in ('booking_blocks_car','prevent_car_double_booking')
     and grantee in ('anon','authenticated','PUBLIC'))=0
order by ok, item;"

echo "== the guard actually refuses an overlap (post-package) =="
CAR=ca000000-0000-0000-0000-00000000000a
TEN=11111111-1111-1111-1111-111111111111
"${PSQL[@]}" -d "$DB" -c "insert into public.rental_contracts (contract_number,car_id,start_date,end_date,status,tenant_id) values ('RC-1','$CAR','2026-03-01','2026-03-05','pending','$TEN');" >/dev/null
out=$("${PSQL[@]}" -d "$DB" -c "insert into public.rental_contracts (contract_number,car_id,start_date,end_date,status,tenant_id) values ('RC-2','$CAR','2026-03-03','2026-03-06','pending','$TEN');" 2>&1)
if echo "$out" | grep -qiE "exclusion|already booked|conflicting"; then echo " refused: OK"; else echo " NOT REFUSED: $out"; fi

"${PSQL[@]}" -c "drop database if exists $DB" >/dev/null 2>&1
