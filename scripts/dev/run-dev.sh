#!/usr/bin/env bash
# Run the app against the local Supabase stub, for screenshots and manual QA.
#
# Nothing here touches a real Supabase project: the stub serves a fixed dataset
# and issues well-formed (unsigned) JWTs for its own `localdevref`, so the real
# pages, middleware and route handlers run unchanged against it.
#
# Usage: bash scripts/dev/run-dev.sh [port]
set -u

PORT="${1:-3099}"
STUB_PORT=54321
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cd "$ROOT"

# A stale .next cache makes Next serve chunk URLs that no longer exist, which
# shows up as 404s on /_next/static/chunks/*.js and a page that never hydrates.
rm -rf .next

node scripts/dev/local-supabase-stub.mjs "$STUB_PORT" > /tmp/local-supabase-stub.log 2>&1 &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null' EXIT

export NEXT_PUBLIC_SUPABASE_URL="http://localhost:${STUB_PORT}"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="local-anon-key"
export SUPABASE_SERVICE_ROLE_KEY="local-service-key"

echo "[run-dev] stub on :${STUB_PORT}, app on :${PORT}"
npx next dev -p "$PORT"
