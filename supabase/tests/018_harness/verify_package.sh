#!/usr/bin/env bash
# ============================================================================
# Verify the FROZEN activation package for 018, not just the raw migration.
#
# The package is what an operator pastes into the Supabase SQL Editor, so it is
# the artifact that must work: this applies supabase/PRODUCTION_ACTIVATION_018.sql
# whole - PRE-FLIGHT, embedded body, POST-FLIGHT - on a date-only schema, twice,
# and fails if any statement errors or if the POST-FLIGHT is not all-true.
#
# Usage: bash supabase/tests/018_harness/verify_package.sh [psql args...]
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PKG="$ROOT/supabase/PRODUCTION_ACTIVATION_018.sql"
DB="speed_pkg_018"
ARGS=("$@")
PSQL=(psql -X -q -v ON_ERROR_STOP=1 "${ARGS[@]}")

pass=0; fail=0
ok()  { pass=$((pass+1)); printf ' PASS | %s\n' "$*"; }
bad() { fail=$((fail+1)); printf ' FAIL | %s\n' "$*"; }

[ -f "$PKG" ] || { echo "missing $PKG"; exit 2; }

echo "== 018 activation-package harness =="
"${PSQL[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
"${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null 2>&1 \
  || { echo "cannot create $DB; is PostgreSQL reachable?"; exit 2; }

"${PSQL[@]}" -d "$DB" -f "$HERE/schema.sql" >/dev/null 2>&1 || { echo "schema failed"; exit 2; }
"${PSQL[@]}" -d "$DB" -q >/dev/null 2>&1 <<'SQL'
insert into public.settings (tenant_id, key, value)
values ('11111111-1111-1111-1111-111111111111', 'company_timezone', 'Asia/Bahrain');
insert into public.rental_contracts
  (tenant_id, car_id, contract_number, start_date, end_date, status)
values
  ('11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-0000-0000-0000-000000000001', 'RC-LEGACY', '2026-03-10', '2026-03-12', 'pending');
SQL

# --- the whole package, twice ----------------------------------------------
for run in 1 2; do
  OUT="$("${PSQL[@]}" -d "$DB" -f "$PKG" 2>&1)"
  if echo "$OUT" | grep -qE '^psql:.*ERROR'; then
    bad "the package failed on run $run"
    printf '%s\n' "$OUT" | grep -E 'ERROR' | head -5
    exit 1
  fi
  ok "the whole package applied on run $run"
done

# --- the POST-FLIGHT must be all-true --------------------------------------
# Only the table AFTER the POST-FLIGHT marker counts: the PRE-FLIGHT's
# "not already applied" row is legitimately false on a second run, and counting it
# would make an idempotent package look broken.
LAST="$("${PSQL[@]}" -d "$DB" -f "$PKG" 2>&1)"
FALSE_ROWS="$(printf '%s\n' "$LAST" \
  | awk '/POST-FLIGHT VERIFICATION/{seen=1} seen && /item *\| *ok/{flag=1;next} seen && /^\(/{flag=0} flag' \
  | grep -cE '\| f$')"
if [ "${FALSE_ROWS:-0}" = "0" ]; then
  ok "the POST-FLIGHT reports no false row"
else
  bad "the POST-FLIGHT has $FALSE_ROWS false row(s)"
fi

# --- the end state ----------------------------------------------------------
check() { # name, sql
  local v; v="$("${PSQL[@]}" -tA -d "$DB" -c "$2" 2>/dev/null | head -1)"
  [ "$v" = "t" ] && ok "$1" || bad "$1 (got: ${v:-<null>})"
}
check "the embedded body really took effect (the time columns exist)" \
  "select count(*) = 4 from information_schema.columns where table_name='rental_contracts' and column_name in ('start_at','end_at','start_time','end_time')"
check "the legacy row was backfilled (the package is not a no-op)" \
  "select start_at = timestamptz '2026-03-10 00:00:00+03' from public.rental_contracts where contract_number='RC-LEGACY'"
check "the guard is at instant precision" \
  "select prosrc like '%new.start_at :=%' from pg_proc where proname='prevent_car_double_booking'"

echo "-----------------------------------------"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && { echo "018 PACKAGE: PASS"; exit 0; } || { echo "018 PACKAGE: FAIL"; exit 1; }
