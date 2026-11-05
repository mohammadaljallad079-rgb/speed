#!/usr/bin/env bash
# ============================================================================
# 018 harness: prove migration 018 by EXECUTION on a real PostgreSQL 17.
#
# Usage:
#   bash supabase/tests/018_harness/run.sh [psql_connection_args...]
#
# Needs a reachable PostgreSQL 17 with a superuser (to create a throwaway
# database). Defaults to the local socket; override with PGHOST/PGUSER or by
# passing psql args, e.g.  bash run.sh -h localhost -U postgres
#
# It applies the REAL migration file - not a copy of its logic - so the evidence
# is about the artifact that ships, and it asserts behaviour (what the database
# does), never the presence of text in a file.
#
# The scenarios are the ones a rental business depends on:
#   * the backfill produced instants in the COMPANY's timezone
#   * a same-day booking at a different time is allowed (the point of 018)
#   * overlapping hours are refused; adjacent bookings are a turnover
#   * a row written with only the legacy columns is derived AND guarded
#   * a backwards window is refused; another company never conflicts
#   * the rollback removes what it says, and deletes no row
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MIG="$ROOT/supabase/migrations/018_booking_time_precision.sql"
RB="$ROOT/supabase/migrations/018_booking_time_precision_rollback.sql"
DB="speed_harness_018"
ARGS=("$@")

PSQL=(psql -X -q -v ON_ERROR_STOP=1 "${ARGS[@]}")
pass=0
fail=0

note() { printf '%s\n' "$*"; }
ok()   { pass=$((pass + 1)); printf ' PASS | %s\n' "$*"; }
bad()  { fail=$((fail + 1)); printf ' FAIL | %s\n' "$*"; }

scalar() { "${PSQL[@]}" -tA -d "$DB" -c "$1" 2>/dev/null | head -1; }

# Assert a boolean SQL expression is true.
check() { # name, sql
  local v
  v="$(scalar "$2")"
  [ "$v" = "t" ] && ok "$1" || bad "$1 (got: ${v:-<null>})"
}

for f in "$MIG" "$RB" "$HERE/schema.sql" "$HERE/assert.sql"; do
  [ -f "$f" ] || { note "missing $f"; exit 2; }
done

note "== 018 harness (PostgreSQL 17) =="
"${PSQL[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
"${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null 2>&1 \
  || { note "could not create the harness database; is PostgreSQL reachable?"; exit 2; }

# --- the pre-migration shape (DATE-ONLY, as the live project is today) -------
"${PSQL[@]}" -d "$DB" -f "$HERE/schema.sql" >/dev/null 2>&1 || { note "schema failed"; exit 2; }

"${PSQL[@]}" -d "$DB" -q >/dev/null 2>&1 <<'SQL'
insert into public.settings (tenant_id, key, value)
values ('11111111-1111-1111-1111-111111111111', 'company_timezone', 'Asia/Bahrain');
insert into public.rental_contracts
  (tenant_id, car_id, contract_number, start_date, end_date, status)
values
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-0000-0000-0000-000000000001', 'RC-LEGACY', '2026-03-10', '2026-03-12', 'pending');
SQL

check "the pre-migration schema really has no time columns (the harness starts where the live DB is)" \
  "select count(*) = 0 from information_schema.columns where table_name='rental_contracts' and column_name in ('start_at','end_at','start_time','end_time')"

# --- 1. apply, then re-apply ------------------------------------------------
if "${PSQL[@]}" -d "$DB" -f "$MIG" >/tmp/h018_apply.log 2>&1; then
  ok "migration 018 applies on a date-only schema"
else
  bad "migration 018 FAILED to apply"; sed -n '1,25p' /tmp/h018_apply.log; exit 1
fi

if "${PSQL[@]}" -d "$DB" -f "$MIG" >/tmp/h018_reapply.log 2>&1; then
  ok "migration 018 re-applies idempotently"
else
  bad "migration 018 FAILED on re-apply"; sed -n '1,25p' /tmp/h018_reapply.log
fi

check "the four time columns exist" \
  "select count(*) = 4 from information_schema.columns where table_name='rental_contracts' and column_name in ('start_at','end_at','start_time','end_time')"
check "the guard trigger is installed" \
  "select count(*) = 1 from pg_trigger where tgname='rental_contracts_no_double_booking' and not tgisinternal"
