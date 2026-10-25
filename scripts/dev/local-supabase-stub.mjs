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
  { id: "aaaaaaaa-1111-1111-1111-111111111111", email: "speedadmin@speed.local", full_name: "SPEED Administrator", role: "admin", tenant_id: TENANT_A, is_active: true, created_at: "2026-08-02T08:00:00Z", customer_id: null },
  { id: "aaaaaaaa-2222-2222-2222-222222222222", email: "staff@speed.local", full_name: "Front Desk", role: "staff", tenant_id: TENANT_A, is_active: true, created_at: "2026-08-03T08:00:00Z", customer_id: null },
  { id: "aaaaaaaa-3333-3333-3333-333333333333", email: "old@speed.local", full_name: "Former Staff", role: "staff", tenant_id: TENANT_A, is_active: false, created_at: "2026-08-04T08:00:00Z", customer_id: null },
  { id: "bbbbbbbb-1111-1111-1111-111111111111", email: "admin@harbour.local", full_name: "Harbour Administrator", role: "admin", tenant_id: TENANT_B, is_active: true, created_at: "2026-09-15T08:00:00Z", customer_id: null },
  { id: "bbbbbbbb-2222-2222-2222-222222222222", email: "driver@harbour.local", full_name: "Harbour Driver", role: "staff", tenant_id: TENANT_B, is_active: true, created_at: "2026-09-16T08:00:00Z", customer_id: null },
];

const BRANCHES = [
  { id: "br1", tenant_id: TENANT_A, name: "Manama" },
  { id: "br2", tenant_id: TENANT_A, name: "Airport" },
  { id: "br3", tenant_id: TENANT_B, name: "Muharraq" },
];

