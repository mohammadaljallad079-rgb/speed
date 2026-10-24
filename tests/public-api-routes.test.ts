import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";

import { middleware } from "../src/middleware.ts";
import { GET as getVehicles } from "../src/app/api/public/vehicles/route.ts";
import { GET as getCompanyProfile } from "../src/app/api/public/company-profile/route.ts";

/**
 * Public marketing API routes.
 *
 * These two endpoints are the ONLY anonymously reachable data routes besides the
 * sanctioned signup routes. They exist because the `cars` and `settings` tables
 * are RLS-protected and have no `anon` grant, so the public pages cannot read them
 * directly. The tests below prove they stay intentionally public, keep the
 * protected APIs protected, and never expose more than the approved projection.
 */

const ROOT = process.cwd();
const VEHICLES_ROUTE = path.join(ROOT, "src/app/api/public/vehicles/route.ts");
const PROFILE_ROUTE = path.join(ROOT, "src/app/api/public/company-profile/route.ts");

const APPROVED_VEHICLE_FIELDS = [
  "id", "make", "model", "year", "color", "category", "mileage", "status",
  "created_at", "daily_rate", "weekly_rate", "monthly_rate", "sale_price",
  "fuel_type", "transmission", "seats", "location", "image_url",
  "gallery_images", "plate_number",
  // Display fields the public fleet/detail pages render. They describe the car
  // to a buyer/renter; none of them is commercial or identifying data.
  "body_type", "condition", "description", "features",
];

const FORBIDDEN_VEHICLE_FIELDS = [
  "tenant_id", "purchase_price", "purchase_costs", "maintenance_costs",
  "salvage_value", "supplier_id", "vin", "chassis_number", "engine_number",
  "insurance_policy_number", "insurance_company", "insurance_expiry",
  "bank_name", "interest_rate", "down_payment", "monthly_installment",
  "remaining_installments", "total_installments", "registration_expiry", "notes",
];

const APPROVED_PROFILE_FIELDS = ["name", "phone", "email", "address", "crNumber"];
// `key`/`value` are legitimate settings-table query columns, so they are not in
// this list; that they are never *returned* is asserted by the response-shape
// test below. This list is for values that must never appear in the route at all.
const FORBIDDEN_PROFILE_FIELDS = [
  "ai_settings", "api_key", "apiKey", "service_role", "secret", "token", "tenant_id",
];

const hasLiveDb = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

function assertNoSecret(value: unknown, label: string) {
  const text = JSON.stringify(value ?? null);
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{20,}/, `${label} must not contain a JWT`);
  assert.doesNotMatch(text, /service_role/i, `${label} must not mention service_role`);
  assert.doesNotMatch(text, /SUPABASE_[A-Z_]*KEY/, `${label} must not leak an env key name`);
}

// ---------------------------------------------------------------------------
// Intentionally public, and only these
// ---------------------------------------------------------------------------

describe("public API allowlist", () => {
  test("GET /api/public/vehicles is intentionally public", async () => {
    const res = await middleware(new NextRequest("http://localhost/api/public/vehicles"));
    assert.equal(res.status, 200);
  });

  test("GET /api/public/company-profile is intentionally public", async () => {
    const res = await middleware(new NextRequest("http://localhost/api/public/company-profile"));
    assert.equal(res.status, 200);
  });

  test("/api/customers stays protected (401)", async () => {
    const res = await middleware(new NextRequest("http://localhost/api/customers"));
    assert.equal(res.status, 401);
  });

  test("/api/saas/onboarding stays protected (401)", async () => {
    const res = await middleware(new NextRequest("http://localhost/api/saas/onboarding"));
    assert.equal(res.status, 401);
  });

  test("other protected APIs stay protected (401)", async () => {
    for (const p of ["/api/invoices", "/api/expenses", "/api/users", "/api/suppliers", "/api/excel/export"]) {
      const res = await middleware(new NextRequest(`http://localhost${p}`));
      assert.equal(res.status, 401, `${p} must require auth`);
    }
  });
});

// ---------------------------------------------------------------------------
// Static source guarantees
// ---------------------------------------------------------------------------

