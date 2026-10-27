#!/usr/bin/env bash
# Execute migration 014 against a real PostgreSQL and assert its behaviour.
#
# 014 turns the GLOBAL unique rule on accounts.code into a TENANT-SCOPED one, so
# two companies can hold the same code while one company cannot hold it twice.
# It also adds postability, a reporting bucket, a same-tenant parent rule and a
# delete guard for an account used by posted journal lines.
#
# Parsing the SQL proves none of that. This harness APPLIES it to a schema
# modelled on the live project and asserts the isolation semantics directly.
#
# Usage (local PostgreSQL 17, superuser reachable):
#   PGHOST=127.0.0.1 PGPORT=55433 PGUSER=postgres PGPASSWORD=postgres \
#     bash supabase/tests/014_harness/run.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_014
MIG="$ROOT/supabase/migrations/014_tenant_chart_of_accounts.sql"

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
q() { "${PSQL[@]}" -d "$DB" -tAc "$1" 2>&1; }
apply() { "${PSQL[@]}" -d "$DB" -f - < "$MIG" >/dev/null 2>&1; }

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> got: $2"; fail=$((fail+1)); }
expect_eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3"; fi; }
expect_err() { # desc sql
  local desc="$1" sql="$2" out
  out=$(q "$sql")
  if echo "$out" | grep -qiE "duplicate key|unique|violates|belongs to a different company|does not exist in this company|used by posted|error"; then
    ok "$desc"
  else
    bad "$desc" "$out"
  fi
}
expect_ok() { # desc sql
  local desc="$1" sql="$2" out
  out=$(q "$sql")
  if echo "$out" | grep -qiE "error|violates"; then bad "$desc" "$out"; else ok "$desc"; fi
}

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB" >/dev/null

echo "== base schema: accounts with a GLOBAL unique code, as the live project has =="
"${PSQL[@]}" -d "$DB" >/dev/null <<'SQL'
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,           -- the global rule 014 removes
  name text,
  name_ar text,
  name_en text,
  type text not null default 'asset',
  parent_code text,
  balance numeric default 0,
  level int default 1,
  is_active boolean default true,
  tenant_id uuid
);
create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid,
  account_id uuid references public.accounts(id),
  debit numeric default 0,
  credit numeric default 0
);
-- The live chart: 19 NULL-tenant accounts (the shared/single-tenant chart).
insert into public.accounts (code, name_en, name_ar, type, tenant_id) values
  ('11001','Cash','الصندوق','asset',null),
  ('11002','Bank','البنك','asset',null),
  ('11003','Petty Cash','النقد الاحتياطي','asset',null),
  ('12001','Accounts Receivable','ذمم مدينة','asset',null),
  ('13001','Vehicle Fleet','أسطول المركبات','asset',null),
  ('14001','Accumulated Depreciation','مجمع إهلاك الأصول','asset',null),
  ('21001','Accounts Payable','ذمم دائنة','liability',null),
  ('22001','Bank Loans','قروض بنكية','liability',null),
  ('24000','Output VAT','ضريبة المخرجات','liability',null),
  ('24001','Input VAT','ضريبة المدخلات','liability',null),
  ('25000','Customer Deposits','تأمينات العملاء','liability',null),
  ('31001','Owner Equity','رأس المال','equity',null),
  ('41001','Rental Revenue','إيرادات الإيجار','revenue',null),
  ('41002','Sales Revenue','إيرادات المبيعات','revenue',null),
  ('41003','Sales Returns','مردودات المبيعات','revenue',null),
  ('51001','Fuel','الوقود','expense',null),
  ('51002','Repairs and Maintenance','الإصلاحات والصيانة','expense',null),
  ('51003','Insurance','تأمين المركبات','expense',null),
  ('52001','Depreciation Expense','مصروف الإهلاك','expense',null),
  -- A pre-existing GROUP heading, so the postability backfill can be asserted
  -- on a row that existed BEFORE the migration (not on a fresh insert, whose
  -- column default would mask the backfill).
  ('10000','Assets','الأصول','asset',null);
SQL

