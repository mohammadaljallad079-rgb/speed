#!/usr/bin/env bash
# Execute the frozen 005 -> 006 activation bundle against a real PostgreSQL and
# assert its behaviour in three scenarios:
#
#   A. clean ledger           -> bundle applies, all objects appear
#   B. re-apply               -> idempotent, no error, objects unchanged
#   C. pre-existing duplicate -> bundle ABORTS and leaves NO partial change
#
# Requires a local PostgreSQL 17 and a superuser (postgres) you can reach:
#   PGHOST=... PGUSER=postgres bash supabase/tests/activation_005_006_harness/run.sh
#
# Creates and drops throwaway databases named `speed_act005` / `speed_act005_dup`.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PKG="$ROOT/supabase/PRODUCTION_ACTIVATION_005_006.sql"
DB=speed_act005
DBDUP=speed_act005_dup

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
if [ "$(id -un)" = "root" ] || [ "$(id -u)" = "0" ]; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
elif command -v sudo >/dev/null && sudo -n -u postgres true 2>/dev/null; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
fi
q() { "${PSQL[@]}" -d "$1" -tAc "$2" 2>&1; }

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> got: $2"; fail=$((fail+1)); }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3"; fi; }

# Same predicate as the 005 unique index: rows that would make it fail.
DUP_QUERY="select count(*) from (
  select 1 from public.journal_entries
   where status='posted' and reference_number is not null and reference_number <> ''
     and entry_type in ('sale_invoice','supplier_payment')
   group by entry_type, reference_number having count(*) > 1
) d"

prepare() { # db
  "${PSQL[@]}" -c "drop database if exists $1" -c "create database $1" >/dev/null
  "${PSQL[@]}" -d "$1" -f - < "$ROOT/supabase/tests/isolation_harness/base_schema.sql" >/dev/null 2>&1
  "${PSQL[@]}" -d "$1" >/dev/null <<'SQL'
alter table public.journal_entries
  add column if not exists entry_type text,
  add column if not exists reference_number text,
  add column if not exists total_debit numeric,
  add column if not exists total_credit numeric;
SQL
  for m in 001_core_security 002_tenant_isolation_hardening 003_sales_lifecycle 004_global_super_admin; do
    "${PSQL[@]}" -d "$1" -f - < "$ROOT/supabase/migrations/$m.sql" >/dev/null
  done
}

apply_pkg() { # db  -> echoes output, returns psql status
  "${PSQL[@]}" -d "$1" -f - < "$PKG" 2>&1
}

echo "================ SCENARIO A: clean ledger ================"
prepare "$DB"
echo "== applying the bundle (clean) =="
OUT=$(apply_pkg "$DB"); rc=$?
if [ "$rc" -eq 0 ]; then ok "A0 bundle applies with no error"; else bad "A0 bundle applies with no error" "$OUT"; fi

expect_eq "A1 lookup index exists" "1" \
  "$(q "$DB" "select count(*) from pg_indexes where schemaname='public' and indexname='journal_entries_type_ref_idx'")"
expect_eq "A2 partial unique index exists" "1" \
  "$(q "$DB" "select count(*) from pg_indexes where schemaname='public' and indexname='journal_entries_one_posted_per_doc_uidx'")"
expect_eq "A3 integrity view exists" "1" \
  "$(q "$DB" "select count(*) from information_schema.views where table_schema='public' and table_name='v_journal_integrity_issues'")"
expect_eq "A4 view empty on clean ledger" "0" \
  "$(q "$DB" "select count(*) from public.v_journal_integrity_issues")"
expect_eq "A5 ai_repair_executions table exists" "1" \
  "$(q "$DB" "select count(*) from information_schema.tables where table_schema='public' and table_name='ai_repair_executions'")"
expect_eq "A6 RLS enabled on ai_repair_executions" "t" \
  "$(q "$DB" "select relrowsecurity from pg_class where oid='public.ai_repair_executions'::regclass")"
expect_eq "A7 tenant unique index exists" "1" \
  "$(q "$DB" "select count(*) from pg_indexes where schemaname='public' and indexname='ai_repair_executions_tenant_key_uidx'")"
expect_eq "A8 null-tenant unique index exists" "1" \
  "$(q "$DB" "select count(*) from pg_indexes where schemaname='public' and indexname='ai_repair_executions_null_tenant_key_uidx'")"
