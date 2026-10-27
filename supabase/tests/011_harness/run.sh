#!/usr/bin/env bash
# Execute migration 011 (post_journal_entry) against a real PostgreSQL and assert
# its behaviour. Parsing SQL proves nothing; this runs it.
#
# 011 makes a journal header and its lines one transaction. The assertions below
# prove:
#   1. the function is created and is idempotent on re-apply,
#   2. a balanced journal is written as one header + N lines,
#   3. an unbalanced journal is REFUSED and writes nothing (no orphan header),
#   4. a journal with no lines is refused,
#   5. a line with both debit and credit, or neither, is refused,
#   6. a line with a negative amount is refused,
#   7. the refusal leaves the table exactly as it was (the key property: a
#      failed post cannot leave a header behind),
#   8. rollback drops the function and the already-written journal survives.
#
# Requires a reachable PostgreSQL. Set PGHOST/PGPORT/PGUSER as needed:
#   bash supabase/tests/011_harness/run.sh
#
# Creates and drops a throwaway database named `speed_011`.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DB=speed_011
MIG="$ROOT/supabase/migrations/011_atomic_journal_posting.sql"
ROLLBACK="$ROOT/supabase/migrations/011_atomic_journal_posting_rollback.sql"

# Prefer a local psql; fall back to the throwaway docker container below.
PSQL=(psql -X -q -v ON_ERROR_STOP=1)
USE_DOCKER=0
if ! command -v psql >/dev/null 2>&1; then
  USE_DOCKER=1
fi

pass=0; fail=0
ok()  { echo " PASS | $1"; pass=$((pass+1)); }
bad() { echo " FAIL | $1  -> $2"; fail=$((fail+1)); }
expect_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3]"; fi; }
expect_refused() { # desc sql (must raise)
  local desc="$1" sql="$2" out
  out=$(q "$sql")
  if echo "$out" | grep -qiE "post_journal_entry|violates|error|exception"; then ok "$desc"; else bad "$desc" "$out"; fi
}

if [ "$USE_DOCKER" = "1" ]; then
  echo "== psql absent; using a throwaway postgres:17 container =="
  sudo -n docker rm -f speed_pg_011 >/dev/null 2>&1
  sudo -n docker run -d --name speed_pg_011 -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=postgres \
    -p 55432:5432 postgres:17-alpine >/dev/null
  for i in $(seq 1 40); do
    if sudo -n docker exec speed_pg_011 pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done
  PSQL=(sudo -n docker exec -i speed_pg_011 psql -X -q -v ON_ERROR_STOP=1 -U postgres)
fi
q() { "${PSQL[@]}" -d "$DB" -tAc "$1" </dev/null 2>&1 | tr -d "\r"; }

echo "== recreating $DB =="
"${PSQL[@]}" -c "drop database if exists $DB" -c "create database $DB" </dev/null >/dev/null

echo "== minimal journal schema (mirrors the live shape) =="
"${PSQL[@]}" -d "$DB" </dev/null >/dev/null <<'SQL'
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  code text,
  tenant_id uuid
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
  created_at timestamptz default now()
);
create table public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid references public.journal_entries(id) on delete cascade,
  account_id uuid references public.accounts(id),
  description text,
  debit numeric default 0,
  credit numeric default 0,
  customer_id uuid,
  line_order int
);
insert into public.accounts (id, code) values
  ('00000000-0000-0000-0000-0000000000a1', '11001'),
  ('00000000-0000-0000-0000-0000000000a2', '41002');
SQL

echo "== apply 011 =="
if "${PSQL[@]}" -d "$DB" -f - < "$MIG" >/dev/null 2>&1; then ok "011 applies"; else bad "011 applies" "see error"; fi
if "${PSQL[@]}" -d "$DB" -f - < "$MIG" >/dev/null 2>&1; then ok "011 re-applies (idempotent)"; else bad "011 re-applies (idempotent)" "see error"; fi

