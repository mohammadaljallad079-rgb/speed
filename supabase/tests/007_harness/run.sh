#!/usr/bin/env bash
# Verify migration 007 (purchase ↔ credit-sale analytical links) by EXECUTION
# against a real PostgreSQL, with two tenants. Complements the structural checks
# in tests/exec30-purchase-sale-links.test.ts.
#
# Requires a local PostgreSQL and a superuser (postgres) you can reach:
#   PGHOST=... PGUSER=postgres bash supabase/tests/007_harness/run.sh
#
# Creates and drops a throwaway database named `speed_007`.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_007

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
expect_denied() {
  local out; out=$(q "$2")
  if echo "$out" | grep -qiE "row-level security|permission denied|violates unique|duplicate key"; then ok "$1"; else bad "$1" "$out"; fi
}

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB"

echo "== base schema + Supabase-like default grants =="
"${PSQL[@]}" -d "$DB" -f - < "$HERE/../isolation_harness/base_schema.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -c "grant all on all tables in schema public to anon, authenticated;" >/dev/null

echo "== applying migrations 001 -> 002 (predicates 007 depends on) =="
for m in 001_core_security 002_tenant_isolation_hardening; do
  "${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/$m.sql" >/dev/null
done

echo "== applying migration 007 =="
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/007_purchase_sale_links.sql" >/dev/null && ok "007 applies cleanly" || bad "007 applies cleanly" "error"

echo "== idempotency: re-apply 007 =="
"${PSQL[@]}" -d "$DB" -f - < "$ROOT/supabase/migrations/007_purchase_sale_links.sql" >/dev/null && ok "007 re-applies (idempotent)" || bad "007 re-applies" "error"

# Supabase grants `authenticated` on new tables; RLS must be the denial.
"${PSQL[@]}" -d "$DB" -c "grant select, insert, update, delete on all tables in schema public to authenticated;" >/dev/null

expect_eq "007 created the table" "1" \
  "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name='purchase_sale_links'")"
expect_eq "007 enabled RLS" "1" \
  "$(q "select relrowsecurity::int from pg_class where relname='purchase_sale_links'")"

echo "== seeding two tenants, users and documents =="
"${PSQL[@]}" -d "$DB" >/dev/null <<'SQL'
insert into public.tenants (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Tenant A'),
  ('22222222-2222-2222-2222-222222222222', 'Tenant B');
insert into public.users (id, email, role, tenant_id, is_active) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'adminA@x.local', 'admin',       '11111111-1111-1111-1111-111111111111', true),
  ('cccccccc-0000-0000-0000-000000000003', 'super@x.local',  'super_admin', null,                                   true);
insert into public.purchase_invoices (id, tenant_id, status) values
  ('aaaa0001-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'pending'),
  ('aaaa0001-0000-4000-8000-000000000002', '22222222-2222-2222-2222-222222222222', 'pending');
insert into public.invoices (id, tenant_id, status) values
  ('bbbb0001-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'pending'),
  ('bbbb0001-0000-4000-8000-000000000002', '22222222-2222-2222-2222-222222222222', 'pending');
SQL

as_user() { q "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$1')::text, true); end \$j\$; set local role authenticated; $2; rollback;"; }
dml() { echo "with t as ($1 returning 1) select count(*) from t;"; }

ADMIN_A=aaaaaaaa-0000-0000-0000-000000000001
SUPER=cccccccc-0000-0000-0000-000000000003
PA=aaaa0001-0000-4000-8000-000000000001
PB=aaaa0001-0000-4000-8000-000000000002
SA=bbbb0001-0000-4000-8000-000000000001
SB=bbbb0001-0000-4000-8000-000000000002

echo "== assertions =="

# 1. Tenant A can create a link between its own purchase and sale. (Seeded via
#    the service role below so later read assertions have a persistent row; the
#    tenant-A insert itself is asserted here.)
expect_eq "A1 tenant A links its own purchase/sale" "1" \
  "$(as_user $ADMIN_A "insert into public.purchase_sale_links (tenant_id, purchase_invoice_id, invoice_id) values ('11111111-1111-1111-1111-111111111111','$PA','$SA') returning 1" | tail -1)"

# 2. Tenant A cannot create a tenant-B-owned link row (RLS write predicate).
expect_denied "A2 tenant A cannot insert a tenant B link row" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; insert into public.purchase_sale_links (tenant_id, purchase_invoice_id, invoice_id) values ('22222222-2222-2222-2222-222222222222','$PB','$SB'); rollback;"

# Persist one link per tenant via the service role (the tenant-A insert above was
# rolled back with its transaction).
q "insert into public.purchase_sale_links (tenant_id, purchase_invoice_id, invoice_id) values ('11111111-1111-1111-1111-111111111111','$PA','$SA')" >/dev/null
q "insert into public.purchase_sale_links (tenant_id, purchase_invoice_id, invoice_id) values ('22222222-2222-2222-2222-222222222222','$PB','$SB')" >/dev/null
expect_eq "A3 tenant A cannot read tenant B links" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.purchase_sale_links where tenant_id='22222222-2222-2222-2222-222222222222'" | tail -1)"
expect_eq "A3b tenant A reads only its own link" "1" \
  "$(as_user $ADMIN_A "select count(*) from public.purchase_sale_links" | tail -1)"

# 4. Tenant A cannot update or delete tenant B's link.
expect_eq "A4 tenant A cannot update tenant B link" "0" \
  "$(as_user $ADMIN_A "$(dml "update public.purchase_sale_links set note='x' where tenant_id='22222222-2222-2222-2222-222222222222'")" | tail -1)"
expect_eq "A4b tenant A cannot delete tenant B link" "0" \
  "$(as_user $ADMIN_A "$(dml "delete from public.purchase_sale_links where tenant_id='22222222-2222-2222-2222-222222222222'")" | tail -1)"

# 5. A NULL-tenant link is not a cross-tenant path for a tenanted caller.
q "insert into public.purchase_sale_links (purchase_invoice_id, invoice_id) values ('$PB','$SB')" >/dev/null
expect_eq "A5 NULL-tenant link invisible to tenant A" "0" \
  "$(as_user $ADMIN_A "select count(*) from public.purchase_sale_links where tenant_id is null" | tail -1)"

# 6. Duplicate pair is blocked by the unique index (same tenant).
expect_denied "A6 duplicate pair blocked" \
  "begin; do \$j\$ begin perform set_config('request.jwt.claims', json_build_object('sub','$ADMIN_A')::text, true); end \$j\$; set local role authenticated; insert into public.purchase_sale_links (tenant_id, purchase_invoice_id, invoice_id) values ('11111111-1111-1111-1111-111111111111','$PA','$SA'); rollback;"

# 7. Anonymous has zero access.
expect_denied "A7 anon select denied" "begin; set local role anon; select count(*) from public.purchase_sale_links; rollback;"
expect_denied "A8 anon insert denied" "begin; set local role anon; insert into public.purchase_sale_links (purchase_invoice_id, invoice_id) values ('$PA','$SA'); rollback;"

# 8. The migration is additive: the tables it references still exist.
expect_eq "A9 purchase_invoices still present" "1" \
  "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name='purchase_invoices'")"

echo "-----------------------------------------"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && echo "007 HARNESS: PASS" || echo "007 HARNESS: FAIL"
