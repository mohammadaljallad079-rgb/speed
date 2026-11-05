#!/usr/bin/env bash
# ============================================================================
# Exec 77 harness - NULL-tenant rental-customer isolation (migration 019).
#
# Proves, by EXECUTION against a real PostgreSQL 17 with real `authenticated`
# identities, that a SPEED rental customer (role `client`, tenant_id NULL) can
# reach only its own data, while ERP companies stay isolated from each other and
# from the SPEED rental records.
#
# Nothing here is mocked: the migrations run against a throwaway database and
# every assertion runs as `authenticated` with a GUC-driven `auth.uid()`, which
# is exactly how Supabase evaluates RLS. The service-role client is deliberately
# NOT used - it bypasses RLS and would prove nothing.
#
# Run:
#   bash supabase/tests/exec77_harness/run.sh
# Requires a reachable PostgreSQL superuser (PGHOST/PGUSER/PGPASSWORD honoured).
#
# It creates and drops a throwaway database named `speed_exec77`.
# ============================================================================

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_exec77

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
if [ "$(id -u)" = "0" ]; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
elif command -v sudo >/dev/null && sudo -n -u postgres true 2>/dev/null; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
fi
if [ -n "$PGHOST" ]; then PSQL+=(-h "$PGHOST"); fi
if [ -n "$PGPORT" ]; then PSQL+=(-p "$PGPORT"); fi
if [ -n "$PGUSER" ]; then PSQL+=(-U "$PGUSER"); fi

q() { "${PSQL[@]}" -d "$DB" -tAc "$1" 2>&1; }

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> got: $2"; fail=$((fail+1)); }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3"; fi; }
expect_denied_or_zero() { # desc sql - anon: either a privilege error or zero rows
  local out; out=$(anon_count "$2")
  if [ "$out" = "denied" ] || [ "$out" = "0" ]; then ok "$1"; else bad "$1" "$out"; fi
}
expect_denied() { # desc sql - must be refused (RLS with-check / trigger / privilege)
  local out; out=$(q "$2")
  if echo "$out" | grep -qiE "row-level security|permission denied|violates|may not|Only a|is required"; then
    ok "$1"
  else
    bad "$1" "$out"
  fi
}

# Runs `sql` as an authenticated user and rolls back, so a harness run never
# mutates the database it is measuring.
as_user() { # uuid sql
  q "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$1')::text, true); end \$j\$; set local role authenticated; $2; rollback;"
}
# `anon` is denied by the revoked GRANT (a privilege error) rather than by RLS;
# both are a denial, so the raw output is compared against "0 or denied".
as_anon() { # sql
  q "begin; set local role anon; $1; rollback;"
}
anon_count() { # sql -> the count, or "denied"
  local out; out=$(as_anon "$1")
  if echo "$out" | grep -qi "permission denied"; then echo "denied"; else echo "$(echo "$out" | tail -1)"; fi
}
# Counts the rows a DML statement actually affected (RLS-denied UPDATE/DELETE
# returns 0 rows silently rather than raising).
dml() { echo "with t as ($1 returning 1) select count(*) from t;"; }

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB" >/dev/null

echo "== base schema + Supabase-like default grants =="
"${PSQL[@]}" -d "$DB" -f - < "$HERE/../isolation_harness/base_schema.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f - < "$HERE/../cross_company_harness/rich_schema.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f - < "$HERE/extra_schema.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -c "grant all on all tables in schema public to anon, authenticated;" >/dev/null

# The production migration chain, in order. 019 is the migration under test.
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
  017_booking_overlap_guard
  018_booking_time_precision
)

echo "== applying migrations 001 -> 018 =="
for m in "${MIGRATIONS[@]}"; do
  if ! out=$("${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/$m.sql" 2>&1); then
    echo " FAIL | migration $m did not apply"; echo "$out" | grep -i error | head -3; fail=$((fail+1))
  fi
done

# Supabase grants `authenticated` table privileges by default; RLS - not a
# missing GRANT - must be what denies a customer.
"${PSQL[@]}" -d "$DB" -c "grant select, insert, update, delete on all tables in schema public to authenticated;" >/dev/null
"${PSQL[@]}" -d "$DB" -c "grant execute on all functions in schema public to authenticated;" >/dev/null

