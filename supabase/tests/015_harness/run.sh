#!/usr/bin/env bash
# Execute migration 015 against a real PostgreSQL and assert its behaviour.
#
# 015 hardens `post_journal_entry` (a tenanted journal may only reference
# accounts its own company may use) and adds an ATOMIC customer receipt
# (`post_customer_receipt`) that writes the payment row, the journal and the
# invoice settlement in one transaction.
#
# Parsing the SQL proves none of that. This harness APPLIES it to a schema
# modelled on the live project and asserts the semantics directly, including the
# case that matters most: a refused receipt leaves NO payment row behind.
#
# Usage (local PostgreSQL 17):
#   PGHOST=127.0.0.1 PGPORT=55433 PGUSER=postgres PGPASSWORD=postgres \
#     bash supabase/tests/015_harness/run.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_015
MIG015="$ROOT/supabase/migrations/015_strict_accounting_integrity.sql"
ROLL015="$ROOT/supabase/migrations/015_strict_accounting_integrity_rollback.sql"

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
q() { "${PSQL[@]}" -d "$DB" -tAc "$1" </dev/null 2>&1 | tr -d "\r"; }
apply() { "${PSQL[@]}" -d "$DB" -f - < "$1" >/dev/null 2>&1; }

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> $2"; fail=$((fail+1)); }
expect_eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
expect_refused() { # desc sql  -- the statement must raise
  local desc="$1" sql="$2" out
  out=$(q "$sql")
  if echo "$out" | grep -qiE "not usable by this company|violates|error|exception|does not belong"; then
    ok "$desc"
  else
    bad "$desc" "$out"
  fi
}

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB" </dev/null >/dev/null

echo "== schema modelled on the live project (two tenants + a shared chart) =="
"${PSQL[@]}" -d "$DB" </dev/null >/dev/null <<'SQL'
create extension if not exists pgcrypto;
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  code text,
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
  description text,
  debit numeric default 0,
  credit numeric default 0,
  line_order int,
  tenant_id uuid
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  receipt_number text,
  customer_id uuid,
  invoice_id uuid,
  rental_contract_id uuid,
  amount numeric,
  payment_method text,
  payment_date date,
  payment_type text,
  notes text,
  status text,
  tenant_id uuid
);
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text,
  customer_id uuid,
  total_amount numeric default 0,
  paid_amount numeric default 0,
  status text,
  tenant_id uuid
);

-- Tenant A owns 11001/12001. Tenant B owns its own 11001/12001.
insert into public.accounts (id, code, tenant_id, is_active, is_postable) values
  ('00000000-0000-0000-0000-00000000a001', '11001', '00000000-0000-0000-0000-0000000000a1', true, true),
  ('00000000-0000-0000-0000-00000000a002', '12001', '00000000-0000-0000-0000-0000000000a1', true, true),
  ('00000000-0000-0000-0000-00000000a003', '41002', '00000000-0000-0000-0000-0000000000a1', true, true),
  ('00000000-0000-0000-0000-00000000b001', '11001', '00000000-0000-0000-0000-0000000000b1', true, true),
  ('00000000-0000-0000-0000-00000000b002', '12001', '00000000-0000-0000-0000-0000000000b1', true, true),
  -- shared (NULL-tenant) chart, usable by anyone
  ('00000000-0000-0000-0000-0000000000f1', '41002', null, true, true),
  -- an INACTIVE and a NON-POSTABLE account, to prove the new refusals
  ('00000000-0000-0000-0000-0000000000f2', '51001', null, false, true),
  ('00000000-0000-0000-0000-0000000000f3', '99999', null, true, false);

insert into public.invoices (id, invoice_number, customer_id, total_amount, paid_amount, status, tenant_id) values
  ('00000000-0000-0000-0000-0000000000e1', 'INV-A', '00000000-0000-0000-0000-0000000000c1', 99, 0, 'pending', '00000000-0000-0000-0000-0000000000a1');
SQL

echo "== apply 015 =="
if apply "$MIG015"; then ok "015 applies"; else bad "015 applies" "see error"; fi
if apply "$MIG015"; then ok "015 re-applies (idempotent)"; else bad "015 re-applies (idempotent)" "see error"; fi

