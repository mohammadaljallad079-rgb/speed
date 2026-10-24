#!/usr/bin/env node
/**
 * Local Supabase stand-in for UI screenshots and manual QA.
 *
 * SPEED ERP's pages are browser-direct Supabase clients, so rendering a real
 * screen (rather than a mock) needs an auth + REST endpoint the browser can talk
 * to. This process speaks just enough of the two protocols the app uses:
 *
 *   POST /auth/v1/token?grant_type=password  -> an operator session
 *   GET  /auth/v1/user                       -> the session's user
 *   GET  /rest/v1/<table>                    -> seeded rows (service-role data)
 *
 * It is a DEVELOPMENT/QA tool. It holds no real credentials, serves only the
 * fixture rows below, and is never imported by application code. Point the app
 * at it with NEXT_PUBLIC_SUPABASE_URL=http://localhost:<port> and the same value
 * for SUPABASE_INTERNAL_URL so server-side (service-role) reads hit the fixture
 * too, then screenshot the pages that render from it.
 *
 * Run: node scripts/dev/local-supabase-stub.mjs [port]
 */

import http from "node:http";

const PORT = Number(process.argv[2] ?? 54321);

/** A tenant-less global operator, so `/api/me` resolves `isSuperAdmin: true`. */
const SUPER_ADMIN = {
  id: "00000000-0000-0000-0000-0000000000aa",
  email: "admin@system.local",
  password: "local-dev-password",
  role: "super_admin",
  full_name: "Global Administrator",
  tenant_id: null,
};

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const TENANTS = [
  { id: TENANT_A, name: "SPEED Rentals", name_en: "SPEED Rentals", created_at: "2026-08-01T08:00:00Z" },
  { id: TENANT_B, name: "Harbour Motors", name_en: "Harbour Motors", created_at: "2026-09-14T08:00:00Z" },
];

const USERS = [
  { id: SUPER_ADMIN.id, email: SUPER_ADMIN.email, full_name: SUPER_ADMIN.full_name, role: "super_admin", tenant_id: null, is_active: true, created_at: "2026-07-01T08:00:00Z", customer_id: null },
  { id: "a1", email: "speedadmin@speed.local", full_name: "SPEED Administrator", role: "admin", tenant_id: TENANT_A, is_active: true, created_at: "2026-08-02T08:00:00Z", customer_id: null },
  { id: "a2", email: "staff@speed.local", full_name: "Front Desk", role: "staff", tenant_id: TENANT_A, is_active: true, created_at: "2026-08-03T08:00:00Z", customer_id: null },
  { id: "a3", email: "old@speed.local", full_name: "Former Staff", role: "staff", tenant_id: TENANT_A, is_active: false, created_at: "2026-08-04T08:00:00Z", customer_id: null },
  { id: "b1", email: "admin@harbour.local", full_name: "Harbour Administrator", role: "admin", tenant_id: TENANT_B, is_active: true, created_at: "2026-09-15T08:00:00Z", customer_id: null },
  { id: "b2", email: "driver@harbour.local", full_name: "Harbour Driver", role: "staff", tenant_id: TENANT_B, is_active: true, created_at: "2026-09-16T08:00:00Z", customer_id: null },
];

const BRANCHES = [
  { id: "br1", tenant_id: TENANT_A, name: "Manama" },
  { id: "br2", tenant_id: TENANT_A, name: "Airport" },
  { id: "br3", tenant_id: TENANT_B, name: "Muharraq" },
];

const ACTIVITY = [
  { id: "e1", action: "create", entity: "invoices", entity_id: "i1", user_email: "speedadmin@speed.local", tenant_id: TENANT_A, created_at: "2026-10-23T10:15:00Z", metadata: {} },
  { id: "e2", action: "update", entity: "suppliers", entity_id: "s1", user_email: "admin@harbour.local", tenant_id: TENANT_B, created_at: "2026-10-23T09:40:00Z", metadata: {} },
  { id: "e3", action: "login", entity: "users", entity_id: "a1", user_email: "speedadmin@speed.local", tenant_id: TENANT_A, created_at: "2026-10-23T08:05:00Z", metadata: {} },
];