const ACTIVITY = [
  { id: "e1", action: "create", entity: "invoices", entity_id: "i1", user_email: "speedadmin@speed.local", tenant_id: TENANT_A, created_at: "2026-10-23T10:15:00Z", metadata: {} },
  { id: "e2", action: "update", entity: "suppliers", entity_id: "s1", user_email: "admin@harbour.local", tenant_id: TENANT_B, created_at: "2026-10-23T09:40:00Z", metadata: {} },
  { id: "e3", action: "login", entity: "users", entity_id: "aaaaaaaa-1111-1111-1111-111111111111", user_email: "speedadmin@speed.local", tenant_id: TENANT_A, created_at: "2026-10-23T08:05:00Z", metadata: {} },
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
    { id: "ac6", code: "24000", name: "Output VAT", name_ar: "ضريبة المخرجات", name_en: "Output VAT", type: "liability", level: 1, is_active: true, tenant_id: null, parent_code: null, balance: 0 },
    { id: "ac7", code: "51001", name: "Rent Expense", name_ar: "مصروف الإيجار", name_en: "Rent Expense", type: "expense", level: 1, is_active: true, tenant_id: null, parent_code: null, balance: 0 },
    { id: "ac8", code: "31001", name: "Owner Equity", name_ar: "رأس المال", name_en: "Owner Equity", type: "equity", level: 1, is_active: true, tenant_id: null, parent_code: null, balance: 0 },
    { id: "ac9", code: "13001", name: "Vehicle Fleet", name_ar: "أسطول المركبات", name_en: "Vehicle Fleet", type: "asset", level: 1, is_active: true, tenant_id: null, parent_code: null, balance: 0 },
    { id: "ac10", code: "14001", name: "Accumulated Depreciation", name_ar: "مجمع إهلاك الأصول", name_en: "Accumulated Depreciation", type: "asset", level: 1, is_active: true, tenant_id: null, parent_code: null, balance: 0 },
    { id: "ac11", code: "52001", name: "Depreciation Expense", name_ar: "مصروف الإهلاك", name_en: "Depreciation Expense", type: "expense", level: 1, is_active: true, tenant_id: null, parent_code: null, balance: 0 },
  ],
  // A small, balanced ledger so the financial reports and the General Ledger
  // render real movements (they read `journal_entries`/`journal_lines` directly).
  // Debits equal credits: 1,110.000 each.
  journal_entries: [
    { id: "je1", journal_number: "JV-0001", entry_date: "2026-04-01", reference_number: "INV-0001", description: "Sale to Ali Hassan", entry_type: "sale_invoice", status: "posted", total_debit: 110, total_credit: 110, is_balanced: true, tenant_id: TENANT_A },
    { id: "je2", journal_number: "JV-0002", entry_date: "2026-04-05", reference_number: "REC-0001", description: "Collection from Ali Hassan", entry_type: "customer_receipt", status: "posted", total_debit: 110, total_credit: 110, is_balanced: true, tenant_id: TENANT_A },
    { id: "je3", journal_number: "JV-0003", entry_date: "2026-04-10", reference_number: "EXP-0001", description: "Showroom rent for April", entry_type: "expense", status: "posted", total_debit: 20, total_credit: 20, is_balanced: true, tenant_id: TENANT_A },
    { id: "je4", journal_number: "JV-0004", entry_date: "2026-04-15", reference_number: "CAP-0001", description: "Owner capital contribution", entry_type: "manual", status: "posted", total_debit: 1000, total_credit: 1000, is_balanced: true, tenant_id: TENANT_A },
  ],
  journal_lines: [
    { id: "jl1", journal_entry_id: "je1", account_id: "ac3", debit: 110, credit: 0, description: "Receivable on INV-0001", line_order: 1 },
    { id: "jl2", journal_entry_id: "je1", account_id: "ac5", debit: 0, credit: 100, description: "Sales revenue", line_order: 2 },
    { id: "jl3", journal_entry_id: "je1", account_id: "ac6", debit: 0, credit: 10, description: "Output VAT 10%", line_order: 3 },
    { id: "jl4", journal_entry_id: "je2", account_id: "ac1", debit: 110, credit: 0, description: "Cash received", line_order: 1 },
    { id: "jl5", journal_entry_id: "je2", account_id: "ac3", debit: 0, credit: 110, description: "Settle receivable", line_order: 2 },
    { id: "jl6", journal_entry_id: "je3", account_id: "ac7", debit: 20, credit: 0, description: "April rent", line_order: 1 },
    { id: "jl7", journal_entry_id: "je3", account_id: "ac2", debit: 0, credit: 20, description: "Paid from bank", line_order: 2 },
    { id: "jl8", journal_entry_id: "je4", account_id: "ac2", debit: 1000, credit: 0, description: "Capital into bank", line_order: 1 },
    { id: "jl9", journal_entry_id: "je4", account_id: "ac8", debit: 0, credit: 1000, description: "Owner equity", line_order: 2 },
  ],
  cars: [
    { id: "car1", make: "Toyota", model: "Corolla", year: 2024, plate_number: "12345", status: "available", category: "rental", tenant_id: TENANT_A, purchase_price: 10000, purchase_date: "2025-01-01" },
    { id: "car2", make: "Nissan", model: "Patrol", year: 2023, plate_number: "67890", status: "rented", category: "rental", tenant_id: TENANT_A, purchase_price: 24000, purchase_date: "2024-06-01" },
  ],
  depreciation_schedules: [
    { id: "ds1", car_id: "car1", method: "straight_line", useful_life_years: 5, salvage_value: 1000, annual_rate: 20, start_date: "2026-12-31", tenant_id: TENANT_A },
  ],
  // Purchasing documents, so the Exec 54 purchasing/expense reports render real
  // rows rather than an empty state. Every bill's taxable base is
  // `total_amount − vat_amount` (the reports' VAT-inclusive convention).
  purchase_invoices: [
    { id: "pi1", invoice_number: "BILL-0001", supplier_id: "s1", bill_date: "2026-09-05", due_date: "2026-10-05", total_amount: 220, vat_amount: 20, paid_amount: 0, status: "pending", tenant_id: TENANT_A, expense_category: "maintenance", car_id: "car1", branch: "Manama" },
    { id: "pi2", invoice_number: "BILL-0002", supplier_id: "s2", bill_date: "2026-09-18", due_date: "2026-10-18", total_amount: 550, vat_amount: 50, paid_amount: 550, status: "paid", tenant_id: TENANT_A, expense_category: "fuel", car_id: "car2", branch: "Airport" },
    { id: "pi3", invoice_number: "BILL-0003", supplier_id: "s1", bill_date: "2026-10-02", due_date: "2026-11-02", total_amount: 330, vat_amount: 30, paid_amount: 100, status: "partial", tenant_id: TENANT_A, expense_category: "tyres", car_id: "car1", branch: "Manama" },
    { id: "pi9", invoice_number: "BILL-9000", supplier_id: "s2", bill_date: "2026-10-04", total_amount: 110, vat_amount: 10, paid_amount: 0, status: "cancelled", tenant_id: TENANT_A, expense_category: "other", branch: "Manama" },
  ],
  supplier_payments: [
    { id: "sp1", payment_number: "SP-0001", supplier_id: "s2", purchase_invoice_id: "pi2", amount: 550, payment_date: "2026-09-20", payment_method: "bank_transfer", status: "completed", tenant_id: TENANT_A },
    { id: "sp2", payment_number: "SP-0002", supplier_id: "s1", purchase_invoice_id: "pi3", amount: 100, payment_date: "2026-10-10", payment_method: "cash", status: "completed", tenant_id: TENANT_A },
  ],
  debit_notes: [
    { id: "dn1", note_number: "DN-0001", supplier_id: "s1", purchase_invoice_id: "pi1", amount: 55, vat_amount: 5, note_date: "2026-09-25", reason: "Damaged parts returned", status: "active", tenant_id: TENANT_A },
  ],
  expenses: [
    { id: "ex1", expense_date: "2026-09-12", description: "Showroom electricity", amount: 45, vat_amount: 4.5, expense_account_id: "ac7", branch: "Manama", tenant_id: TENANT_A },
    { id: "ex2", expense_date: "2026-10-03", description: "Vehicle washing", amount: 30, vat_amount: 3, expense_account_id: "ac7", branch: "Airport", car_id: "car2", tenant_id: TENANT_A },
  ],
  invoices: [
    { id: "inv1", invoice_number: "INV-0001", customer_id: "c1", invoice_date: "2026-09-08", total_amount: 330, vat_amount: 30, paid_amount: 330, status: "paid", invoice_type: "rental", car_id: "car1", tenant_id: TENANT_A },
    { id: "inv2", invoice_number: "INV-0002", customer_id: "c2", invoice_date: "2026-10-06", total_amount: 220, vat_amount: 20, paid_amount: 0, status: "pending", invoice_type: "rental", car_id: "car2", tenant_id: TENANT_A },
  ],
  // Exec 58 — the notification store and the rows the due-date scan reads.
  rental_contracts: [
    { id: "rc1", contract_number: "RC-0001", customer_id: "c1", car_id: "car1", status: "active", start_date: "2026-10-01", end_date: "2026-10-20", tenant_id: TENANT_A },
    { id: "rc2", contract_number: "RC-0002", customer_id: "c2", car_id: "car2", status: "active", start_date: "2026-10-10", end_date: "2027-01-10", tenant_id: TENANT_A },
  ],
  notifications: [],
};

