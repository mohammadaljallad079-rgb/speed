# SPEED ERP — EXECUTION 06 REPORT
## Post-Production Audit + ERP Gap Completion + Public SaaS Website + Free Account

Date: 2026-09-30
Branch: `main`
Scope: incremental work on the existing codebase. No rebuild, no duplicate
services, no RLS weakening, no inventory.

---

## 1. Executive summary

Execution 06 delivered the three highest-impact genuine gaps that the Phase 0
audit found, all integrated with the existing architecture:

1. **Public SPEED ERP SaaS website** — a real marketing surface at `/`, plus
   `/features`, `/solutions`, `/pricing`, `/faq`, `/privacy`, `/terms`, with a
   dedicated marketing navbar/footer, SEO metadata, and Arabic (RTL) /
   English (LTR) support.
2. **Free SaaS account signup** — a public, server-authoritative route
   (`/api/saas/signup`) that creates a brand-new tenant and makes the signer the
   `admin` of that new tenant only. The browser can never choose its `tenant_id`,
   `role` or `company_id`.
3. **Tenant onboarding** — an authenticated, tenant-scoped wizard
   (`/onboarding` + `/api/saas/onboarding`) that provisions company name,
   business info, a default financial year and an optional branch.

`expenses.branch_id` was investigated and **deliberately not added** — it is not
required by the existing architecture (see §5/§6).

Nothing in the completed baseline (accounting core, sales lifecycle, Excel
engine, RLS, auth/RBAC) was replaced. The central `postJournalEntry` accounting
service, the `src/lib/sales/service.ts` lifecycle, and `src/lib/excel/*` were
reused, not duplicated. **No new accounting, Excel, auth or RBAC system was
created.**

---

## 2. Existing functionality found (source of truth = the code)

- **Auth/RBAC/tenant core** — `src/lib/auth/*`: `resolveAuthContext`,
  `withAuth`/`withAuthResponse`/`requireContext` (api-guard), pure policy
  (`can`, `scopeToTenant`, `assertWritableTenant`, `assertBranchAccess`,
  `assertDateInOpenFinancialYear`, `sanitizeMetadata`), `assertReference*`
  (cross-tenant FK guards), `assertTenantOwnership`, `logAudit`.
- **Central accounting** — `src/lib/accounting/posting.ts` (`postJournalEntry`,
  `validateJournalLines`, `resolveAccountIds`, `applyLineBalances`).
- **Sales lifecycle** — `src/lib/sales/service.ts`
  (`createSalesInvoice`, `recordPayment`, `createSalesReturn`), posting through
  the central service with `sourceKey` duplicate guards.
- **Universal Excel engine** — `src/lib/excel/*` (18 modules).
- **Documents numbering** — `src/lib/documents/numbering.ts`.
- **DB capability probes** — `src/lib/db/columns.ts` (`hasColumn`,
  `insertTolerant`).
- **Middleware** — `src/middleware.ts` (session refresh + coarse `/api/*` gate).
- **RLS migrations** — `supabase/migrations/001..003` + the applied production
  activation package.
- **Existing public surface (car-rental site)** — `/fleet`, `/services`,
  `/contact`, `PublicNavbar`, `/customer-login`, `/customer-signup`, and the
  sanctioned public routes `/api/public/vehicles`, `/api/public/company-profile`.
- **Existing tests** — 17 files (core, accounting, excel, sales, session
  context, tenant isolation).

Live production schema was inspected (75 tables) to confirm the columns the new
code writes: `tenants(id,name,name_en,created_at)`,
`branches(id,name,location,tenant_id,created_at)`,
`financial_years(id,name,start_date,end_date,is_current,status,tenant_id)`,
`settings(id,key,value,updated_at,tenant_id)`, `users(...,role,tenant_id,...)`.

---

## 3. Production RLS verification

Re-verified against the live database during this execution:

- `anon` direct reads are **denied** on `customers`, `invoices`, `users`,
  `accounts`, `journal_entries`, `expenses`, `tenants` → `42501 permission denied`.
- Public marketing reads continue to work through the sanctioned server routes
  with explicit safe projections (`/api/public/vehicles` → 200 for anon).
- The new signup/onboarding work does **not** change RLS and does **not** make
  any ERP table publicly readable. The service-role client is used only inside
  the validated signup/onboarding routes, always with server-generated ownership.

---

## 4. Post-RLS problems discovered

- **No SaaS account provisioning existed at all.** `/signup` did not exist, no
  code path created a `tenants` row, and the only public signup
  (`/api/customer-signup`) creates a `client` of the *existing* installation —
  it cannot create a tenant. → implemented.
- **No onboarding.** No `/onboarding`; a new account had no way to set a company
  or a financial year. → implemented.
