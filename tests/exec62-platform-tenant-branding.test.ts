import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  PLATFORM_BRANDING,
  sanitizeAssetUrl,
  sanitizeName,
  tenantBrandingFromProfile,
} from "../src/lib/branding/platform.ts";
import { loadTenantPlan } from "../src/lib/saas/tenant-plan.ts";
import { loadDocumentTemplates } from "../src/lib/templates/document-template-store.ts";
import {
  applyTenantScope,
  brandingTenantForWrite,
  loadCompanyProfile,
  resolveDocumentBranding,
  resolvePlatformBranding,
  resolvePublicTenantBranding,
  resolveTenantBranding,
} from "../src/lib/branding/resolve.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Comments explain the fix and legitimately name the very patterns they warn
 * about, so structural assertions must run against code only. String literals
 * are preserved (routes and keys live there).
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Execution 62 — platform vs tenant (white-label) identity.
 *
 * The defect this suite guards against was observed on production: the SPEED
 * marketing homepage rendered a subscriber's company name
 * (`Jameel- TESTING opening account 3 OCT`). The cause was a `settings` read with
 * no tenant filter and `.limit(1)` — `settings` is tenant-owned, so "the first
 * row" is simply whichever tenant the database returned first.
 *
 * A static check alone cannot catch that class of bug (the code looks fine), so
 * the resolver is exercised against a recording stub that APPLIES the filters it
 * is given and returns only matching rows — exactly like PostgREST.
 */

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

type Row = { tenant_id: string | null; key: string; value: unknown };

/**
 * A minimal PostgREST-like stub: it records every filter and returns only the
 * rows that satisfy them. An unfiltered read returns everything, which is how the
 * production defect produced a foreign company's profile.
 */
function makeDb(rows: Row[]) {
  const calls: string[] = [];
  const matches = (row: Row, filters: Array<{ op: string; column: string; value: unknown }>) =>
    filters.every((f) =>
      f.op === "is" ? row[f.column as keyof Row] === null : row[f.column as keyof Row] === f.value,
    );

  return {
    calls,
    from(table: string) {
      const filters: Array<{ op: string; column: string; value: unknown }> = [];
      const api = {
        select(columns: string) {
          calls.push(`${table}.select(${columns})`);
          return api;
        },
        eq(column: string, value: unknown) {
          filters.push({ op: "eq", column, value });
          calls.push(`eq(${column}=${String(value)})`);
          return api;
        },
        is(column: string, value: null) {
          filters.push({ op: "is", column, value });
          calls.push(`is(${column}=null)`);
          return api;
        },
        limit(count: number) {
          calls.push(`limit(${count})`);
          return api;
        },
        async maybeSingle() {
          const found = rows.filter((r) => matches(r, filters));
          return { data: found.length ? { value: found[0].value } : null, error: null };
        },
        then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve({
            data: rows.filter((r) => matches(r, filters)).map((r) => ({ value: r.value })),
            error: null,
          }).then(resolve);
        },
      };
      return api;
    },
  };
}

// ---------------------------------------------------------------------------
// The reported defect, reproduced and closed
// ---------------------------------------------------------------------------