echo "== seeding SPEED (NULL tenant) + two independent ERP companies =="
if ! seed_out=$("${PSQL[@]}" -d "$DB" 2>&1 <<'SQL'
-- Two independent ERP SaaS companies.
insert into public.tenants (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Company A'),
  ('22222222-2222-2222-2222-222222222222', 'Company B');

-- SPEED rental customers: role `client`, tenant_id NULL. This is the production
-- shape - a rental customer belongs to no ERP company.
insert into public.customers (id, tenant_id, name, phone) values
  ('c0000001-0000-0000-0000-000000000001', null, 'Rental Customer 1', '39000001'),
  ('c0000002-0000-0000-0000-000000000002', null, 'Rental Customer 2', '39000002'),
  ('c000000a-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'Company A Customer', '39000003');

insert into public.users (id, email, full_name, role, tenant_id, customer_id, is_active) values
  ('a0000001-0000-0000-0000-000000000001','rc1@speed.local','Rental One','client',null,'c0000001-0000-0000-0000-000000000001',true),
  ('a0000002-0000-0000-0000-000000000002','rc2@speed.local','Rental Two','client',null,'c0000002-0000-0000-0000-000000000002',true),
  ('a0000003-0000-0000-0000-000000000003','super@speed.local','Platform Operator','super_admin',null,null,true),
  ('b0000001-0000-0000-0000-000000000001','adminA@x.local','Admin A','admin','11111111-1111-1111-1111-111111111111',null,true),
  ('b0000002-0000-0000-0000-000000000002','staffA@x.local','Staff A','staff','11111111-1111-1111-1111-111111111111',null,true),
  ('b0000003-0000-0000-0000-000000000003','adminB@x.local','Admin B','admin','22222222-2222-2222-2222-222222222222',null,true);

-- SPEED fleet (tenant-less) + one car per company.
-- One car per contract: 017's exclusion constraint forbids two BLOCKING
-- contracts on the same car, and a tenant-less car is shared by the NULL sentinel.
insert into public.cars (id, tenant_id, make, model, daily_rate, status) values
  ('e0000001-0000-0000-0000-000000000001', null, 'Toyota','Camry',25,'available'),
  ('e0000002-0000-0000-0000-000000000002', null, 'Nissan','Sunny',20,'available'),
  ('e0000003-0000-0000-0000-000000000003', null, 'Mazda','3',22,'available'),
  ('e000000a-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111','Kia','Rio',18,'available'),
  ('e000000b-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222','Honda','City',19,'available');

-- The two REAL production contract numbers, tenant-less, owned by customer 1.
insert into public.rental_contracts (id, tenant_id, customer_id, car_id, contract_number, status, total) values
  ('d0000001-0000-0000-0000-000000000001', null,'c0000001-0000-0000-0000-000000000001','e0000001-0000-0000-0000-000000000001','RC-900020','active',100),
  ('d0000002-0000-0000-0000-000000000002', null,'c0000001-0000-0000-0000-000000000001','e0000002-0000-0000-0000-000000000002','RC-79787137','pending',50),
  ('d0000003-0000-0000-0000-000000000003', null,'c0000002-0000-0000-0000-000000000002','e0000003-0000-0000-0000-000000000003','RC-CUSTOMER2','pending',70),
  ('d000000a-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','c000000a-0000-0000-0000-00000000000a','e000000a-0000-0000-0000-00000000000a','RC-COMPANY-A','pending',80),
  ('d000000b-0000-0000-0000-00000000000b','22222222-2222-2222-2222-222222222222',null,'e000000b-0000-0000-0000-00000000000b','RC-COMPANY-B','pending',90);

insert into public.invoices (id, tenant_id, customer_id, invoice_number, total_amount, status) values
  ('f0000001-0000-0000-0000-000000000001', null,'c0000001-0000-0000-0000-000000000001','INV-RC1',100,'issued'),
  ('f0000002-0000-0000-0000-000000000002', null,'c0000002-0000-0000-0000-000000000002','INV-RC2',500,'issued'),
  ('f000000a-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','c000000a-0000-0000-0000-00000000000a','INV-A',700,'issued');

insert into public.payments (id, tenant_id, customer_id, invoice_id, amount, payment_type) values
  ('91000001-0000-0000-0000-000000000001', null,'c0000001-0000-0000-0000-000000000001','f0000001-0000-0000-0000-000000000001',100,'receipt'),
  ('91000002-0000-0000-0000-000000000002', null,'c0000002-0000-0000-0000-000000000002','f0000002-0000-0000-0000-000000000002',500,'receipt');

-- The ERP/platform-only tables a rental customer must never reach.
insert into public.financial_years (id, tenant_id, name, start_date, end_date) values
  ('99999999-0000-0000-0000-000000000001', null, 'FY-SPEED','2026-01-01','2026-12-31'),
  ('99999999-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','FY-A','2026-01-01','2026-12-31'),
  ('99999999-0000-0000-0000-00000000000b','22222222-2222-2222-2222-222222222222','FY-B','2026-01-01','2026-12-31');

insert into public.settings (id, tenant_id, key, value) values
  ('99999998-0000-0000-0000-000000000001', null, 'platform_secret', 'do-not-leak'),
  ('99999998-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','company_a_key','a-secret');

insert into public.branches (id, tenant_id, name) values
  ('99999997-0000-0000-0000-000000000001', null, 'SPEED Main');
insert into public.employees (id, tenant_id, name) values
  ('99999996-0000-0000-0000-000000000001', null, 'SPEED Staff');
insert into public.suppliers (id, tenant_id, name) values
  ('99999994-0000-0000-0000-000000000001', null, 'SPEED Supplier');
insert into public.accounts (id, tenant_id, code, name) values
  ('99999995-0000-0000-0000-000000000001', null, '11001', 'Cash');
insert into public.journal_entries (id, tenant_id, journal_number) values
  ('99999993-0000-0000-0000-000000000001', null, 'JV-SPEED-1');
insert into public.support_tickets (id, tenant_id, customer_id, subject) values
  ('a7000000-0000-0000-0000-0000000000a1', null,'c0000001-0000-0000-0000-000000000001','RC1 ticket'),
  ('a7000000-0000-0000-0000-0000000000a2', null,'c0000002-0000-0000-0000-000000000002','RC2 ticket');
SQL
); then
  echo " FAIL | seed did not apply"; echo "$seed_out" | grep -i error | head -5; fail=$((fail+1))
fi

C1=a0000001-0000-0000-0000-000000000001
C2=a0000002-0000-0000-0000-000000000002
SUPER=a0000003-0000-0000-0000-000000000003
ADMIN_A=b0000001-0000-0000-0000-000000000001
STAFF_A=b0000002-0000-0000-0000-000000000002
ADMIN_B=b0000003-0000-0000-0000-000000000003
CAR_SPEED=e0000001-0000-0000-0000-000000000001
CAR_A=e000000a-0000-0000-0000-00000000000a

echo
echo "== A. THE DEFECT: a NULL-tenant rental customer before 019 =="
# Measured before 019 is applied: this is the leak the migration closes.
expect_eq "A1 BEFORE 019: customer 1 reads another customer's invoice" "1" \
  "$(as_user $C1 "select count(*) from public.invoices where invoice_number='INV-RC2'" | tail -1)"
expect_eq "A3 BEFORE 019: customer 1 reads the platform settings row" "1" \
  "$(as_user $C1 "select count(*) from public.settings where key='platform_secret'" | tail -1)"
expect_eq "A4 BEFORE 019: customer 1 can DELETE a ledger entry" "1" \
  "$(as_user $C1 "$(dml "delete from public.journal_entries where journal_number='JV-SPEED-1'")" | tail -1)"
expect_eq "A5 BEFORE 019: customer 1 can UPDATE the SPEED car rate" "1" \
  "$(as_user $C1 "$(dml "update public.cars set daily_rate=0 where id='$CAR_SPEED'")" | tail -1)"

echo
echo "== applying 019 (the migration under test) =="
if ! out=$("${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/019_null_tenant_isolation.sql" 2>&1); then
  echo " FAIL | 019 did not apply"; echo "$out" | grep -i error | head -5; fail=$((fail+1))
fi
"${PSQL[@]}" -d "$DB" -c "grant select, insert, update, delete on all tables in schema public to authenticated;" >/dev/null
"${PSQL[@]}" -d "$DB" -c "grant execute on all functions in schema public to authenticated;" >/dev/null

echo
echo "== B. Rental customer 1 sees ONLY its own rows =="
expect_eq "B1  reads its own contract RC-900020" "1" \
  "$(as_user $C1 "select count(*) from public.rental_contracts where contract_number='RC-900020'" | tail -1)"
expect_eq "B2  reads its own contract RC-79787137" "1" \
  "$(as_user $C1 "select count(*) from public.rental_contracts where contract_number='RC-79787137'" | tail -1)"
expect_eq "B3  cannot read customer 2's contract" "0" \
  "$(as_user $C1 "select count(*) from public.rental_contracts where contract_number='RC-CUSTOMER2'" | tail -1)"
expect_eq "B4  sees exactly its 2 contracts, not the company ones" "2" \
  "$(as_user $C1 "select count(*) from public.rental_contracts" | tail -1)"
expect_eq "B5  reads its own invoice" "1" \
  "$(as_user $C1 "select count(*) from public.invoices where invoice_number='INV-RC1'" | tail -1)"
expect_eq "B6  cannot read customer 2's invoice" "0" \
  "$(as_user $C1 "select count(*) from public.invoices where invoice_number='INV-RC2'" | tail -1)"
expect_eq "B7  cannot read company A's invoice" "0" \
  "$(as_user $C1 "select count(*) from public.invoices where invoice_number='INV-A'" | tail -1)"
expect_eq "B8  sees exactly its 1 invoice" "1" \
  "$(as_user $C1 "select count(*) from public.invoices" | tail -1)"
expect_eq "B9  reads its own payment" "1" \
  "$(as_user $C1 "select count(*) from public.payments where invoice_id='f0000001-0000-0000-0000-000000000001'" | tail -1)"
expect_eq "B10 cannot read customer 2's payment" "0" \
  "$(as_user $C1 "select count(*) from public.payments where invoice_id='f0000002-0000-0000-0000-000000000002'" | tail -1)"
expect_eq "B11 reads only its own customer row" "1" \
  "$(as_user $C1 "select count(*) from public.customers" | tail -1)"
expect_eq "B12 cannot read customer 2's PII" "0" \
  "$(as_user $C1 "select count(*) from public.customers where name='Rental Customer 2'" | tail -1)"
expect_eq "B13 reads only its own users row" "1" \
  "$(as_user $C1 "select count(*) from public.users" | tail -1)"
expect_eq "B14 cannot read the global super admin row" "0" \
  "$(as_user $C1 "select count(*) from public.users where role='super_admin'" | tail -1)"
expect_eq "B15 cannot read a company admin's row" "0" \
  "$(as_user $C1 "select count(*) from public.users where email='adminA@x.local'" | tail -1)"

echo
echo "== C. Rental customer 1 cannot reach the ERP or the platform =="
expect_eq "C1  cannot read financial_years" "0" \
  "$(as_user $C1 "select count(*) from public.financial_years" | tail -1)"
expect_eq "C2  cannot read settings (company/platform config)" "0" \
  "$(as_user $C1 "select count(*) from public.settings" | tail -1)"
expect_eq "C3  cannot read branches" "0" \
  "$(as_user $C1 "select count(*) from public.branches" | tail -1)"
expect_eq "C4  cannot read employees" "0" \
  "$(as_user $C1 "select count(*) from public.employees" | tail -1)"
expect_eq "C5  cannot read suppliers" "0" \
  "$(as_user $C1 "select count(*) from public.suppliers" | tail -1)"
expect_eq "C6  cannot read the chart of accounts" "0" \
  "$(as_user $C1 "select count(*) from public.accounts" | tail -1)"
expect_eq "C7  cannot read the general ledger" "0" \
  "$(as_user $C1 "select count(*) from public.journal_entries" | tail -1)"

echo
echo "== D. Rental customer 1 cannot WRITE another party's data =="
expect_eq "D1  cannot UPDATE the SPEED car rate" "0" \
  "$(as_user $C1 "$(dml "update public.cars set daily_rate=0 where id='$CAR_SPEED'")" | tail -1)"
expect_eq "D2  cannot DELETE a SPEED car" "0" \
  "$(as_user $C1 "$(dml "delete from public.cars where id='$CAR_SPEED'")" | tail -1)"
expect_denied "D3  cannot INSERT a car into the fleet" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$C1')::text, true); end \$j\$; set local role authenticated; insert into public.cars (tenant_id, make) values (null,'Evil'); rollback;"
expect_eq "D4  cannot UPDATE customer 2's invoice" "0" \
  "$(as_user $C1 "$(dml "update public.invoices set total_amount=0 where invoice_number='INV-RC2'")" | tail -1)"
expect_eq "D5  cannot DELETE customer 2's invoice" "0" \
  "$(as_user $C1 "$(dml "delete from public.invoices where invoice_number='INV-RC2'")" | tail -1)"
expect_denied "D6  cannot INSERT an invoice for customer 2" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$C1')::text, true); end \$j\$; set local role authenticated; insert into public.invoices (tenant_id, customer_id, invoice_number) values (null,'c0000002-0000-0000-0000-000000000002','INV-EVIL'); rollback;"
expect_eq "D7  cannot DELETE a ledger entry" "0" \
  "$(as_user $C1 "$(dml "delete from public.journal_entries where journal_number='JV-SPEED-1'")" | tail -1)"
expect_eq "D8  cannot DELETE the chart of accounts" "0" \
  "$(as_user $C1 "$(dml "delete from public.accounts")" | tail -1)"
expect_eq "D9  cannot DELETE the platform settings" "0" \
  "$(as_user $C1 "$(dml "delete from public.settings")" | tail -1)"
expect_eq "D10 cannot DELETE its own contract (office action)" "0" \
  "$(as_user $C1 "$(dml "delete from public.rental_contracts where contract_number='RC-900020'")" | tail -1)"
expect_eq "D11 cannot UPDATE customer 2's record" "0" \
  "$(as_user $C1 "$(dml "update public.customers set name='hacked' where name='Rental Customer 2'")" | tail -1)"
expect_eq "D12 cannot DELETE customer 2's record" "0" \
  "$(as_user $C1 "$(dml "delete from public.customers where name='Rental Customer 2'")" | tail -1)"

echo
echo "== E. A rental customer cannot acquire an ERP identity =="
expect_denied "E1  cannot promote itself to staff" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$C1')::text, true); end \$j\$; set local role authenticated; update public.users set role='staff' where id='$C1'; rollback;"
expect_denied "E2  cannot promote itself to admin" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$C1')::text, true); end \$j\$; set local role authenticated; update public.users set role='admin' where id='$C1'; rollback;"
expect_denied "E3  cannot promote itself to super_admin" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$C1')::text, true); end \$j\$; set local role authenticated; update public.users set role='super_admin' where id='$C1'; rollback;"
expect_denied "E4  cannot move itself into an ERP tenant" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$C1')::text, true); end \$j\$; set local role authenticated; update public.users set tenant_id='11111111-1111-1111-1111-111111111111' where id='$C1'; rollback;"
expect_denied "E5  cannot re-point its own customer link" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$C1')::text, true); end \$j\$; set local role authenticated; update public.users set customer_id='c0000002-0000-0000-0000-000000000002' where id='$C1'; rollback;"
expect_denied "E6  cannot deactivate/reactivate itself" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$C1')::text, true); end \$j\$; set local role authenticated; update public.users set is_active=false where id='$C1'; rollback;"
expect_eq "E7  may still edit its own non-privileged fields" "1" \
  "$(as_user $C1 "$(dml "update public.users set full_name='Renamed' where id='$C1'")" | tail -1)"
expect_denied "E8  cannot INSERT a new users row for itself" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$C1')::text, true); end \$j\$; set local role authenticated; insert into public.users (id, email, role) values ('a0000009-0000-0000-0000-000000000009','x@y.local','admin'); rollback;"

echo
echo "== F. Customer 2 is isolated from customer 1 (both directions) =="
expect_eq "F1  customer 2 sees exactly its 1 contract" "1" \
  "$(as_user $C2 "select count(*) from public.rental_contracts" | tail -1)"
expect_eq "F2  customer 2 cannot read customer 1's contract" "0" \
  "$(as_user $C2 "select count(*) from public.rental_contracts where contract_number='RC-900020'" | tail -1)"
expect_eq "F3  customer 2 sees exactly its 1 invoice" "1" \
  "$(as_user $C2 "select count(*) from public.invoices" | tail -1)"
expect_eq "F4  customer 2 cannot read customer 1's PII" "0" \
  "$(as_user $C2 "select count(*) from public.customers where name='Rental Customer 1'" | tail -1)"
expect_eq "F5  customer 2 cannot UPDATE customer 1's contract" "0" \
  "$(as_user $C2 "$(dml "update public.rental_contracts set total=0 where contract_number='RC-900020'")" | tail -1)"

echo
echo "== G. ERP companies remain isolated from each other =="
expect_eq "G1  company A admin reads its own contract" "1" \
  "$(as_user $ADMIN_A "select count(*) from public.rental_contracts where contract_number='RC-COMPANY-A'" | tail -1)"
expect_eq "G2  company A cannot read company B's contract" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.rental_contracts where contract_number='RC-COMPANY-B'" | tail -1)"
expect_eq "G3  company A cannot read the SPEED rental contracts" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.rental_contracts where contract_number in ('RC-900020','RC-79787137')" | tail -1)"
expect_eq "G4  company A reads its own car" "1" \
  "$(as_user $ADMIN_A "select count(*) from public.cars where make='Kia'" | tail -1)"
expect_eq "G5  company A cannot read company B's car" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.cars where make='Honda'" | tail -1)"
expect_eq "G6  company A cannot read the SPEED fleet" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.cars where make in ('Toyota','Nissan')" | tail -1)"
expect_eq "G7  company A reads its own financial year" "1" \
  "$(as_user $ADMIN_A "select count(*) from public.financial_years where name='FY-A'" | tail -1)"
expect_eq "G8  company A cannot read company B's financial year" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.financial_years where name='FY-B'" | tail -1)"
expect_eq "G9  company A cannot read the platform financial year" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.financial_years where name='FY-SPEED'" | tail -1)"
expect_eq "G10 company B cannot read company A's contract" "0" \
  "$(as_user $ADMIN_B "select count(*) from public.rental_contracts where contract_number='RC-COMPANY-A'" | tail -1)"
expect_eq "G11 company A admin still sees its own tenant's users" "2" \
  "$(as_user $ADMIN_A "select count(*) from public.users where tenant_id='11111111-1111-1111-1111-111111111111'" | tail -1)"
expect_eq "G12 company A admin cannot read the global super admin" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.users where role='super_admin'" | tail -1)"
expect_eq "G13 company A admin can UPDATE its own contract (workflow intact)" "1" \
  "$(as_user $ADMIN_A "$(dml "update public.rental_contracts set notes='ok' where contract_number='RC-COMPANY-A'")" | tail -1)"
expect_eq "G14 company A admin can DELETE its own contract (workflow intact)" "1" \
  "$(as_user $ADMIN_A "$(dml "delete from public.rental_contracts where contract_number='RC-COMPANY-A'")" | tail -1)"
expect_denied "G15 company A admin cannot INSERT into company B" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; insert into public.rental_contracts (tenant_id, contract_number) values ('22222222-2222-2222-2222-222222222222','RC-EVIL'); rollback;"

echo
echo "== H. Staff stays restricted; the super admin keeps global reach =="
expect_eq "H1  staff A reads its own tenant's contract" "1" \
  "$(as_user $STAFF_A "select count(*) from public.rental_contracts where contract_number='RC-COMPANY-A'" | tail -1)"
expect_eq "H2  staff A cannot read company B" "0" \
  "$(as_user $STAFF_A "select count(*) from public.rental_contracts where contract_number='RC-COMPANY-B'" | tail -1)"
expect_eq "H3  staff A cannot read the SPEED rentals" "0" \
  "$(as_user $STAFF_A "select count(*) from public.rental_contracts where contract_number='RC-900020'" | tail -1)"
expect_denied "H4  staff A cannot promote itself to admin" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$STAFF_A')::text, true); end \$j\$; set local role authenticated; update public.users set role='admin' where id='$STAFF_A'; rollback;"
expect_eq "H5  super admin reads the SPEED rental contracts" "3" \
  "$(as_user $SUPER "select count(*) from public.rental_contracts where tenant_id is null" | tail -1)"
expect_eq "H6  super admin reads company A's contract" "1" \
  "$(as_user $SUPER "select count(*) from public.rental_contracts where contract_number='RC-COMPANY-A'" | tail -1)"
expect_eq "H7  super admin reads company B's contract" "1" \
  "$(as_user $SUPER "select count(*) from public.rental_contracts where contract_number='RC-COMPANY-B'" | tail -1)"
expect_eq "H8  super admin reads every financial year" "3" \
  "$(as_user $SUPER "select count(*) from public.financial_years" | tail -1)"
expect_eq "H9  super admin is not treated as a rental customer" "f" \
  "$(as_user $SUPER "select public.is_client_only()" | tail -1)"

echo
echo "== I. The approved catalog and the booking guard still work =="
expect_eq "I1  customer 1 still sees the SPEED fleet" "3" \
  "$(as_user $C1 "select count(*) from public.cars where tenant_id is null" | tail -1)"
expect_eq "I2  customer 1 does not see a company's car" "0" \
  "$(as_user $C1 "select count(*) from public.cars where make='Kia'" | tail -1)"
expect_denied_or_zero "I3  anon cannot read the SPEED fleet" \
  "select count(*) from public.cars"
expect_denied_or_zero "I4  anon cannot read rental contracts" \
  "select count(*) from public.rental_contracts"
expect_denied_or_zero "I5  anon cannot read the ledger" \
  "select count(*) from public.journal_entries"
expect_eq "I6  the 017 booking-overlap trigger is installed" "1" \
  "$(q "select count(*) from pg_trigger where tgname='rental_contracts_no_double_booking' and not tgisinternal" | tail -1)"
expect_eq "I7  booking_blocks_car() is present (guard predicate)" "t" \
  "$(q "select public.booking_blocks_car('pending')" | tail -1)"
expect_eq "I8  back-to-back windows do not overlap (guard semantics)" "f" \
  "$(q "select tstzrange('2026-03-01 10:00+03','2026-03-02 10:00+03','[)') && tstzrange('2026-03-02 10:00+03','2026-03-03 10:00+03','[)')" | tail -1)"
expect_eq "I9  a genuinely overlapping window does overlap" "t" \
  "$(q "select tstzrange('2026-03-01 10:00+03','2026-03-02 10:00+03','[)') && tstzrange('2026-03-01 12:00+03','2026-03-03 10:00+03','[)')" | tail -1)"

echo
echo "== J. Grants: the predicates are not anon-callable =="
expect_eq "J1  anon cannot execute is_client_only()" "f" \
  "$(q "select has_function_privilege('anon','public.is_client_only()','execute')" | tail -1)"
expect_eq "J2  anon cannot execute is_erp_user()" "f" \
  "$(q "select has_function_privilege('anon','public.is_erp_user()','execute')" | tail -1)"
expect_eq "J3  authenticated may execute is_client_only()" "t" \
  "$(q "select has_function_privilege('authenticated','public.is_client_only()','execute')" | tail -1)"
expect_eq "J4  anon holds no privilege on settings" "f" \
  "$(q "select has_table_privilege('anon','public.settings','select')" | tail -1)"
expect_eq "J5  the identity-reservation trigger exists" "1" \
  "$(q "select count(*) from pg_trigger where tgname='users_reserve_client_identity' and not tgisinternal" | tail -1)"

echo
echo "== K. Idempotency, rollback and re-apply =="
if "${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/019_null_tenant_isolation.sql" >/dev/null 2>&1; then
  ok "K1  re-applying 019 is clean (idempotent)"
else
  bad "K1  re-applying 019 is clean (idempotent)" "non-zero exit"
fi
expect_eq "K2  isolation still holds after re-apply" "0" \
  "$(as_user $C1 "select count(*) from public.settings" | tail -1)"

"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/019_null_tenant_isolation_rollback.sql" >/dev/null 2>&1
expect_eq "K3  after rollback the leak returns (documented)" "1" \
  "$(as_user $C1 "select count(*) from public.settings where key='platform_secret'" | tail -1)"
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/019_null_tenant_isolation.sql" >/dev/null 2>&1
expect_eq "K4  re-applying 019 restores isolation" "0" \
  "$(as_user $C1 "select count(*) from public.settings" | tail -1)"

echo "-----------------------------------------"
echo "RESULT: $pass passed, $fail failed"
if [ "$fail" -eq 0 ]; then echo "EXEC77 NULL-TENANT ISOLATION: PASS"; else echo "EXEC77 NULL-TENANT ISOLATION: FAIL"; fi
echo "-----------------------------------------"

"${PSQL[@]}" -c "drop database if exists $DB" >/dev/null 2>&1
[ "$fail" -eq 0 ]