check "the trigger body takes the advisory lock (race safety preserved)" \
  "select prosrc like '%pg_advisory_xact_lock%' from pg_proc where proname='prevent_car_double_booking'"
check "the trigger DERIVES the window from the legacy columns" \
  "select prosrc like '%new.start_at :=%' from pg_proc where proname='prevent_car_double_booking'"

# --- 2. the behavioural assertions -----------------------------------------
OUT="$("${PSQL[@]}" -d "$DB" -f "$HERE/assert.sql" 2>&1)"

probe() { # label, expected SQLSTATE, description
  local got
  got="$(printf '%s\n' "$OUT" | grep "PROBE $1 " | head -1 | awk '{print $NF}')"
  [ "$got" = "$2" ] && ok "$3" || bad "$3 (SQLSTATE ${got:-<none>}, expected $2)"
}

check "the backfill produced instants in the COMPANY's timezone" \
  "select start_at = timestamptz '2026-03-10 00:00:00+03' and end_at = timestamptz '2026-03-12 00:00:00+03' from public.rental_contracts where contract_number='RC-LEGACY'"
check "the helper resolves the configured zone and defaults without one" \
  "select public.company_timezone('11111111-1111-1111-1111-111111111111') = 'Asia/Bahrain' and public.company_timezone(null) = 'Asia/Bahrain'"
check "a per-tenant zone is honoured (Europe/London, not the default)" \
  "select public.company_timezone('22222222-2222-2222-2222-222222222222') = 'Europe/London'"
check "a same-day booking at a DIFFERENT time is allowed (the point of 018)" \
  "select start_at = timestamptz '2026-03-12 14:00:00+03' and end_at = timestamptz '2026-03-12 16:00:00+03' from public.rental_contracts where contract_number='RC-SAMEDAY'"
check "an adjacent booking (16:00 return, 16:00 pickup) is a turnover" \
  "select count(*) = 1 from public.rental_contracts where contract_number='RC-ADJACENT'"
check "a legacy row with NO instants written was derived and guarded" \
  "select start_at = timestamptz '2026-04-01 00:00:00+03' and end_at = timestamptz '2026-04-03 00:00:00+03' from public.rental_contracts where contract_number='RC-DERIVE'"
check "another company's booking on the same car never conflicts" \
  "select count(*) = 1 from public.rental_contracts where contract_number='RC-OTHER-CO'"
check "the other company's zone is honoured for ITS rows" \
  "select start_at = timestamptz '2026-03-12 15:00:00+00' from public.rental_contracts where contract_number='RC-OTHER-CO'"
check "a non-blocking status does not occupy the car" \
  "select count(*) = 1 from public.rental_contracts where contract_number='RC-CANCELLED'"
check "the helper is not callable by a client role" \
  "select count(*) = 0 from information_schema.routine_privileges where routine_name='company_timezone' and grantee in ('anon','authenticated','PUBLIC')"

probe overlapping_hours "23P01" "overlapping hours on the same day are refused"
probe legacy_overlap    "23P01" "a legacy-column overlap is refused (the derive is load-bearing)"
probe backwards         "23514" "a backwards window is refused by the CHECK constraint"
probe free_window       "NO-ERROR" "a genuinely free window is still accepted"

# --- 3. the rollback -------------------------------------------------------
BEFORE="$(scalar "select count(*) from public.rental_contracts")"
if "${PSQL[@]}" -d "$DB" -f "$RB" >/tmp/h018_rb.log 2>&1; then
  ok "the rollback runs"
else
  bad "the rollback FAILED"; sed -n '1,25p' /tmp/h018_rb.log
fi

check "the rollback removed the time columns" \
  "select count(*) = 0 from information_schema.columns where table_name='rental_contracts' and column_name in ('start_at','end_at','start_time','end_time')"
check "the rollback deleted no booking row" \
  "select count(*) = $BEFORE from public.rental_contracts"
check "the rollback dropped the helper" \
  "select count(*) = 0 from pg_proc where proname='company_timezone'"

note "-----------------------------------------"
note "RESULT: $pass passed, $fail failed"
if [ "$fail" -eq 0 ]; then note "018 HARNESS: PASS"; exit 0; else note "018 HARNESS: FAIL"; exit 1; fi
