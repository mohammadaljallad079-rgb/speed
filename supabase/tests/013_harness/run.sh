#!/usr/bin/env bash
# Execute migration 013 against a real PostgreSQL and assert its behaviour.
#
# 013 adds the database half of the booking->invoice idempotency fix:
#   * a lookup index on invoices(rental_contract_id)
#   * a PARTIAL UNIQUE index preventing a second LIVE invoice per contract
#   * a read-only duplicate report view
#
# It must be additive, idempotent, block a second live invoice, ALLOW a reissue
# after the first is cancelled, and be a clean no-op when `invoices` lacks the
# columns it targets.
#
# Usage (local PostgreSQL 17, superuser reachable):
#   PGHOST=... PGUSER=postgres bash supabase/tests/013_harness/run.sh
# With Docker:
#   docker run -d --name speed_pg13 -e POSTGRES_PASSWORD=postgres \
#     -e POSTGRES_DB=speed013 -p 55433:5432 postgres:17
#   PGHOST=127.0.0.1 PGPORT=55433 PGUSER=postgres PGPASSWORD=postgres \
#     bash supabase/tests/013_harness/run.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_013

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
q() { "${PSQL[@]}" -d "$DB" -tAc "$1" 2>&1; }

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> got: $2"; fail=$((fail+1)); }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3"; fi; }
expect_err() { # desc sql
  local desc="$1" sql="$2" out
  out=$(q "$sql")
  if echo "$out" | grep -qiE "duplicate key|unique|violates|error"; then ok "$desc"; else bad "$desc" "$out"; fi
}

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB"

echo "== base schema: a realistic invoices table =="
"${PSQL[@]}" -d "$DB" >/dev/null <<'SQL'
create table public.rental_contracts (
  id uuid primary key default gen_random_uuid(),
  contract_number text
);
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text,
  invoice_type text default 'sale',
  status text default 'pending',
  rental_contract_id uuid references public.rental_contracts(id),
  total_amount numeric default 0,
  created_at timestamptz default now()
);
SQL

echo "== apply 013 (first run) =="
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/013_booking_invoice_idempotency.sql" >/dev/null 2>&1 \
  && ok "013 applied without error" || bad "013 applied without error" "$(q 'select 1')"

expect_eq "lookup index exists" \
  "1" "$(q "select count(*) from pg_indexes where schemaname='public' and indexname='invoices_rental_contract_id_idx'")"
expect_eq "unique index exists" \
  "1" "$(q "select count(*) from pg_indexes where schemaname='public' and indexname='invoices_one_live_per_rental_contract_uidx'")"
expect_eq "duplicate view exists" \
  "1" "$(q "select count(*) from pg_views where schemaname='public' and viewname='v_duplicate_rental_invoices'")"

echo "== idempotent re-apply =="
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/013_booking_invoice_idempotency.sql" >/dev/null 2>&1 \
  && ok "013 re-applied cleanly (idempotent)" || bad "013 re-applied cleanly (idempotent)" "$(q 'select 1')"

echo "== behaviour: one live invoice per contract =="
C1="11111111-1111-1111-1111-111111111111"
q "insert into public.rental_contracts (id) values ('$C1')" >/dev/null
q "insert into public.invoices (invoice_number, rental_contract_id, status) values ('RI-1','$C1','pending')" >/dev/null
expect_err "second LIVE invoice for the same contract is refused" \
  "insert into public.invoices (invoice_number, rental_contract_id, status) values ('RI-2','$C1','pending')"

echo "== behaviour: a cancelled invoice does NOT block a reissue =="
q "update public.invoices set status='cancelled' where invoice_number='RI-1'" >/dev/null
q "insert into public.invoices (invoice_number, rental_contract_id, status) values ('RI-3','$C1','pending')" >/dev/null 2>&1
expect_eq "reissue after cancellation is allowed" \
  "1" "$(q "select count(*) from public.invoices where rental_contract_id='$C1' and status='pending'")"

echo "== behaviour: many tenant-less (NULL) contracts are unaffected =="
q "insert into public.invoices (invoice_number, rental_contract_id, status) values ('S-1', null, 'pending'), ('S-2', null, 'pending')" >/dev/null 2>&1
expect_eq "NULL rental_contract_id rows are not constrained" \
  "2" "$(q "select count(*) from public.invoices where rental_contract_id is null")"

echo "== behaviour: duplicate report lists the violation =="
C2="22222222-2222-2222-2222-222222222222"
q "insert into public.rental_contracts (id) values ('$C2')" >/dev/null
# Bypass the constraint to simulate a PRE-EXISTING duplicate, as an operator
# would find it in production before applying the migration.
q "alter table public.invoices drop constraint if exists invoices_rental_contract_id_fkey" >/dev/null 2>&1
q "insert into public.invoices (invoice_number, rental_contract_id, status) values ('RI-9','$C2','pending')" >/dev/null 2>&1
q "drop index if exists public.invoices_one_live_per_rental_contract_uidx" >/dev/null
q "insert into public.invoices (invoice_number, rental_contract_id, status) values ('RI-10','$C2','pending')" >/dev/null 2>&1
expect_eq "duplicate view reports the contract" \
  "1" "$(q "select count(*) from public.v_duplicate_rental_invoices where rental_contract_id='$C2'")"
expect_eq "duplicate view counts both invoices" \
  "2" "$(q "select invoice_count from public.v_duplicate_rental_invoices where rental_contract_id='$C2'")"

echo "== rollback =="
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/013_booking_invoice_idempotency_rollback.sql" >/dev/null 2>&1 \
  && ok "rollback ran" || bad "rollback ran" "$(q 'select 1')"
expect_eq "rollback removed the unique index" \
  "0" "$(q "select count(*) from pg_indexes where schemaname='public' and indexname='invoices_one_live_per_rental_contract_uidx'")"
expect_eq "rollback removed the view" \
  "0" "$(q "select count(*) from pg_views where schemaname='public' and viewname='v_duplicate_rental_invoices'")"
expect_eq "rollback preserved the invoice rows" \
  "6" "$(q "select count(*) from public.invoices")"

echo "== no-op on a schema without the target columns =="
"${PSQL[@]}" -c "drop database if exists ${DB}_bare" -c "create database ${DB}_bare" >/dev/null
"${PSQL[@]}" -d "${DB}_bare" -c "create table public.other (id int)" >/dev/null
"${PSQL[@]}" -d "${DB}_bare" -f - < "$ROOT/supabase/migrations/013_booking_invoice_idempotency.sql" >/dev/null 2>&1 \
  && ok "013 is a clean no-op without an invoices table" || bad "013 is a clean no-op without an invoices table" "$(q 'select 1')"
"${PSQL[@]}" -c "drop database if exists ${DB}_bare" >/dev/null

echo
echo "==== 013 harness: $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]
