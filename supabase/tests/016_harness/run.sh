#!/usr/bin/env bash
# Verify migration 016 (customer row isolation) by EXECUTION against a real
# PostgreSQL 17, with two tenants and - inside one tenant - two CUSTOMERS.
#
# The defect this proves fixed: 002 scopes every table by TENANT, which is not a
# boundary inside a company. A rental customer is an authenticated user of the
# tenant, so customer A could read customer B's contracts and tickets through the
# browser client (RLS is the enforcement boundary in the portal).
#
# Requires a reachable PostgreSQL superuser:
#   PGHOST=... PGUSER=postgres bash supabase/tests/016_harness/run.sh
#
# It creates and drops a throwaway database named `speed_016`.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_016

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
if [ "$(id -u)" = "0" ]; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
elif command -v sudo >/dev/null && sudo -n -u postgres true 2>/dev/null; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
fi
q() { "${PSQL[@]}" -d "$DB" -tAc "$1" 2>&1; }

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> got: $2"; fail=$((fail+1)); }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3"; fi; }
expect_denied() { # desc sql  (must be refused by an RLS policy)
  local out; out=$(q "$2")
  if echo "$out" | grep -qiE "row-level security|violates|Only an administrator may|permission denied"; then ok "$1"; else bad "$1" "$out"; fi
}

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB" >/dev/null

echo "== base schema + Supabase-like default grants =="
"${PSQL[@]}" -d "$DB" -f - < "$HERE/../isolation_harness/base_schema.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -c "grant all on all tables in schema public to anon, authenticated;" >/dev/null

# Columns the customer portal actually reads. `users.customer_id` is the link
# from an Auth identity to its customer record (Exec 48); 016 reads it.
"${PSQL[@]}" -d "$DB" >/dev/null <<'SQL'
alter table public.users add column if not exists customer_id uuid;
alter table public.rental_contracts add column if not exists customer_id uuid;
alter table public.rental_contracts add column if not exists contract_number text;
alter table public.support_tickets add column if not exists customer_id uuid;
alter table public.support_tickets add column if not exists subject text;
alter table public.documents add column if not exists customer_id uuid;
alter table public.documents add column if not exists file_name text;
alter table public.cars add column if not exists make text;
SQL

echo "== applying migrations 001 -> 004 -> 016 =="
for m in 001_core_security 002_tenant_isolation_hardening 004_global_super_admin 016_customer_row_isolation; do
  "${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/$m.sql" >/dev/null
done

# Supabase grants `authenticated` table privileges on new tables by default;
# RLS (not a missing GRANT) must be what denies a customer.
"${PSQL[@]}" -d "$DB" -c "grant select, insert, update, delete on all tables in schema public to authenticated;" >/dev/null

echo "== idempotency: re-apply 016 =="
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/016_customer_row_isolation.sql" >/dev/null

