import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";

import {
  loginErrorMessage,
  notProvisionedMessage,
  unauthorizedRoleMessage,
} from "../src/lib/auth/login-errors.ts";
import {
  projectRefFromKey,
  projectRefFromUrl,
  supabaseConfigConsistent,
} from "../src/lib/supabase-config.ts";
import { isProtectedPage, isPublicApiPath, middleware } from "../src/middleware.ts";

/**
 * Login + authentication flow regression guard.
 *
 * These lock in the properties that make the browser sign-in safe and
 * diagnosable: the role is resolved server-side, the provider's raw string is
 * never shown, and the privileged API surface stays gated when the deployment is
 * misconfigured. No live credentials are used; the middleware cases exercise the
 * documented fail-safe path (no Supabase env).
 */

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("login error mapping is safe and localized", () => {
  test("invalid credentials (status 400 / code / message) map to a clear message", () => {
    const raw = { message: "Invalid login credentials", status: 400, code: "invalid_credentials" };
    assert.equal(loginErrorMessage(raw, false), "Incorrect email or password.");
    assert.equal(loginErrorMessage(raw, true), "البريد الإلكتروني أو كلمة المرور غير صحيحة.");
    // status-only and code-only variants behave identically.
    assert.equal(loginErrorMessage({ status: 400 }, false), "Incorrect email or password.");
    assert.equal(loginErrorMessage({ code: "invalid_credentials" }, false), "Incorrect email or password.");
  });

  test("the provider's raw message is never echoed", () => {
    const out = loginErrorMessage({ message: "Invalid login credentials", status: 400 }, false);
    assert.doesNotMatch(out, /invalid login credentials/i);
  });

  test("other failure modes are distinguished", () => {
    assert.match(loginErrorMessage({ code: "email_not_confirmed" }, false), /not confirmed/i);
    assert.match(loginErrorMessage({ status: 429 }, false), /too many/i);
    assert.match(loginErrorMessage({ message: "boom", status: 500 }, false), /try again/i);
    assert.match(loginErrorMessage(null, false), /try again/i);
    assert.match(loginErrorMessage(null, true), /حاول/);
  });

  test("provisioning and role messages are localized and secret-free", () => {
    assert.match(notProvisionedMessage(false), /not linked to the ERP/i);
    assert.match(notProvisionedMessage(true), /غير مرتبط/);
    assert.match(unauthorizedRoleMessage(false), /not authorized/i);
    assert.match(unauthorizedRoleMessage(true), /غير مخوّل/);
  });
});