describe("public routes are safe by construction", () => {
  const sources = {
    vehicles: fs.readFileSync(VEHICLES_ROUTE, "utf8"),
    profile: fs.readFileSync(PROFILE_ROUTE, "utf8"),
  };

  test("neither route uses select('*')", () => {
    for (const [name, source] of Object.entries(sources)) {
      assert.doesNotMatch(source, /select\(\s*["'`]\*["'`]\s*\)/, `${name} must not select *`);
    }
  });

  test("neither route mutates RLS or grants table access", () => {
    for (const [name, source] of Object.entries(sources)) {
      assert.doesNotMatch(source, /\b(create|drop)\s+policy\b/i, `${name} must not create/drop policies`);
      assert.doesNotMatch(source, /\balter\s+table\b/i, `${name} must not alter tables`);
      // SQL privilege grant, e.g. `grant select on public.cars to anon`.
      assert.doesNotMatch(source, /\bgrant\s+[a-z]+\s+on\b/i, `${name} must not grant privileges`);
    }
  });

  test("neither route reads tenant identity from the request as a trust mechanism", () => {
    for (const [name, source] of Object.entries(sources)) {
      assert.doesNotMatch(source, /searchParams\.get\(\s*["'`](tenant_id|tenantId|role|company_id)["'`]\s*\)/,
        `${name} must not trust caller-supplied identity`);
    }
  });

  test("the vehicles route projects only approved public columns", () => {
    const source = sources.vehicles;
    for (const field of APPROVED_VEHICLE_FIELDS) {
      assert.match(source, new RegExp(`["'\`]${field}["'\`]`), `vehicles must expose ${field}`);
    }
    for (const field of FORBIDDEN_VEHICLE_FIELDS) {
      assert.doesNotMatch(source, new RegExp(`["'\`]${field}["'\`]`), `vehicles must NOT expose ${field}`);
    }
  });

  test("the company-profile route projects only approved public fields", () => {
    const source = sources.profile;
    // Only the `company_profile` settings key is read.
    assert.match(source, /\.eq\(\s*["'`]key["'`]\s*,\s*["'`]company_profile["'`]\s*\)/);
    for (const field of APPROVED_PROFILE_FIELDS) {
      assert.match(source, new RegExp(`${field}:`), `profile must expose ${field}`);
    }
    // The response is an explicit literal projection, so it must never spread the
    // raw settings row or return the whole `value` object.
    assert.doesNotMatch(source, /\.\.\.\s*value\b/, "profile must not spread the raw settings value");
    assert.doesNotMatch(source, /data:\s*value\s*[,}]/, "profile must not return the raw settings value");
    for (const field of FORBIDDEN_PROFILE_FIELDS) {
      assert.doesNotMatch(source, new RegExp(`\\b${field}\\b`), `profile must NOT expose ${field}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Live response shape (requires the configured Supabase project)
// ---------------------------------------------------------------------------

describe("public route responses", { skip: hasLiveDb ? false : "no Supabase env configured" }, () => {
  test("GET /api/public/vehicles returns 200 with only approved fields", async () => {
    const res = await getVehicles(new NextRequest("http://localhost/api/public/vehicles?limit=5"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data), "data must be an array");
    assertNoSecret(body, "vehicles response");
    for (const row of body.data) {
      for (const key of Object.keys(row)) {
        assert.ok(APPROVED_VEHICLE_FIELDS.includes(key), `unexpected public vehicle field: ${key}`);
      }
    }
  });

  test("GET /api/public/vehicles?id=... returns a single safe row", async () => {
    const list = await (await getVehicles(new NextRequest("http://localhost/api/public/vehicles?limit=1"))).json();
    const first = list.data?.[0];
    if (!first) return; // empty table is acceptable
    const res = await getVehicles(new NextRequest(`http://localhost/api/public/vehicles?id=${first.id}`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assertNoSecret(body, "vehicle detail response");
    for (const key of Object.keys(body.data ?? {})) {
      assert.ok(APPROVED_VEHICLE_FIELDS.includes(key), `unexpected public vehicle field: ${key}`);
    }
  });

  test("GET /api/public/company-profile returns 200 with only approved fields", async () => {
    const res = await getCompanyProfile();
    assert.equal(res.status, 200);
    const body = await res.json();
    assertNoSecret(body, "company-profile response");
    for (const key of Object.keys(body.data ?? {})) {
      assert.ok(APPROVED_PROFILE_FIELDS.includes(key), `unexpected public profile field: ${key}`);
    }
  });
});
