#!/usr/bin/env node
/**
 * Local Supabase-compatible stub backend (DEVELOPMENT / VERIFICATION ONLY).
 *
 * Purpose: run the real Next.js application in a browser without touching the
 * production Supabase project, so UI behaviour (including the access boundary
 * and the Super Admin console) can be observed and screenshotted.
 *
 * It implements the small slice of the Supabase surface the app uses:
 *   - GoTrue:  POST /auth/v1/token?grant_type=password, GET /auth/v1/user,
 *              POST /auth/v1/logout
 *   - PostgREST: GET/POST/PATCH/DELETE /rest/v1/<table> with the `select`,
 *              `eq`/`is`/`in` filters, `limit`, `order` and `offset` params,
 *              plus POST /rest/v1/rpc/<fn>
 *
 * It is an in-memory store seeded with a small, obviously-fake dataset. It is
 * never part of a production build and is not imported by application code.
 *
 * Usage: node scripts/dev/stub-supabase.mjs [port]
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.argv[2] ?? 54321);
const REF = "stubprojectref";

// --- seed data -------------------------------------------------------------
const TENANT_SPEED = "11111111-1111-1111-1111-111111111111";
const TENANT_GULF = "22222222-2222-2222-2222-222222222222";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000a001";
const ADMIN_SPEED_ID = "00000000-0000-0000-0000-00000000a002";
const STAFF_SPEED_ID = "00000000-0000-0000-0000-00000000a003";
const CLIENT_ID = "00000000-0000-0000-0000-00000000a004";

const now = new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const db = {
  tenants: [
    { id: TENANT_SPEED, name: "SPEED Car Rental", name_en: "SPEED Car Rental", created_at: daysAgo(120) },
    { id: TENANT_GULF, name: "Gulf Motors", name_en: "Gulf Motors", created_at: daysAgo(45) },
  ],
  users: [
    { id: SUPER_ADMIN_ID, email: "admin@system.local", full_name: "Platform Operator", role: "super_admin", tenant_id: null, customer_id: null, is_active: true, created_at: daysAgo(120) },
    { id: ADMIN_SPEED_ID, email: "speedadmin@speed.local", full_name: "SPEED Administrator", role: "admin", tenant_id: TENANT_SPEED, customer_id: null, is_active: true, created_at: daysAgo(120) },
    { id: STAFF_SPEED_ID, email: "staff@speed.local", full_name: "SPEED Staff", role: "staff", tenant_id: TENANT_SPEED, customer_id: null, is_active: true, created_at: daysAgo(90) },
    { id: CLIENT_ID, email: "customer@example.com", full_name: "Rental Customer", role: "client", tenant_id: null, customer_id: "c0000000-0000-0000-0000-00000000c001", is_active: true, created_at: daysAgo(20) },
  ],
  branches: [
    { id: "b0000000-0000-0000-0000-00000000b001", tenant_id: TENANT_SPEED, name: "Manama" },
    { id: "b0000000-0000-0000-0000-00000000b002", tenant_id: TENANT_SPEED, name: "Muharraq" },
    { id: "b0000000-0000-0000-0000-00000000b003", tenant_id: TENANT_GULF, name: "Riffa" },
  ],
  activity_logs: [
    { id: randomUUID(), action: "login", entity: "users", entity_id: ADMIN_SPEED_ID, user_email: "speedadmin@speed.local", tenant_id: TENANT_SPEED, created_at: daysAgo(1), metadata: {} },
    { id: randomUUID(), action: "create", entity: "invoices", entity_id: "INV-2026-0007", user_email: "speedadmin@speed.local", tenant_id: TENANT_SPEED, created_at: daysAgo(2), metadata: { total: 115 } },
    { id: randomUUID(), action: "signup", entity: "tenants", entity_id: TENANT_GULF, user_email: "owner@gulfmotors.example", tenant_id: TENANT_GULF, created_at: daysAgo(45), metadata: {} },
  ],
  settings: [
    { id: randomUUID(), tenant_id: TENANT_SPEED, key: "company_profile", value: { name: "SPEED Car Rental", phone: "+973 1700 0000" } },
    { id: randomUUID(), tenant_id: TENANT_SPEED, key: "tenant_plan", value: "free" },
    { id: randomUUID(), tenant_id: TENANT_GULF, key: "tenant_plan", value: "free" },
  ],
  cars: [
    { id: "ca000000-0000-0000-0000-00000000c001", tenant_id: TENANT_SPEED, name: "Toyota Camry 2025", category: "rental", daily_rate: 25, is_available: true },
    { id: "ca000000-0000-0000-0000-00000000c002", tenant_id: TENANT_SPEED, name: "Nissan Patrol 2024", category: "rental", daily_rate: 60, is_available: true },
  ],
  customers: [
    { id: "c0000000-0000-0000-0000-00000000c001", tenant_id: TENANT_SPEED, name: "Rental Customer", email: "customer@example.com", phone: "+973 3600 0000" },
  ],
  invoices: [],
  payments: [],
  accounts: [
    { id: "ac000000-0000-0000-0000-00000000a001", tenant_id: null, code: "11001", name: "Cash", account_type: "asset" },
    { id: "ac000000-0000-0000-0000-00000000a002", tenant_id: null, code: "41002", name: "Sales Revenue", account_type: "revenue" },
  ],
};

/** Password accepted for every seeded identity (verification stub only). */
const PASSWORD = "Verify!2026";