expect_eq "post_journal_entry exists" \
  "$(q "select count(*) from pg_proc where proname='post_journal_entry'")" "1"
expect_eq "post_customer_receipt exists" \
  "$(q "select count(*) from pg_proc where proname='post_customer_receipt'")" "1"

# --- 1. the ownership rule: a tenanted journal cannot use a foreign account ---
expect_refused "a tenanted journal using ANOTHER company's account is refused" \
  "select public.post_journal_entry(
     '{\"journal_number\":\"JV-X\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-00000000b001\",\"debit\":10,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-0000000000f1\",\"debit\":0,\"credit\":10}]'::jsonb)"

expect_refused "a tenanted journal using an INACTIVE account is refused" \
  "select public.post_journal_entry(
     '{\"journal_number\":\"JV-INACT\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-0000000000f2\",\"debit\":10,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-0000000000f1\",\"debit\":0,\"credit\":10}]'::jsonb)"

expect_refused "a tenanted journal using a NON-POSTABLE account is refused" \
  "select public.post_journal_entry(
     '{\"journal_number\":\"JV-NONPOST\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-0000000000f3\",\"debit\":10,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-0000000000f1\",\"debit\":0,\"credit\":10}]'::jsonb)"

expect_refused "a tenanted journal using a NON-EXISTENT account is refused" \
  "select public.post_journal_entry(
     '{\"journal_number\":\"JV-GHOST\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-0000000000dead\",\"debit\":10,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-0000000000f1\",\"debit\":0,\"credit\":10}]'::jsonb)"

expect_eq "no refused journal left a header behind" \
  "$(q "select count(*) from public.journal_entries")" "0"

# --- 2. the rule does NOT break the legitimate cases -------------------------
expect_eq "a tenanted journal on its OWN account posts" \
  "$(q "select public.post_journal_entry(
     '{\"journal_number\":\"JV-OWN\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-00000000a001\",\"debit\":10,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-00000000a003\",\"debit\":0,\"credit\":10}]'::jsonb
   ) is not null")" "t"

expect_refused "a tenanted journal on the SHARED chart is refused" \
  "$(q "select public.post_journal_entry(
     '{\"journal_number\":\"JV-SHARED\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-0000000000f1\",\"debit\":5,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-00000000a002\",\"debit\":0,\"credit\":5}]'::jsonb
   ) is not null")" "t"

# Historical NULL-tenant journals remain stored, but new ones are refused.
expect_refused "a NEW NULL-tenant journal is refused" \
  "select public.post_journal_entry(
     '{\"journal_number\":\"JV-LEGACY\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-0000000000f1\",\"debit\":1,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-0000000000f2\",\"debit\":0,\"credit\":1}]'::jsonb
   )"

# Reject a line that claims to belong to another company.
expect_refused "a journal with a FOREIGN line tenant is refused" \
  "select public.post_journal_entry(
     '{\"journal_number\":\"JV-LINE-MISMATCH\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-00000000a001\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000b1\",\"debit\":10,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-00000000a003\",\"debit\":0,\"credit\":10}]'::jsonb)"

expect_eq "a mismatched line left NO journal header" \
  "$(q "select count(*) from public.journal_entries where journal_number='JV-LINE-MISMATCH'")" "0"