/** Rows a table returns, honouring the simple `eq`/`in` filters the pages send. */
function selectRows(table, searchParams) {
  let rows = TABLES[table] ?? [];
  for (const [key, value] of searchParams.entries()) {
    if (["select", "order", "limit", "offset", "apikey"].includes(key)) continue;
    // PostgREST `in.(a,b,c)` — used for `.in("journal_entry_id", ids)`. Without
    // this a report reads no journal lines and silently shows all-zero balances.
    if (value.startsWith("in.(")) {
      const list = value.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
      rows = rows.filter((r) => list.includes(String(r[key])));
      continue;
    }
    if (value === "is.null") {
      rows = rows.filter((r) => r[key] == null);
      continue;
    }
    // PostgREST `like.` — the depreciation route finds posted charges for an
    // asset with `.like("reference_number", "DEP-<car>-%" )`.
    if (value.startsWith("like.")) {
      const pattern = value.slice(5);
      const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$");
      rows = rows.filter((r) => r[key] != null && re.test(String(r[key])));
      continue;
    }
    // PostgREST range filters. A report that sends `entry_date=gte.…&lte=…`
    // would otherwise read zero rows and render an all-zero statement.
    if (value.startsWith("gte.") || value.startsWith("lte.") || value.startsWith("gt.") || value.startsWith("lt.")) {
      const op = value.slice(0, value.indexOf("."));
      const bound = value.slice(op.length + 1);
      rows = rows.filter((r) => {
        const v = r[key];
        if (v == null) return false;
        if (op === "gte") return String(v) >= bound;
        if (op === "lte") return String(v) <= bound;
        if (op === "gt") return String(v) > bound;
        return String(v) < bound;
      });
      continue;
    }
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

const server = http.createServer(async (req, res) => {
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
    const table = rest[1];
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const rows = Array.isArray(body) ? body : [body];
      TABLES[table] = TABLES[table] ?? [];
      const created = rows.map((r, i) => {
        // A real Supabase id is a UUID. Emitting a short slug here made an id
        // that a UUID-validating route (e.g. the Super Admin user PATCH) would
        // reject, so the stub would diverge from the live schema.
        const n = TABLES[table].length + i + 1;
        const prefix = Buffer.from(table).toString("hex").slice(0, 8).padEnd(8, "0");
        const row = { id: `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`, ...r };
        TABLES[table].push(row);
        return row;
      });
      const wantsObject = String(req.headers.accept ?? "").includes("pgrst.object");
      return send(res, 201, wantsObject ? created[0] : created);
    }
    let rows = selectRows(table, url.searchParams);
    // PostgREST `PATCH` (`.update(...)`). Without this the stub echoed the rows
    // unchanged, so an update appeared to succeed while nothing was written -
    // which is exactly how the notification "mark read" defect stayed invisible
    // in the browser. It applies the SAME filters `selectRows` understands.
    if (req.method === "PATCH") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const patch = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const affected = rows.map((r) => Object.assign(r, patch));
      const wantsObject = String(req.headers.accept ?? "").includes("pgrst.object");
      return send(res, 200, wantsObject ? affected[0] ?? null : affected, {
        "content-range": affected.length ? `0-${affected.length - 1}/${affected.length}` : "*/0",
      });
    }
    // PostgREST embed, e.g. `select=*,car:cars(...)`. The depreciation screen
    // reads the vehicle through this relation.
    if (/car:cars\(/.test(url.searchParams.get("select") ?? "") && table === "depreciation_schedules") {
      rows = rows.map((r) => ({ ...r, car: (TABLES.cars ?? []).find((c) => c.id === r.car_id) ?? null }));
    }
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