const TABLES = {
  tenants: TENANTS,
  users: USERS,
  branches: BRANCHES,
  activity_logs: ACTIVITY,
  profiles: [],
  settings: [],
  financial_years: [],
  ai_dev_requests: [],
  customers: [
    { id: "c1", full_name: "Ali Hassan", phone: "+97333001122", customer_type: "individual", status: "active", tenant_id: TENANT_A },
    { id: "c2", full_name: "Gulf Trading W.L.L.", phone: "+97317009900", customer_type: "company", status: "active", tenant_id: TENANT_A },
  ],
  suppliers: [
    { id: "s1", name: "Bahrain Auto Parts", phone: "+97317112233", email: "sales@bap.bh", tenant_id: TENANT_A },
    { id: "s2", name: "Gulf Lubricants", phone: "+97317114455", email: "info@gulflub.bh", tenant_id: TENANT_A },
  ],
  accounts: [
    { id: "ac1", code: "11001", name: "Cash", name_ar: "الصندوق", name_en: "Cash", type: "asset", level: 1, is_active: true, tenant_id: null, parent_code: null, balance: 0 },
    { id: "ac2", code: "11002", name: "Bank", name_ar: "البنك", name_en: "Bank", type: "asset", level: 1, is_active: true, tenant_id: null, parent_code: null, balance: 0 },
    { id: "ac3", code: "12001", name: "Accounts Receivable", name_ar: "ذمم مدينة", name_en: "Accounts Receivable", type: "asset", level: 1, is_active: true, tenant_id: null, parent_code: null, balance: 0 },
    { id: "ac4", code: "21001", name: "Accounts Payable", name_ar: "ذمم دائنة", name_en: "Accounts Payable", type: "liability", level: 1, is_active: true, tenant_id: null, parent_code: null, balance: 0 },
    { id: "ac5", code: "41002", name: "Sales Revenue", name_ar: "إيرادات المبيعات", name_en: "Sales Revenue", type: "revenue", level: 1, is_active: true, tenant_id: null, parent_code: null, balance: 0 },
  ],
  cars: [
    { id: "car1", make: "Toyota", model: "Corolla", year: 2024, plate_number: "12345", status: "available", category: "rental", tenant_id: TENANT_A },
  ],
};

/** Rows a table returns, honouring the simple `eq` filters the pages send. */
function selectRows(table, searchParams) {
  let rows = TABLES[table] ?? [];
  for (const [key, value] of searchParams.entries()) {
    if (["select", "order", "limit", "offset", "apikey"].includes(key)) continue;
    const raw = value.startsWith("eq.") ? value.slice(3) : value;
    if (raw === "null") rows = rows.filter((r) => r[key] == null);
    else rows = rows.filter((r) => String(r[key]) === raw);
  }
  const order = searchParams.get("order");
  if (order) {
    const [col, dir] = order.split(".");
    rows = [...rows].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (dir === "desc" ? -1 : 1));
  }
  const limit = Number(searchParams.get("limit") ?? 0);
  return limit > 0 ? rows.slice(0, limit) : rows;
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const ACCESS_TOKEN = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: SUPER_ADMIN.id, role: "service_role", exp: 2000000000 })}.localdevsignature`;

function session() {
  return {
    access_token: ACCESS_TOKEN,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "local-dev-refresh",
    user: {
      id: SUPER_ADMIN.id,
      aud: "authenticated",
      role: "authenticated",
      email: SUPER_ADMIN.email,
      email_confirmed_at: "2026-07-01T08:00:00Z",
      phone: "",
      confirmed_at: "2026-07-01T08:00:00Z",
      last_sign_in_at: new Date().toISOString(),
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { full_name: SUPER_ADMIN.full_name },
      identities: [],
      created_at: "2026-07-01T08:00:00Z",
      updated_at: new Date().toISOString(),
    },
  };
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "content-range",
    ...headers,
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") return send(res, 204, undefined);

  if (path === "/auth/v1/token") {
    return send(res, 200, session());
  }
  if (path === "/auth/v1/user") {
    return send(res, 200, session().user);
  }
  if (path === "/auth/v1/logout") {
    return send(res, 204, undefined);
  }
  if (path === "/auth/v1/settings") {
    return send(res, 200, { external: {}, disable_signup: false });
  }

  const rest = /^\/rest\/v1\/([A-Za-z_]+)$/.exec(path);
  if (rest) {
    const rows = selectRows(rest[1], url.searchParams);
    // `maybeSingle()`/`single()` ask for a bare object via the Accept header.
    const wantsObject = String(req.headers.accept ?? "").includes("pgrst.object");
    if (wantsObject) {
      return send(res, 200, rows[0] ?? null, { "content-range": rows.length ? `0-0/${rows.length}` : "*/0" });
    }
    return send(res, 200, rows, { "content-range": rows.length ? `0-${rows.length - 1}/${rows.length}` : "*/0" });
  }

  send(res, 404, { message: `stub: no route for ${req.method} ${path}` });
});

server.listen(PORT, () => {
  console.log(`[local-supabase-stub] listening on http://localhost:${PORT}`);
  console.log(`[local-supabase-stub] operator: ${SUPER_ADMIN.email} / ${SUPER_ADMIN.password}`);
});