expect_eq "post_journal_entry exists" \
  "$(q "select count(*) from pg_proc where proname='post_journal_entry'")" "1"

# --- 2. a balanced journal writes one header and its lines -------------------
expect_eq "balanced journal posts" \
  "$(q "select public.post_journal_entry(
      '{\"journal_number\":\"JV-1\",\"entry_date\":\"2026-01-01\",\"description\":\"sale\",\"entry_type\":\"sale_invoice\",\"reference_number\":\"INV-1\",\"status\":\"posted\"}'::jsonb,
      '[{\"account_id\":\"00000000-0000-0000-0000-0000000000a1\",\"debit\":99,\"credit\":0,\"description\":\"AR\",\"customer_id\":\"00000000-0000-0000-0000-0000000000c1\",\"line_order\":7},
        {\"account_id\":\"00000000-0000-0000-0000-0000000000a2\",\"debit\":0,\"credit\":99,\"description\":\"revenue\"}]'::jsonb
    ) is not null")" "t"

expect_eq "header count is 1" "$(q "select count(*) from public.journal_entries where journal_number='JV-1'")" "1"
expect_eq "line count is 2" "$(q "select count(*) from public.journal_lines")" "2"
expect_eq "header carries its totals" \
  "$(q "select (total_debit = 99 and total_credit = 99 and is_balanced)::text from public.journal_entries where journal_number='JV-1'")" \
  "true"
expect_eq "every line is attached to the header" \
  "$(q "select count(*) from public.journal_lines l join public.journal_entries e on e.id=l.journal_entry_id where e.journal_number='JV-1'")" "2"

# --- 2b. optional line columns are preserved when the schema has them ---------
expect_eq "a line keeps its customer_id and line_order" \
  "$(q "select (count(*) = 1)::text from public.journal_lines
          where customer_id = '00000000-0000-0000-0000-0000000000c1' and line_order = 7")" "true"

# --- 3-6. refusals ------------------------------------------------------------
expect_refused "an unbalanced journal is refused" \
  "select public.post_journal_entry('{\"journal_number\":\"JV-BAD\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-0000000000a1\",\"debit\":100,\"credit\":0},
       {\"account_id\":\"00000000-0000-0000-0000-0000000000a2\",\"debit\":0,\"credit\":90}]'::jsonb)"

expect_refused "a journal with no lines is refused" \
  "select public.post_journal_entry('{\"journal_number\":\"JV-EMPTY\"}'::jsonb, '[]'::jsonb)"

expect_refused "a line with both debit and credit is refused" \
  "select public.post_journal_entry('{\"journal_number\":\"JV-BOTH\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-0000000000a1\",\"debit\":10,\"credit\":10}]'::jsonb)"

expect_refused "a line with neither debit nor credit is refused" \
  "select public.post_journal_entry('{\"journal_number\":\"JV-NEITHER\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-0000000000a1\",\"debit\":0,\"credit\":0}]'::jsonb)"

expect_refused "a negative amount is refused" \
  "select public.post_journal_entry('{\"journal_number\":\"JV-NEG\"}'::jsonb,
     '[{\"account_id\":\"00000000-0000-0000-0000-0000000000a1\",\"debit\":-5,\"credit\":0}]'::jsonb)"

expect_refused "a line without an account is refused" \
  "select public.post_journal_entry('{\"journal_number\":\"JV-NOACC\"}'::jsonb,
     '[{\"debit\":5,\"credit\":0}]'::jsonb)"

# --- 7. THE key property: a refused post writes nothing ----------------------
expect_eq "no header was left behind by any refused post" \
  "$(q "select count(*) from public.journal_entries")" "1"
expect_eq "no line was left behind by any refused post" \
  "$(q "select count(*) from public.journal_lines")" "2"
expect_eq "no orphan header exists (every header has lines)" \
  "$(q "select count(*) from public.journal_entries e where not exists (select 1 from public.journal_lines l where l.journal_entry_id=e.id)")" "0"