- **Public site was a car-rental site, not a SaaS site.** The home page sold
  rentals and the CTAs pointed to `/customer-login`. No `/features`, `/solutions`,
  `/pricing`, `/faq`, `/privacy`, `/terms`. → implemented.
- **SEO metadata said "Speed Application — Car Rental & Sales System".** →
  updated to SPEED ERP SaaS metadata with OpenGraph/Twitter.

No application workflow was found to be silently relying on unrestricted DB
access: every privileged route already calls a guard (verified by the existing
"every service-role route calls an authorization guard" test, extended here).

---

## 5. ERP gaps discovered

| Gap | Finding | Action |
| --- | --- | --- |
| SaaS signup / tenant creation | Missing entirely | Implemented |
| Tenant onboarding | Missing entirely | Implemented |
| Public SaaS pages | Missing | Implemented |
| SEO metadata | Car-rental oriented | Updated |
| `expenses.branch_id` | Column absent | **Not added** — see below |
| Subscription/plan tables | None exist in DB | Minimal static free-plan foundation only (no billing system) |

### `expenses.branch_id` — investigated, not implemented

Evidence that branch-level expense support is **not** required by the existing
architecture:

- `expenses` already has a **free-text `branch`** column that the expense API
  accepts and stores (`src/app/api/expenses/route.ts` `ALLOWED_FIELDS` includes
  `branch`; the page writes `branch: branchId`).
- `branch_id` is referenced **nowhere** else: not in the expenses service/API,
  not in reports, not in any RLS policy, not in the sales/accounting services.
- `REF_BRANCH` exists in the reference catalogue but is not used by the expense
  flow.

Adding `branch_id` would introduce a second, competing branch column and a new
FK with no consumer — i.e. churn without benefit. Per the explicit instruction
("Only implement it if branch-level expense support is genuinely required"),
it was **left unchanged**. This is a documented decision, not an omission.

---

## 6. ERP fixes implemented

1. **`/api/saas/signup`** (public, new): validates the payload, rejects a
   duplicate email *before* creating anything, creates the auth user, creates a
   **new** tenant, inserts the profile as `role: "admin"` **of that new tenant**,
   provisions a default financial year, and writes an audit event. Any partial
   failure rolls back the auth user and the tenant. Returns no internal ids.
2. **`/api/saas/onboarding`** (authenticated admin, new): resolves the tenant from
   the session via `requireContext(request, { requireAdmin: true })`, then writes
   company name, business info (`settings.company_profile`), a default financial
   year (only when absent) and an optional branch — each `.eq("tenant_id", tenantId)`.
   Idempotent; every step optional.
3. **`src/lib/saas/provisioning.ts`** (new, pure): `validateSignup`,
   `validateOnboarding`, `defaultFinancialYear`, `FREE_PLAN`. No infrastructure
   imports, so the rules are unit-testable and server-authoritative.
4. **Middleware**: added `/api/saas/signup` to `PUBLIC_API_PREFIXES`. Onboarding
   stays behind the auth gate.

---

## 7. Public website changes

- **`/` (rebuilt as SaaS landing)** — hero ("Run Your Business Smarter with
  SPEED ERP" / "أدر أعمالك بذكاء مع SPEED ERP"), Why, Core modules (14 real
  modules), How it works, Free plan ($0), Security, a real-UI-style dashboard
  preview (no fake screenshots/statistics/logos/testimonials), FAQ, CTA.
  Primary CTA → `/signup`; secondary → `/login`.
- **`/features`, `/solutions`, `/pricing`, `/faq`, `/privacy`, `/terms`** (new).
  Pricing shows only the real **FREE $0** plan; paid plans are explicitly
  "coming soon / contact us" — no invented prices, no fake payment flow.
- **`src/components/MarketingNavbar.tsx`** and **`MarketingFooter.tsx`** (new):
  responsive, bilingual, mobile hamburger, no admin routes exposed.
- **`/login`**: added "Forgot password?" (existing Supabase
  `resetPasswordForEmail`) and a "Start Free" link; the existing admin login
  mechanism is unchanged.
- **`src/app/layout.tsx`**: SPEED ERP title template, description, keywords,
  OpenGraph, Twitter card, favicon.
- The existing car-rental pages (`/fleet`, `/services`, `/contact`) and their
  `PublicNavbar` were left intact.

No inventory feature is advertised anywhere.

---

## 8. Free SaaS signup implementation

Public flow: `/` → "ابدأ مجانًا" → `/signup` → `POST /api/saas/signup`
(creates auth user + **new tenant** + admin profile + default financial year) →
browser `signInWithPassword` (cookie session via `createBrowserAuthClient`) →
`/onboarding` → `/dashboard`.

Security properties (all enforced server-side):

- The body supplies only name/email/password/company/phone.
- `tenant_id`, `role`, `company_id`, `user_id` are **never** read from the body
  (asserted by test).
