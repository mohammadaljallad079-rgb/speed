#!/usr/bin/env bash
# ============================================================================
# Cross-company isolation harness (migrations 001 -> 016).
#
# Item 1 of the Exec 72 brief: prove tenant isolation against a REAL PostgreSQL
# 17 with REAL authenticated identities from two independent companies, and
# cover the surfaces the brief names - SELECT, INSERT, UPDATE, DELETE, RPCs,
# exports and role escalation. Local stubs are explicitly NOT sufficient for
# this requirement, so nothing here is mocked: the migrations are applied to a
# throwaway database and every assertion runs as an `authenticated` role with a
# GUC-driven `auth.uid()`, exactly as Supabase does.
#
# Run:
#   bash supabase/tests/cross_company_harness/run.sh
#
# Requires a reachable PostgreSQL superuser via `psql` on PATH (set PGUSER/
# PGHOST if your setup differs).
#
# It creates and drops a throwaway database named `speed_cross_company`.
# ============================================================================

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_cross_company

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
if [ "$(id -u)" = "0" ]; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
elif command -v sudo >/dev/null && sudo -n -u postgres true 2>/dev/null; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
fi
# Connection can be redirected with the standard PG* variables (PGHOST/PGPORT/
# PGUSER/PGPASSWORD) - e.g. a PostgreSQL container on a TCP port, which is how
# this harness is exercised in CI-less environments. libpq reads them directly.
if [ -n "$PGHOST" ]; then
  PSQL+=(-h "$PGHOST")
fi
if [ -n "$PGPORT" ]; then
  PSQL+=(-p "$PGPORT")
fi
if [ -n "$PGUSER" ]; then
  PSQL+=(-U "$PGUSER")
fi
q() { "${PSQL[@]}" -d "$DB" -tAc "$1" 2>&1; }

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> got: $2"; fail=$((fail+1)); }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3"; fi; }
expect_denied() { # desc sql  (must be refused by RLS / trigger / privilege)
  local out; out=$(q "$2")
  if echo "$out" | grep -qiE "row-level security|permission denied|violates|not permitted|may grant or revoke|belongs to a different|not usable by this company|does not exist in this company|must be positive|does not balance|is required"; then
    ok "$1"
  else
    bad "$1" "$out"
  fi
}
# Runs a multi-statement script as a user (insert-then-delete needs two
# statements: a data-modifying CTE sees one snapshot, so a `delete` in the same
# statement cannot see the rows its sibling CTE just inserted).
as_user_script() { # uuid sql
  q "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$1')::text, true); end \$j\$; set local role authenticated; $2; rollback;"
}

# ---------------------------------------------------------------------------
# Migrations. 014 rewrites the chart of accounts and needs the whole chain, so
# the order is the production order and nothing is skipped.
# ---------------------------------------------------------------------------
MIGRATIONS=(
  001_core_security
  002_tenant_isolation_hardening
  003_sales_lifecycle
  004_global_super_admin
  005_accounting_integrity
  006_ai_repair
  007_purchase_sale_links
  008_user_role_hardening
  009_depreciation_accounts
  010_purchasing_accounts
  011_atomic_journal_posting
  012_notifications
  013_booking_invoice_idempotency
  014_tenant_chart_of_accounts
  015_strict_accounting_integrity
  016_customer_row_isolation
)

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB" >/dev/null

echo "== base schema (Supabase-like roles + auth.uid()) =="
"${PSQL[@]}" -d "$DB" -f - < "$HERE/../isolation_harness/base_schema.sql" >/dev/null

# The base schema has only the columns the migrations reference. The application
# services need the real shapes (a booking reads `cars.make`, a posting writes
# `journal_entries.journal_number`), so widen it before the migrations run.
echo "== rich schema (real application column shapes) =="
"${PSQL[@]}" -d "$DB" -f - < "$HERE/rich_schema.sql" >/dev/null

# Supabase grants anon/authenticated table privileges by default. RLS - not a
# missing GRANT - must be what denies a tenant, so mirror the permissive default
# and let the migrations strip `anon`.
"${PSQL[@]}" -d "$DB" -c "grant all on all tables in schema public to anon, authenticated;" >/dev/null