expect_eq "base has 20 NULL-tenant accounts" "20" "$(q "select count(*) from public.accounts")"
expect_eq "the global unique constraint exists on the base" \
  "1" "$(q "select count(*) from pg_constraint c join pg_class t on t.oid=c.conrelid
            where t.relname='accounts' and c.contype='u'")"

echo "== apply 014 (first run) =="
if apply; then ok "014 applied without error"; else bad "014 applied without error" "$(q 'select 1')"; fi

expect_eq "the global unique constraint is gone" \
  "0" "$(q "select count(*) from pg_constraint c join pg_class t on t.oid=c.conrelid
            where t.relname='accounts' and c.contype='u'")"
expect_eq "the tenant-scoped unique index exists" \
  "1" "$(q "select count(*) from pg_indexes where schemaname='public' and indexname='accounts_tenant_code_uidx'")"
expect_eq "the NULL-tenant unique index exists" \
  "1" "$(q "select count(*) from pg_indexes where schemaname='public' and indexname='accounts_null_tenant_code_uidx'")"
expect_eq "is_postable was added" \
  "1" "$(q "select count(*) from information_schema.columns
            where table_schema='public' and table_name='accounts' and column_name='is_postable'")"
expect_eq "reporting_category was added" \
  "1" "$(q "select count(*) from information_schema.columns
            where table_schema='public' and table_name='accounts' and column_name='reporting_category'")"

echo "== idempotent re-apply =="
if apply; then ok "014 re-applied cleanly (idempotent)"; else bad "014 re-applied cleanly (idempotent)" "$(q 'select 1')"; fi
expect_eq "still exactly one tenant-scoped index after re-apply" \
  "1" "$(q "select count(*) from pg_indexes where schemaname='public' and indexname='accounts_tenant_code_uidx'")"

echo "== behaviour: two companies may share a code =="
TA='aaaaaaaa-0000-0000-0000-00000000000a'
TB='bbbbbbbb-0000-0000-0000-00000000000b'
expect_ok "tenant A gets its own 11001" \
  "insert into public.accounts (code,name_en,type,tenant_id,is_postable) values ('11001','Cash A','asset','$TA',true)"
expect_ok "tenant B gets its OWN 11001 (same code, different company)" \
  "insert into public.accounts (code,name_en,type,tenant_id,is_postable) values ('11001','Cash B','asset','$TB',true)"
expect_eq "each company holds its own 11001" \
  "2" "$(q "select count(*) from public.accounts where code='11001' and tenant_id is not null")"

echo "== behaviour: a duplicate WITHIN one company is refused =="
expect_err "tenant A cannot hold 11001 twice" \
  "insert into public.accounts (code,name_en,type,tenant_id) values ('11001','Cash A dup','asset','$TA')"
expect_err "the NULL-tenant chart cannot hold 11001 twice" \
  "insert into public.accounts (code,name_en,type,tenant_id) values ('11001','Shared dup','asset',null)"

echo "== behaviour: historical NULL-tenant accounts are NOT reassigned =="
expect_eq "every historical account still has tenant_id = NULL" \
  "20" "$(q "select count(*) from public.accounts where tenant_id is null")"
expect_eq "the historical 11001 is still NULL-tenant (a company copy is separate)" \
  "1" "$(q "select count(*) from public.accounts where tenant_id is null and code='11001'")"
expect_eq "no company gained a NULL-tenant account" \
  "0" "$(q "select count(*) from public.accounts where tenant_id is not null and code in ('11002','12001','13001')")"

echo "== behaviour: parent must be in the same company =="
expect_ok "a tenant parent is accepted" \
  "insert into public.accounts (code,name_en,type,parent_code,tenant_id) values ('11000','Cash and Bank','asset',null,'$TA')"
expect_ok "a child under its OWN company's parent is accepted" \
  "insert into public.accounts (code,name_en,type,parent_code,tenant_id) values ('11004','Second Bank','asset','11000','$TA')"
expect_err "a child under ANOTHER company's parent is refused" \
  "insert into public.accounts (code,name_en,type,parent_code,tenant_id) values ('11005','Cross','asset','11000','$TB')"
expect_err "a child under the shared NULL-tenant parent is refused for a company" \
  "insert into public.accounts (code,name_en,type,parent_code,tenant_id) values ('11006','Under shared','asset','11002','$TA')"
