/**
 * Exec 69 - the customer <-> ERP access boundary.
 *
 * The reported defect: a rental CUSTOMER (role `client`) could reach the ERP
 * dashboard. The root cause was that the middleware only ever asked "is there a
 * session?" and never "is this identity allowed here?", so an authenticated
 * customer was served the ERP shell.
 *
 * These tests are deliberately end-to-end: they run the REAL `middleware()`,
 * the REAL `@supabase/ssr` client and REAL cookies, against a local HTTP stub
 * that speaks the small slice of the Supabase API involved (the auth `getUser`
 * call and the `users` row read). Mocking the Supabase client module instead
 * would have proved nothing about the code that actually runs.
 *
 * The stub is a plain `node:http` server; no network, no live database, no
 * credentials.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { NextRequest } from "next/server";

import {
  areaForPath,
  isPublicPath,
  loginPathForArea,
  safeCustomerRedirect,
} from "../src/lib/auth/access-areas.ts";

/** The identity the stub's auth endpoint reports. */
type StubUser = { id: string; email: string } | null;

/** The row the stub's REST endpoint returns for `users`. */
type StubRow = { role: string | null; is_active: boolean | null } | null;

let currentUser: StubUser = null;
let currentRow: StubRow = null;
/** When true the REST endpoint returns a 500, to exercise the fail-closed path. */
let restFails = false;

let server: ReturnType<typeof createServer>;
let baseUrl = "";
let projectRef = "";

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(payload);
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");

  // --- Auth: GET /auth/v1/user (supabase-js validates the session here) ------
  if (url.pathname === "/auth/v1/user") {
    if (!currentUser) return json(res, 401, { message: "invalid claim: missing sub claim" });
    return json(res, 200, {
      id: currentUser.id,
      aud: "authenticated",
      role: "authenticated",
      email: currentUser.email,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    });
  }

  // --- REST: GET /rest/v1/users?select=role,is_active&id=eq.<id> ------------
  if (url.pathname === "/rest/v1/users") {
    if (restFails) return json(res, 500, { message: "boom" });
    const rows = currentRow ? [currentRow] : [];
    return json(res, 200, rows, { "content-range": rows.length ? "0-0/1" : "*/0" });
  }

  return json(res, 404, { message: "not found" });
}