echo "== applying migrations 001 -> 016 =="
for m in "${MIGRATIONS[@]}"; do
  if ! out=$("${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/$m.sql" 2>&1); then
    echo " FAIL | migration $m did not apply"
    echo "$out" | grep -i error | head -3
    fail=$((fail+1))
  fi
done

# The migrations create new tables; Supabase would grant `authenticated` access
# to them, so reproduce that and let RLS do the denying.
"${PSQL[@]}" -d "$DB" -c "grant select, insert, update, delete on all tables in schema public to authenticated;" >/dev/null
"${PSQL[@]}" -d "$DB" -c "grant execute on all functions in schema public to authenticated;" >/dev/null

echo "== idempotency: re-apply 002, 004 and 016 =="
for m in 002_tenant_isolation_hardening 004_global_super_admin 016_customer_row_isolation; do
  "${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/$m.sql" >/dev/null 2>&1 || {
    echo " FAIL | re-applying $m was not idempotent"; fail=$((fail+1)); }
done

echo "== seeding two independent companies =="
# A seed failure would silently skew every later assertion (an aborted heredoc
# leaves later INSERTs unrun), so surface it instead of redirecting to /dev/null.
if ! seed_out=$("${PSQL[@]}" -d "$DB" 2>&1 <<'SQL'
insert into public.tenants (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Alpha Rentals'),
  ('22222222-2222-2222-2222-222222222222', 'Beta Motors');

-- Identity rows. `role` is set directly here because seeding runs as the
-- superuser (the service path); the escalation trigger only guards the
-- `authenticated` path, which is asserted separately below.
insert into public.users (id, email, role, tenant_id, is_active) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin@alpha.local', 'admin',       '11111111-1111-1111-1111-111111111111', true),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'staff@alpha.local', 'staff',       '11111111-1111-1111-1111-111111111111', true),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'admin@beta.local',  'admin',       '22222222-2222-2222-2222-222222222222', true),
  ('cccccccc-0000-0000-0000-000000000001', 'super@platform.local', 'super_admin', null,                                true);

-- One customer per company, plus a tenant-less row (the single-tenant install).
insert into public.customers (id, tenant_id, name, amount) values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'Alpha Customer', 10),
  ('b0000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'Beta Customer',  20),
  ('00000000-0000-0000-0000-00000000000c', null,                                   'Shared Row',     30);

-- Vehicles: one per company, plus a maintenance-blocked one.
insert into public.cars (id, tenant_id, make, model, category, status, daily_rate) values
  ('a1000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'Toyota', 'Corolla', 'rental', 'available',   20),
  ('b1000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'Nissan', 'Sunny',   'rental', 'available',   25),
  ('a1000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 'Kia',    'Sportage','rental', 'maintenance', 40);

-- A chart-of-accounts row per company: same code, different owner. Migration
-- 014 makes this legal, which is the point of a per-company chart.
insert into public.accounts (id, tenant_id, code, name, is_postable) values
  ('ac000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', '11001', 'Alpha Cash', true),
  ('ac000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', '11001', 'Beta Cash',  true);

-- An audit row for the append-only assertions.
insert into public.activity_logs (tenant_id, action, entity) values
  ('11111111-1111-1111-1111-111111111111', 'seed', 'customers');
SQL
); then
  echo " FAIL | the seed block did not complete"
  echo "$seed_out" | grep -i error | head -5
  fail=$((fail+1))
fi

# ---------------------------------------------------------------------------
# Session helpers. `as_user` sets the JWT claims the way Supabase does, switches
# to the `authenticated` role, runs one statement, and rolls back so the
# assertions never depend on each other's writes.
# ---------------------------------------------------------------------------
as_user() { # uuid sql
  q "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$1')::text, true); end \$j\$; set local role authenticated; $2; rollback;"
}
# Wraps DML so its affected-row count comes back as a value (psql -tAc would
# otherwise print the command tag).
dml() { echo "with t as ($1 returning 1) select count(*) from t;"; }

ADMIN_A=aaaaaaaa-0000-0000-0000-000000000001
STAFF_A=aaaaaaaa-0000-0000-0000-000000000002
ADMIN_B=bbbbbbbb-0000-0000-0000-000000000001
SUPER=cccccccc-0000-0000-0000-000000000001
TEN_A=11111111-1111-1111-1111-111111111111
TEN_B=22222222-2222-2222-2222-222222222222

echo
echo "== 1. SELECT isolation =="
expect_eq "A1 admin sees only its own company's customers" "1" \
  "$(as_user $ADMIN_A "select count(*) from public.customers" | tail -1)"
expect_eq "A2 admin cannot read company B's customer by name" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.customers where name='Beta Customer'" | tail -1)"
expect_eq "A3 admin B sees only its own customer" "1" \
  "$(as_user $ADMIN_B "select count(*) from public.customers" | tail -1)"
expect_eq "A4 admin cannot read company B's vehicle" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.cars where id='b1000000-0000-0000-0000-00000000000b'" | tail -1)"
expect_eq "A5 staff confined to its own company" "0" \
  "$(as_user $STAFF_A "select count(*) from public.customers where name='Beta Customer'" | tail -1)"
expect_eq "A6 the tenant-less row is invisible to a tenanted caller" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.customers where tenant_id is null" | tail -1)"
expect_eq "A7 global super admin sees every company" "3" \
  "$(as_user $SUPER "select count(*) from public.customers" | tail -1)"

echo
echo "== 2. INSERT isolation =="
expect_denied "B1 cross-company insert is refused" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; insert into public.customers (tenant_id, name) values ('$TEN_B','intruder'); rollback;"
expect_denied "B2 an insert with no tenant_id is refused (no orphan rows)" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; insert into public.customers (name) values ('orphan'); rollback;"
expect_eq "B3 an insert into its OWN company succeeds" "1" \
  "$(as_user $ADMIN_A "$(dml "insert into public.customers (tenant_id, name) values ('$TEN_A','mine')")" | tail -1)"

echo
echo "== 3. UPDATE isolation =="
expect_eq "C1 cross-company update affects 0 rows" "0" \
  "$(as_user $ADMIN_A "$(dml "update public.customers set amount=999 where tenant_id='$TEN_B'")" | tail -1)"
expect_eq "C2 cross-company vehicle update affects 0 rows" "0" \
  "$(as_user $ADMIN_A "$(dml "update public.cars set daily_rate=1 where tenant_id='$TEN_B'")" | tail -1)"
expect_eq "C3 own-company update succeeds" "1" \
  "$(as_user $ADMIN_A "$(dml "update public.customers set amount=11 where tenant_id='$TEN_A'")" | tail -1)"
expect_denied "C4 a row cannot be re-pointed into another company" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; update public.customers set tenant_id='$TEN_B' where tenant_id='$TEN_A'; rollback;"

echo
echo "== 4. DELETE isolation =="
expect_eq "D1 cross-company delete affects 0 rows" "0" \
  "$(as_user $ADMIN_A "$(dml "delete from public.customers where tenant_id='$TEN_B'")" | tail -1)"
# Insert and delete as two statements inside ONE transaction: an earlier
# `as_user` rolls back, so a row it created is not available to a later
# assertion, and a single data-modifying CTE cannot delete what it just inserted.
expect_eq "D2 own-company delete succeeds" "1" \
  "$(as_user_script $ADMIN_A "insert into public.customers (tenant_id, name) values ('$TEN_A','to-delete'); with d as (delete from public.customers where name='to-delete' returning 1) select count(*) from d" | tail -1)"
expect_eq "D3 the audit trail is append-only (no update)" "0" \
  "$(as_user $ADMIN_A "$(dml "update public.activity_logs set action='tampered'")" | tail -1)"
expect_eq "D4 the audit trail is append-only (no delete)" "0" \
  "$(as_user $ADMIN_A "$(dml "delete from public.activity_logs")" | tail -1)"

echo
echo "== 5. Role escalation =="
expect_denied "E1 a company admin cannot promote itself to super_admin" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; update public.users set role='super_admin' where id='$ADMIN_A'; rollback;"
expect_denied "E2 a company admin cannot grant super_admin to another user" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; update public.users set role='super_admin' where id='$STAFF_A'; rollback;"
expect_denied "E3 a user cannot move itself into another company" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; update public.users set tenant_id='$TEN_B' where id='$ADMIN_A'; rollback;"
expect_eq "E4 a company admin cannot read the platform super admin row" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.users where id='$SUPER'" | tail -1)"

echo
echo "== 6. Anonymous (the public key) =="
expect_denied "F1 anon cannot SELECT customers" "begin; set local role anon; select count(*) from public.customers; rollback;"
expect_denied "F2 anon cannot INSERT customers" "begin; set local role anon; insert into public.customers (name) values ('x'); rollback;"
expect_denied "F3 anon cannot UPDATE customers" "begin; set local role anon; update public.customers set amount=0; rollback;"
expect_denied "F4 anon cannot DELETE customers" "begin; set local role anon; delete from public.customers; rollback;"
expect_denied "F5 anon cannot read the ledger" "begin; set local role anon; select count(*) from public.journal_entries; rollback;"
expect_denied "F6 anon cannot execute is_super_admin()" "begin; set local role anon; select public.is_super_admin(); rollback;"
expect_denied "F7 anon cannot execute current_customer_id()" "begin; set local role anon; select public.current_customer_id(); rollback;"

echo
echo "== 7. RPCs =="
# `post_journal_entry` requires a tenant, a balanced line set and accounts that
# belong to that company. A tenant-less caller therefore cannot post at all
# (G3), which is the fail-closed direction; a tenant admin can post in its own
# company (G1) but not with another company's account (G2).
expect_eq "G1 a tenant admin can post a balanced journal in its own company" "1" \
  "$(as_user $ADMIN_A "select count(*) from public.post_journal_entry(
       jsonb_build_object('tenant_id','$TEN_A','entry_date','2026-01-15','journal_number','J-1'),
       jsonb_build_array(
         jsonb_build_object('account_id','ac000000-0000-0000-0000-00000000000a','debit',100,'credit',0),
         jsonb_build_object('account_id','ac000000-0000-0000-0000-00000000000a','debit',0,'credit',100)))" | tail -1)"
expect_denied "G2 the posting RPC refuses another company's account" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; select public.post_journal_entry(
       jsonb_build_object('tenant_id','$TEN_A','entry_date','2026-01-15','journal_number','J-2'),
       jsonb_build_array(
         jsonb_build_object('account_id','ac000000-0000-0000-0000-00000000000b','debit',50,'credit',0),
         jsonb_build_object('account_id','ac000000-0000-0000-0000-00000000000b','debit',0,'credit',50))); rollback;"
expect_denied "G3 the posting RPC refuses a journal with no tenant" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; select public.post_journal_entry(
       jsonb_build_object('entry_date','2026-01-15','journal_number','J-3'),
       jsonb_build_array(
         jsonb_build_object('account_id','ac000000-0000-0000-0000-00000000000a','debit',1,'credit',0),
         jsonb_build_object('account_id','ac000000-0000-0000-0000-00000000000a','debit',0,'credit',1))); rollback;"
expect_denied "G4 anon cannot call the posting RPC" \
  "begin; set local role anon; select public.post_journal_entry(
       jsonb_build_object('tenant_id','$TEN_A','entry_date','2026-01-15','journal_number','J-4'),
       jsonb_build_array(
         jsonb_build_object('account_id','ac000000-0000-0000-0000-00000000000a','debit',1,'credit',0),
         jsonb_build_object('account_id','ac000000-0000-0000-0000-00000000000a','debit',0,'credit',1))); rollback;"
# A tenant-less (single-tenant install) journal is deliberately still postable by
# the service path, so the rule above is "tenanted callers must name their
# company", not "no tenant-less postings exist".
expect_denied "G5 the posting RPC refuses an unbalanced journal" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; select public.post_journal_entry(
       jsonb_build_object('tenant_id','$TEN_A','entry_date','2026-01-15','journal_number','J-5'),
       jsonb_build_array(
         jsonb_build_object('account_id','ac000000-0000-0000-0000-00000000000a','debit',100,'credit',0),
         jsonb_build_object('account_id','ac000000-0000-0000-0000-00000000000a','debit',0,'credit',90))); rollback;"

echo
echo "== 8. Exports (the reporting/export read path) =="
# The Excel/report export runs through the same RLS-governed reads, so an export
# must not be a way around the boundary. Assert the raw read the export uses.
expect_eq "H1 an export read returns only its own company's rows" "1" \
  "$(as_user $ADMIN_A "select count(*) from public.customers" | tail -1)"
expect_eq "H2 an export read cannot reach the other company" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.customers where tenant_id='$TEN_B'" | tail -1)"
expect_eq "H3 the ledger an export reads is company-scoped" "0" \
  "$(as_user $ADMIN_B "select count(*) from public.journal_entries where tenant_id='$TEN_A'" | tail -1)"

echo
echo "== 9. Migration artefacts =="
expect_eq "I1 the sales-returns contra account 41003 exists exactly once" "1" \
  "$(q "select count(*) from public.accounts where code='41003'")"
expect_eq "I2 both numbering sequences exist" "2" \
  "$(q "select count(*) from public.document_sequences where doc_type in ('receipt','sales_return')")"
# 014 replaces the GLOBAL unique(code) with a per-company rule, so the same code
# in two companies is legal while a duplicate INSIDE one company is not.
expect_eq "I3a the same code exists in two different companies" "2" \
  "$(q "select count(*) from public.accounts where code='11001'")"
expect_denied "I3b a duplicate code inside ONE company is refused" \
  "insert into public.accounts (tenant_id, code, name) values ('$TEN_A','11001','Duplicate Cash');"
expect_eq "I4 RLS is enabled on the customer tables" "3" \
  "$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('customers','cars','invoices') and c.relrowsecurity")"
expect_eq "I5 anon holds no privilege on customers" "0" \
  "$(q "select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name='customers'")"
expect_eq "I6 anon holds no privilege on the ledger" "0" \
  "$(q "select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name in ('journal_entries','journal_lines','invoices')")"
# Both guards are expected: 008 normalises roles on ANY role change and 016
# blocks a client from editing its own privileged fields. A single count would
# silently pass if one were dropped, so assert the pair.
expect_eq "I7 both role-escalation triggers exist on users" "2" \
  "$(q "select count(*) from pg_trigger where tgrelid='public.users'::regclass and not tgisinternal and tgname in ('users_prevent_role_escalation','users_prevent_self_privilege_escalation')")"

echo
echo "== 10. Harness self-test (mutation control) =="
# A green isolation suite is only meaningful if it CAN go red. Disable RLS on one
# table and confirm the cross-company read that A2 denies now leaks, then restore
# it. If J1 fails, the denials above were caused by an empty table or a broken
# query rather than by the policies, and the whole run would be vacuous.
"${PSQL[@]}" -d "$DB" -c "alter table public.customers disable row level security;" >/dev/null 2>&1
expect_eq "J1 control: with RLS off the cross-company read leaks" "1" \
  "$(as_user $ADMIN_A "select count(*) from public.customers where name='Beta Customer'" | tail -1)"
"${PSQL[@]}" -d "$DB" -c "alter table public.customers enable row level security;" >/dev/null 2>&1
expect_eq "J2 control: re-enabling RLS restores the boundary" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.customers where name='Beta Customer'" | tail -1)"

echo
echo "========================================="
echo "RESULT: $pass passed, $fail failed"
if [ "$fail" -eq 0 ]; then echo "CROSS-COMPANY ISOLATION: PASS"; else echo "CROSS-COMPANY ISOLATION: FAIL"; fi
echo "========================================="

"${PSQL[@]}" -c "drop database if exists $DB" >/dev/null 2>&1
[ "$fail" -eq 0 ]