expect_eq "A9 delete policy is RESTRICTIVE (permissive=false)" "f" \
  "$(q "$DB" "select polpermissive from pg_policy where polrelid='public.ai_repair_executions'::regclass and polname='ai_repair_executions_no_delete'")"
expect_eq "A10 anon holds no SELECT privilege" "f" \
  "$(q "$DB" "select has_table_privilege('anon','public.ai_repair_executions','select')")"
expect_eq "A11 preflight duplicate query returns 0 rows" "0" "$(q "$DB" "$DUP_QUERY")"

echo "== 006 claim semantics (superuser path) =="
q "$DB" "insert into public.ai_repair_executions (proposal_id,action,plan_fingerprint,content_fingerprint,idempotency_key) values ('p','a','pf','cf','k1')" >/dev/null
expect_eq "A12 null-tenant key accepted" "1" \
  "$(q "$DB" "select count(*) from public.ai_repair_executions where idempotency_key='k1'")"
DUPOUT=$(q "$DB" "insert into public.ai_repair_executions (proposal_id,action,plan_fingerprint,content_fingerprint,idempotency_key) values ('p','a','pf','cf','k1')")
if echo "$DUPOUT" | grep -qiE "duplicate key|unique|violates"; then ok "A13 duplicate null-tenant key blocked"; else bad "A13 duplicate null-tenant key blocked" "$DUPOUT"; fi
q "$DB" "insert into public.ai_repair_executions (tenant_id,proposal_id,action,plan_fingerprint,content_fingerprint,idempotency_key) values ('11111111-1111-1111-1111-111111111111','p','a','pf','cf','k1')" >/dev/null
expect_eq "A14 same key allowed for a real tenant" "1" \
  "$(q "$DB" "select count(*) from public.ai_repair_executions where tenant_id='11111111-1111-1111-1111-111111111111'")"

echo "================ SCENARIO B: re-apply (idempotent) ================"
OUT=$(apply_pkg "$DB"); rc=$?
if [ "$rc" -eq 0 ]; then ok "B0 bundle re-applies with no error"; else bad "B0 bundle re-applies with no error" "$OUT"; fi
expect_eq "B1 unique index still exactly one" "1" \
  "$(q "$DB" "select count(*) from pg_indexes where schemaname='public' and indexname='journal_entries_one_posted_per_doc_uidx'")"
expect_eq "B2 rows preserved after re-apply (no reset)" "2" \
  "$(q "$DB" "select count(*) from public.ai_repair_executions")"

echo "================ SCENARIO C: pre-existing duplicate ================"
prepare "$DBDUP"
# Seed the exact conflict the unique index forbids (two posted sale_invoice, same ref).
q "$DBDUP" "insert into public.journal_entries (entry_type,reference_number,status,total_debit,total_credit) values ('sale_invoice','INV-DUP','posted',100,100)" >/dev/null
q "$DBDUP" "insert into public.journal_entries (entry_type,reference_number,status,total_debit,total_credit) values ('sale_invoice','INV-DUP','posted',100,100)" >/dev/null

expect_eq "C1 preflight query DETECTS the conflict before apply" "1" "$(q "$DBDUP" "$DUP_QUERY")"

OUT=$(apply_pkg "$DBDUP"); rc=$?
if [ "$rc" -ne 0 ]; then ok "C2 bundle ABORTS on the duplicate"; else bad "C2 bundle ABORTS on the duplicate" "applied unexpectedly"; fi
expect_eq "C3 NO partial change: unique index absent" "0" \
  "$(q "$DBDUP" "select count(*) from pg_indexes where schemaname='public' and indexname='journal_entries_one_posted_per_doc_uidx'")"
expect_eq "C4 NO partial change: lookup index absent (005 rolled back)" "0" \
  "$(q "$DBDUP" "select count(*) from pg_indexes where schemaname='public' and indexname='journal_entries_type_ref_idx'")"
expect_eq "C5 NO partial change: integrity view absent" "0" \
  "$(q "$DBDUP" "select count(*) from information_schema.views where table_schema='public' and table_name='v_journal_integrity_issues'")"
expect_eq "C6 NO partial change: 006 table absent (never ran)" "0" \
  "$(q "$DBDUP" "select count(*) from information_schema.tables where table_schema='public' and table_name='ai_repair_executions'")"

"${PSQL[@]}" -c "drop database if exists $DB" -c "drop database if exists $DBDUP" >/dev/null

echo "-----------------------------------------"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && echo "ACTIVATION 005_006: PASS" || echo "ACTIVATION 005_006: FAIL"