expect_err "a child under a non-existent parent is refused" \
  "insert into public.accounts (code,name_en,type,parent_code,tenant_id) values ('11007','Orphan','asset','99999','$TA')"

echo "== behaviour: postability was backfilled from the numbering scheme =="
expect_eq "the backfill marked a pre-existing heading (xx00) NOT postable" \
  "0" "$(q "select is_postable::int from public.accounts where code='10000' and tenant_id is null")"
expect_eq "the backfill marked a pre-existing ledger account postable" \
  "1" "$(q "select is_postable::int from public.accounts where code='11002' and tenant_id is null")"
# The live chart uses 24000 (output VAT) and 25000 (customer deposits), whose
# codes end in `00`. The naive "headings end in 00" rule would mark both a
# heading, and every sale / deposit refund would then fail to resolve its
# account. The backfill must exempt the codes the posting path names.
expect_eq "24000 (output VAT) stays postable despite ending in 00" \
  "1" "$(q "select is_postable::int from public.accounts where code='24000' and tenant_id is null")"
expect_eq "25000 (customer deposits) stays postable despite ending in 00" \
  "1" "$(q "select is_postable::int from public.accounts where code='25000' and tenant_id is null")"
expect_eq "a real heading (10000) is still NOT postable" \
  "0" "$(q "select is_postable::int from public.accounts where code='10000' and tenant_id is null")"
expect_eq "a fresh hand-added account defaults to postable" \
  "1" "$(q "select is_postable::int from public.accounts where code='11000' and tenant_id='$TA'")"
expect_ok "an operator may create an explicit heading" \
  "insert into public.accounts (code,name_en,type,tenant_id,is_postable) values ('12000','AR group','asset','$TA',false)"
expect_eq "that heading is not postable" \
  "0" "$(q "select is_postable::int from public.accounts where code='12000' and tenant_id='$TA'")"

echo "== behaviour: an account used by a posted line cannot be deleted =="
AID=$(q "select id from public.accounts where code='11004' and tenant_id='$TA'")
q "insert into public.journal_lines (account_id, debit) values ('$AID', 100)" >/dev/null
expect_err "deleting an account used by a posted line is refused" \
  "delete from public.accounts where id='$AID'"
expect_ok "deactivating it instead is allowed" \
  "update public.accounts set is_active=false where id='$AID'"

echo "== behaviour: a pre-existing duplicate aborts the migration =="
DB2=speed_014_dup
"${PSQL[@]}" -c "drop database if exists $DB2" -c "create database $DB2" >/dev/null
"${PSQL[@]}" -d "$DB2" >/dev/null <<'SQL'
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  code text, name text, name_en text, type text default 'asset',
  parent_code text, level int default 1, is_active boolean default true, tenant_id uuid
);
insert into public.accounts (code, tenant_id) values ('11001', null), ('11001', null);
SQL
out=$("${PSQL[@]}" -d "$DB2" -f - < "$MIG" 2>&1)
if echo "$out" | grep -qiE "duplicate code"; then
  ok "a duplicate NULL-tenant code aborts 014 with a clear message"
else
  bad "a duplicate NULL-tenant code aborts 014 with a clear message" "$(echo "$out" | tail -2)"
fi
expect_eq "the abort left the table unchanged (no partial index)" \
  "0" "$("${PSQL[@]}" -d "$DB2" -tAc "select count(*) from pg_indexes where indexname='accounts_tenant_code_uidx'" 2>&1)"

echo "== behaviour: clean no-op without an accounts table =="
DB3=speed_014_noop
"${PSQL[@]}" -c "drop database if exists $DB3" -c "create database $DB3" >/dev/null
if "${PSQL[@]}" -d "$DB3" -f - < "$MIG" >/dev/null 2>&1; then
  ok "014 is a clean no-op when accounts is absent"
else
  bad "014 is a clean no-op when accounts is absent" "$("${PSQL[@]}" -d "$DB3" -tAc 'select 1' 2>&1)"
fi

echo
echo "==== 014 harness: $pass passed, $fail failed ===="
[ "$fail" -eq 0 ]