describe("login page resolves authorization server-side", () => {
  const page = read("src/app/login/page.tsx");

  test("uses the single shared browser client, not an ad-hoc one", () => {
    assert.match(page, /from ['"]@\/lib\/supabase['"]/);
    assert.doesNotMatch(page, /createClient\(/);
    assert.doesNotMatch(page, /createBrowserClient\(/);
  });

  test("role comes from /api/me, never from client-side metadata", () => {
    assert.match(page, /\/api\/me/);
    assert.doesNotMatch(page, /user_metadata/);
    assert.doesNotMatch(page, /app_metadata/);
    // It must not read the role from the browser client directly.
    assert.doesNotMatch(page, /\.from\(['"]users['"]\)/);
  });

  test("allows admin and staff; routes super admins and clients to their consoles", () => {
    assert.match(page, /me\?\.role !== "admin"/);
    assert.match(page, /me\?\.role !== "staff"/);
    // The global operator is decided server-side (isSuperAdmin), never by the
    // client role list, and is sent to the global console rather than the ERP.
    assert.match(page, /me\?\.isSuperAdmin === true/);
    assert.match(page, /router\.replace\("\/super-admin"\)/);
    assert.match(page, /\/customer-dashboard/);
    assert.match(page, /router\.replace\("\/dashboard"\)/);
  });

  test("maps auth errors through the shared mapper and handles missing mapping", () => {
    assert.match(page, /loginErrorMessage\(/);
    assert.match(page, /account_not_provisioned/);
    assert.match(page, /notProvisionedMessage\(/);
  });

  test("never references the service-role key", () => {
    assert.doesNotMatch(page, /SERVICE_ROLE/);
  });
});

describe("browser supabase client is consistent", () => {
  const client = read("src/lib/supabase.ts");

  test("uses NEXT_PUBLIC env and the ssr browser factory", () => {
    assert.match(client, /createBrowserClient/);
    assert.match(client, /NEXT_PUBLIC_SUPABASE_URL/);
    assert.match(client, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });

  test("contains no hardcoded project url or anon key", () => {
    assert.doesNotMatch(client, /https:\/\/[a-z0-9]+\.supabase\.co/);
    assert.doesNotMatch(client, /eyJ[A-Za-z0-9_-]{10,}/);
  });
});

describe("supabase config consistency", () => {
  // Build synthetic (non-secret) JWTs; only the `ref` claim matters.
  const fakeKey = (ref: string) =>
    `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.` +
    `${Buffer.from(JSON.stringify({ role: "anon", ref, iss: "supabase" })).toString("base64url")}.` +
    `sig`;

  test("extracts the project ref from a url", () => {
    assert.equal(projectRefFromUrl("https://chlkmdobhvfnldqkgdji.supabase.co"), "chlkmdobhvfnldqkgdji");
    assert.equal(projectRefFromUrl("https://other.supabase.co/"), "other");
    assert.equal(projectRefFromUrl("not-a-url"), null);
    assert.equal(projectRefFromUrl(null), null);
  });

  test("extracts the project ref from a key without leaking it", () => {
    const ref = projectRefFromKey(fakeKey("abcdefghijklmnopqrst"));
    assert.equal(ref, "abcdefghijklmnopqrst");
    assert.equal(projectRefFromKey("opaque-non-jwt-key"), null);
    assert.equal(projectRefFromKey(undefined), null);
  });

  test("detects a url/key project mismatch (the classic build-env failure)", () => {
    const url = "https://aaaa.supabase.co";
    assert.equal(supabaseConfigConsistent(url, fakeKey("aaaa")), true);
    assert.equal(supabaseConfigConsistent(url, fakeKey("bbbb")), false);
    // Unknown key format is treated as "cannot tell", not a mismatch.
    assert.equal(supabaseConfigConsistent(url, "opaque"), true);
  });
});

describe("middleware gates the privileged API surface", () => {
  const protectedReq = () => new NextRequest("https://example.com/api/users");

  test("denies a protected API without a session", async () => {
    const res = await middleware(protectedReq());
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, "unauthenticated");
  });

  test("allows the public signup API to reach its handler", async () => {
    const res = await middleware(new NextRequest("https://example.com/api/saas/signup"));
    assert.notEqual(res.status, 401);
  });

  test("does not gate public pages", async () => {
    const res = await middleware(new NextRequest("https://example.com/login"));
    assert.notEqual(res.status, 401);
  });
});

describe("page-level gate redirects anonymous callers", () => {
  test("ERP pages are protected", () => {
    for (const p of [
      "/dashboard",
      "/financial-dashboard",
      "/accounting/journal-entries",
      "/reports/profit-loss",
      "/sales/new",
      "/settings/users",
      "/hr/payroll",
    ]) {
      assert.equal(isProtectedPage(p), true, `${p} must be protected`);
    }
  });

  test("marketing and auth pages stay public", () => {
    for (const p of ["/", "/login", "/pricing", "/features", "/signup", "/customer-login", "/erp"]) {
      assert.equal(isProtectedPage(p), false, `${p} must stay public`);
    }
  });

  test("the global operator console is protected but its sign-in door is public", () => {
    assert.equal(isProtectedPage("/super-admin"), true, "/super-admin must be protected");
    assert.equal(isProtectedPage("/super-admin-login"), false, "/super-admin-login must stay public");
  });

  test("a prefix does not swallow an unrelated page", () => {
    // `/carsomething` must not be treated as the `/cars` section.
    assert.equal(isProtectedPage("/carsomething"), false);
  });

  test("public API allow-list is exact", () => {
    assert.equal(isPublicApiPath("/api/saas/signup"), true);
    assert.equal(isPublicApiPath("/api/public/vehicles"), true);
    assert.equal(isPublicApiPath("/api/users"), false);
  });
});
