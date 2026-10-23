#!/usr/bin/env bash
# Execute migrations 004 + 008 against a real PostgreSQL and assert behaviour.
#
# Mirrors the project's established verification pattern (AGENTS.md Exec 03):
# build a schema that reflects the live project, apply the migration, and assert
# isolation semantics by execution rather than by parsing.
#
# Requires a local PostgreSQL 17 and a superuser (postgres) you can reach.
#   PGHOST=... PGUSER=postgres bash supabase/tests/008_harness/run.sh
#
# It creates and drops a throwaway database named `speed_harness`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

if [ "$(id -un)" = "root" ] || [ "$(id -u)" = "0" ]; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
elif command -v sudo >/dev/null && sudo -n -u postgres true 2>/dev/null; then
  PSQL=(sudo -n -u postgres psql -X -q -v ON_ERROR_STOP=1)
fi

echo "== recreating speed_harness =="
"${PSQL[@]}" -c "drop database if exists speed_harness" -c "create database speed_harness"

echo "== applying base schema (migration 002 semantics) =="
"${PSQL[@]}" -d speed_harness -f - < "$ROOT/supabase/tests/004_harness/base_schema.sql" >/dev/null

echo "== applying migration 004 =="
"${PSQL[@]}" -d speed_harness -f - < "$ROOT/supabase/migrations/004_global_super_admin.sql" >/dev/null

echo "== applying migration 008 =="
"${PSQL[@]}" -d speed_harness -f - < "$ROOT/supabase/migrations/008_user_role_hardening.sql" >/dev/null

echo "== re-applying migration 008 (idempotency) =="
"${PSQL[@]}" -d speed_harness -f - < "$ROOT/supabase/migrations/008_user_role_hardening.sql" >/dev/null

echo "== assertions =="
OUT="$("${PSQL[@]}" -d speed_harness -f - < "$HERE/assertions.sql" 2>&1)"
echo "$OUT" | grep -E "PASS|FAIL" || true

if echo "$OUT" | grep -q "FAIL"; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