- The role is a literal `admin` of the newly created tenant only — a public
  signup can never become a global/super admin and can never join an existing
  tenant.
- Duplicate email → `409 email_taken`, checked before any user/tenant is created.
- Password confirmation and minimum length enforced; field-level, user-safe errors.
- Failed provisioning rolls back auth user + tenant.
- The response never returns internal identifiers.

---

## 9. Tenant onboarding

`/onboarding` wizard (4 steps + skip): Company name → Business info →
Financial year → Optional branch. Each step persists through the authenticated
`/api/saas/onboarding` route; "Skip to dashboard" is always available so the
operator is never forced through configuration. A default financial year is
provisioned even if every step is skipped, so posting works immediately.

---

## 10. Plan / subscription behavior

No subscription or plan table exists in the database. Per instruction, **no
billing system was created.** Only a minimal static free-plan foundation exists
(`FREE_PLAN` in `src/lib/saas/provisioning.ts`): `price: 0`,
`requiresPaymentMethod: false`, and a feature list restricted to modules that
actually exist (no inventory). Paid plans are shown as "coming soon" — paid
billing is **not** pretended to be implemented.

---

## 11. Database migrations

**None.** Execution 06 added **no** migration and did **not** touch the applied
production activation package. All new writes use columns that already exist in
the live schema (`tenants`, `branches`, `financial_years`, `settings`, `users`).
The production schema was inspected before implementation and the E2E writes were
verified against it.

---

## 12. Security changes

- New public route is narrowly scoped and server-authoritative; the auth gate
  allow-list was extended by exactly one prefix.
- No RLS change; verified `anon` still denied on sensitive tables after the work.
- No service-role key exposure; the service-role client stays server-only.
- Audit events written for signup (`tenants`/create) and onboarding
  (`tenants`/update), via the existing `logAudit`.
- `.env.local` remains untracked; no secret was printed in this report.

---

## 13. API changes

| Route | Class | Change |
| --- | --- | --- |
| `POST /api/saas/signup` | PUBLIC | **New** — creates a new tenant + admin profile + default FY |
| `POST /api/saas/onboarding` | AUTHENTICATED (admin) | **New** — tenant-scoped onboarding writes |
| `/api/public/*` | PUBLIC | unchanged |
| all other `/api/*` | AUTHENTICATED | unchanged |

---

## 14. UI changes

New: `/`, `/features`, `/solutions`, `/pricing`, `/faq`, `/privacy`, `/terms`,
`/signup`, `/onboarding`; `MarketingNavbar`, `MarketingFooter`.
Changed: `/login` (links only), `src/app/layout.tsx` (metadata).
Untouched: dashboard and all ERP module UIs.

---

## 15. Mobile verification

**NOT VERIFIED (device/browser).** The new pages use responsive Tailwind
(mobile-first grids, `sm:`/`md:`/`lg:` breakpoints, a hamburger menu, no fixed
widths, `flex-wrap` on the hero CTAs). No automated viewport testing was run, so
360/390/414/768/1024/1440 rendering is asserted **by construction only**.

---

## 16. RTL / LTR verification

Direction is applied via `dir={isRTL ? "rtl" : "ltr"}` on each new page root,
with logical spacing (`ms-*`, `text-start`) and mirrored arrows
(`rotate-180`). **NOT VERIFIED visually**; asserted by construction.

---

## 17. Test results

- **Full suite:** `379 tests, 373 pass, 0 fail, 6 skipped` (baseline 366 + 13 new).
- **New:** `tests/saas-signup.test.ts` — 13 tests, all pass (validation,
  onboarding year rules, free-plan invariants incl. "no inventory", and
  static assertions that the signup route creates a NEW tenant, never reads
  ownership from the body, hardcodes `admin`, rolls back, and that the
  onboarding route is admin-guarded and tenant-scoped).
- **Updated:** `tests/security-tenant-isolation.test.ts` allow-list extended with
  `/api/saas/signup` (with a rationale comment); the existing guard test still
  passes.
- `test:core` / `test:accounting` / `test:excel` / `test:sales` all remain green
  (subset of the full run).

---

## 18. TypeScript results

`tsc --noEmit`: **119 errors — all pre-existing**, identical to the recorded
baseline. **0 new errors.** Filtering the error list for every new/changed file
(`saas`, `Marketing*`, `signup`, `onboarding`, `features`, `solutions`,
`pricing`, `faq`, `privacy`, `terms`, `app/page.tsx`, `app/login/page.tsx`,
`middleware`, `layout.tsx`) returns **none**.

---

## 19. Build result

`npm run build`: **PASS**. All new routes are emitted (`/`, `/features`,
`/solutions`, `/pricing`, `/faq`, `/privacy`, `/terms`, `/signup`, `/onboarding`,
`/api/saas/signup`, `/api/saas/onboarding`). Pre-existing warning only: an
unrecognized `experimental.missingSuspenseWithCSRBailout` key in `next.config.js`
(not introduced here).