echo "== seeding two tenants, two customers in tenant A, and rows =="
"${PSQL[@]}" -d "$DB" >/dev/null <<'SQL'
insert into public.tenants (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Tenant A'),
  ('22222222-2222-2222-2222-222222222222', 'Tenant B');

insert into public.users (id, email, role, tenant_id, customer_id, is_active) values
  ('c0000000-0000-0000-0000-0000000000a1', 'custA@x.local', 'client',      '11111111-1111-1111-1111-111111111111', 'aa000000-0000-0000-0000-0000000000a1', true),
  ('c0000000-0000-0000-0000-0000000000a2', 'custB@x.local', 'client',      '11111111-1111-1111-1111-111111111111', 'aa000000-0000-0000-0000-0000000000a2', true),
  ('c0000000-0000-0000-0000-0000000000b1', 'custC@x.local', 'client',      '22222222-2222-2222-2222-222222222222', 'aa000000-0000-0000-0000-0000000000b1', true),
  ('a0000000-0000-0000-0000-0000000000f1', 'adminA@x.local','admin',       '11111111-1111-1111-1111-111111111111', null,                                   true),
  ('a0000000-0000-0000-0000-0000000000f2', 'staffA@x.local','staff',       '11111111-1111-1111-1111-111111111111', null,                                   true),
  ('d0000000-0000-0000-0000-0000000000f1', 'super@x.local', 'super_admin', null,                                   null,                                   true);

insert into public.customers (id, tenant_id, name) values
  ('aa000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'Customer A'),
  ('aa000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'Customer B'),
  ('aa000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'Customer C');

insert into public.rental_contracts (id, tenant_id, customer_id, contract_number, total) values
  ('ac000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'aa000000-0000-0000-0000-0000000000a1', 'RC-A', 100),
  ('ac000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'aa000000-0000-0000-0000-0000000000a2', 'RC-B', 250),
  ('ac000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'aa000000-0000-0000-0000-0000000000b1', 'RC-C', 900),
  ('ac000000-0000-0000-0000-0000000000f1', '11111111-1111-1111-1111-111111111111', null,                                   'RC-OFFICE', 50);

insert into public.support_tickets (id, tenant_id, customer_id, subject) values
  ('a7000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'aa000000-0000-0000-0000-0000000000a1', 'A-ticket'),
  ('a7000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'aa000000-0000-0000-0000-0000000000a2', 'B-ticket');

insert into public.documents (id, tenant_id, customer_id, file_name) values
  ('d0000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'aa000000-0000-0000-0000-0000000000a1', 'a-cpr.pdf'),
  ('d0000000-0000-0000-0000-0000000000a2', '11111111-1111-1111-1111-111111111111', 'aa000000-0000-0000-0000-0000000000a2', 'b-cpr.pdf');

insert into public.cars (id, tenant_id, make) values
  ('ca000000-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'Toyota'),
  ('ca000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'Honda');
SQL

as_user() { # uuid sql
  q "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$1')::text, true); end \$j\$; set local role authenticated; $2; rollback;"
}
dml() { echo "with t as ($1 returning 1) select count(*) from t;"; }

CUST_A=c0000000-0000-0000-0000-0000000000a1
CUST_C=c0000000-0000-0000-0000-0000000000b1
ADMIN_A=a0000000-0000-0000-0000-0000000000f1
STAFF_A=a0000000-0000-0000-0000-0000000000f2
SUPER=d0000000-0000-0000-0000-0000000000f1

echo "== assertions =="

# --- THE DEFECT: a customer must not read another customer's rows ------------
# RC-OFFICE has no customer_id, so it belongs to no portal account and is
# visible only to the office - not to every customer of the company.
expect_eq "B1 customer A reads only its own contract" "1" \
  "$(as_user $CUST_A "select count(*) from public.rental_contracts" | tail -1)"
expect_eq "B2 customer A cannot read customer B's contract" "0" \
  "$(as_user $CUST_A "select count(*) from public.rental_contracts where contract_number='RC-B'" | tail -1)"
expect_eq "B3 customer A cannot read customer B's ticket" "0" \
  "$(as_user $CUST_A "select count(*) from public.support_tickets where subject='B-ticket'" | tail -1)"
expect_eq "B4 customer A reads only its own ticket" "1" \
  "$(as_user $CUST_A "select count(*) from public.support_tickets" | tail -1)"
expect_eq "B5 customer A cannot read customer B's document" "0" \
  "$(as_user $CUST_A "select count(*) from public.documents where file_name='b-cpr.pdf'" | tail -1)"

# --- writes -----------------------------------------------------------------
expect_eq "B6 customer A cannot update customer B's contract" "0" \
  "$(as_user $CUST_A "$(dml "update public.rental_contracts set total=1 where contract_number='RC-B'")" | tail -1)"
expect_eq "B7 customer A cannot delete customer B's contract" "0" \
  "$(as_user $CUST_A "$(dml "delete from public.rental_contracts where contract_number='RC-B'")" | tail -1)"
expect_eq "B8 customer A may insert its OWN contract" "1" \
  "$(as_user $CUST_A "insert into public.rental_contracts (tenant_id, customer_id, contract_number, total) values ('11111111-1111-1111-1111-111111111111','aa000000-0000-0000-0000-0000000000a1','RC-A2',10) returning 1" | tail -1)"
expect_denied "B9 customer A cannot insert a contract FOR customer B" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$CUST_A')::text, true); end \$j\$; set local role authenticated; insert into public.rental_contracts (tenant_id, customer_id, contract_number, total) values ('11111111-1111-1111-1111-111111111111','aa000000-0000-0000-0000-0000000000a2','RC-EVIL',10); rollback;"

# --- the office is unaffected ----------------------------------------------
expect_eq "B10 admin reads every contract in the tenant" "3" \
  "$(as_user $ADMIN_A "select count(*) from public.rental_contracts" | tail -1)"
expect_eq "B11 staff reads every contract in the tenant" "3" \
  "$(as_user $STAFF_A "select count(*) from public.rental_contracts" | tail -1)"
expect_eq "B12 staff reads the office contract (customer_id null)" "1" \
  "$(as_user $STAFF_A "select count(*) from public.rental_contracts where contract_number='RC-OFFICE'" | tail -1)"
expect_eq "B13 admin reads every ticket in the tenant" "2" \
  "$(as_user $ADMIN_A "select count(*) from public.support_tickets" | tail -1)"
expect_eq "B14 super admin reads across tenants" "4" \
  "$(as_user $SUPER "select count(*) from public.rental_contracts" | tail -1)"

# --- a customer never crosses the TENANT boundary either --------------------
expect_eq "B15 customer C reads only its own tenant's contract" "1" \
  "$(as_user $CUST_C "select count(*) from public.rental_contracts" | tail -1)"
expect_eq "B16 customer C cannot read tenant A's contracts" "0" \
  "$(as_user $CUST_C "select count(*) from public.rental_contracts where contract_number='RC-A'" | tail -1)"
expect_eq "B17 customer A sees its own tenant's cars" "1" \
  "$(as_user $CUST_A "select count(*) from public.cars" | tail -1)"
expect_eq "B18 customer A cannot see another tenant's car" "0" \
  "$(as_user $CUST_A "select count(*) from public.cars where make='Honda'" | tail -1)"

# --- helpers exist and the migration is idempotent --------------------------
expect_eq "B19 current_customer_id() resolves the caller" "aa000000-0000-0000-0000-0000000000a1" \
  "$(as_user $CUST_A "select public.current_customer_id()" | tail -1)"
expect_eq "B20 is_erp_user() false for a client" "f" \
  "$(as_user $CUST_A "select public.is_erp_user()" | tail -1)"
expect_eq "B21 is_erp_user() true for staff" "t" \
  "$(as_user $STAFF_A "select public.is_erp_user()" | tail -1)"

# --- the customers table is PII: a client sees only its own row -------------
expect_eq "B24 customer A reads only its own customer row" "1" \
  "$(as_user $CUST_A "select count(*) from public.customers" | tail -1)"
expect_eq "B25 customer A cannot read customer B's record" "0" \
  "$(as_user $CUST_A "select count(*) from public.customers where name='Customer B'" | tail -1)"
expect_eq "B26 admin reads every customer in the tenant" "2" \
  "$(as_user $ADMIN_A "select count(*) from public.customers" | tail -1)"

# --- the users table: a client sees only itself -----------------------------
expect_eq "B27 customer A reads only its own users row" "1" \
  "$(as_user $CUST_A "select count(*) from public.users" | tail -1)"
expect_eq "B28 customer A cannot read a colleague's users row" "0" \
  "$(as_user $CUST_A "select count(*) from public.users where email='adminA@x.local'" | tail -1)"
# A company admin sees the 4 users in its own tenant; the tenant-less global
# operator is not part of any tenant (004's users_self_select).
expect_eq "B29 admin reads every user in the tenant" "4" \
  "$(as_user $ADMIN_A "select count(*) from public.users" | tail -1)"

# --- a non-admin may not change its own identity columns --------------------
expect_denied "B30 a customer cannot promote itself to admin" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$CUST_A')::text, true); end \$j\$; set local role authenticated; update public.users set role='admin' where id='$CUST_A'; rollback;"
expect_denied "B31 a customer cannot move itself to another tenant" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$CUST_A')::text, true); end \$j\$; set local role authenticated; update public.users set tenant_id='22222222-2222-2222-2222-222222222222' where id='$CUST_A'; rollback;"
expect_denied "B32 a customer cannot re-point its own customer_id" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$CUST_A')::text, true); end \$j\$; set local role authenticated; update public.users set customer_id='aa000000-0000-0000-0000-0000000000a2' where id='$CUST_A'; rollback;"
expect_eq "B33 a customer may still edit its own non-privileged fields" "1" \
  "$(as_user $CUST_A "$(dml "update public.users set full_name='New Name' where id='$CUST_A'")" | tail -1)"
expect_eq "B34 an admin may still change a role in its tenant" "1" \
  "$(as_user $ADMIN_A "$(dml "update public.users set role='staff' where id='c0000000-0000-0000-0000-0000000000a2'")" | tail -1)"
expect_eq "B35 the service path may still grant a role (auth.uid() is null)" "1" \
  "$(q "with t as (update public.users set role='staff' where id='c0000000-0000-0000-0000-0000000000a2' returning 1) select count(*) from t" | tail -1)"

# --- the predicate helpers are not callable by anon -------------------------
expect_eq "B36 anon cannot execute current_customer_id()" "f" \
  "$(q "select has_function_privilege('anon','public.current_customer_id()','execute')" | tail -1)"
expect_eq "B37 anon cannot execute is_erp_user()" "f" \
  "$(q "select has_function_privilege('anon','public.is_erp_user()','execute')" | tail -1)"
expect_eq "B38 authenticated may execute current_customer_id()" "t" \
  "$(q "select has_function_privilege('authenticated','public.current_customer_id()','execute')" | tail -1)"
expect_denied "B39 anon cannot read a contract at all" \
  "begin; set local role anon; select count(*) from public.rental_contracts; rollback;"

echo "== rollback restores the (documented) leak =="
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/016_customer_row_isolation_rollback.sql" >/dev/null
expect_eq "B22 after rollback customer A sees the whole tenant again" "3" \
  "$(as_user $CUST_A "select count(*) from public.rental_contracts" | tail -1)"
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/016_customer_row_isolation.sql" >/dev/null
expect_eq "B23 re-applying 016 restores isolation" "1" \
  "$(as_user $CUST_A "select count(*) from public.rental_contracts" | tail -1)"

echo "-----------------------------------------"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && echo "CUSTOMER ISOLATION: PASS" || echo "CUSTOMER ISOLATION: FAIL"
