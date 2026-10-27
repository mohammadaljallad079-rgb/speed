# SPEED ERP — Execution 62 Report
## Complete Platform Branding & Multi-Tenant White-Label Identity Fix

**Branch:** `feat/final-hardening-round5`
**Base (last confirmed pushed):** `c536858a6e629c495b4d3b6b294cfa54c1424bd0` (Exec 41) — ancestor of HEAD, verified with `merge-base --is-ancestor`
**Date:** 2026-10-24

---

## 0. Continuation point — verified, not assumed

This session continued an interrupted sandbox. The repository state was confirmed
against the local clone before any change:

| Fact | Value |
|---|---|
| Working branch | `feat/final-hardening-round5` |
| Local `HEAD` == `origin/feat/final-hardening-round5` | `38da915` (Exec 60 docs tip) |
| `c536858` (Exec 41, "last pushed") | **is an ancestor of HEAD** → 44 commits behind |
| Clone depth | full (`--is-shallow-repository` → `false`) |
| Working tree before this execution | clean |

So every previously completed execution (41 → 60) was already committed and
pushed. Nothing was recreated.

**Administrator accounts were not recreated or reset.** No provisioning script was
run. `scripts/provision-admin-accounts.mjs` was not invoked, and it never rotates
an existing password without `--rotate-passwords` in any case.

---

## 1. The defect

The SPEED marketing homepage rendered a **subscriber's company name**
(`Jameel- TESTING opening account 3 OCT`) as the platform's own brand.

Root cause: the platform's identity was read from the **tenant-owned** `settings`
table with no tenant filter.

```ts
// the shape that caused it
supabase.from('settings').select('value').eq('key', 'company_profile').maybeSingle()
```

`settings` is tenant-owned, so "the company profile" with no tenant scope is
whichever tenant's row the database returns first. The homepage — which belongs
to the SaaS provider, not to any subscriber — was therefore rendering a customer.

The same unscoped read/`onConflict: 'key'` write pair was replicated in several
other places, each of which could read or overwrite another tenant's settings.

---

## 2. The fix — one rule, applied everywhere

> **Platform identity is a constant. Tenant identity is resolved explicitly from
> an authoritative server-side source — the session, or a verified tenant
> parameter — and is scoped fail-closed.**

| Surface | Identity | Source |
|---|---|---|
| Marketing homepage, navbar, contact, `/erp` | platform (SPEED) | `PLATFORM_BRANDING` constant — **no database read at all** |
| Tenant dashboard / sidebar | the signed-in company | `/api/branding/company` (session-scoped) |
| `settings/company` editor | the signed-in company | `useTenantId()` → `/api/me`, then `readScopedSetting`/`writeScopedSetting` |
| Document / rental print branding | the issuing company | `resolveDocumentBranding(db, tenantId)` |
| A tenant's own public pages | the verified tenant only | `resolvePublicTenantBranding(db, tenantId)` |

### 2.1 The fail-closed predicate has exactly one definition

The platform already had a fail-closed `scopeToCompany`. Rather than add a second
copy for branding, the predicate was extracted once and every scoped read now
delegates to it:

```ts
// src/lib/auth/policy.ts
export function scopeToTenantColumn<T>(query: T, tenantId: string | null, column = "tenant_id"): T {
  const q = query as unknown as { eq: (c: string, v: string) => unknown; is: (c: string, v: null) => unknown };
  return (tenantId ? q.eq(column, tenantId) : q.is(column, null)) as T;
}
```