---

## 20. Production HTTP verification

**Local production-mode server (`next start`) — VERIFIED:**

- Public pages `/ /features /solutions /pricing /faq /privacy /terms /signup
  /login /onboarding` → **200**.
- Anonymous protected API (`/api/invoices /api/expenses /api/users /api/suppliers
  /api/saas/onboarding /api/excel/export`, GET and POST) → **401**.
- Anonymous `/api/public/vehicles` → **200** (public by design).
- Signup validation: empty body → `400` `validation_error` (fullName); bad email
  → `400` (email). No tenant created on validation failure.
- **Real E2E against live Supabase:** `POST /api/saas/signup` → `{success:true}`;
  a second identical call → `409 email_taken`; the new user row was
  `role=admin` with a **new** `tenant_id`; onboarding (authenticated via a real
  GoTrue session cookie) → `{success:true, applied:[company,business_info,branch]}`
  and the DB showed the tenant renamed, a branch, a `settings` company profile
  and a financial year — all scoped to that tenant. **All test rows were deleted
  afterwards** and the DB was confirmed back to its prior state.
- `anon` direct reads re-checked → still `42501 permission denied`.

**The actual deployed server** (`/var/www/speed.harbourconsultancies.com`,
PM2 `speed`, port 3090) was **NOT VERIFIED from this environment** — it is not
reachable here and no deployment was performed. The deployment must be updated
with these commits before the new pages/routes are live.

---

## 21. Remaining gaps

- Deploy the new commits to the production server (PM2 `speed`) and re-run the
  HTTP checks against `speed.harbourconsultancies.com`.
- Email verification for signup is currently bypassed (`email_confirm: true`) to
  keep the flow usable without SMTP; switch to verification if/when SMTP is
  configured.
- Paid plans / billing are not implemented (by design).
- No visual/device verification of mobile and RTL layouts.

---

## 22. Explicitly NOT implemented

- Inventory (stock, warehouses, movements, valuation, transfers, counts) — none.
- A new auth mechanism, accounting engine, sales service, Excel engine or RBAC
  system — none (all reused).
- Paid billing / payment processing — none.
- `expenses.branch_id` — deliberately not added (documented in §5).
- Changes to the applied production migration package — none.
- No RLS weakening; no ERP table made publicly readable.

---

## 23. Files changed

**Created**
- `src/lib/saas/provisioning.ts`
- `src/app/api/saas/signup/route.ts`
- `src/app/api/saas/onboarding/route.ts`
- `src/app/signup/page.tsx`
- `src/app/onboarding/page.tsx`
- `src/app/features/page.tsx`
- `src/app/solutions/page.tsx`
- `src/app/pricing/page.tsx`
- `src/app/faq/page.tsx`
- `src/app/privacy/page.tsx`
- `src/app/terms/page.tsx`
- `src/components/MarketingNavbar.tsx`
- `src/components/MarketingFooter.tsx`
- `tests/saas-signup.test.ts`
- `SPEED_EXECUTION_06_POST_PRODUCTION_SAAS_REPORT.md`

**Modified**
- `src/app/page.tsx` (replaced car-rental landing with the SPEED ERP SaaS landing)
- `src/app/login/page.tsx` (forgot-password + create-account links)
- `src/app/layout.tsx` (SEO metadata)
- `src/middleware.ts` (public allow-list + `/api/saas/signup`)
- `tests/security-tenant-isolation.test.ts` (allow-list + rationale)

---

## FINAL VERIFICATION SUMMARY

```
STATUS:

Execution 06:          PARTIAL
Public SaaS:           PASS (built + HTTP-verified locally; not verified on the deployed host)
Free Signup:           PASS (E2E verified against live Supabase, then cleaned up)
Tenant Onboarding:     PASS (E2E verified authenticated, tenant-scoped, then cleaned up)
ERP Gap Completion:    PARTIAL (the genuine gaps above; expenses.branch_id deliberately not added)
RLS:                   PASS (anon denied re-verified; no weakening)
Production HTTP:       PARTIAL (local production-mode server verified; deployed server NOT VERIFIED)

Tests:                 373 passed / 0 failed / 6 skipped (379 total)
Build:                 PASS
TypeScript:            119 errors (all pre-existing; 0 new)
Lint:                  PRE-EXISTING ISSUE (next lint tooling crash; not caused by these changes)

Remaining blockers:
- The new commits are not yet deployed to /var/www/speed.harbourconsultancies.com
  (PM2 `speed`); production HTTP verification of the deployed host is therefore
  NOT VERIFIED.
- Mobile/RTL rendering was not visually verified (no viewport testing here).
```