describe("Exec 62 — the marketing homepage cannot render a subscriber's identity", () => {
  test("a tenant-less read returns the NULL-tenant profile, not another tenant's", async () => {
    const db = makeDb([
      { tenant_id: TENANT_A, key: "company_profile", value: { name: "Jameel- TESTING opening account 3 OCT" } },
      { tenant_id: null, key: "company_profile", value: { name: "Single Install Co" } },
    ]);
    const profile = await loadCompanyProfile(db as never, null);
    assert.equal(profile?.name, "Single Install Co", "a tenant-less caller must never see TENANT_A's name");
    assert.ok(db.calls.some((c) => c === "is(tenant_id=null)"), "the scope must be applied as IS NULL");
  });

  test("tenant A's read returns A, and tenant B's read returns B — never each other", async () => {
    const db = makeDb([
      { tenant_id: TENANT_A, key: "company_profile", value: { name: "SPEED Rentals" } },
      { tenant_id: TENANT_B, key: "company_profile", value: { name: "Harbour Motors" } },
    ]);
    assert.equal((await loadCompanyProfile(db as never, TENANT_A))?.name, "SPEED Rentals");
    assert.equal((await loadCompanyProfile(db as never, TENANT_B))?.name, "Harbour Motors");
  });

  test("every profile read is tenant-scoped — there is no unscoped path", async () => {
    const db = makeDb([{ tenant_id: TENANT_A, key: "company_profile", value: { name: "A" } }]);
    await loadCompanyProfile(db as never, TENANT_A);
    assert.ok(
      db.calls.some((c) => c === `eq(tenant_id=${TENANT_A})`),
      "the tenant filter must reach the query",
    );
  });

  test("the public company-profile route never falls back to the first row", () => {
    const route = code(read("src/app/api/public/company-profile/route.ts"));
    // The scope is applied by the shared helper, which is what removes the
    // `.limit(1)`-with-no-filter shape that caused the defect.
    assert.match(route, /applyTenantScope\(/, "the route must scope by tenant");
    assert.doesNotMatch(
      route,
      /\.select\(["'`]value["'`]\)\s*\.eq\(["'`]key["'`],\s*["'`]company_profile["'`]\)\s*\.limit\(1\)\s*(?:\.maybeSingle\(\))?\s*;/,
      "an unscoped key+limit(1) read is the defect",
    );
    assert.match(route, /if \(!tenant\)/, "a missing tenant must short-circuit");
    assert.match(route, /data: null/, "a missing tenant must yield no company");
  });

  test("the platform identity is a constant, not a database row", () => {
    const platform = resolvePlatformBranding();
    assert.equal(platform.isPlatform, true);
    assert.equal(platform.source, "platform");
    assert.equal(platform.name, "SPEED");
    // The module that defines it must not import anything: it is used by client
    // components and must not drag `server-only` (or a DB client) into the bundle.
    const source = read("src/lib/branding/platform.ts");
    assert.doesNotMatch(source, /^\s*import\s/m, "platform.ts must stay dependency-free");
  });

  test("the platform branding route serves the constant and takes no input", () => {
    const route = code(read("src/app/api/public/platform-branding/route.ts"));
    assert.match(route, /PLATFORM_BRANDING/);
    assert.doesNotMatch(route, /searchParams/, "the platform identity must not be parameterised");
    assert.doesNotMatch(route, /supabase/, "the platform identity must not read the database");
  });
});

// ---------------------------------------------------------------------------
// Public marketing chrome
// ---------------------------------------------------------------------------

describe("Exec 62 — public marketing chrome shows the platform, never a company", () => {
  for (const file of ["src/components/PublicNavbar.tsx", "src/app/contact/page.tsx"]) {
    test(`${file} uses the platform constant`, () => {
      const source = code(read(file));
      assert.match(source, /PLATFORM_BRANDING/, `${file} must use the platform identity`);
      assert.doesNotMatch(
        source,
        /from\(['"]settings['"]\)/,
        `${file} must not read the tenant-owned settings table directly`,
      );
      assert.doesNotMatch(
        source,
        /api\/public\/company-profile/,
        `${file} must not fetch an unqualified company profile`,
      );
    });
  }

  test("no public marketing page reads the settings table for its brand", () => {
    const pages = ["src/app/page.tsx", "src/app/erp/page.tsx", "src/app/features/page.tsx"];
    for (const page of pages) {
      if (!fs.existsSync(path.join(ROOT, page))) continue;
      const source = code(read(page));
      assert.doesNotMatch(
        source,
        /from\(['"]settings['"]\)/,
        `${page} must not read the tenant-owned settings table`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Tenant dashboard identity
// ---------------------------------------------------------------------------

describe("Exec 62 — a tenant dashboard shows its own company", () => {
  const layout = code(read("src/components/DashboardLayout.tsx"));

  test("the dashboard resolves its brand server-side from the session", () => {
    assert.match(layout, /\/api\/branding\/company/, "branding must come from the guarded route");
    assert.match(layout, /brand\?\.name \|\| t\.appName/, "the company name must fall back to the platform name");
  });

  test("the sidebar config read is tenant-scoped", () => {
    assert.match(layout, /readScopedSetting\(/, "the sidebar config must be read per tenant");
    assert.doesNotMatch(
      layout,
      /from\('settings'\)\s*\.select\('[*]'\)\s*\.eq\('key',\s*'sidebar_menu_v2'\)\s*\.single\(\)/,
      "an unscoped .single() read is the defect",
    );
  });

  test("the dashboard never reads its identity from browser storage or the URL", () => {
    assert.doesNotMatch(layout, /localStorage\.getItem\(['"][^'"]*(company|brand|tenant)/i);
    assert.doesNotMatch(layout, /searchParams\.get\(['"](tenant|tenant_id|company)['"]\)/);
  });
});

// ---------------------------------------------------------------------------
// Branding writes are tenant-authoritative
// ---------------------------------------------------------------------------

describe("Exec 62 — branding writes cannot cross a tenant boundary", () => {
  const route = code(read("src/app/api/branding/company/route.ts"));

  test("the tenant comes from the session, never the body", () => {
    assert.match(route, /requireContext\(/, "the route must be authenticated");
    assert.match(route, /context\.tenantId/, "the tenant must come from the context");
    assert.doesNotMatch(route, /body\.tenant_id/, "the body must never supply the tenant");
  });

  test("the platform operator has no company branding to edit", () => {
    assert.match(route, /brandingTenantForWrite\(/);
    const denied = brandingTenantForWrite({ tenantId: null, isSuperAdmin: true });
    assert.equal(denied.ok, false, "a super admin holds no company");
  });

  test("a company admin writes its own company only", () => {
    const allowed = brandingTenantForWrite({ tenantId: TENANT_A, isSuperAdmin: false });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.ok === true && allowed.tenantId, TENANT_A);
  });

  test("the write is scoped by tenant and never by key alone", () => {
    assert.match(route, /eq\("tenant_id", tenantId\)/, "the update must be scoped by tenant");
    assert.match(route, /is\("tenant_id", null\)/, "the NULL tenant must be scoped explicitly");
    assert.doesNotMatch(route, /onConflict:\s*["']key["']/, "a key-only conflict target crosses tenants");
  });

  test("every stored branding field is sanitised", () => {
    for (const fn of ["sanitizeName", "sanitizeAssetUrl", "sanitizeContact"]) {
      assert.match(route, new RegExp(fn), `${fn} must be applied`);
    }
  });

  test("the settings editor writes per tenant, not with a bare key conflict target", () => {
    const page = code(read("src/app/settings/company/page.tsx"));
    assert.match(page, /writeScopedSetting\(/, "the editor must write per tenant");
    assert.doesNotMatch(page, /onConflict:\s*['"]key['"]/, "a key-only upsert lets one tenant overwrite another");
    assert.match(page, /api\/me/, "the tenant must come from the session");
  });
});

// ---------------------------------------------------------------------------
// Sanitisers (pure)
// ---------------------------------------------------------------------------

describe("Exec 62 — branding sanitisers", () => {
  test("only same-origin paths and https URLs may become a brand asset", () => {
    assert.equal(sanitizeAssetUrl("/logo.png"), "/logo.png");
    assert.equal(sanitizeAssetUrl("https://cdn.example.com/a.png"), "https://cdn.example.com/a.png");
    assert.equal(sanitizeAssetUrl("javascript:alert(1)"), null);
    assert.equal(sanitizeAssetUrl("data:image/svg+xml,<svg/>"), null);
    assert.equal(sanitizeAssetUrl("http://insecure.example.com/a.png"), null);
    assert.equal(sanitizeAssetUrl("//evil.example.com/a.png"), null);
  });

  test("a name is a short single-line string or nothing", () => {
    assert.equal(sanitizeName("  Harbour   Motors  "), "Harbour Motors");
    assert.equal(sanitizeName(""), null);
    assert.equal(sanitizeName("x".repeat(121)), null);
    assert.equal(sanitizeName(42), null);
  });

  test("a tenant identity falls back per field, never to another company", () => {
    const brand = tenantBrandingFromProfile({ name: "Harbour Motors" });
    assert.equal(brand.name, "Harbour Motors");
    assert.equal(brand.isPlatform, false);
    assert.equal(brand.source, "tenant");
    // An absent field falls back to the platform default, not to "a" company.
    assert.equal(brand.email, PLATFORM_BRANDING.email);
  });

  test("a company with no usable name resolves to null, not to the platform name", async () => {
    const db = makeDb([{ tenant_id: TENANT_A, key: "company_profile", value: { phone: "1234" } }]);
    assert.equal(await resolveTenantBranding(db as never, TENANT_A), null);
  });

  test("public tenant branding refuses an unverified (absent) tenant", async () => {
    const db = makeDb([{ tenant_id: TENANT_A, key: "company_profile", value: { name: "A" } }]);
    assert.equal(await resolvePublicTenantBranding(db as never, null), null);
  });

  test("document branding uses the transaction's company", async () => {
    const db = makeDb([
      { tenant_id: TENANT_A, key: "company_profile", value: { name: "SPEED Rentals" } },
      { tenant_id: TENANT_B, key: "company_profile", value: { name: "Harbour Motors" } },
    ]);
    const doc = await resolveDocumentBranding(db as never, TENANT_B);
    assert.equal(doc.nameAr, "Harbour Motors", "a document must carry its own company's identity");
  });

  test("document branding falls back to the platform document name when unset", async () => {
    const db = makeDb([]);
    const doc = await resolveDocumentBranding(db as never, TENANT_A);
    assert.match(doc.nameEn, /SPEED/);
  });
});

// ---------------------------------------------------------------------------
// The scope helper itself
// ---------------------------------------------------------------------------

describe("Exec 62 — the scope helper is fail-closed", () => {
  test("a null tenant scopes to IS NULL, never to 'everything'", () => {
    const calls: string[] = [];
    const query = {
      eq(column: string, value: string) { calls.push(`eq:${column}=${value}`); return query; },
      is(column: string, value: null) { calls.push(`is:${column}=${String(value)}`); return query; },
    };
    applyTenantScope(query, null);
    assert.deepEqual(calls, ["is:tenant_id=null"]);
  });

  test("a real tenant scopes with equality", () => {
    const calls: string[] = [];
    const query = {
      eq(column: string, value: string) { calls.push(`eq:${column}=${value}`); return query; },
      is(column: string, value: null) { calls.push(`is:${column}=${String(value)}`); return query; },
    };
    applyTenantScope(query, TENANT_A);
    assert.deepEqual(calls, [`eq:tenant_id=${TENANT_A}`]);
  });
});

// ---------------------------------------------------------------------------
// The shared settings stores are fail-closed too
// ---------------------------------------------------------------------------

describe("Exec 62 — every settings-backed store is fail-closed", () => {
  /**
   * A settings stub that RECORDS the tenant predicate it received and returns
   * rows accordingly. A store that forgets the filter reads every tenant's row,
   * which is how a subscriber's name reached the platform homepage.
   */
  function recordingSettings(rows: Array<{ key: string; tenant_id: string | null; value: unknown }>) {
    const seen: Array<{ column: string; value: unknown; op: string }> = [];
    const db = {
      seen,
      from(table: string) {
        assert.equal(table, "settings");
        return {
          select(_columns: string) {
            let keyFilter: string | null = null;
            const filters: Array<{ op: string; column: string; value: unknown }> = [];
            const q: any = {
              eq(column: string, value: unknown) {
                filters.push({ op: "eq", column, value });
                seen.push({ column, value, op: "eq" });
                if (column === "key") keyFilter = String(value);
                return q;
              },
              is(column: string, value: null) {
                filters.push({ op: "is", column, value });
                seen.push({ column, value, op: "is" });
                return q;
              },
              async maybeSingle() {
                const found = rows.find(
                  (r) =>
                    r.key === keyFilter &&
                    filters.every((f) =>
                      f.op === "is" ? r.tenant_id === null : r.tenant_id === f.value,
                    ),
                );
                return { data: found ? { value: found.value } : null, error: null };
              },
            };
            return q;
          },
          async upsert() {
            return { error: null };
          },
        };
      },
    };
    return db;
  }

  test("a tenant-less read scopes to IS NULL, never to every tenant", async () => {
    const rows = [
      { key: "tenant_plan", tenant_id: TENANT_A, value: "premium" },
      { key: "tenant_plan", tenant_id: null, value: "free" },
    ];
    const db = recordingSettings(rows);
    const plan = await loadTenantPlan(db as never, null);
    assert.equal(plan, "free", "the NULL-tenant install must read its own plan, not TENANT_A's");
    assert.ok(
      db.seen.some((f) => f.op === "is" && f.column === "tenant_id"),
      "the read must be scoped with IS NULL",
    );
    assert.ok(
      !db.seen.some((f) => f.op === "eq" && f.column === "tenant_id" && f.value === TENANT_A),
      "a tenant-less caller must not filter to another tenant",
    );
  });

  test("the document template store scopes a tenant-less read", async () => {
    const db = recordingSettings([{ key: "document_templates", tenant_id: null, value: [] }]);
    await loadDocumentTemplates(db as never, null);
    assert.ok(
      db.seen.some((f) => f.op === "is" && f.column === "tenant_id"),
      "the template store must scope a tenant-less read with IS NULL",
    );
  });

  test("no settings store keeps the fail-open `if (tenantId)` guard", () => {
    const stores = [
      "src/lib/ai/settings.ts",
      "src/lib/ai/dev-requests.ts",
      "src/lib/saas/tenant-plan.ts",
      "src/lib/templates/document-template-store.ts",
      "src/lib/reporting/templates.ts",
    ];
    for (const store of stores) {
      const source = read(store);
      assert.doesNotMatch(
        source,
        /if \(tenantId\) query = query\.eq\("tenant_id", tenantId\)/,
        `${store} must not leave a tenant-less caller unfiltered`,
      );
      assert.match(source, /scopeToTenantColumn/, `${store} must use the shared fail-closed scope`);
    }
  });
});