# --- 3. THE key property: an atomic receipt -------------------------------
expect_eq "a receipt writes payment + journal + settlement in one call" \
  "$(q "select (public.post_customer_receipt(
     '{\"receipt_number\":\"REC-A-1\",\"customer_id\":\"00000000-0000-0000-0000-0000000000c1\",\"invoice_id\":\"00000000-0000-0000-0000-0000000000e1\",\"amount\":99,\"payment_method\":\"cash\",\"payment_date\":\"2026-01-05\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '{\"journal_number\":\"JV-REC-1\",\"entry_date\":\"2026-01-05\",\"reference_number\":\"REC-A-1\",\"entry_type\":\"customer_receipt\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-00000000a001\",\"debit\":99,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-00000000a002\",\"debit\":0,\"credit\":99}]'::jsonb
   )->>'journal_id') is not null")" "t"

expect_eq "the payment row exists exactly once" \
  "$(q "select count(*) from public.payments where receipt_number='REC-A-1'")" "1"
expect_eq "the receipt journal exists" \
  "$(q "select count(*) from public.journal_entries where reference_number='REC-A-1'")" "1"
expect_eq "the receipt journal has its two lines" \
  "$(q "select count(*) from public.journal_lines l join public.journal_entries e on e.id=l.journal_entry_id where e.reference_number='REC-A-1'")" "2"
expect_eq "the invoice is settled to paid" \
  "$(q "select round(paid_amount,3)::text || '/' || status from public.invoices where invoice_number='INV-A'")" "99.000/paid"

# --- 4. a REFUSED receipt writes NOTHING (the release-blocking property) -----
expect_refused "a receipt whose journal uses a foreign account is refused" \
  "select public.post_customer_receipt(
     '{\"receipt_number\":\"REC-A-BAD\",\"customer_id\":\"00000000-0000-0000-0000-0000000000c1\",\"invoice_id\":\"00000000-0000-0000-0000-0000000000e1\",\"amount\":5,\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '{\"journal_number\":\"JV-REC-BAD\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-00000000b001\",\"debit\":5,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-00000000b002\",\"debit\":0,\"credit\":5}]'::jsonb)"

expect_eq "the refused receipt left NO payment row" \
  "$(q "select count(*) from public.payments where receipt_number='REC-A-BAD'")" "0"
expect_eq "the refused receipt left NO journal" \
  "$(q "select count(*) from public.journal_entries where reference_number='REC-A-BAD'")" "0"
expect_eq "the refused receipt did NOT settle the invoice" \
  "$(q "select round(paid_amount,3)::text from public.invoices where invoice_number='INV-A'")" "99.000"

# --- 5. receipt uniqueness ---------------------------------------------------
expect_refused "a duplicate receipt_number is refused by the unique index" \
  "insert into public.payments (receipt_number, amount, tenant_id) values ('REC-A-1', 1, '00000000-0000-0000-0000-0000000000a1')"

expect_eq "another company may reuse the same receipt number" \
  "$(q "insert into public.payments (receipt_number, amount, tenant_id) values ('REC-A-1', 1, '00000000-0000-0000-0000-0000000000b1') returning 'ok'")" "ok"

# --- 5b. the atomic REVERSAL ------------------------------------------------
# The receipt written in section 3 (REC-A-1, 99, invoice INV-A) is reversed. The
# mirror must restore the receivable, mark the payment cancelled and write
# exactly one mirror journal - and a second attempt must be a no-op.
REC_PAY_ID="$(q "select id from public.payments where receipt_number='REC-A-1' and tenant_id='00000000-0000-0000-0000-0000000000a1'")"

expect_eq "the reversal mirrors the receipt in one call" \
  "$(q "select (public.post_customer_receipt_reversal(
     '$REC_PAY_ID'::uuid,
     '00000000-0000-0000-0000-0000000000a1'::uuid,
     '{\"journal_number\":\"JV-REV-1\",\"entry_date\":\"2026-01-09\",\"reference_number\":\"REC-A-1\",\"entry_type\":\"customer_receipt_reversal\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-00000000a002\",\"debit\":99,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-00000000a001\",\"debit\":0,\"credit\":99}]'::jsonb
   )->>'already_cancelled')")" "false"

expect_eq "the reversal journal exists exactly once" \
  "$(q "select count(*) from public.journal_entries where reference_number='REC-A-1' and entry_type='customer_receipt_reversal'")" "1"
expect_eq "the reversal restores the invoice to pending" \
  "$(q "select round(paid_amount,3)::text || '/' || status from public.invoices where invoice_number='INV-A'")" "0.000/pending"
expect_eq "the payment is marked cancelled" \
  "$(q "select status from public.payments where receipt_number='REC-A-1' and tenant_id='00000000-0000-0000-0000-0000000000a1'")" "cancelled"

# Idempotency: reversing again writes nothing and says so.
expect_eq "a second reversal is a no-op" \
  "$(q "select (public.post_customer_receipt_reversal(
     '$REC_PAY_ID'::uuid,
     '00000000-0000-0000-0000-0000000000a1'::uuid,
     '{\"journal_number\":\"JV-REV-2\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-00000000a002\",\"debit\":99,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-00000000a001\",\"debit\":0,\"credit\":99}]'::jsonb
   )->>'already_cancelled')")" "true"
expect_eq "the second reversal wrote no second journal" \
  "$(q "select count(*) from public.journal_entries where reference_number='REC-A-1' and entry_type='customer_receipt_reversal'")" "1"
expect_eq "the second reversal did not un-settle the invoice twice" \
  "$(q "select round(paid_amount,3)::text from public.invoices where invoice_number='INV-A'")" "0.000"

# A reversal whose mirror journal is refused must change nothing.
expect_eq "re-settle the invoice for the refusal case" \
  "$(q "select (public.post_customer_receipt(
     '{\"receipt_number\":\"REC-A-2\",\"customer_id\":\"00000000-0000-0000-0000-0000000000c1\",\"invoice_id\":\"00000000-0000-0000-0000-0000000000e1\",\"amount\":99,\"payment_method\":\"cash\",\"payment_date\":\"2026-01-06\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '{\"journal_number\":\"JV-REC-2\",\"entry_date\":\"2026-01-06\",\"reference_number\":\"REC-A-2\",\"entry_type\":\"customer_receipt\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-00000000a001\",\"debit\":99,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-00000000a002\",\"debit\":0,\"credit\":99}]'::jsonb
   )->>'journal_id') is not null")" "t"
REC2_PAY_ID="$(q "select id from public.payments where receipt_number='REC-A-2' and tenant_id='00000000-0000-0000-0000-0000000000a1'")"
expect_refused "a reversal whose mirror uses a foreign account is refused" \
  "select public.post_customer_receipt_reversal(
     '$REC2_PAY_ID'::uuid,
     '00000000-0000-0000-0000-0000000000a1'::uuid,
     '{\"journal_number\":\"JV-REV-BAD\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000a1\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-00000000b001\",\"debit\":99,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-00000000b002\",\"debit\":0,\"credit\":99}]'::jsonb)"
expect_eq "the refused reversal left the receipt cancelled=false" \
  "$(q "select status from public.payments where receipt_number='REC-A-2' and tenant_id='00000000-0000-0000-0000-0000000000a1'")" "completed"
expect_eq "the refused reversal left the invoice settled" \
  "$(q "select round(paid_amount,3)::text || '/' || status from public.invoices where invoice_number='INV-A'")" "99.000/paid"

# A reversal cannot touch another company's receipt.
expect_refused "a reversal scoped to the wrong company finds nothing" \
  "select public.post_customer_receipt_reversal(
     '$REC2_PAY_ID'::uuid,
     '00000000-0000-0000-0000-0000000000b1'::uuid,
     '{\"journal_number\":\"JV-REV-X\"}'::jsonb, '[]'::jsonb)"

# --- 6. rollback --------------------------------------------------------------
echo "== rollback =="
if apply "$ROLL015"; then ok "rollback applies"; else bad "rollback applies" "see error"; fi
expect_eq "post_customer_receipt is gone" \
  "$(q "select count(*) from pg_proc where proname='post_customer_receipt'")" "0"
expect_eq "post_customer_receipt_reversal is gone" \
  "$(q "select count(*) from pg_proc where proname='post_customer_receipt_reversal'")" "0"
expect_eq "the receipt indexes are gone" \
  "$(q "select count(*) from pg_indexes where indexname in ('payments_tenant_receipt_uidx','payments_null_tenant_receipt_uidx')")" "0"
expect_eq "every posted journal survives the rollback" \
  "$(q "select count(*) >= 4 from public.journal_entries")" "t"
expect_eq "the settled invoice survives the rollback" \
  "$(q "select round(paid_amount,3)::text from public.invoices where invoice_number='INV-A'")" "99.000"

echo
echo "== 015 harness: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
