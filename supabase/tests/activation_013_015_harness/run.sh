#!/usr/bin/env bash
# Execute the 013 / 014 / 015 activation packages against a real PostgreSQL and
# assert what they change.
#
# The packages are the operator's delivery vehicle for these migrations, so a
# stale or broken package is a production defect even when the migration file
# itself is correct. Parsing proves neither: this harness APPLIES each package to
# a schema modelled on the live project and asserts the effect.
#
# Usage (local PostgreSQL 17):
#   PGHOST=127.0.0.1 PGPORT=55433 PGUSER=postgres PGPASSWORD=postgres \
#     bash supabase/tests/activation_013_015_harness/run.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_act_013_015
P013="$ROOT/supabase/PRODUCTION_ACTIVATION_013.sql"
P014="$ROOT/supabase/PRODUCTION_ACTIVATION_014.sql"
P015="$ROOT/supabase/PRODUCTION_ACTIVATION_015.sql"

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
q() { "${PSQL[@]}" -d "$DB" -tAc "$1" </dev/null 2>&1 | tr -d "\r"; }
apply() { "${PSQL[@]}" -d "$DB" -f - < "$1" >/dev/null 2>&1; }

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> $2"; fail=$((fail+1)); }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB" </dev/null >/dev/null

echo "== schema modelled on the live project =="
"${PSQL[@]}" -d "$DB" </dev/null >/dev/null <<'SQL'
create extension if not exists pgcrypto;

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  code text,
  name text,
  name_en text,
  name_ar text,
  type text,
  parent_code text,
  parent_id uuid,
  level int default 1,
  balance numeric default 0,
  reporting_category text,
  tenant_id uuid,
  is_active boolean default true,
  is_postable boolean default true
);
create table public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  journal_number text,
  entry_date date,
  description text,
  entry_type text,
  reference_number text,
  status text,
  total_debit numeric,
  total_credit numeric,
  is_balanced boolean,
  tenant_id uuid,
  created_at timestamptz default now()
);
create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid references public.journal_entries(id) on delete cascade,
  account_id uuid references public.accounts(id),
  debit numeric default 0,
  credit numeric default 0,
  description text,
  line_order int,
  tenant_id uuid
);
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text,
  customer_id uuid,
  rental_contract_id uuid,
  total_amount numeric default 0,
  paid_amount numeric default 0,
  status text,
  tenant_id uuid
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  receipt_number text,
  customer_id uuid,
  invoice_id uuid,
  amount numeric default 0,
  payment_method text default 'cash',
  payment_date date default current_date,
  payment_type text default 'receipt',
  notes text,
  status text default 'completed',
  tenant_id uuid,
  financial_year_id uuid,
  rental_contract_id uuid,
  car_plate text
);
SQL

# ---------------------------------------------------------------------------
# 013 — booking invoice idempotency
# ---------------------------------------------------------------------------
echo "== 013 =="
if apply "$P013"; then ok "013 package applies"; else bad "013 package applies" "see error"; fi
expect_eq "013 created the one-live-invoice-per-contract index" \
  "$(q "select count(*) from pg_class where relname='invoices_one_live_per_rental_contract_uidx'")" "1"
expect_eq "013 created the rental-contract lookup index" \
  "$(q "select count(*) from pg_class where relname='invoices_rental_contract_id_idx'")" "1"
# Re-apply must be a clean no-op.
if apply "$P013"; then ok "013 re-applies idempotently"; else bad "013 re-applies idempotently" "see error"; fi
expect_eq "013 still has exactly one uniqueness index" \
  "$(q "select count(*) from pg_class where relname='invoices_one_live_per_rental_contract_uidx'")" "1"

# Behaviour: a second live invoice for the same contract is refused.
q "insert into public.invoices (invoice_number, rental_contract_id, tenant_id)
   values ('INV-1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1')" >/dev/null