# --- 7b. tenant persistence when the column exists (Exec 64) -----------------
# The chart became per-company in 014, so a journal must record WHICH company it
# belongs to; otherwise every company's ledger is the single-tenant ledger.
q "alter table public.journal_entries add column tenant_id uuid;
   alter table public.journal_lines add column tenant_id uuid;" >/dev/null 2>&1
# Re-apply so the function picks up the newly-added columns.
"${PSQL[@]}" -d "$DB" -f - < "$MIG" >/dev/null 2>&1
expect_eq "a journal posted with a tenant posts" \
  "$(q "select public.post_journal_entry(
      '{\"journal_number\":\"JV-T1\",\"entry_date\":\"2026-01-02\",\"description\":\"tenant sale\",\"tenant_id\":\"00000000-0000-0000-0000-0000000000b1\"}'::jsonb,
      '[{\"account_id\":\"00000000-0000-0000-0000-0000000000a1\",\"debit\":50,\"credit\":0,\"tenant_id\":\"00000000-0000-0000-0000-0000000000b1\"},
        {\"account_id\":\"00000000-0000-0000-0000-0000000000a2\",\"debit\":0,\"credit\":50}]'::jsonb
    ) is not null")" "t"
expect_eq "the header carries its tenant" \
  "$(q "select tenant_id::text from public.journal_entries where journal_number='JV-T1'")" \
  "00000000-0000-0000-0000-0000000000b1"
expect_eq "the lines carry the same tenant" \
  "$(q "select count(*) from public.journal_lines l join public.journal_entries e on e.id=l.journal_entry_id
          where e.journal_number='JV-T1' and l.tenant_id = '00000000-0000-0000-0000-0000000000b1'")" "2"
expect_eq "a journal posted WITHOUT a tenant stays tenant-less" \
  "$(q "select public.post_journal_entry(
      '{\"journal_number\":\"JV-T0\",\"entry_date\":\"2026-01-02\"}'::jsonb,
      '[{\"account_id\":\"00000000-0000-0000-0000-0000000000a1\",\"debit\":1,\"credit\":0},
        {\"account_id\":\"00000000-0000-0000-0000-0000000000a2\",\"debit\":0,\"credit\":1}]'::jsonb
    ) is not null")" "t"
expect_eq "that header has no tenant" \
  "$(q "select coalesce(tenant_id::text,'NULL') from public.journal_entries where journal_number='JV-T0'")" "NULL"

# --- 8. rollback --------------------------------------------------------------
echo "== rollback =="
if "${PSQL[@]}" -d "$DB" -f - < "$ROLLBACK" >/dev/null 2>&1; then ok "rollback applies"; else bad "rollback applies" "see error"; fi
expect_eq "function is gone after rollback" \
  "$(q "select count(*) from pg_proc where proname='post_journal_entry'")" "0"
expect_eq "the already-posted journal survives the rollback" \
  "$(q "select count(*) from public.journal_entries where journal_number='JV-1'")" "1"

# --- no-op on a schema without the journal tables -----------------------------
echo "== no-op on a schema without journal tables =="
q "drop table public.journal_lines; drop table public.journal_entries;" >/dev/null 2>&1
if "${PSQL[@]}" -d "$DB" -f - < "$MIG" >/dev/null 2>&1; then
  ok "011 is a clean no-op without the journal tables"
else
  bad "011 is a clean no-op without the journal tables" "see error"
fi
expect_eq "no function is created on that schema" \
  "$(q "select count(*) from pg_proc where proname='post_journal_entry'")" "0"

echo
echo "== 011 harness: $pass passed, $fail failed =="
if [ "$USE_DOCKER" = "1" ]; then
  "${PSQL[@]}" -c "drop database if exists $DB" </dev/null >/dev/null 2>&1
  sudo -n docker rm -f speed_pg_011 >/dev/null 2>&1
fi
[ "$fail" = "0" ]
