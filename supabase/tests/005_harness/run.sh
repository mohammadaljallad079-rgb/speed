#!/usr/bin/env bash
# Execute migration 005 against a real PostgreSQL and assert its behaviour.
#
# 005 adds the database half of the accounting-integrity fix: a lookup index, a
# PARTIAL UNIQUE index (one posted journal per sale_invoice / supplier_payment),
# and a read-only integrity view. It must be additive, idempotent, and a clean
# no-op when `journal_entries` lacks the columns it targets.
#
# Requires a local PostgreSQL 17 and a superuser (postgres) you can reach:
#   PGHOST=... PGUSER=postgres bash supabase/tests/005_harness/run.sh
#
# Creates and drops a throwaway database named `speed_005`.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_005

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
if [ "$(id -un)" = "root" ] || [ "$(id -u)" = "0" ]; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
elif command -v sudo >/dev/null && sudo -n -u postgres true 2>/dev/null; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
fi
q() { "${PSQL[@]}" -d "$DB" -tAc "$1" 2>&1; }

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> got: $2"; fail=$((fail+1)); }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3"; fi; }
expect_err() { # desc sql  (must fail)
  local desc="$1" sql="$2" out
  out=$(q "$sql")
  if echo "$out" | grep -qiE "duplicate key|unique|violates|error"; then ok "$desc"; else bad "$desc" "$out"; fi
}

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB"

echo "== base schema (001-004 target tables) =="
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/tests/isolation_harness/base_schema.sql" >/dev/null 2>&1

# Give journal_entries the real columns 005 targets (the isolation harness makes
# a generic shape; the live table has these).
"${PSQL[@]}" -d "$DB" >/dev/null <<'SQL'
alter table public.journal_entries
  add column if not exists entry_type text,
  add column if not exists reference_number text,
  add column if not exists total_debit numeric,
  add column if not exists total_credit numeric;
SQL

echo "== applying 001 -> 005 =="
for m in 001_core_security 002_tenant_isolation_hardening 003_sales_lifecycle 004_global_super_admin 005_accounting_integrity; do
  "${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/$m.sql" >/dev/null
done

echo "== idempotency: re-apply 005 =="
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/005_accounting_integrity.sql" >/dev/null

echo "== assertions =="

expect_eq "B1 lookup index exists" "1" \
  "$(q "select count(*) from pg_indexes where schemaname='public' and indexname='journal_entries_type_ref_idx'")"
expect_eq "B2 partial unique index exists" "1" \
  "$(q "select count(*) from pg_indexes where schemaname='public' and indexname='journal_entries_one_posted_per_doc_uidx'")"
expect_eq "B3 integrity view exists" "1" \
  "$(q "select count(*) from information_schema.views where table_schema='public' and table_name='v_journal_integrity_issues'")"
expect_eq "B3b view empty on clean ledger" "0" \
  "$(q "select count(*) from public.v_journal_integrity_issues")"

# Seed one posted sale journal, then attempt a duplicate.
q "insert into public.journal_entries (entry_type, reference_number, status, total_debit, total_credit) values ('sale_invoice','INV-1','posted',100,100)" >/dev/null
expect_err "B4 duplicate posted sale_invoice blocked" \
  "insert into public.journal_entries (entry_type, reference_number, status, total_debit, total_credit) values ('sale_invoice','INV-1','posted',100,100)"

expect_eq "B5 same reference, different entry_type allowed" "1" \
  "$(q "insert into public.journal_entries (entry_type, reference_number, status, total_debit, total_credit) values ('journal_entry','INV-1','posted',5,5) returning 1" | tail -1)"
expect_eq "B6 non-posted duplicate allowed" "1" \
  "$(q "insert into public.journal_entries (entry_type, reference_number, status, total_debit, total_credit) values ('sale_invoice','INV-1','draft',100,100) returning 1" | tail -1)"
expect_eq "B7 empty reference not constrained" "1" \
  "$(q "insert into public.journal_entries (entry_type, reference_number, status, total_debit, total_credit) values ('sale_invoice','','posted',1,1) returning 1" | tail -1)"

# An unbalanced header must be surfaced by the view.
q "insert into public.journal_entries (entry_type, reference_number, status, total_debit, total_credit) values ('journal_entry','BAD-1','posted',10,9)" >/dev/null
expect_eq "B8 view flags an unbalanced header" "1" \
  "$(q "select count(*) from public.v_journal_integrity_issues where issue='unbalanced_header' and reference_number='BAD-1'")"

echo "== clean no-op path: journal_entries without the target columns =="
"${PSQL[@]}" -c "drop database if exists speed_005_noop" -c "create database speed_005_noop" >/dev/null
"${PSQL[@]}" -d speed_005_noop -f - < "$ROOT/supabase/tests/isolation_harness/base_schema.sql" >/dev/null 2>&1
# The generic journal_entries has no entry_type/reference_number/total_debit.
OUT=$("${PSQL[@]}" -d speed_005_noop -f - < "$ROOT/supabase/migrations/005_accounting_integrity.sql" 2>&1 || true)
if echo "$OUT" | grep -qiE "error"; then bad "B9 005 is a clean no-op without target columns" "$OUT"; else ok "B9 005 is a clean no-op without target columns"; fi
"${PSQL[@]}" -c "drop database if exists speed_005_noop" >/dev/null

echo "-----------------------------------------"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && echo "005: PASS" || echo "005: FAIL"