expect_eq "013 blocks a duplicate live invoice for one contract" \
  "$(q "insert into public.invoices (invoice_number, rental_contract_id, tenant_id)
        values ('INV-2', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1')" \
      | grep -ciE 'duplicate|unique|violates')" "1"
expect_eq "013 allows a different contract" \
  "$(q "insert into public.invoices (invoice_number, rental_contract_id, tenant_id)
        values ('INV-3', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1')
        returning 'ok'")" "ok"

# ---------------------------------------------------------------------------
# 014 — per-tenant chart of accounts
# ---------------------------------------------------------------------------
echo "== 014 =="
q "insert into public.accounts (code, tenant_id) values
     ('11001', '00000000-0000-0000-0000-0000000000a1'),
     ('11001', '00000000-0000-0000-0000-0000000000b1'),
     ('11001', null)" >/dev/null
if apply "$P014"; then ok "014 package applies"; else bad "014 package applies" "see error"; fi
expect_eq "014 created the tenant+code uniqueness index" \
  "$(q "select count(*) from pg_class where relname='accounts_tenant_code_uidx'")" "1"
expect_eq "014 created the NULL-tenant code uniqueness index" \
  "$(q "select count(*) from pg_class where relname='accounts_null_tenant_code_uidx'")" "1"
if apply "$P014"; then ok "014 re-applies idempotently"; else bad "014 re-applies idempotently" "see error"; fi
expect_eq "014 blocks a duplicate code inside one company" \
  "$(q "insert into public.accounts (code, tenant_id)
        values ('11001', '00000000-0000-0000-0000-0000000000a1')" \
      | grep -ciE 'duplicate|unique|violates')" "1"
expect_eq "014 allows the same code in another company" \
  "$(q "insert into public.accounts (code, tenant_id)
        values ('11001', '00000000-0000-0000-0000-0000000000c1') returning 'ok'")" "ok"
expect_eq "014 blocks a second NULL-tenant row with the same code" \
  "$(q "insert into public.accounts (code, tenant_id) values ('11001', null)" \
      | grep -ciE 'duplicate|unique|violates')" "1"

# ---------------------------------------------------------------------------
# 015 — strict accounting integrity + the atomic receipt and its reversal
# ---------------------------------------------------------------------------
echo "== 015 =="
if apply "$P015"; then ok "015 package applies"; else bad "015 package applies" "see error"; fi
expect_eq "015 hardened post_journal_entry" \
  "$(q "select count(*) from pg_proc where proname='post_journal_entry'")" "1"
expect_eq "015 created the atomic receipt" \
  "$(q "select count(*) from pg_proc where proname='post_customer_receipt'")" "1"
expect_eq "015 created the atomic receipt reversal" \
  "$(q "select count(*) from pg_proc where proname='post_customer_receipt_reversal'")" "1"
expect_eq "015 created the tenant receipt index" \
  "$(q "select count(*) from pg_class where relname='payments_tenant_receipt_uidx'")" "1"
expect_eq "015 created the NULL-tenant receipt index" \
  "$(q "select count(*) from pg_class where relname='payments_null_tenant_receipt_uidx'")" "1"
if apply "$P015"; then ok "015 re-applies idempotently"; else bad "015 re-applies idempotently" "see error"; fi

# The end-to-end property the whole package exists for: collect 99 on INV-H,
# then reverse it - each in ONE call, leaving no orphan.
q "insert into public.accounts (id, code, tenant_id, is_active, is_postable) values
     ('00000000-0000-0000-0000-00000000a001', '77001', '00000000-0000-0000-0000-0000000000a1', true, true),
     ('00000000-0000-0000-0000-00000000a002', '77002', '00000000-0000-0000-0000-0000000000a1', true, true)" >/dev/null
expect_eq "the two receipt accounts exist and are usable" \
  "$(q "select count(*) from public.accounts where id in
        ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-00000000a002')
        and is_active and is_postable")" "2"
q "insert into public.invoices (id, invoice_number, customer_id, total_amount, paid_amount, status, tenant_id)
   values ('00000000-0000-0000-0000-0000000000e1', 'INV-H', '00000000-0000-0000-0000-0000000000c1', 99, 0, 'pending',
           '00000000-0000-0000-0000-0000000000a1')" >/dev/null

expect_eq "a receipt writes payment + journal + settlement in one call" \
  "$(q "select (public.post_customer_receipt(
       '{\"receipt_number\":\"REC-H-1\",\"customer_id\":\"00000000-0000-0000-0000-0000000000c1\",\"invoice_id\":\"00000000-0000-0000-0000-0000000000e1\",\"amount\":99,\"payment_method\":\"cash\",\"payment_date\":\"2026-01-05\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
       '{\"journal_number\":\"JV-H-1\",\"entry_date\":\"2026-01-05\",\"reference_number\":\"REC-H-1\",\"entry_type\":\"customer_receipt\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
       '[{\"account_id\":\"00000000-0000-0000-0000-00000000a001\",\"debit\":99,\"credit\":0},
         {\"account_id\":\"00000000-0000-0000-0000-00000000a002\",\"debit\":0,\"credit\":99}]'::jsonb
     )->>'journal_id') is not null")" "t"
expect_eq "the invoice is settled to paid" \
  "$(q "select round(paid_amount,3)::text || '/' || status from public.invoices where invoice_number='INV-H'")" "99.000/paid"

REC_H_ID="$(q "select id from public.payments where receipt_number='REC-H-1' and tenant_id='00000000-0000-0000-0000-0000000000a1'")"
expect_eq "the reversal mirrors the receipt in one call" \
  "$(q "select (public.post_customer_receipt_reversal(
       '$REC_H_ID'::uuid,
       '00000000-0000-0000-0000-0000000000a1'::uuid,
       '{\"journal_number\":\"JV-H-REV\",\"entry_date\":\"2026-01-09\",\"reference_number\":\"REC-H-1\",\"entry_type\":\"customer_receipt_reversal\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
       '[{\"account_id\":\"00000000-0000-0000-0000-00000000a002\",\"debit\":99,\"credit\":0},
         {\"account_id\":\"00000000-0000-0000-0000-00000000a001\",\"debit\":0,\"credit\":99}]'::jsonb
     )->>'already_cancelled')")" "false"
expect_eq "the reversal restores the invoice to pending" \
  "$(q "select round(paid_amount,3)::text || '/' || status from public.invoices where invoice_number='INV-H'")" "0.000/pending"
expect_eq "the payment is cancelled, not deleted" \
  "$(q "select status from public.payments where receipt_number='REC-H-1'")" "cancelled"
expect_eq "a second reversal is a no-op" \
  "$(q "select (public.post_customer_receipt_reversal(
       '$REC_H_ID'::uuid,
       '00000000-0000-0000-0000-0000000000a1'::uuid,
       '{\"journal_number\":\"JV-H-REV2\"}'::jsonb,
       '[{\"account_id\":\"00000000-0000-0000-0000-00000000a002\",\"debit\":99,\"credit\":0},
         {\"account_id\":\"00000000-0000-0000-0000-00000000a001\",\"debit\":0,\"credit\":99}]'::jsonb
     )->>'already_cancelled')")" "true"

echo
echo "== activation 013-015 harness: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
