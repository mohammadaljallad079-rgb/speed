#!/usr/bin/env node
/**
 * Verify the LIVE database schema against what the migrations require, WITHOUT a
 * direct Postgres connection.
 *
 * WHY
 * ---
 * DDL cannot be executed from this environment (the pooler credentials are
 * rejected and the direct host is IPv6-only), so a migration's requirements used
 * to be assumed rather than checked. But PostgREST publishes its own OpenAPI
 * description at `/rest/v1/`, and that document lists every exposed table and
 * every column with its type. Reading it answers "does the live table actually
 * have the column this migration needs?" - the exact question that decides
 * whether an import gate, a tenant column or a booking guard is real or inert.
 *
 * This is READ-ONLY: two GETs, no writes, no DDL, no `set role`.
 *
 * USAGE
 *   node scripts/verify-live-schema.mjs            # uses .env.local
 *   node scripts/verify-live-schema.mjs --json     # machine-readable
 *
 * EXIT CODES
 *   0  every required column is present
 *   1  a required column is missing (the migration would not do what it claims)
 *   2  the live schema could NOT be read (no credentials / unreachable), so
 *      nothing is claimed either way. This is deliberately NOT success: an
 *      unverified schema must never be reported as verified.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// --- What each migration needs to be effective -------------------------------
// A column listed here is one the SQL reads or writes; if it is absent the
// migration is a no-op (or fails), so the check is worth running before applying.
const REQUIREMENTS = [
  {
    id: "017",
    file: "supabase/migrations/017_booking_overlap_guard.sql",
    why: "The double-booking guard needs a car and a booking window.",
    table: "rental_contracts",
    // Most specific FIRST: a table with the time columns satisfies the
    // date-only alternative too, and the more precise guard is the one 017
    // actually installs.
    anyOf: [
      { label: "timestamptz window", columns: ["car_id", "start_at", "end_at"] },
      { label: "date + time window", columns: ["car_id", "start_date", "end_date", "start_time", "end_time"] },
      { label: "date-only window", columns: ["car_id", "start_date", "end_date"] },
    ],
    optional: ["tenant_id", "status"],
  },
  {
    id: "016",
    file: "supabase/migrations/016_customer_row_isolation.sql",
    why: "A customer row is linked to its identity through users.customer_id.",
    table: "users",
    anyOf: [{ label: "customer link", columns: ["customer_id"] }],
  },
  {
    id: "013",
    file: "supabase/migrations/013_booking_invoice_idempotency.sql",
    why: "One invoice per rental contract.",
    table: "invoices",
    anyOf: [{ label: "contract link", columns: ["rental_contract_id"] }],
  },
];

// --- env ---------------------------------------------------------------------
function loadEnv() {
  const out = {};
  for (const f of [".env.local", ".env"]) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

function looksPlaceholder(v) {
  if (!v) return true;
  const l = v.toLowerCase();
  return ["your-", "placeholder", "changeme", "example", "xxxx"].some((s) => l.includes(s));
}

async function fetchOpenApi(base, key) {
  const res = await fetch(`${base.replace(/\/$/, "")}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`PostgREST returned HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** table -> Set(column names), from the OpenAPI `definitions`. */
function tableColumns(spec) {
  const defs = spec.definitions ?? spec.components?.schemas ?? {};
  const out = new Map();
  for (const [name, def] of Object.entries(defs)) {
    const props = def.properties ?? {};
    out.set(name, new Set(Object.keys(props)));
  }
  return out;
}

function checkRequirement(req, tables) {
  const cols = tables.get(req.table);
  if (!cols) {
    return { ...req, status: "table_missing", detail: `table public.${req.table} is not exposed` };
  }
  const satisfied = req.anyOf.find((alt) => alt.columns.every((c) => cols.has(c)));
  const missingOptional = (req.optional ?? []).filter((c) => !cols.has(c));
  if (!satisfied) {
    const tried = req.anyOf.map((a) => `${a.label} [${a.columns.join(", ")}]`).join(" OR ");
    const present = [...cols].filter((c) => /car_id|start|end|date|time|tenant|status/.test(c));
    return {
      ...req,
      status: "unsatisfied",
      detail: `none of: ${tried}. Present window-ish columns: ${present.join(", ") || "(none)"}`,
    };
  }
  return {
    ...req,
    status: "satisfied",
    precision: satisfied.label,
    missingOptional,
    detail: missingOptional.length
      ? `guard is effective, but optional ${missingOptional.join(", ")} absent (the tenant-less path is used)`
      : "guard is effective",
  };
}

async function main() {
  const json = process.argv.includes("--json");
  const env = loadEnv();
  const base = env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    (looksPlaceholder(env.SUPABASE_SERVICE_ROLE_KEY) ? null : env.SUPABASE_SERVICE_ROLE_KEY) ??
    (looksPlaceholder(env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ? null : env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (!base || !key) {
    const msg =
      "Live schema could NOT be read: no usable Supabase URL/key in .env.local " +
      "(the values present are placeholders). Nothing is verified or refuted.";
    if (json) console.log(JSON.stringify({ verified: false, reason: msg }, null, 2));
    else console.error(`NOT VERIFIED - ${msg}`);
    process.exit(2);
  }

  let spec;
  try {
    spec = await fetchOpenApi(base, key);
  } catch (err) {
    const msg = `Live schema could NOT be read: ${err.message}`;
    if (json) console.log(JSON.stringify({ verified: false, reason: msg }, null, 2));
    else console.error(`NOT VERIFIED - ${msg}`);
    process.exit(2);
  }

  const tables = tableColumns(spec);
  const results = REQUIREMENTS.map((r) => checkRequirement(r, tables));

  if (json) {
    console.log(JSON.stringify({ verified: true, project: base, tables: tables.size, results }, null, 2));
  } else {
    console.log(`Live schema read: ${tables.size} tables exposed by ${base}`);
    for (const r of results) {
      const mark = r.status === "satisfied" ? "OK  " : "FAIL";
      console.log(` ${mark} | ${r.id} ${r.table}: ${r.detail}`);
    }
  }

  const bad = results.filter((r) => r.status !== "satisfied");
  process.exit(bad.length ? 1 : 0);
}

// Run only when invoked directly, so the pure helpers below can be imported by
// a test without performing a network call.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`NOT VERIFIED - unexpected error: ${err.message}`);
    process.exit(2);
  });
}

export { REQUIREMENTS, tableColumns, checkRequirement, loadEnv, looksPlaceholder };