const sessions = new Map(); // access_token -> user id

// --- helpers ---------------------------------------------------------------
function json(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "content-range",
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const bearer = (req) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
const userFor = (req) => {
  const token = bearer(req);
  const id = sessions.get(token);
  return id ? db.users.find((u) => u.id === id) ?? null : null;
};

/** Minimal PostgREST filter parser: `col=eq.v`, `col=is.null`, `col=in.(a,b)`. */
function matches(row, params) {
  for (const [key, raw] of params.entries()) {
    if (["select", "limit", "offset", "order", "on_conflict"].includes(key)) continue;
    const [op, ...rest] = String(raw).split(".");
    const value = rest.join(".");
    const actual = row[key];
    if (op === "eq" && String(actual) !== value) return false;
    if (op === "is") {
      if (value === "null" && actual != null) return false;
      if (value === "true" && actual !== true) return false;
      if (value === "false" && actual !== false) return false;
    }
    if (op === "in") {
      const list = value.replace(/^\(|\)$/g, "").split(",");
      if (!list.includes(String(actual))) return false;
    }
    if (op === "neq" && String(actual) === value) return false;
  }
  return true;
}

function project(row, select) {
  if (!select || select === "*") return row;
  const cols = select.split(",").map((c) => c.trim().split(":").pop());
  const out = {};
  for (const c of cols) if (c in row) out[c] = row[c];
  return out;
}

// --- request handling ------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const { pathname } = url;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "*",
    });
    return res.end();
  }

  // ---- GoTrue ----
  if (pathname === "/auth/v1/token") {
    const body = await readBody(req);
    const user = db.users.find((u) => u.email === String(body.email ?? "").toLowerCase());
    if (!user || body.password !== PASSWORD) {
      return json(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
    }
    const token = randomUUID();
    sessions.set(token, user.id);
    return json(res, 200, {
      access_token: token,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: randomUUID(),
      user: { id: user.id, aud: "authenticated", role: "authenticated", email: user.email },
    });
  }

  if (pathname === "/auth/v1/user") {
    const user = userFor(req);
    if (!user) return json(res, 401, { message: "invalid claim: missing sub claim" });
    return json(res, 200, {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      created_at: user.created_at,
    });
  }

  if (pathname === "/auth/v1/logout") {
    sessions.delete(bearer(req));
    return json(res, 204, undefined);
  }

  // ---- PostgREST RPC ----
  if (pathname.startsWith("/rest/v1/rpc/")) {
    const fn = pathname.slice("/rest/v1/rpc/".length);
    const body = await readBody(req);
    if (fn === "generate_document_number") {
      return json(res, 200, `INV-2026-${String(1000 + (db.invoices.length + 1))}`);
    }
    return json(res, 200, null, { "content-range": "*/0" });
  }

  // ---- PostgREST tables ----
  if (pathname.startsWith("/rest/v1/")) {
    const table = pathname.slice("/rest/v1/".length).split("/")[0];
    const rows = db[table];
    if (!rows) return json(res, 404, { message: `relation "${table}" does not exist` });
    const select = url.searchParams.get("select");

    if (req.method === "GET" || req.method === "HEAD") {
      let out = rows.filter((r) => matches(r, url.searchParams));
      const order = url.searchParams.get("order");
      if (order) {
        const [col, dir] = order.split(".");
        out = [...out].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (dir === "desc" ? -1 : 1));
      }
      const limit = Number(url.searchParams.get("limit") ?? 0);
      if (limit > 0) out = out.slice(0, limit);
      const projected = out.map((r) => project(r, select));
      return json(res, 200, projected, {
        "content-range": projected.length ? `0-${projected.length - 1}/${projected.length}` : "*/0",
      });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const list = Array.isArray(body) ? body : [body];
      const inserted = list.map((r) => ({ id: r.id ?? randomUUID(), created_at: now, ...r }));
      rows.push(...inserted);
      return json(res, 201, inserted.map((r) => project(r, select)), {
        "content-range": `0-${inserted.length - 1}/${inserted.length}`,
      });
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      const hit = rows.filter((r) => matches(r, url.searchParams));
      hit.forEach((r) => Object.assign(r, body));
      return json(res, 200, hit.map((r) => project(r, select)), { "content-range": `0-${hit.length - 1}/${hit.length}` });
    }

    if (req.method === "DELETE") {
      const hit = rows.filter((r) => matches(r, url.searchParams));
      db[table] = rows.filter((r) => !hit.includes(r));
      return json(res, 204, undefined);
    }
  }

  return json(res, 404, { message: "not found" });
}

createServer((req, res) => {
  handle(req, res).catch((err) => json(res, 500, { message: String(err) }));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`stub supabase listening on http://127.0.0.1:${PORT}`);
  console.log(`  project ref (storage key): ${REF}`);
  console.log(`  identities (password ${PASSWORD}):`);
  for (const u of db.users) console.log(`    ${u.email.padEnd(28)} role=${u.role}`);
});