A tenant-less caller is scoped to `IS NULL` (the single-tenant install's own rows)
— never left unfiltered. A second copy of this predicate would be a second chance
to get it wrong, which is exactly how the original defect survived.

### 2.2 Files changed

**New**

- `src/lib/branding/platform.ts` — `PLATFORM_BRANDING` constant, `CompanyProfile`
  type, sanitisers. **Dependency-free** (asserted by test) so it is safe in client
  components and cannot drag `server-only` into the browser bundle.
- `src/lib/branding/resolve.ts` — `loadCompanyProfile`, `resolveTenantBranding`,
  `resolvePublicTenantBranding`, `resolveDocumentBranding`, `brandingTenantForWrite`,
  `applyTenantScope`. The DB is injected, so it is unit-testable.
- `src/lib/branding/settings-client.ts` — browser-safe `readScopedSetting` /
  `writeScopedSetting`.
- `src/lib/hooks/use-tenant-id.ts` — the single client way to learn the session's
  tenant (`ready` distinguishes "still resolving" from "resolved to no tenant").
- `src/app/api/public/platform-branding/route.ts` — serves the constant, reads no DB.
- `src/app/api/branding/company/route.ts` — session-authoritative tenant branding
  GET/POST via `requireContext` + `logAudit`.

**Rewritten / fixed**

- `src/app/api/public/company-profile/route.ts` — tenant is explicit and required;
  the `.limit(1)`-with-no-filter fallback is gone; a missing/unknown tenant yields
  `{ data: null }`; the catch no longer echoes a driver error.
- `src/components/PublicNavbar.tsx`, `src/app/contact/page.tsx` — use the constant;
  the Supabase client and the unscoped fetch were removed.
- `src/components/DashboardLayout.tsx` — brand from `/api/branding/company`;
  sidebar config via `readScopedSetting`.
- `src/app/settings/company/page.tsx`, `settings/integrations/whatsapp/page.tsx`,
  `settings/integrations/zoho/page.tsx`, `settings/sidebar/page.tsx` — scoped
  reads/writes; the cross-tenant `onConflict: 'key'` upsert is gone from all four.
- `src/app/rentals/new/page.tsx` — scoped `company_profile` read (was an unscoped
  `.single()`).
- `src/lib/ai/settings.ts`, `src/lib/ai/dev-requests.ts`, `src/lib/saas/tenant-plan.ts`,
  `src/lib/templates/document-template-store.ts`, `src/lib/reporting/templates.ts` —
  the fail-open `if (tenantId) query = query.eq(...)` guard replaced with the shared
  fail-closed helper. These are reachable with `tenantId === null`
  (`/api/ai/settings`, `/api/import`), so they were latent leaks, not theoretical.

---

## 3. Verification

### 3.1 Unit / structural — `tests/exec62-platform-tenant-branding.test.ts`

**30 tests, all passing.** Registered in `npm run test:core`.

The resolver is exercised against a **recording PostgREST-like stub** that applies
the filters it is given and returns only matching rows. A static check alone cannot
catch this class of bug — the faulty code looked fine — so the reported defect is
reproduced and closed:

- a tenant-less read returns the NULL-tenant profile, **not** another tenant's;
- tenant A reads A and tenant B reads B, never each other;
- a company with no usable name resolves to `null`, **not** to the platform name;
- every settings-backed store scopes a tenant-less read with `IS NULL` and none
  retains the fail-open guard.

### 3.2 Browser acceptance — `scripts/dev/e2e-exec62-branding.mjs`

**17/17 checks passed** against the real dev stack (`next dev` + the local Supabase
stub) with a real Chromium.

The stub seeds **two deliberately different** company names (`SPEED Rentals`,
`Harbour Motors`). A fixture where the names matched could not tell a leak from
correct behaviour.

```
PASS  platform branding endpoint returns the platform identity
PASS  platform branding is named SPEED — got SPEED
PASS  company-profile without a tenant returns no company — {"data":null}
PASS  company-profile with an unknown tenant returns no company — {"data":null}
PASS  / renders the SPEED platform brand
PASS  / does NOT render a subscriber company name
PASS  /contact renders the SPEED platform brand
PASS  /contact does NOT render a subscriber company name
PASS  /erp renders the SPEED platform brand
PASS  /erp does NOT render a subscriber company name
PASS  company A dashboard renders company A's name
PASS  company A dashboard does NOT render company B's name
PASS  company A's branding endpoint returns company A — got SPEED Rentals
PASS  company B dashboard renders company B's name
PASS  company B dashboard does NOT render company A's name
PASS  company B's branding endpoint returns company B — got Harbour Motors
PASS  the two companies resolve to different identities — SPEED Rentals vs Harbour Motors
```

The last check is the real cross-tenant proof: two signed-in tenants, two
different identities, neither seeing the other's.

### 3.3 Gates

| Gate | Result |
|---|---|
| `npm test` | **1261 tests / 1255 pass / 0 fail / 6 skipped** |
| `npm run typecheck` | **0 errors** |
| `npm run lint` | **No ESLint warnings or errors** |
| `npm run build` | **green** (placeholder Supabase env; the build needs the vars to collect page data) |
| `tests/public-api-routes.test.ts` (preserved) | **10/10 passing** |

The preserved production test constrains this work in two opposite directions: the
company-profile route must contain a literal `.eq("key", "company_profile")` **and**
must not expose `tenant_id`. Both are satisfied by having the route own the `.eq`
while the isolation column is applied by the shared helper.

---

## 4. Screenshots (real browser, committed)

Captured by driving the running app in headless Chromium. Committed to
`docs/screenshots/` and listed in `docs/screenshots/MANIFEST.json`. Each image is
distinct and non-blank (the capture pipeline fails rather than commit a duplicate).

| Shot | Proves | Link |
|---|---|---|
| Platform homepage | the platform brand, no subscriber name | [desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/exec62-public-home-platform-brand-desktop.png) · [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/exec62-public-home-platform-brand-mobile.png) |
| Public contact | the platform identity on a second public page | [desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/exec62-public-contact-platform-brand-desktop.png) · [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/exec62-public-contact-platform-brand-mobile.png) |
| Company A dashboard | tenant A renders **SPEED Rentals** | [desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/exec62-tenant-a-dashboard-desktop.png) |
| Company B dashboard | tenant B renders **Harbour Motors** | [desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/exec62-tenant-b-dashboard-desktop.png) |

The two dashboard images are byte-different and show different company names — the
visual counterpart of the cross-tenant assertion.

---

## 5. Invariants for future work

- **Platform identity is a constant.** Never read `settings` for the platform's own
  brand. `PLATFORM_BRANDING` is dependency-free on purpose.
- **`settings` is tenant-owned.** Every read and write carries a tenant. A write
  must never use `onConflict: 'key'` — that lets one tenant overwrite another.
  For a NULL tenant, do an explicit find-then-write: PostgreSQL treats NULLs as
  distinct, so `onConflict: "tenant_id,key"` cannot replace a NULL-tenant row.
- **One fail-closed predicate:** `scopeToTenantColumn` (`src/lib/auth/policy.ts`).
  A tenant-less caller is scoped to `IS NULL`, never left unfiltered. Do not
  reintroduce `if (tenantId) query = query.eq(...)`.
- **A client page learns its tenant only from `/api/me`** (via `useTenantId`), never
  from a form field, a cookie or localStorage.
- **The public company-profile route takes an explicit tenant** and has no "first
  row" fallback. Do not re-add one.
- **A public route must not echo a driver error** — it can name a table, column or host.

---

## 6. Scope and honesty

- Only branding/identity was changed. No accounting, posting, numbering or
  financial logic was touched.
- No migration was added or applied. No production database was contacted.
- No administrator account was created, reset or rotated.
- **Not verified from this environment:** the fix running against the live
  production database. The dev environment has placeholder Supabase credentials
  (`NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-…`) and cannot reach the live
  project, so verification was done against the local Supabase stub, which serves
  real HTTP and real JWTs. Live confirmation requires a deploy (an operator step).
- The live database still has migrations 001–007 unapplied; that is unchanged by
  this execution and remains an operator step.
