#!/usr/bin/env bash
# Verify migrations 001 -> 004 by EXECUTION against a real PostgreSQL, with two
# tenants. This complements supabase/tests/004_harness (which covers the
# super-admin role semantics) by asserting the full cross-tenant isolation the
# mission lists as acceptance tests.
#
# Requires a local PostgreSQL and a superuser (postgres) you can reach:
#   PGHOST=... PGUSER=postgres bash supabase/tests/isolation_harness/run.sh
#
# It creates and drops a throwaway database named `speed_isolation`.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_isolation

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
if [ "$(id -u)" = "0" ]; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
elif command -v sudo >/dev/null && sudo -n -u postgres true 2>/dev/null; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
fi
# Query helper: runs one statement and prints the raw result (or the error).
q() { "${PSQL[@]}" -d "$DB" -tAc "$1" 2>&1; }

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> got: $2"; fail=$((fail+1)); }

expect_eq() { # desc expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3"; fi
}
expect_denied() { # desc sql  (must error with an RLS/permission/trigger denial)
  local out; out=$(q "$2")
  if echo "$out" | grep -qiE "row-level security|permission denied|violates|only a super administrator|may grant or revoke"; then ok "$1"; else bad "$1" "$out"; fi
}

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB"

echo "== base schema + Supabase-like default grants =="
"${PSQL[@]}" -d "$DB" -f - < "$HERE/base_schema.sql" >/dev/null
# Supabase grants anon/authenticated full access by default; 002 must strip anon.
"${PSQL[@]}" -d "$DB" -c "grant all on all tables in schema public to anon, authenticated;" >/dev/null

echo "== applying migrations 001 -> 004 =="
for m in 001_core_security 002_tenant_isolation_hardening 003_sales_lifecycle 004_global_super_admin; do
  "${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/$m.sql" >/dev/null
done

# Supabase grants `authenticated` table privileges on new tables by default;
# RLS (not a missing GRANT) must be what denies a tenant. Mirror that.
"${PSQL[@]}" -d "$DB" -c "grant select, insert, update, delete on all tables in schema public to authenticated;" >/dev/null
"${PSQL[@]}" -d "$DB" -c "grant execute on all functions in schema public to authenticated;" >/dev/null

echo "== idempotency: re-apply 002 and 004 =="
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/002_tenant_isolation_hardening.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/004_global_super_admin.sql" >/dev/null

echo "== seeding two tenants, users and rows =="
"${PSQL[@]}" -d "$DB" >/dev/null <<'SQL'
insert into public.tenants (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Tenant A'),
  ('22222222-2222-2222-2222-222222222222', 'Tenant B');
insert into public.users (id, email, role, tenant_id, is_active) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'adminA@x.local', 'admin',       '11111111-1111-1111-1111-111111111111', true),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'staffB@x.local', 'staff',       '22222222-2222-2222-2222-222222222222', true),
  ('cccccccc-0000-0000-0000-000000000003', 'super@x.local',  'super_admin', null,                                   true);
insert into public.customers (id, tenant_id, name, amount) values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'A-customer', 10),
  ('b0000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'B-customer', 20),
  ('00000000-0000-0000-0000-00000000000c', null,                                   'NULL-row',   30);
insert into public.activity_logs (tenant_id, action, entity) values
  ('11111111-1111-1111-1111-111111111111', 'test', 'customers');
SQL

# Session helper: run SQL as a given authenticated user. The claims are set
# inside a DO block (PL/pgSQL `perform`) so nothing extra is printed, then the
# role is switched and the query runs. `dml` wraps a DML statement so its
# affected-row count is returned as a value instead of a suppressed command tag.
as_user() { # uuid sql
  q "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$1')::text, true); end \$j\$; set local role authenticated; $2; rollback;"
}
dml() { echo "with t as ($1 returning 1) select count(*) from t;"; }

ADMIN_A=aaaaaaaa-0000-0000-0000-000000000001
STAFF_B=bbbbbbbb-0000-0000-0000-000000000002
SUPER=cccccccc-0000-0000-0000-000000000003

echo "== assertions =="

# 1. Tenant A admin reads only its own rows.
expect_eq "A1 company admin reads own tenant only" "1" \
  "$(as_user $ADMIN_A "select count(*) from public.customers" | tail -1)"

# 2. Tenant A cannot INSERT into Tenant B.
expect_denied "A2 cross-tenant insert blocked" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; insert into public.customers (tenant_id, name) values ('22222222-2222-2222-2222-222222222222','x'); rollback;"

# 3. Tenant A cannot UPDATE Tenant B's row.
expect_eq "A3 cross-tenant update affects 0 rows" "0" \
  "$(as_user $ADMIN_A "$(dml "update public.customers set amount=1 where tenant_id='22222222-2222-2222-2222-222222222222'")" | tail -1)"

# 4. Tenant A cannot DELETE Tenant B's row.
expect_eq "A4 cross-tenant delete affects 0 rows" "0" \
  "$(as_user $ADMIN_A "$(dml "delete from public.customers where tenant_id='22222222-2222-2222-2222-222222222222'")" | tail -1)"

# 5. A tenant-less row is NOT a cross-tenant access path for a tenanted caller.
expect_eq "A5 NULL-tenant row invisible to tenant A" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.customers where tenant_id is null" | tail -1)"

# 6. Ordinary staff confined to its own tenant.
expect_eq "A6 staff reads own tenant only" "1" \
  "$(as_user $STAFF_B "select count(*) from public.customers" | tail -1)"
expect_eq "A6b staff cannot read tenant A" "0" \
  "$(as_user $STAFF_B "select count(*) from public.customers where tenant_id='11111111-1111-1111-1111-111111111111'" | tail -1)"

# 7. Global super admin sees across tenants (explicit policy).
expect_eq "A7 super admin sees all tenants" "3" \
  "$(as_user $SUPER "select count(*) from public.customers" | tail -1)"

# 8. Anonymous has zero access.
expect_denied "A8 anon select denied" "begin; set local role anon; select count(*) from public.customers; rollback;"
expect_denied "A9 anon insert denied" "begin; set local role anon; insert into public.customers (name) values ('x'); rollback;"
expect_denied "A12 anon cannot execute is_super_admin()" "begin; set local role anon; select public.is_super_admin(); rollback;"

# 10. Audit trail is append-only for a tenant admin (RESTRICTIVE policies).
expect_eq "A10 activity_logs update affects 0 rows" "0" \
  "$(as_user $ADMIN_A "$(dml "update public.activity_logs set action='tampered'")" | tail -1)"
expect_eq "A10b activity_logs delete affects 0 rows" "0" \
  "$(as_user $ADMIN_A "$(dml "delete from public.activity_logs")" | tail -1)"

# 11. A company admin cannot promote itself to super_admin.
expect_denied "A11 self-promotion to super_admin blocked" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; update public.users set role='super_admin' where id='$ADMIN_A'; rollback;"

# 13. Super admin write predicate is global.
expect_eq "A13 super admin may write tenant B" "1" \
  "$(as_user $SUPER "insert into public.customers (tenant_id, name) values ('22222222-2222-2222-2222-222222222222','sa') returning 1" | tail -1)"

# 14. Migration-created artifacts.
expect_eq "A14 account 41003 created once" "1" \
  "$(q "select count(*) from public.accounts where code='41003'")"
expect_eq "A15 sequences receipt+sales_return present" "2" \
  "$(q "select count(*) from public.document_sequences where doc_type in ('receipt','sales_return')")"

echo "-----------------------------------------"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && echo "ISOLATION: PASS" || echo "ISOLATION: FAIL"