/** Build the cookie value `@supabase/ssr` writes for a session. */
function sessionCookie(ref: string, userId: string, email: string): string {
  const session = {
    access_token: "stub-access-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "stub-refresh-token",
    user: { id: userId, aud: "authenticated", role: "authenticated", email },
  };
  // The default storage adapter base64url-encodes the JSON and may split it
  // into chunks; a single small cookie needs no chunking.
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

function request(path: string, opts: { user?: { id: string; email: string }; cookie?: boolean } = {}) {
  const headers = new Headers();
  if (opts.cookie && opts.user) {
    headers.set("cookie", `sb-${projectRef}-auth-token=${sessionCookie(projectRef, opts.user.id, opts.user.email)}`);
  }
  return new NextRequest(`${baseUrl}${path}`, { headers });
}

const CLIENT = { id: "cccccccc-0000-0000-0000-0000000000c1", email: "customer@x.local" };
const ADMIN = { id: "aaaaaaaa-0000-0000-0000-0000000000a1", email: "admin@x.local" };
const STAFF = { id: "bbbbbbbb-0000-0000-0000-0000000000b1", email: "staff@x.local" };
const SUPER = { id: "dddddddd-0000-0000-0000-0000000000d1", email: "super@x.local" };

describe("Exec 69 - customer <-> ERP access boundary (middleware, end to end)", () => {
  let middleware: typeof import("../src/middleware.ts").middleware;

  before(async () => {
    server = createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    // `createServerClient` derives the storage key as
    // `sb-${hostname.split(".")[0]}-auth-token` (supabase-js SupabaseClient),
    // so the cookie name follows from the stub URL, not from a constant.
    projectRef = new URL(baseUrl).hostname.split(".")[0];
    process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";

    ({ middleware } = await import("../src/middleware.ts"));
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  const setIdentity = (user: StubUser, row: StubRow) => {
    currentUser = user;
    currentRow = row;
    restFails = false;
  };

  // ======================= THE REPORTED DEFECT ============================
  describe("the reported defect: a customer must not reach the ERP", () => {
    test("a signed-in CLIENT is refused the ERP dashboard (page)", async () => {
      setIdentity(CLIENT, { role: "client", is_active: true });
      const res = await middleware(request("/dashboard", { user: CLIENT, cookie: true }));
      assert.equal(res.status, 307, "a customer must be redirected, never served the ERP shell");
      assert.equal(new URL(res.headers.get("location")!).pathname, "/access-denied");
    });

    test("a signed-in CLIENT is refused the ERP dashboard (API)", async () => {
      setIdentity(CLIENT, { role: "client", is_active: true });
      const res = await middleware(request("/api/customers", { user: CLIENT, cookie: true }));
      assert.equal(res.status, 403, "a customer must not call an ERP API");
      assert.equal((await res.json()).code, "forbidden");
    });

    test("a CLIENT may still use the customer portal", async () => {
      setIdentity(CLIENT, { role: "client", is_active: true });
      const page = await middleware(request("/customer-dashboard", { user: CLIENT, cookie: true }));
      assert.equal(page.status, 200);
      const api = await middleware(request("/api/customer/bookings", { user: CLIENT, cookie: true }));
      assert.equal(api.status, 200);
    });

    test("every ERP page prefix refuses a CLIENT", async () => {
      setIdentity(CLIENT, { role: "client", is_active: true });
      const erpPages = [
        "/dashboard",
        "/financial-dashboard",
        "/accounting/journal-entries",
        "/reports/profit-loss",
        "/sales",
        "/purchases",
        "/rentals",
        "/cars",
        "/cars/new",
        "/customers",
        "/suppliers",
        "/invoices",
        "/payments",
        "/expenses",
        "/settings/company",
        "/hr",
        "/super-admin",
      ];
      for (const p of erpPages) {
        const res = await middleware(request(p, { user: CLIENT, cookie: true }));
        assert.equal(res.status, 307, `${p} must redirect a customer`);
        assert.equal(
          new URL(res.headers.get("location")!).pathname,
          "/access-denied",
          `${p} must send a customer to /access-denied`,
        );
      }
    });
  });

  // ======================= ERP USERS KEEP WORKING =========================
  describe("ERP users are unaffected", () => {
    test("an ADMIN reaches the ERP pages and APIs", async () => {
      setIdentity(ADMIN, { role: "admin", is_active: true });
      for (const p of ["/dashboard", "/accounting/journal-entries", "/reports/profit-loss", "/customers"]) {
        const res = await middleware(request(p, { user: ADMIN, cookie: true }));
        assert.equal(res.status, 200, `${p} must be served to an admin`);
      }
      const api = await middleware(request("/api/customers", { user: ADMIN, cookie: true }));
      assert.equal(api.status, 200);
    });

    test("a STAFF user reaches the ERP pages and APIs", async () => {
      setIdentity(STAFF, { role: "staff", is_active: true });
      const page = await middleware(request("/dashboard", { user: STAFF, cookie: true }));
      assert.equal(page.status, 200);
      const api = await middleware(request("/api/invoices", { user: STAFF, cookie: true }));
      assert.equal(api.status, 200);
    });

    test("an ERP user is refused the CUSTOMER API area", async () => {
      setIdentity(ADMIN, { role: "admin", is_active: true });
      const res = await middleware(request("/api/customer/bookings", { user: ADMIN, cookie: true }));
      assert.equal(res.status, 403, "the customer API is not an ERP surface");
    });

    test("an ERP user is refused the platform console", async () => {
      setIdentity(ADMIN, { role: "admin", is_active: true });
      const res = await middleware(request("/super-admin", { user: ADMIN, cookie: true }));
      assert.equal(res.status, 307);
      assert.equal(new URL(res.headers.get("location")!).pathname, "/access-denied");
    });
  });

  // ======================= PLATFORM OPERATOR ==============================
  describe("the global super admin", () => {
    test("reaches the platform console and its API", async () => {
      setIdentity(SUPER, { role: "super_admin", is_active: true });
      const page = await middleware(request("/super-admin", { user: SUPER, cookie: true }));
      assert.equal(page.status, 200);
      const api = await middleware(request("/api/super-admin/tenants", { user: SUPER, cookie: true }));
      assert.equal(api.status, 200);
    });

    test("is refused the company ERP workspace", async () => {
      setIdentity(SUPER, { role: "super_admin", is_active: true });
      const res = await middleware(request("/dashboard", { user: SUPER, cookie: true }));
      assert.equal(res.status, 307);
      assert.equal(new URL(res.headers.get("location")!).pathname, "/access-denied");
    });
  });

  // ======================= FAIL CLOSED ====================================
  describe("fail-closed behaviour", () => {
    test("an authenticated identity with NO users row is refused the ERP", async () => {
      setIdentity(CLIENT, null); // no application row at all
      const res = await middleware(request("/dashboard", { user: CLIENT, cookie: true }));
      assert.equal(res.status, 307);
      assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
    });

    test("an UNRECOGNISED role grants nothing (never defaults to staff)", async () => {
      setIdentity(CLIENT, { role: "customer", is_active: true });
      const res = await middleware(request("/dashboard", { user: CLIENT, cookie: true }));
      assert.equal(res.status, 307, "an unknown role must not be treated as staff");
      assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
    });

    test("a NULL role grants nothing", async () => {
      setIdentity(CLIENT, { role: null, is_active: true });
      const res = await middleware(request("/api/customers", { user: CLIENT, cookie: true }));
      assert.equal(res.status, 403);
    });

    test("an INACTIVE account is refused", async () => {
      setIdentity(CLIENT, { role: "admin", is_active: false });
      const res = await middleware(request("/dashboard", { user: CLIENT, cookie: true }));
      assert.equal(res.status, 307);
      assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
    });

    test("an unreadable role (REST error) refuses the ERP API", async () => {
      currentUser = ADMIN;
      currentRow = { role: "admin", is_active: true };
      restFails = true;
      const res = await middleware(request("/api/customers", { user: ADMIN, cookie: true }));
      assert.equal(res.status, 403, "a failed role read must deny, not allow");
    });

    test("an anonymous caller is redirected to the matching sign-in door", async () => {
      setIdentity(null, null);
      const erp = await middleware(request("/dashboard"));
      assert.equal(new URL(erp.headers.get("location")!).pathname, "/login");
      const console_ = await middleware(request("/super-admin"));
      assert.equal(new URL(console_.headers.get("location")!).pathname, "/super-admin-login");
    });

    test("an anonymous caller is refused a protected API with 401", async () => {
      setIdentity(null, null);
      const res = await middleware(request("/api/customers"));
      assert.equal(res.status, 401);
    });
  });

  // ======================= PUBLIC SURFACE UNCHANGED =======================
  describe("the public surface is untouched", () => {
    test("marketing and portal pages stay reachable anonymously", async () => {
      setIdentity(null, null);
      for (const p of [
        "/",
        "/login",
        "/signup",
        "/customer-login",
        "/super-admin-login",
        "/pricing",
        "/features",
        "/faq",
        "/privacy",
        "/terms",
        "/erp",
        "/fleet",
        "/cars/abc-123",
        "/access-denied",
      ]) {
        const res = await middleware(request(p));
        assert.notEqual(res.status, 401, `${p} must stay public`);
        assert.notEqual(res.status, 307, `${p} must not be redirected`);
      }
    });

    test("public APIs stay reachable anonymously", async () => {
      setIdentity(null, null);
      for (const p of ["/api/public/vehicles", "/api/public/company-profile", "/api/saas/signup", "/api/customer-signup"]) {
        const res = await middleware(request(p));
        assert.notEqual(res.status, 401, `${p} must stay public`);
        assert.notEqual(res.status, 403, `${p} must stay public`);
      }
    });

    test("/api/me is reachable by ANY authenticated identity (login depends on it)", async () => {
      setIdentity(CLIENT, { role: "client", is_active: true });
      const asClient = await middleware(request("/api/me", { user: CLIENT, cookie: true }));
      assert.equal(asClient.status, 200, "the customer login flow must be able to read /api/me");
      setIdentity(SUPER, { role: "super_admin", is_active: true });
      const asSuper = await middleware(request("/api/me", { user: SUPER, cookie: true }));
      assert.equal(asSuper.status, 200, "the operator login flow must be able to read /api/me");
    });
  });

  // ======================= SIGN-IN DOORS =================================
  describe("sign-in doors are resolved by area", () => {
    test("an anonymous customer is sent to the CUSTOMER door, not the ERP login", async () => {
      setIdentity(null, null);
      const res = await middleware(request("/customer-dashboard"));
      assert.equal(
        new URL(res.headers.get("location")!).pathname,
        "/customer-login",
        "a customer must be sent to the portal sign-in, which refuses non-customer accounts",
      );
    });

    test("the ERP and platform doors are unchanged", () => {
      assert.equal(loginPathForArea("erp"), "/login");
      assert.equal(loginPathForArea("platform"), "/super-admin-login");
      assert.equal(loginPathForArea("customer"), "/customer-login");
      assert.equal(loginPathForArea(null), "/login");
    });
  });
});

/**
 * The customer portal accepts a `?redirect=` target, which is caller input. A
 * naive `startsWith("/")` check would still allow `//evil.com` (protocol
 * relative) or `/\evil.com` (backslash) and turn the portal into an open
 * redirect used for phishing. It must also refuse to bounce a customer at the
 * ERP. Pure function, so the cases are exhaustive and cheap.
 */
describe("Exec 69 - customer redirect target is sanitised (no open redirect)", () => {
  test("honours a same-origin customer path", () => {
    assert.equal(safeCustomerRedirect("/customer-dashboard?tab=booking&car=7"), "/customer-dashboard?tab=booking&car=7");
    assert.equal(safeCustomerRedirect("/customer-dashboard"), "/customer-dashboard");
    assert.equal(safeCustomerRedirect("/booking"), "/booking");
  });

  test("honours a public page", () => {
    assert.equal(safeCustomerRedirect("/cars/abc"), "/cars/abc");
    assert.equal(safeCustomerRedirect("/"), "/");
  });

  test("refuses an absolute or protocol-relative URL", () => {
    for (const evil of [
      "https://evil.example/phish",
      "http://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/\\\\evil.example",
      "javascript:alert(1)",
      "//evil.example/customer-dashboard",
    ]) {
      assert.equal(safeCustomerRedirect(evil), "/customer-dashboard", `${evil} must be refused`);
    }
  });

  test("refuses to bounce a customer at the ERP or the platform console", () => {
    assert.equal(safeCustomerRedirect("/dashboard"), "/customer-dashboard");
    assert.equal(safeCustomerRedirect("/settings/company"), "/customer-dashboard");
    assert.equal(safeCustomerRedirect("/super-admin"), "/customer-dashboard");
    assert.equal(safeCustomerRedirect("/api/customers"), "/customer-dashboard");
  });

  test("falls back for an empty or absent target", () => {
    assert.equal(safeCustomerRedirect(null), "/customer-dashboard");
    assert.equal(safeCustomerRedirect(undefined), "/customer-dashboard");
    assert.equal(safeCustomerRedirect(""), "/customer-dashboard");
    assert.equal(safeCustomerRedirect("customer-dashboard"), "/customer-dashboard");
  });
});

/**
 * The area map is the single source of truth, so a drift between it and the
 * pages on disk is a real risk: a new ERP page that nobody classified would be
 * served to a customer. This asserts that every top-level `src/app` route is
 * classified (public, customer, erp or platform) rather than silently omitted.
 */
describe("Exec 69 - every top-level app route is deliberately classified", () => {
  const appDir = path.join(process.cwd(), "src", "app");
  const routeDirs = fs
    .readdirSync(appDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("(") && !e.name.startsWith("_"))
    .map((e) => e.name);

  /** Top-level route groups that actually render a page or an API handler. */
  const routes = routeDirs
    .map((name) => ({ name, dir: path.join(appDir, name) }))
    .filter(({ dir }) => fs.existsSync(path.join(dir, "page.tsx")) || fs.existsSync(path.join(dir, "route.ts")))
    .map(({ name }) => name);

  test("no top-level route is left undecided", () => {
    const undecided = routes.filter((name) => {
      const p = `/${name}`;
      if (areaForPath(p) !== null) return false; // gated: erp / customer / platform
      if (isPublicPath(p)) return false; // deliberately public
      // `api` is the route-handler tree, gated per-path by `apiAccessForPath`.
      if (name === "api") return false;
      return true;
    });
    assert.deepEqual(
      undecided,
      [],
      "a top-level route that is neither gated nor explicitly public must be classified in access-areas.ts",
    );
  });

  test("every ERP route on disk is gated", () => {
    const erp = ["dashboard", "financial-dashboard", "accounting", "reports", "sales", "purchases", "purchase-orders", "rentals", "cars", "customers", "suppliers", "supplier-payments", "supplier-statements", "invoices", "payments", "expenses", "quotations", "loans", "credits", "maintenance", "hr", "settings", "employee-portal", "onboarding"];
    for (const name of erp) {
      if (!routes.includes(name)) continue; // route not present in this build
      assert.equal(areaForPath(`/${name}`), "erp", `/${name} must be an ERP area`);
    }
  });

  test("the customer portal and the platform console are gated to their own area", () => {
    for (const name of ["customer-dashboard", "booking"]) {
      if (!routes.includes(name)) continue;
      assert.equal(areaForPath(`/${name}`), "customer", `/${name} must be the customer area`);
    }
    if (routes.includes("super-admin")) {
      assert.equal(areaForPath("/super-admin"), "platform");
    }
  });
});
