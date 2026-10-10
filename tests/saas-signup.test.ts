import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  defaultFinancialYear,
  FREE_PLAN,
  MIN_PASSWORD_LENGTH,
  validateOnboarding,
  validateSignup,
} from "../src/lib/saas/provisioning";

const ROOT = process.cwd();
const SIGNUP_ROUTE = path.join(ROOT, "src/app/api/saas/signup/route.ts");
const ONBOARDING_ROUTE = path.join(ROOT, "src/app/api/saas/onboarding/route.ts");

// ---------------------------------------------------------------------------
// Signup validation
// ---------------------------------------------------------------------------

test("signup: a valid payload is accepted and the email is normalised", () => {
  const result = validateSignup({
    fullName: "  Ada Lovelace ",
    email: "  ADA@Example.COM ",
    password: "supersecret",
    confirmPassword: "supersecret",
    companyName: " Analytical Engines ",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.email, "ada@example.com");
  assert.equal(result.data.fullName, "Ada Lovelace");
  assert.equal(result.data.companyName, "Analytical Engines");
});

test("signup: missing or malformed fields are rejected with a field name", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ email: "a@b.co", password: "12345678", confirmPassword: "12345678", companyName: "C" }, "fullName"],
    [{ fullName: "A", password: "12345678", confirmPassword: "12345678", companyName: "C" }, "email"],
    [{ fullName: "A", email: "not-an-email", password: "12345678", confirmPassword: "12345678", companyName: "C" }, "email"],
    [{ fullName: "A", email: "a@b.co", password: "12345678", confirmPassword: "12345678" }, "companyName"],
    [{ fullName: "A", email: "a@b.co", password: "short", confirmPassword: "short", companyName: "C" }, "password"],
    [{ fullName: "A", email: "a@b.co", password: "12345678", confirmPassword: "different", companyName: "C" }, "confirmPassword"],
  ];
  for (const [input, field] of cases) {
    const result = validateSignup(input);
    assert.equal(result.ok, false, `expected failure for ${field}`);
    if (result.ok) continue;
    assert.equal(result.field, field);
  }
});

test("signup: password must meet the minimum length", () => {
  const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
  const result = validateSignup({
    fullName: "A",
    email: "a@b.co",
    password: short,
    confirmPassword: short,
    companyName: "C",
  });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Onboarding validation
// ---------------------------------------------------------------------------

test("onboarding: with no year supplied the default financial year is provisioned", () => {
  const now = new Date("2031-06-15T00:00:00Z");
  const result = validateOnboarding({ companyName: "Acme" }, now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.financialYear, {
    name: "2031",
    start_date: "2031-01-01",
    end_date: "2031-12-31",
  });
});

test("onboarding: an explicit financial year is honoured when well-formed", () => {
  const result = validateOnboarding({
    financialYearName: "FY25",
    financialYearStart: "2025-04-01",
    financialYearEnd: "2026-03-31",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.financialYear, {
    name: "FY25",
    start_date: "2025-04-01",
    end_date: "2026-03-31",
  });
});

test("onboarding: an inverted financial year is rejected", () => {
  const result = validateOnboarding({
    financialYearStart: "2025-12-31",
    financialYearEnd: "2025-01-01",
  });
  assert.equal(result.ok, false);
});

test("onboarding: a partial financial year (missing end) is rejected", () => {
  const result = validateOnboarding({ financialYearStart: "2025-01-01" });
  assert.equal(result.ok, false);
});

test("defaultFinancialYear derives a calendar year from the supplied date", () => {
  const year = defaultFinancialYear(new Date("2027-02-02T00:00:00Z"));
  assert.deepEqual(year, { name: "2027", start_date: "2027-01-01", end_date: "2027-12-31" });
});

// ---------------------------------------------------------------------------
// Free plan
// ---------------------------------------------------------------------------

test("free plan is $0 and needs no payment method", () => {
  assert.equal(FREE_PLAN.price, 0);
  assert.equal(FREE_PLAN.requiresPaymentMethod, false);
});

test("free plan advertises no inventory feature", () => {
  const advertised = JSON.stringify(FREE_PLAN).toLowerCase();
  for (const banned of ["inventory", "stock", "warehouse", "مخزون"]) {
    assert.equal(advertised.includes(banned), false, `free plan must not advertise ${banned}`);
  }
});

// ---------------------------------------------------------------------------
// The signup route cannot be used to escalate or to join an existing tenant
// ---------------------------------------------------------------------------

test("signup route always creates a NEW tenant and never trusts a client tenant_id", () => {
  const source = fs.readFileSync(SIGNUP_ROUTE, "utf8");

  // It creates a tenant of its own (server-generated id).
  assert.match(source, /from\(\s*["'`]tenants["'`]\s*\)\s*\.insert/);

  // Ownership columns are never read from the request body.
  for (const field of ["tenant_id", "tenantId", "company_id", "companyId", "user_id", "userId"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`body\\s*\\[\\s*["'\`]${field}["'\`]\\s*\\]`),
      `signup route must not read ${field} from the body`,
    );
    assert.doesNotMatch(source, new RegExp(`body\\.${field}\\b`), `signup route must not read ${field} from the body`);
  }

  // The role is a literal admin of the NEW tenant, never taken from the body.
  assert.match(source, /role:\s*["'`]admin["'`]/);
  assert.doesNotMatch(source, /role:\s*body/);
});

test("signup route validates before it provisions and rolls back on failure", () => {
  const source = fs.readFileSync(SIGNUP_ROUTE, "utf8");
  // Validation happens first.
  assert.match(source, /validateSignup/);
  // Cleanup on partial failure (auth user and tenant are removed again).
  assert.match(source, /auth\.admin\.deleteUser/);
  assert.match(source, /\.delete\(\)\s*\.eq\(\s*["'`]id["'`]/);
  // Duplicate email is handled explicitly.
  assert.match(source, /email_taken/);
});

// ---------------------------------------------------------------------------
// The onboarding route is authenticated and tenant-scoped
// ---------------------------------------------------------------------------

test("onboarding route requires an authenticated admin and scopes to the caller tenant", () => {
  const source = fs.readFileSync(ONBOARDING_ROUTE, "utf8");
  // Authentication + authorization guard is present.
  assert.match(source, /requireContext\s*\(/);
  assert.match(source, /requireAdmin:\s*true/);
  // Tenant comes from the resolved context, never from the body.
  assert.match(source, /context\.tenantId/);
  assert.doesNotMatch(source, /body\.tenant_id/);
  assert.doesNotMatch(source, /body\s*\[\s*["'`]tenant_id["'`]\s*\]/);
  // Every write is filtered by the caller's tenant.
  assert.match(source, /\.eq\(\s*["'`]tenant_id["'`]\s*,\s*tenantId\s*\)/);
});
