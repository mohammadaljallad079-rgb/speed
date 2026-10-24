# AGENTS.md

Repository-specific knowledge for AI agents working on this project.

## Project

Next.js 15 (App Router) + Supabase ERP for car rental and sales. Arabic/English UI
(`src/lib/LanguageContext.tsx`, `src/lib/i18n.ts`). Single repo, no monorepo.

## Commands

```bash
npm run dev          # dev server on :3000
npm run build        # production build
npm run typecheck    # tsc --noEmit
npm test             # all tests (node:test via tsx)
npm run test:core    # auth + tenant isolation
npm run test:excel   # Excel engine
```

### Known pre-existing failures (not caused by new work)

- `npm run typecheck` reports **125 errors** in the legacy ERP pages. This is the
  baseline; new code must not increase it. Verify with
  `npm run typecheck 2>&1 | grep -c "error TS"`.
- `npm run lint` currently passes clean (`next lint`). Historically it failed with
  `Converting circular structure to JSON` вҖ” a broken
  ESLint config, unrelated to source code. Lint is **not usable** as a gate here.

## Architecture that must not be bypassed

```
src/lib/auth/api-guard.ts   requireContext / withAuth вҖ” the only entry point for API auth
src/lib/auth/policy.ts      can(), tenant/branch/financial-year assertions (pure)
src/lib/auth/context.ts     resolveAuthContext, getActiveFinancialYear (server-only)
src/lib/auth/permissions.ts module x action catalogue
src/lib/auth/audit.ts       logAudit вҖ” sanitises metadata before writing
src/lib/supabase-admin.ts   service-role client (server-only)
```

Rules learned the hard way:

- **Never trust the request body for identity.** `tenant_id`, `branch`, `role` come
  from the session via `requireContext`, never from client input.
- **`resolveAuthContext` always starts from `DEFAULT_ROLE_PERMISSIONS[role]`** and
  only then merges DB overrides. A test that constructs a context with an empty
  permission map tests a state that cannot occur in production.
- **Split pure logic from DB-bound logic.** `policy.ts` (pure rules) vs
  `references.ts` (DB lookups), `api-guard.ts` (`requireContext`/`withAuth`)
  vs `scope.ts` (query scoping).
  Importing the `@/lib/auth` barrel pulls `server-only` and breaks client
  components. Import `policy.ts` / `errors.ts` / `types.ts` directly instead.
- **Tenant filters are applied before any narrowing filter**, so `ids`/`filters`
  can only reduce a result set, never widen it.

## Excel import/export engine (`src/lib/import/` + `src/lib/reporting/workbook.ts`)

The real, single Excel capability (there is **no** `src/lib/excel/` module):

- `src/lib/import/registry.ts` — `IMPORT_MODULES` specs (fields, labels, aliases,
  types, permissions, duplicate keys). Add a module here; nothing else hardcodes
  module knowledge.
- Import pipeline: `parse` → `mapHeaders` / `buildPreview` → `commitImport`
  (`src/lib/import/engine.ts`), with `template.ts` and `export.ts` helpers.
- Supported import modules are **exactly** `customers`, `suppliers`, `expenses`
  (verified in `registry.ts`). Do not claim any other module without evidence.
- Route: `POST /api/import` (guarded by `requireContext` + module permission).
  UI: `src/components/import/ExcelImportPanel.tsx`, page `settings/import`.
- Export: `src/lib/reporting/workbook.ts` (ExcelJS), used by the report pages and
  the dynamic report builder; templates come from `src/lib/reporting/templates.ts`.

> Note: earlier text in this file (and the "Execution 04" section below) referenced a
> `src/lib/excel/` engine with `ExcelModuleActions` / `/api/excel/*` and tests such as
> `excel-module-integration.test.ts`. **That engine does not exist**; the import engine
> above (Execution 25) is the single, real implementation.

### Database access from this environment

- DDL is **not executable** here: `DATABASE_URL`'s pooler region does not serve the
  project (every region returns `(ENOTFOUND) tenant/user postgres.<ref> not found`),
  `db.<ref>.supabase.co` does not resolve, and PostgREST exposes no `exec_sql` RPC.
  Migrations are delivered as files for an operator to apply, and their application
  is reported `NOT VERIFIED`.
- PostgREST **is** reachable with the service key, so the live schema and the current
  RLS state can be verified at the data level. A useful read-only probe: `GET
  /rest/v1/<table>?select=id&limit=1` with the anon key вҖ” a `content-range` header on
  a table that should be protected means RLS is not yet enabled.
- `supabase/migrations/001_core_security.sql` is **not applied** on the live project:
  `activity_logs` does not exist, the tenant-less tables still have no `tenant_id`,
  and the anon key can still read, update and delete rows. Until an operator applies
  it, the anon key remains fully privileged.

## Testing

Tests use `node:test` + `node:assert/strict`, run with `tsx --test`. They import
source with explicit `.ts` extensions. No live database is reachable, so DB-bound
code is tested through the injectable client with a PostgREST-like recording stub
that applies the filters it is given and returns only affected rows.

## Execution 01 invariants (tenant + financial-year wiring)

- There is **no** `src/lib/auth/session-context.ts`. Server routes learn the tenant
  and active financial year from the session via `resolveAuthContext` /
  `getActiveFinancialYear` (`src/lib/auth/context.ts`); a browser page must never read
  `tenant_id`/`financial_year_id` from a form field, query string or other caller input.
- The migration's three `tables text[]` arrays must stay consistent: every table
  that receives a policy (tenant or company) **must** also appear in the RLS-enable
  array, or the policy is inert. `tests/core-security-migration.test.ts` enforces
  this, and would have caught the `ai_recommendations` defect.
- `financial_years.tenant_id` does not exist until the migration is applied, so
  the year lookup fails closed to `null` rather than throwing; the creation pages
  keep working with no financial year in the interim.
- `journal_entries`/`journal_lines` have **no** `tenant_id` column in the live
  schema. Only `financial_year_id` is set on journal entries; a `tenant_id` write
  there would error and is deliberately omitted.
- `purchase_invoices.tenant_id` is likewise migration-only, so `/purchases/new`
  spreads `tenant_id` conditionally.

## Execution 03 invariants (RLS / tenant isolation hardening)

- `supabase/migrations/002_tenant_isolation_hardening.sql` is the authoritative,
  idempotent isolation model and **supersedes** 001. It must be applied for tenant
  isolation to exist; until then the anon key still reads/writes every table.
- The migration is verified by execution, not only by parsing. A local PostgreSQL 17
  with a schema mirroring the live project (63 tables, `anon`/`authenticated`/
  `service_role` roles, a GUC-driven `auth.uid()`) is enough to run it and assert the
  isolation semantics. Reuse this pattern for any future DDL change.
- Two predicates, deliberately different:
  - `can_read_tenant` is NULL-tolerant (`is not distinct from`), so the current
    single-tenant install вҖ” every `tenant_id` NULL вҖ” keeps working unchanged.
  - `can_write_tenant` is strict: a tenanted caller may not create tenant-less rows
    (no "orphans" that would leak into the NULL-tenant install) and may not write into
    another tenant. `assertWritableTenant` in `src/lib/auth/policy.ts` mirrors this.
- The anon role must hold **zero** table privileges. Supabase grants `anon` full access
  by default; `revoke all` is the fix, and RLS alone would not have removed those grants.
- Privileged (service-role) routes bypass RLS, so tenant scoping there lives in the
  **query** (`.eq("tenant_id", ...)` / `.is("tenant_id", null)`), never only in a
  post-fetch comparison. See `src/lib/auth/references.ts` and `ownership.ts`.
- `users` update policy: nobody, not even an admin, may change a row's `tenant_id`.
  Tenant (re)assignment is provisioning and belongs to the service-role route.
- `financial_ratio_history` has no tenant/company column; it is isolated through its
  parent `financial_ratios` row.
- `npm test` / `test:core` load `.env.local` via `tsx --env-file-if-exists`. Without it,
  any test that transitively imports the browser Supabase client fails at load.

## Execution 04 invariants (universal Excel engine) — SUPERSEDED by Execution 25

> **Correction:** the `src/lib/excel/` engine, `src/components/excel/`, the
> `/api/excel/*` routes, `postJournalEntry` (`src/lib/excel/journal-group.ts`),
> `importSafety()` and the referenced tests do **not** exist in this repository. The
> real import engine is `src/lib/import/` (see Execution 25). The bullets below are
> retained for history only and must not be followed literally.


- There is **one** Excel engine (`src/lib/excel/`) and **one** action cluster
  (`src/components/excel/ExcelModuleActions`). Never add a per-page import/export
  implementation; add a registry entry instead.
- Adding a module = a `ModuleSpec` in `registry.ts` (fields, labels, aliases,
  permissions, duplicate keys). Fields must map to columns verified on the live table.
- A module is `importable` only when its table has a real tenant column. Otherwise it
  is `exportable` with a `notes` reason shown to the user. This is why `journal_entries`,
  `employees`, `branches`, `financial_years` are export-only today.
- Duplicate detection has two levels: LEVEL 1 (`findFileDuplicates`, same key earlier
  in the upload) and LEVEL 2 (`findDuplicates`, existing DB row). LEVEL 1 wins. A file
  duplicate has no DB id, so commit skips it unless the mode is `create`.
- Grouped modules (`ModuleSpec.group`) assemble several sheet rows into one document
  (`entry_ref` for journals). Document-level validation failure marks **every** row of
  the group as an error, and commit writes groups through the injected `writeGroup`,
  never a generic table insert.
- Journal import must go through `postJournalEntry` (`src/lib/excel/journal-group.ts`).
  Never write `journal_entries`/`journal_lines` directly from the engine вҖ” a second
  accounting path is exactly what the core forbids.
- `postJournalEntry` resolves the tenant **before** its duplicate guard, and scopes the
  guard by `tenant_id` (`.is("tenant_id", null)` for a tenant-less caller). Matching on
  `reference_number` alone leaked one tenant's entry to another.
- `assertAccountsUsable` in `posting.ts` rejects an account id that does not exist or
  belongs to another tenant. `accounts.tenant_id` is nullable (shared chart), so the
  tenant-less chart is accepted for any caller.
- `GET /api/excel/import-history` reads the existing `activity_logs` audit trail; do not
  create a second import-history store.
- The error report carries a "Ш§Щ„ШӯЩ„ Ш§Щ„Щ…ЩӮШӘШұШӯ" / "Resolution" column sourced from the
  `RESOLUTIONS` map in `exporter.ts`; add a code there when adding an error code.
- There are **no** `test:excel` / `test:accounting` npm scripts. The suite is the
  explicit file list in `test:core` (run via `npm test`). Import tests live in
  `tests/exec25-universal-import.test.ts`; accounting tests in the `exec16/17/18/29/…`
  files.


## Execution 05 invariants (sales + invoices + payments + returns)

- **One sales posting path.** There is **no** `src/lib/sales/service.ts`. Sales
  financial mutations go through the server route `src/app/api/invoices/route.ts`
  (`POST` issue, `[id]/reverse`), which posts via `src/lib/accounting/sales-posting.ts`,
  numbers via `src/lib/numbering.ts`, and guards mutability with
  `src/lib/accounting/invoice-guards.ts`. Pages (`sales/new`, `invoices/new`) POST to
  `/api/invoices`; nothing posts a sales journal entry directly from the browser.
- **Revenue is recognised once, at issue.** Issuing an invoice posts
  `Dr AR / Cr Revenue / Cr Output VAT`. Collecting it posts `Dr Cash/Bank / Cr AR`
  and must never credit revenue again. A return posts
  `Dr Sales Returns (or Revenue) + Dr Output VAT / Cr AR`.
- **Paid amount and status are derived, never trusted.** `recomputeInvoicePaid`
  sums the completed payments (refunds negative) and `statusFor` derives the
  status; a client-supplied `paid_amount` is ignored, so a retry cannot double-count.
- **Posted invoices are immutable.** `assertInvoiceMutable` refuses edit/delete once
  a `sale_invoice` journal entry exists for the invoice number (or money was
  collected). Undo a posted sale with a return, which is auditable.
- **Sales pages never write tenant_id or post journals themselves.** `sales/new`,
  `payments/new` and `sales/returns` POST to `/api/invoices`, `/api/payments`,
  `/api/sales-returns`; the server takes tenant + financial year from the session.
  `tests/session-context.test.ts` asserts this.
- **Numbering is one mechanism.** `src/lib/documents/numbering.ts`
  (`nextDocumentNumber`) wraps `generate_document_number`. Never reintroduce
  `REC-${Date.now()}`-style numbers вҖ” a timestamp changes on retry and defeats the
  duplicate guard.
- **Account codes.** `ACCOUNT_CODES` in `accounting/posting.ts`. `41003`
  (salesReturns) is a contra-revenue account that may **not exist** on a live
  install; a return falls back to debiting `41002` (salesRevenue) so it still
  balances. Verified live chart: 11001, 11002, 12001, 21001, 24000, 41001, 41002.
- **Schema drift is handled, not assumed.** Exec 01/03 declared `tenant_id` on
  `sales_returns`, `journal_entries`, `journal_lines` and `activity_logs` in SQL that
  was never applied. `supabase/migrations/003_sales_lifecycle.sql` adds the missing
  columns and the `receipt`/`sales_return` sequences (additive, idempotent).
  `src/lib/db/columns.ts` (`hasColumn`, `insertTolerant`) lets the app run before and
  after the migration вҖ” writes drop only columns the DB lacks instead of failing.
- **Tests need the server condition.** `npm test` uses
  `node --conditions=react-server --import tsx ...` so `server-only` modules
  (`supabase-admin`) load. `tests/sales-lifecycle.test.ts` runs the real service
  against a PostgREST stub; `supabaseAdmin` and `assertReference` take an injectable
  client for this.

## Execution 05.1 — Financial-year enforcement (server side)

- Financial-year enforcement is real but lives at the **route** level:
  `/api/invoices` and `/api/expenses` call `getActiveFinancialYear(context.tenantId)`
  and then `assertDateInOpenFinancialYear(year, date, ...)` before the write. A
  tenant with no configured year is skipped (backward compatible).
- `AuthContext.financialYearId` is currently always `null` — `resolveAuthContext`
  does NOT populate it. Do not assume it is set; resolve the year with
  `getActiveFinancialYear` where it is needed (that is what the routes do).
  (`/api/invoices` only *uses* `context.financialYearId` as an optional stamp on
  the invoice row, so the column is left unset today.)
- `src/lib/sales/service.ts` and `assertPostingYear` referenced by earlier notes do
  NOT exist in this snapshot; the sales posting path is
  `src/lib/accounting/sales-posting.ts` + `/api/invoices`.
- Migrations `001`, `002`, `003` are still NOT applied to the live database
  (direct Postgres access is blocked from the dev environment; the anon key can
  still read/write). Applying them is the one remaining operator step.

## Execution 05.2 - RLS policy semantics + migration verification

- `activity_logs` append-only policies (`activity_logs_no_update` /
  `activity_logs_no_delete`) MUST be `as restrictive`. The generic tenant loop
  creates permissive `activity_logs_tenant_update` / `_delete` policies, and
  PostgreSQL ORs permissive policies - so a permissive `using (false)` deny is a
  no-op and a tenant can rewrite its own audit trail. RESTRICTIVE is ANDed with
  every permissive policy. Regression-guarded in
  `tests/core-security-migration.test.ts` and `tests/security-tenant-isolation.test.ts`.
- Migration `003` seeds the sales-returns contra account `41003` idempotently
  (`where not exists` on `code`, explicit `gen_random_uuid()` id). Without it a
  return falls back to debiting `41002`; `postJournalEntry` maps
  `ACCOUNT_CODES.salesReturns = "41003"`.
- The three migrations were verified end-to-end on a local PostgreSQL 17 built
  from the live schema (63 tables): apply, idempotent re-apply, and rollback all
  succeed; 26/26 behavioural isolation assertions pass. They are still NOT
  applied to the live database (no reachable DDL path from the dev env).
- Cross-tenant FK (e.g. an invoice referencing another tenant's customer) is NOT
  stopped by RLS; it is an application-layer responsibility
  (`assertReference` / `assertAccountsUsable`).

## Execution 05.3 - live production verification + activation status

- **Live DB access:** the configured `DATABASE_URL` in `.env.local` points at the
  stale pooler host `aws-1-us-east-2.pooler.supabase.com` and its credentials are
  rejected (`ENOTFOUND tenant/user`). The IPv6-only direct host does not resolve
  (no IPv6 here). There is no `exec_sql` RPC and no migration-history table, so
  **DDL activation is not possible from this environment** - it is an operator
  step. The live project IS reachable over the authenticated REST (PostgREST)
  path with the service-role key, which is how live facts below were read.
- **Live state confirmed (read-only, via REST):** migrations 001/002/003 are NOT
  applied - `activity_logs` absent; `sales_returns` missing `tenant_id`,
  `return_number`, `vat_amount`; `journal_entries`/`journal_lines` missing
  `tenant_id`; `expenses` missing `branch_id`. Live chart has 18 accounts and
  **no `41003`**. `tenants`/`branches` are empty; the single live user is
  `role=client`, `tenant_id=null`.
- **Live anon exposure CONFIRMED:** with the anon key, `customers`/`users`/
  `accounts` SELECT returns real PII and UPDATE/DELETE return HTTP 204 (privilege
  granted). This closes only when 001/002 are applied live.
- `financial/reports`, `financial/kpis`, `financial/health-score`,
  `financial/ratios`, `financial/recommendations` filter by `company_id` and
  **skip the filter when `tenantId` is null** (fail-open), unlike the
  `scopeToTenant` convention elsewhere. Live is single-tenant (`tenantId=null`)
  and the tables are empty, so it is latent, not exploited.
- `expenses.branch` is free text, not a `branch_id` FK (`assertBranchAccess` not
  applied); documented, not changed.
- Sales document numbering (invoices/payments/returns) uses the centralized
  `nextDocumentNumber`; the legacy `REC-${Date.now()}` pattern remains only in the
  rentals UI (`src/app/rentals/new/page.tsx`), which is out of scope until Exec 06.

## Execution 05.4 - DDL path exhausted (still blocked)

- **Root cause of the DB blocker:** the live direct host
  `db.<ref>.supabase.co` is **IPv6-only** (no A record; only
  `2406:da1c:...`) and this environment has **no IPv6 egress**. The configured
  `DATABASE_URL` points at `aws-1-us-east-2.pooler.supabase.com`, and **all 24
  pooler regions on ports 5432/6543** return `ENOTFOUND tenant/user` -- with both
  the real password and a deliberately-wrong one (a registered tenant would return
  `password authentication failed`). So the pooler host is wrong/unknown and the
  IPv6 route is unavailable.
- **No other DDL path:** Supabase CLI absent (no config, no token,
  `SUPABASE_ACCESS_TOKEN`/`SUPABASE_DB_PASSWORD` unset); management API `401`;
  pg-meta/`/pg/query` `404`; `exec_sql` `404`; `/api/migrate` disabled + depends on
  `exec_sql`; no CI/CD; no DB credentials anywhere in the repo.
- **Live still unapplied:** `activity_logs` absent; `sales_returns`
  `tenant_id`/`return_number`/`vat_amount` missing; `journal_entries`/
  `journal_lines.tenant_id` missing; `expenses.branch_id` missing; 18 accounts, no
  `41003`; 0 tenants/branches; 1 user (`tenant_id=null`).
- **Live anon exposure confirmed again:** anon SELECT returns PII and anon
  INSERT/UPDATE/DELETE return 201/204 on `customers`/`invoices`/`users`/`accounts`.
- **Incident:** the 05.4 anon INSERT probes created two blank rows (one
  `customers`, one `invoices`). They were deleted via service-role REST and the
  counts restored to 2/2. Future anon probes must use non-existent ids and must not
  INSERT on the live database.
- Activation requires the operator to supply the **current** pooler connection
  string (or DB password) as `DATABASE_URL`, then apply 001 -> 002 -> 003.

## Execution 05.5 - Production migration package (owner-executed)

- **Deliverable:** `supabase/PRODUCTION_ACTIVATION_001_002_003.sql` вҖ” the frozen
  migrations 001 -> 002 -> 003 embedded **byte-identical** (SHA-256 of each body
  is recorded in a banner at its header) between a read-only PRE-FLIGHT and a
  read-only POST-FLIGHT. Do not edit the embedded bodies; regenerate the file from
  `supabase/migrations/` instead.
- **Companion SQL:** `supabase/ANON_VERIFICATION.sql` (non-destructive; every write
  probe guarded with `where false`, `SET ROLE anon` inside exception-guarded
  blocks) and `supabase/RLS_COVERAGE_REPORT.sql`.
- **Operator docs:** `PRODUCTION_MIGRATION_RUNBOOK.md`,
  `PRODUCTION_SECURITY_CHECKLIST.md`. Correct project ref: `chlkmdobhvfnldqkgdji`.
- **Local proof:** a live-like 63-table harness (built from the live PostgREST
  OpenAPI spec) applies the package with 0 errors, is idempotent on re-run, leaves
  RLS on all 64 tables, creates `41003` once, and preserves seeded rows. Anon
  probes: 48 denied post-migration, 33 permitted pre-migration.
- **Public-read invariant (do not regress):** `cars` and `settings` are
  tenant-owned and become RLS-protected. Anonymous marketing pages must NOT read
  them directly with the anon key; they use `/api/public/vehicles` and
  `/api/public/company-profile`, which run server-side (service-role) but return
  an explicit PUBLIC-SAFE projection (no cost/supplier/VIN/finance/insurance
  columns, no `select('*')`). `/api/public/` is allow-listed in `src/middleware.ts`
  and the guard is enforced by `tests/security-tenant-isolation.test.ts`.





## Execution 06 вҖ” Public SaaS + Free Account (invariants)

- **Public SaaS routes** (no ERP data, static marketing only): `/`, `/features`,
  `/solutions`, `/pricing`, `/faq`, `/privacy`, `/terms`. Chrome:
  `src/components/MarketingNavbar.tsx` + `MarketingFooter.tsx`. Do NOT expose
  internal/admin routes in the footer or navbar.
- **Free signup is server-authoritative**: `POST /api/saas/signup` (public).
  It creates a NEW tenant and makes the signer `admin` of that tenant only.
  `tenant_id`/`role`/`company_id`/`user_id` are NEVER read from the request body.
  Duplicate email -> 409 before any user/tenant is created; partial failure rolls
  back auth user + tenant. Keep this the ONLY public account-creating route.
- **Onboarding**: `POST /api/saas/onboarding` requires requireContext(...,{requireAdmin:true})
  and scopes every write with .eq("tenant_id", tenantId); tenant comes from the
  session, never the body. Idempotent; all steps optional.
- **Pure rules** live in `src/lib/saas/provisioning.ts` (validateSignup,
  validateOnboarding, defaultFinancialYear, FREE_PLAN) - keep it infrastructure-free.
- **Free plan** is static and advertises only real modules; NO inventory, NO
  billing. Paid plans are "coming soon" only.
- **Middleware** PUBLIC_API_PREFIXES now also allows `/api/saas/signup`; every
  other `/api/*` stays behind the auth gate. Adding a public prefix requires
  updating tests/security-tenant-isolation.test.ts allow-list AND adding a
  safety assertion.
- **expenses.branch_id**: deliberately NOT added - the architecture uses the
  existing free-text expenses.branch; branch_id has no consumer.
- Public pages must never query ERP tables directly; use `/api/public/*` with an
  explicit safe column projection. RLS stays enabled.


## Execution 07 вҖ” administrator accounts, global super admin, login hardening

- **Two distinct administrator roles.** `admin` is the company administrator and
  is tenant-scoped. `super_admin` (`is_super_admin()` / `AuthContext.isSuperAdmin`)
  is the **global** operator and is deliberately tenant-less. Nothing derives
  either role from request input or an email address; both come from
  `public.users.role` via `resolveAuthContext`.
- **The global-only boundary is explicit.** `GuardOptions.requireSuperAdmin`
  rejects a company `admin` with 403. The schema-migration endpoint
  (`/api/migrate`) requires it AND `ENABLE_SCHEMA_MIGRATION_ENDPOINT=true`; it is
  404 otherwise.
- **`/api/me` is the only place the login page learns its role.** It resolves the
  context server-side and separates `401 unauthenticated` (no session) from
  `403 account_not_provisioned` (Auth identity with no `users`/`profiles` row).
  The login page must never read `users.role` with the browser client.
- **Isolation predicates live in migration 004** (`004_global_super_admin.sql`).
  It *extends* `can_read_tenant`/`can_write_tenant`/`can_read_company`/
  `can_write_company` rather than rewriting policies, so every policy inherits
  super-admin behaviour from one definition. It also normalises the `users.role`
  check constraint to include `super_admin`.
- **Privilege escalation is blocked by a BEFORE trigger, not RLS.**
  `prevent_role_escalation` on `users` refuses any `super_admin` grant/revoke by a
  non-super-admin. It must be a trigger: a RLS `with check` sees only the NEW row,
  so it cannot distinguish "granted" from "already was". It allows the service
  path (`auth.uid() is null`) so provisioning still works.
- **004 also tightens `tenants`/`users` policies.** The executable harness
  (`supabase/tests/004_harness/`) proved 002 let a company admin read every
  tenant and INSERT a user into another tenant, and that a super admin could not
  update a tenanted row. 004's `tenants_read`/`users_self_select`/
  `users_self_update`/`users_admin_insert` close all three. The service-role
  `users` API is unaffected (it bypasses RLS). **Run this harness for any future
  identity-policy change** вҖ” parsing alone would not have caught these.
- **`supabaseAdmin` initialises lazily.** Importing a module that references it no
  longer throws when the service-role key is absent (tests, static analysis); the
  client still fails hard on first use. Do not revert to a top-level `throw`.
- **Middleware fails safe.** With no Supabase env it denies protected `/api/*`
  with 401 and lets public routes/pages through, instead of throwing a 500 on
  every matched route.
- **Provisioning tools** (server-only, never imported by app code):
  `scripts/provision-admin-accounts.mjs` (idempotent create/repair via the Auth
  admin API) and `scripts/verify-admin-accounts.mjs` (real sign-in + role/tenant
  assertions). `npm run provision:admins` / `npm run verify:admins`.
  - The provisioner exports `provisionAdmins(client, opts)` and is exercised by
    `tests/admin-provisioning.test.ts` against an in-memory Supabase stub (no live
    DB). Keep it dependency-injected; do not reach for `supabaseAdmin` inside it.
  - It **never resets an existing user's password** unless `--rotate-passwords` (or
    an explicit password) is given, and it rolls back a newly-created Auth identity
    if its `public.users` mapping fails вҖ” no half-provisioned privileged account.
  - It writes temporary passwords to `.admin-credentials.local` (0600, gitignored);
    printing them to stdout requires `--print-passwords`.
  - The company admin must be pinned to a real tenant (`--tenant-id`); the super
    admin is always tenant-less. The script verifies the pinned tenant exists.
- **Migration 004 has an operator activation package**
  (`supabase/PRODUCTION_ACTIVATION_004.sql`) embedding the migration verbatim
  (sha256 in its header) between read-only PRE/POST-FLIGHT queries. Run it after
  `PRODUCTION_ACTIVATION_001_002_003.sql`. Regenerate it from
  `supabase/migrations/004_global_super_admin.sql` rather than editing the body.
  It was executed end-to-end on PostgreSQL 17 (package applied, POST-FLIGHT green,
  11/11 assertions) вҖ” see `supabase/tests/004_harness/`.

## AI report formatting (`src/lib/reporting/`)

- **Formatting/structure only.** The assistant renders EXISTING report data; it
  never writes invoices, journals, balances or tax values. A request that asks to
  change amounts is classified as `intent: "data"`, flagged
  (`dataChangeRequested`) and never executed вҖ” real data changes must go through
  the guarded service layer (`postJournalEntry`, `sales/service.ts`).
- **No free-form code from the model.** `intent.ts` is a deterministic bilingual
  parser that emits a closed set of formatting primitives; nothing from the
  prompt is ever executed as SQL/JS.
- **Report glossary lives in one place:** `definitions.ts` (`REPORT_DEFINITIONS`).
  Add a report/column there, not in the route or UI.
- `vat.ts` implements the Bahrain VAT return structure (standard 10% / zero /
  exempt / out-of-scope-unregistered) and validates arithmetic. It never invents
  a treatment: a zero-VAT registered transaction is `unclassified` and surfaced
  for review. Tax rates are never changed by AI.
- `workbook.ts` (ExcelJS) writes real `SUM` formulas and `verifyWorkbookBuffer`
  **re-opens** the buffer before download; a file that fails verification is
  never offered. `.xlsx` is handled by ExcelJS; `xlsx`/SheetJS remains the
  read-only analyzer in `ai-excel-analysis`.
- `templates.ts` reuses the `settings` key/value store (`report_format_templates`),
  tenant-scoped from the session вҖ” no new table.
- `assistant.ts` is auth-free (identity injected), so it is unit-tested with a
  recording PostgREST stub. Tenant filter is applied first.
- **Missing in this snapshot (reported, not fabricated):** there is no
  `speed_erp_progress.xlsx` and no `VAT Report format-template for Bahrain.xlsx`
  in the repo, and no `src/lib/excel/` unified import/export engine despite
  AGENTS.md referencing one. The Bahrain VAT definition is modelled on the
  documented Bahrain VAT return, not on the absent template file.

### Dynamic report builder + validator (`catalog.ts`, `report-def.ts`, `validation.ts`, `dynamic.ts`)

- **Field catalog is the single whitelist.** `catalog.ts` (`CATALOG`) declares
  every reportable field with its real table/column, permission module, type and
  `aliases`. A request can only reference catalog keys; unknown fields are
  reported (`unknownFields`) and never invented. Add a field = one catalog entry
  whose column exists вҖ” never a schema change for a report request.
- **`report-def.ts`** parses Arabic/English requests deterministically (dataset,
  fields, filters, group-by, aggregates, sort). `findTerm` is Arabic-prefix aware
  (`ЩҲ`/`Ш§Щ„` attach without a space). Only a closed set of filter ops
  (`eq/gte/lte/overdue/contains`) is emitted вҖ” no SQL is built from the prompt.
- **Every report keeps its identifying key** (`DatasetSource.keyField`, e.g.
  `invoice_number`) even when the request omits it. Filter-only fields are loaded
  but not displayed.
- **`validation.ts` is the deterministic checker** (never the LLM). Findings
  carry severity, category, evidence, current/expected, and a repair **class**:
  1 = safe display, 2 = report-definition, 3 = sensitive accounting/data.
  `applicableFixes` returns only class 1. Rounding/currency/refunds and negative
  amounts are tolerated, not flagged.
- **Data-change requests are refused.** A prompt that asks to change an amount,
  balance, VAT or journal is flagged (`dataChangeRequested`) and never applied;
  the UI shows the approved-path notice. There is no accounting write path here.
- **Permission gating per field.** The route calls
  `can(context, field.module, "view")` as the `allow` predicate; denied fields are
  dropped from output and listed in `deniedFields`.
- **Definitions are versioned** in the `settings` store (`report_definitions`),
  tenant-scoped; `restoreDefinition` replays a prior version (bounded history).
- **History reuses `activity_logs`** (`GET ...?what=history`); no second store.
- Endpoints: `POST ?mode=build-preview|build-file|validate|save-definition|
  restore-definition`, `GET ?what=definitions|history`. `sourceCount` (records
  matched) vs rendered rows is compared to catch excluded records.

## Login flow invariants (do not regress)

- **The role is decided server-side, never by the login page.** `src/app/login/page.tsx`
  signs in with the shared browser client, then calls `/api/me`; the role it routes
  on comes from that response, not from `signInWithPassword`'s user object or from
  `user_metadata`. `tests/login-flow.test.ts` asserts the page never reads
  `users`/`user_metadata`/`app_metadata`.
- **Error text is centralized** in `src/lib/auth/login-errors.ts` (pure). Never echo
  the provider's raw message (it varies by `@supabase/supabase-js` version and can
  leak detail). `loginErrorMessage` maps `invalid_credentials`/400/429/вҖҰ to safe,
  localized strings.
- **Credentials are normalised** (`.trim()`) and the email input sets
  `autoCapitalize="none" autoCorrect="off"` вҖ” an autocapitalized or space-padded
  email is the classic cause of an intermittent `400 /token?grant_type=password`.
- **Config consistency is checkable** via `src/lib/supabase-config.ts`
  (`supabaseConfigConsistent`): a `NEXT_PUBLIC_SUPABASE_URL` whose project ref does
  not match the anon key's `ref` claim is the signature of a build/runtime env
  mismatch.
- **A deployed bundle that lacks `/api/me`, `super_admin` and `customer-dashboard`
  is stale.** Verify what production actually serves (`/_next/static/chunks/*.js`)
  before debugging anything else.
- Browser-client note: `src/lib/supabase.ts` in the current source uses
  `createBrowserClient` (cookie-backed, so middleware/route handlers see the
  session). `.bak`/`.save` files are legacy and not built.

## Execution 18 invariants (VAT, sales numbering, date filters, dashboard revenue)

- **VAT report format.** The screen (`src/app/reports/vat/page.tsx`) shows output
  VAT, input VAT, net, a **monthly** breakdown, and a **source breakdown** that
  separates the taxable base from the VAT for each source. The tax base is derived
  from the real columns, which are NOT uniform: `invoices.total_amount` and
  `purchase_invoices.total_amount` are VAT-inclusive (taxable = total - vat), while
  `expenses.amount` is stored pre-VAT (taxable = amount). `summarizeVatSources`
  (`src/lib/reporting/vat.ts`, pure) owns those rules; the page must not re-derive
  them. Cancelled documents are excluded; no tax treatment is invented.
- **Sales serial numbers.** `sales/new` allocates its number at submit time
  (`form.invoice_number || nextDocumentNumber(...)`) and uses that same value for
  the invoice row and the `sale_invoice` journal reference, so a failed mount RPC
  can never insert an empty number or a mismatched reference. `nextDocumentNumber`
  falls back to a **collision-safe** value (monotonic within the process) when the
  `generate_document_number` RPC is unavailable.
- **Numbering sequences live only in migration 003 / the activation package**, which
  seed `receipt` and `sales_return`. `generate_document_number` is a live-only RPC
  (not in the repo); the `sale_invoice` sequence row's existence could not be
  inspected from this environment (no DB access). Any operation whose `doc_type` is
  not seeded falls back to the local prefix - verify the sequence rows before
  treating a document class as fixed.
- **Date filters.** Every date filter applies on an explicit GO/Search press; a
  `type="date"` input must bind to a `*Draft` state, never directly to the applied
  filter. Pages fixed in Exec 18: `accounting/journal-entries`, `hr/attendance`,
  `sales/returns`, `accounting/expenses`, `expenses`. Enforced by
  `tests/exec18-vat-numbering-dates-revenue.test.ts`.
- **Dashboard revenue.** `src/lib/reporting/revenue.ts` (`summarizeRevenue`,
  `invoiceNetRevenue`) is the single revenue definition: recognised at issue, net
  of VAT (`gross - vat`), never from receipts; sales returns are contra-revenue.
  The dashboard shows gross / VAT / net / returns / net-after-returns so the figure
  reconciles with the sales documents the user sees.

## Execution 19 invariants (read-only reconciliation pack)

- `supabase/EXEC19_READONLY_RECONCILIATION.sql` is the operator pack for verifying
  the live `sale_invoice` sequence, last sales invoices, empty/duplicate numbers,
  VAT base by source, revenue vs returns, `update_account_balance` + account drift,
  and tenant distribution. It is **strictly read-only**: only `select` /
  `with … select`, no writes, no DDL, no `set role`, no temp table, and it never
  *calls* `update_account_balance`/`generate_document_number` (it only reads the
  former's definition from `pg_proc`). `tests/exec19-readonly-reconciliation.test.ts`
  strips comments/string literals and enforces this, plus a no-PII column rule.
- **`ANON_VERIFICATION.sql` is NOT read-only** despite its header: it creates a
  temp table, `set role anon`, and issues guarded `insert`/`update`/`delete`
  probes (neutered with `where false`). It must not be run under a "no writes"
  constraint. For a pure read-only anon posture check use the catalogue form
  (`has_table_privilege('anon', 'public.<table>', '<priv>')`).
- Column provenance for the pack: proven from the app writers and migrations 001/003
  (`invoices`, `sales_returns`, `document_sequences`, `journal_lines`/`journal_entries`,
  `accounts`). `journal_lines` has no live `tenant_id`, so account drift is scoped
  through the parent `journal_entries`. The pack reports the ledger sum **both
  signed and as magnitudes** and never assumes a debit/credit sign convention.
- The pack is preparation only; running it against production requires separate,
  explicit authorization. No migration is applied and no row is written by Exec 19.

## Execution 20 invariants (AI audit + repair capability)

- **One AI layer** (`src/lib/ai/`) and **one reporting layer** (`src/lib/reporting/`).
  Never add a second AI engine, a second report engine, or a second Excel engine.
  `src/lib/reporting/*` is the deterministic source of truth for figures; the model
  only phrases a pre-computed facts block (`asUntrustedBlock("FACTS", …)`).
- **No provider call may hang.** `withTimeout` in `src/lib/ai/providers.ts` bounds
  every provider call (default `DEFAULT_TIMEOUT_MS`), threads through
  `completeWithFallback`, and aborts the underlying fetch/SDK; an outer signal is
  chained. A timed-out call rejects so the caller's fallback/degradation runs.
  Do not call a provider without it.
- **Repair complaints are classified deterministically**, never by the model:
  `classifyRepairRequest` in `policy.ts` returns a module, symptom, likely
  `errorType` (display/query/data/posting), the `deterministicSource` to run
  (EXEC19 blocks, `ACCOUNT_BALANCE_VERIFICATION.sql`, `revenue.ts`, …) and a
  `requiresWrite` flag. `answerQuestion` appends the diagnosis to the answer; a
  write is **never** enabled by the diagnosis — it only raises the approval flag.
- **Route hygiene (guarded by `tests/exec20-ai-audit-repair.test.ts`):** every AI
  route calls `requireContext`; no route trusts `tenant_id`/`role` from the body;
  no route introduces `exec_sql`/`eval`/`new Function`/`child_process`.
- **Lint gotcha:** never name a local variable `module` (Next.js
  `no-assign-module-variable`). Use `area` etc. — this bit Exec 20.
- AI provider settings live in the existing `settings` table (`ai_settings`),
  tenant-scoped; the key is written but never read back (`toPublicSettings`).
  `ai_recommendations` is company-scoped and isolated by migration 002.

## Execution 21 invariants (safe AI repair workflow — Phase R1)

- **One repair catalogue** (`src/lib/ai/repair-catalog.ts`). The AI repair flow may
  only run actions declared there; an unknown action id is rejected. The model
  never invents an action or supplies SQL/code/parameters outside a whitelisted
  schema. Each spec declares modules, permission, effect (`read`/`settings`),
  risk, approval need and input schema.
- **The cycle** (`src/lib/ai/repair-workflow.ts`): request → diagnosis →
  allowed action → preview → approval → execute → verify → audit. `proposeRepair`
  writes nothing; `executeRepair` re-checks permission, approval, plan
  fingerprint and expiry, re-computes the preview and aborts with `conflict` if
  the content changed, and refuses a repeated idempotency key.
- **Approval is bound to the plan**: `planFingerprint` hashes action+kind+params;
  an approval whose fingerprint does not match the executed plan is refused
  (`plan_changed`). Re-check permissions at execution, never trust the UI alone.
- **No accounting writes.** R1 actions are read-only or write a tenant-scoped
  report-format template in the existing `settings` store. Financial corrections
  must go through the existing posting/reversal services (a later phase) — never
  a new path.
- **Verification is honest**: a failed post-execution verification returns
  `status: "failed"`, never `verified`. Audit logs record action/status/verified/
  idempotency_key/reference and only the *keys* of the change, never raw values.
- **Route:** `POST /api/ai/repairs?op=catalog|propose|execute`, session-gated via
  `requireContext`; identity/tenant/permission always from the session. Guarded by
  `tests/exec21-safe-ai-repair.test.ts` (no `exec_sql`/`eval`/`Function`/`child_process`).
- Idempotency is per-process best-effort (`createMemoryIdempotency`); a durable
  store would need a `settings` row and is a documented follow-up. The audit
  trail is the authoritative record of what ran.

## Execution 22 invariants (AI Control UI integration + repair expansion)

- **The UI never decides success.** `src/lib/ai/repair-client.ts` is a pure
  controller (no React import) that drives `/api/ai/repairs`; the AI Control page
  renders it. `isVerifiedSuccess(result)` is the only source of a success state,
  and it requires `result.ok && status === "verified" && verification.ok`. Pressing
  "approve" is never success.
- **Double-submit is blocked** in the controller (`busy` guard), not only in the
  DOM. A repeated propose/execute while busy is ignored.
- **Read-first diagnostics** added to the catalogue: `dashboard_revenue_reconciliation`
  (reuses `revenue.ts:summarizeRevenue`) and `date_filter_diagnostic` (replays the
  period window over the unwindowed source). Both are `effect: "read"`, permission
  `reports.view`, no approval, and write nothing. `selectRepairActions` routes
  revenue/dashboard and date/period complaints to them first.
- **`loadReportData` shapes rows**: the sales report returns `{subtotal, vat_amount,
  total}` (not `total_amount`). Revenue reconciliation must map shaped rows onto
  the revenue model — reading `total_amount` off a shaped row yields 0.
- The AI Control page calls only the controller; it sends no `tenant_id`/`role`
  from the browser. No new engine, no accounting writes, no inventory.

## Execution 29 invariants (remaining items closure)

- **One sales posting service.** `src/lib/accounting/sales-posting.ts` owns the
  sale journal: `buildSaleJournal` / `buildSaleReversalJournal` (pure, balanced-or-null)
  and `postSaleInvoice` / `reverseSaleInvoice` (injectable client). `POST /api/invoices`
  is the single server-side issue path; `invoices/new` calls it instead of inserting
  in the browser. Never re-add a browser journal insert for a sale.
- **Issue is idempotent by `(entry_type='sale_invoice', reference_number)`.** A retry
  returns the existing journal (`created:false`) — it must never post a second one.
  Reversal is idempotent the same way under `sale_reversal`. Migration 005's partial
  unique index is the DB-level backstop.
- **`invoices/new` previously posted no journal at all.** The invoice row and its
  balanced journal are now created together by the server; if posting fails the
  invoice is deleted (compensation), so a document can never be left unposted.
- **Posted invoices are reversed, never edited/deleted.** `POST /api/invoices/[id]/reverse`
  mirrors the original journal and sets `status='cancelled'`; the edit page shows
  Reverse for posted invoices. `DELETE /api/invoices/[id]` is server-authoritative and
  refuses a posted invoice or one with dependents.
- **Orphan prevention (Item 11).** `hasInvoiceDependents` (`invoice-guards.ts`) counts
  `payments`/`sales_returns` by `invoice_id`; a delete is refused when any exist.
  An unreadable table counts as zero so the guard never blocks a legitimate delete.
- **Report freshness (Item 9).** `src/lib/hooks/use-report-refresh.ts` — mutating pages
  call `notifyDataChanged()`; report pages call `useReportRefresh(<their own loader>)`.
  The hook only re-runs the existing loader (event + focus/visibility, coalesced) and
  never writes to the ledger, so it cannot duplicate entries. It is a same-session
  signal, not a cross-tab/server-push mechanism.
- **Item 6 (purchases ↔ credit sales) is a business decision, not a code gap.** No
  link column exists anywhere; do not add `sale_id`/link fields until the owner
  chooses a model. SPEED ERP has no inventory.
- `npm run lint` **works** now ("No ESLint warnings or errors"); the old AGENTS.md note
  that it crashes is stale. `npm run build` needs `NEXT_PUBLIC_SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` to collect page data (pre-existing; `/api/financial/calculate`).

## Deployment (production)

- Target: `/var/www/speed.harbourconsultancies.com`, PM2 app `speed`, port 3090,
  domain `https://speed.harbourconsultancies.com`.
- Deploy = `git pull --ff-only origin main` -> `npm run build` ->
  `pm2 restart speed --update-env`. NEVER reset --hard / force push; preserve
  `.env.local` (untracked, never commit it).
- The OpenHands sandbox has NO access to that host (no /var/www, no pm2, no ssh).
  On-server steps must be run on the production VM; from the sandbox only commit
  + push + local production-mode verification are possible.
- Supabase data project: `chlkmdobhvfnldqkgdji`. `slelguoygbfzlpylpxfs` in
  layout.tsx is the Orchids platform script host, NOT a database.
- Pre-existing gap (do not silently fix without a dedicated task): middleware
  gates only `/api/*`; page routes like `/dashboard` return 200 to anonymous
  callers and rely on client-side gating.
- Live E2E signup/onboarding tests MUST use a disposable email and delete the
  auth user, tenant, branch, settings and financial_years afterwards.

## AI assistant, agents & development requests (invariants)

- **One AI engine, one assistant.** `src/lib/ai/` is the only AI layer. Do not
  add a second assistant, a second provider call path or a per-page AI feature.
  `src/app/api/financial/ai-excel-analysis/route.ts` was refactored to reuse
  `completeWithFallback` вҖ” never reintroduce a hard-coded `new Anthropic(...)`.
- **Read-only by construction.** The assistant's tool set (`AI_TOOLS` in
  `src/lib/ai/policy.ts`) is closed and every tool is `kind: "read"`. A request
  to post/edit/delete accounting data is refused by `detectWriteIntent` before
  any model call. Never let the assistant write `journal_entries`,
  `invoices`, `payments` or any financial row вҖ” mutations stay on the existing
  guarded service path.
- **Permissions come from the session.** `allowedTools(context)` /
  `resolveAgent(context, id)` narrow the tool/agent set to the caller's own
  `can(context, module, "view")`. `can()` short-circuits on `isAdmin`, so a
  company admin gets everything within its tenant; a tenant-less super admin is
  the only cross-tenant reader. Identity is never taken from the body.
- **Answers are grounded.** `answerQuestion` always computes the deterministic,
  tenant-scoped facts first; the model only phrases them. If no provider is
  configured or the call fails, the deterministic answer is returned and marked
  `degraded: true`. Never let the model invent a figure.
- **Untrusted text is data.** Prompts, spreadsheet cells and file contents pass
  through `asUntrustedBlock` (delimited, length-capped) and `scanForInjection`.
  `redactSecrets` strips JWTs/keys/connection strings from any output.
- **Providers are configurable, not hard-wired.** `AiSettings` (key
  `ai_settings` in the existing `settings` table, tenant-scoped) holds the
  provider, per-provider keys, per-task models and an ordered fallback chain.
  Anthropic is the built-in default; `openai_compatible` + `baseUrl` reaches a
  self-hosted model (never assumed free). API keys are server-side only and are
  never returned вҖ” `toPublicSettings` exposes only `hasApiKey`.
- **The AI never self-applies.** Development requests
  (`src/lib/ai/dev-requests.ts`) are a review-only pipeline: create вҶ’ plan вҶ’
  approve/reject вҶ’ artifact. `isForbiddenPath` / `assertChangeSetSafe` block any
  change to `src/lib/auth/`, `src/middleware.ts`, `supabase/migrations/`,
  `.env*`, `package.json`. High-risk requests require a global super admin
  (`canApprove`). A human applies the patch on a branch; deployment is separate.
- **The AI Control dashboard** (`/settings/ai-control`) requires an admin to
  write (`settings.edit`) and lists agents with the caller's effective tools.
  `AssistantPanel` is mounted in the financial dashboard's AI tab.
- Tests: `tests/ai-assistant.test.ts` (registered in `test:core`) covers policy,
  permissions, tenant scoping, injection, routing/cost, settings key handling,
  the assistant (deterministic + model + failure) and the dev-request workflow.

## Execution 08 invariants (AI verification, integration & production readiness)

- **The AI tools are real, not stubs.** `customer_lookup`, `invoice_lookup` and
  `report_totals` in `src/lib/ai/tools.ts` run tenant-scoped queries with an
  explicit safe column list (no `select('*')`). `extractLookupTerm` only narrows
  a result set from a quoted string or a document number; it never widens it.
  `customer_lookup`/`invoice_lookup` are gated by the `customers`/`invoices`
  `view` permission, `report_totals` by `reports`.
- **AI settings and dev-request lists share the canonical settings conflict
  target `onConflict: "tenant_id,key"`** (the same one `reporting/templates.ts`
  uses). A bare `onConflict: "key"` would let one tenant overwrite another's
  `ai_settings` / `ai_dev_requests`. Regression-guarded in
  `tests/ai-assistant.test.ts`.
- **Two-tenant RLS verification by execution.**
  `supabase/tests/isolation_harness/` builds a two-tenant base schema, applies
  the real migrations `001 -> 004` (plus an idempotent re-apply), and asserts 17
  cross-tenant behaviours with real authenticated identities (a `super_admin`
  role and two tenants). `run.sh` needs a local PostgreSQL and the `postgres`
  superuser. Reuse it for any future isolation change. Migration 004 alone is
  covered by `supabase/tests/004_harness/` (11 assertions).
- **The frozen activation package's banner hashes were STALE; fixed in Exec 09.**
  The recorded `SHA-256 (body)` values in
  `supabase/PRODUCTION_ACTIVATION_001_002_003.sql` used to disagree with the
  embedded bodies, and `migrations/001` was the pre-fix version while the
  embedded 001 was corrected. Source 001 was brought up to the corrected version
  and the package regenerated, so bodies and hashes now agree and are guarded by
  `tests/activation-package-integrity.test.ts`. See the Exec 09 section below.
- **Do not re-enable `ai_recommendations` import or grant it a tenant column
  casually.** It is company-scoped (`company_id`) and RLS-enabled by 002.
- **`test:excel` / `test:accounting` are not real scripts** (the AGENTS.md
  Commands block is aspirational). The real suites are `test:core`, `test:ai`;
  `tests/saas-signup.test.ts` is now registered in `test:core`.

## Execution 09 invariants (production security closure & release)

- **The activation package banner is now authoritative, and kept that way.**
  `supabase/migrations/001_core_security.sql` was brought up to the corrected
  release version (RESTRICTIVE `activity_logs` policies + `ai_recommendations`
  in the RLS-enable array), so source 001 == embedded 001. Regenerate the
  package with `node supabase/tools/rebuild-activation-package.mjs` whenever a
  migration body changes; it rewrites the three bodies and recomputes their
  recorded SHA-256 while preserving the PRE-/POST-FLIGHT prose.
  `tests/activation-package-integrity.test.ts` recomputes every hash and asserts
  byte-identity for both `PRODUCTION_ACTIVATION_001_002_003.sql` and
  `PRODUCTION_ACTIVATION_004.sql`; it is registered in `test:core`. Never edit an
  embedded body by hand вҖ” a stale hash is a trust failure.
- **`EXEC07_1_TENANT_POLICY_FIX.sql` does not exist.** The tenant-policy fix it
  names (RESTRICTIVE `activity_logs_no_update/_delete`, `ai_recommendations`
  coverage) lives inside migrations `001`/`002`; there is no separate file.
- **Build needs Supabase env.** `next build` fails at "Collecting page data"
  (`supabaseUrl is required`) when `NEXT_PUBLIC_SUPABASE_URL` /
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` are absent, because several API routes create a
  client at module scope. Supply them (real or placeholder) to build; this is
  environmental, not a code defect.
- **Architecture note (differs from older AGENTS.md prose).** On this branch the
  ERP pages are browser-direct Supabase clients (`@/lib/supabase`) with RLS as
  the enforcement boundary; there is no `src/lib/accounting/posting.ts`,
  `src/lib/sales/service.ts` or `src/lib/excel/` engine in the tree. `src/lib/ai`
  and `src/lib/reporting` are the server-side CORE capabilities. Do not
  reintroduce a second posting path when touching a page.
- **Administrator provisioning is idempotent and secret-safe.**
  `scripts/provision-admin-accounts.mjs` (`npm run provision:admins`) creates or
  repairs the two mandated identities (`speedadmin@speed.local` = `admin`, scoped
  to the SPEED tenant; `admin@system.local` = `super_admin`, tenant-less) through
  the existing Supabase Auth admin API and `public.users`. It never duplicates an
  Auth identity, writes temporary passwords only to a `0600` file (not logs), and
  rolls back a new Auth user if its mapping fails. `scripts/verify-admin-accounts.mjs`
  (`npm run verify:admins`) proves the sign-in вҶ’ `public.users` вҶ’ role/tenant flow
  end-to-end. Both require real Supabase credentials, which the sandbox lacks.

## Execution 10 invariants (final closure)

- **Financial tenant scope is fail-closed, everywhere.** `scopeToCompany`
  (`src/lib/auth/policy.ts`) confines a tenant-less caller to `IS NULL`; only a
  super admin reads unfiltered. `financial/reports` and `financial/calculate`
  once used a local `if (!tenantId) return query` helper — that is the exact
  fail-open shape to never reintroduce. `tests/tenant-isolation.test.ts`
  ("financial routes scope fail-closed") scans every `financial/*/route.ts` and
  fails if any uses a helper other than `scopeToCompany` or re-adds the
  `if (!tenant) return query` pattern.
- **Tenant-owned inserts must set `tenant_id` from the session.** A row written
  into a tenant-owned table (per migration 002's `tables text[]` column list)
  without a `tenant_id` is an orphan visible to the single-tenant install. Use
  `assertWritableTenant(context, body.tenant_id)` then `if (tenantId) payload.tenant_id = tenantId`
  — as `suppliers`, `expenses`, `quotations` and `expense-accounts` now do.
  `tests/security-tenant-isolation.test.ts` ("routes that insert tenant-owned
  rows set tenant_id from the session") enforces this by scanning every
  `src/app/api/**/route.ts`. `customer-signup` is the one by-design exception
  (public, NULL-tenant customer).
- **`expense_accounts` IS tenant-owned** (it is in 002's tenant array and has a
  `tenant_id` column). The old "shared chart, no tenant column" comment was
  wrong; do not rely on it.
- **Provisioning refuses to guess a tenant.** `resolveCompanyTenant` reuses a
  pinned `--tenant-id`, the company admin's existing tenant, or a name match,
  then a single existing tenant. With **multiple** tenants and no name match it
  **throws** rather than creating a duplicate; pass `--tenant-id <uuid>`.
- **Live activation is still an operator step.** Migrations 001–004 are not
  applied on the live project and cannot be from the sandbox (no credentials, no
  DDL path). The isolation + 004 harnesses (local PostgreSQL 17) prove the SQL;
  they do not prove the live database. `EXEC07_1_TENANT_POLICY_FIX.sql` does not
  exist in this branch — 002 is the authoritative isolation model.
- **No universal Excel import/export engine exists in this branch.** Do not
  assume `src/lib/excel/` is present; the only Excel surface is the AI analysis
  route. Accounting/sales pages write Supabase directly (browser) plus guarded
  API routes; there is no `src/lib/sales/service.ts` posting engine here.
- **Report files are gitignored on purpose.** `SPEED_FINAL_COMPLETION_REPORT.md`
  is listed in `.gitignore` because it may hold owner-only proposed credentials;
  keep it uncommitted and never place a password in a tracked file or a log.

## Execution 13 invariants (repository + credential hygiene)

- The authorized repository is **`mohammadaljallad079-rgb/speed`** (`origin`). Do
  not push to `startgroup2022-tech/speed` or any other remote.
- The sandbox's `origin` URL previously embedded a `ghu_` token in `.git/config`.
  Never store a token in a remote URL; use a credential helper. If a token is
  exposed, remove it from `.git/config` and **rotate it**.
- `feat/final-hardening-round5` and `main` are the published branches; push with
  plain fast-forward (`git push origin <branch>`), never `--force`/`reset --hard`.
- Local proof for the migration SQL requires a reachable PostgreSQL superuser:
  `bash supabase/tests/isolation_harness/run.sh` (17/17) and
  `bash supabase/tests/004_harness/run.sh`. These prove the SQL, not the live DB.

## Execution 16 invariants (accounting integrity)

- **One document-number mechanism.** Never build a document number from
  `Date.now()` (or any timestamp). Every document and journal number comes from
  `nextDocumentNumber` (`src/lib/numbering.ts` -> `generate_document_number`).
  A timestamp changes on retry and defeats the duplicate guard. As of Exec 16 no
  `Date.now()`-based numbers remain in the sales/purchase/posting pages.
- **One canonical journal-line table: `journal_lines`.** `journal_entry_lines`
  exists in the schema but has **zero readers** - writing lines there makes an
  entry invisible to every report. All four financial reports, the sales engine,
  the manual journal editor and `payment-posting.ts` read/write `journal_lines`.
  Never write journal lines to `journal_entry_lines`.
- **Journal headers must carry `total_debit`, `total_credit`, `is_balanced`.**
  The integrity view (`v_journal_integrity_issues`) and the unbalanced-header
  check rely on them; an entry posted with only `journal_number`/`entry_date`
  looks unbalanced.
- **A posted sale is immutable.** `src/lib/accounting/invoice-guards.ts`
  (`isSaleInvoicePosted`) is checked before editing/deleting an invoice in
  `invoices/[id]`. Reverse a posted sale with a credit note/return; never edit or
  delete it.
- **A supplier payment posts one journal:** Dr AP (21001) / Cr Cash (11001) or
  Bank (11002). It must never touch revenue. `postSupplierPayment` in
  `src/lib/accounting/payment-posting.ts` owns this; `supplier-payments` reads the
  bill's **current** `paid_amount` from the DB (not a stale list) and compensates
  (deletes the payment) if posting fails.
- **Migration `005_accounting_integrity.sql`** adds a partial unique index
  (`entry_type, reference_number` where `status='posted'` and `entry_type in
  ('sale_invoice','supplier_payment')`) - the DB half of the retry/double-post
  guard - plus a lookup index and the read-only integrity view. Additive,
  idempotent, guarded; rollback drops exactly those three objects. **Not applied
  live** (no DDL path from the sandbox).
- **Ledger integrity is detected, not assumed.** `src/lib/accounting/integrity.ts`
  is pure/read-only (duplicate journals, orphaned lines, unbalanced entries,
  stale invoice balances). Nothing there writes.
- **Known, documented, not fixed here:** the four financial reports fail open when
  `tenant_id` is null; `update_account_balance` has no definition in the repo and
  an inconsistent sign convention; `accounts.balance` may drift from the ledger.
  These need a live DB and a dedicated task.
- **Verify a migration by executing it.** A local PostgreSQL 17 with a minimal
  journal schema is enough to prove 005 (apply, idempotent re-apply, behavioural
  duplicate block, rollback, no-op on a schema without `journal_entries`). Do not
  claim a DDL change works from parsing alone.

## Execution 17 invariants (tenant fail-closed + ledger balance reconciliation)

- **The four financial report pages fail closed.** `profit-loss`,
  `balance-sheet`, `trial-balance` and `cash-flow` are client components that
  query Supabase directly. They used to read `journal_entries`/`journal_lines`
  with NO tenant filter. They now resolve scope server-side via `useReportScope`
  (`/api/me`) and filter every journal read through `applyReportScope`
  (`src/lib/auth/scope.ts`). Never reintroduce a raw `from('journal_entries')`
  read in a report page; `tests/exec17-report-tenant-isolation.test.ts` guards it.
- **Scope rules are pure and fail closed.** `resolveReportScope`: super admin ->
  `all`; `admin`/`staff` with a tenant -> `tenant`; `admin`/`staff` without a
  tenant -> `null` (single-tenant rows, never every tenant); any other role or no
  identity -> `denied`. A `denied` scope filters to the nil UUID, never
  unfiltered. Tenant identity is never read from a URL/form field.
- **`accounts.balance` is a cache; `journal_lines` is authoritative.** Every
  report derives balances from the ledger; only the petty-cash screen reads the
  cached column. `update_account_balance` is NOT defined in any migration, so its
  sign cannot be verified from source and is NOT changed. All 10 call sites go
  through `applyAccountBalanceDelta` (`src/lib/accounting/account-balance.ts`),
  which preserves the amount and surfaces failure instead of swallowing it.
  Run `supabase/ACCOUNT_BALANCE_VERIFICATION.sql` (read-only) before changing a
  sign. The deposit-refund module is a documented deviation.
- **Manual postings use pure builders.** Bank transfer, petty cash, payroll and
  deposit refund build their journals through
  `src/lib/accounting/manual-postings.ts` (`buildBankTransferJournal`,
  `buildPettyCashJournal`, `buildPayrollJournal`, `buildDepositRefundJournal`)
  and write to `journal_lines`. The builders return `null` for a non-positive
  amount, so a zero/negative entry cannot post.
- **Migration 005 is column-guarded.** Its lookup index and view are guarded on
  column existence (not just table existence), so it is a clean no-op on a schema
  whose `journal_entries` lacks `entry_type`/`reference_number`/`total_debit`/
  `total_credit`. Verified by execution: `supabase/tests/005_harness/run.sh`.
- **Verify DDL by execution.** `supabase/tests/isolation_harness/run.sh` (17/17),
  `004_harness/run.sh` and `005_harness/run.sh` (10/10) run against a local
  PostgreSQL 17 with two tenants. 001/002/004 are NOT no-ops on a schema missing
  `profiles`/`tenants`/`users`; that is pre-existing and expected (Supabase always
  has them), not a live risk.


## Execution 23 invariants (persistent AI repair, approvals & verified outcomes)

- **Durable idempotency is the `ai_repair_executions` ledger** (migration 006).
  `executeRepair` claims the key *before* any side effect with an atomic insert,
  so concurrent requests, restarts and replayed approvals resolve to one row.
  The claim is `UNIQUE (tenant_id, idempotency_key)`; because a NULL tenant makes
  a plain unique index treat rows as distinct, a second **partial** unique index
  covers `where tenant_id is null`. Both must exist or a single-tenant install
  loses cross-request safety.
- **Store abstraction:** `src/lib/ai/repair-store.ts` (`RepairStore`), with a
  memory store, `createSupabaseRepairStore(client)` and
  `createResilientRepairStore(primary, fallback)`. The route builds the resilient
  store; before 006 is applied the durable store throws and the wrapper degrades
  to memory - the same `hasColumn`-style pattern used elsewhere. A degraded store
  is per-process and does not survive a restart; it is logged, never hidden.
- **The claim is never released blindly.** If recording the outcome fails after
  the side effect, the row stays `claimed` and a retry returns `in_progress`
  instead of re-running. `unresolved` means "executed but not verified - review".
- **Key reuse is a conflict, not a duplicate.** The same key with a different
  plan fingerprint returns `conflict` / `key_reused`. A stored plan may only be
  reported as an already-done `duplicate` when its fingerprint matches.
- **Evidence sufficiency.** `classifyRepairRequest` sets `requiresVerification`
  when there is no module hint, no symptom and no named report; `proposeRepair`
  then returns status `requires_verification` with no preview rather than running
  a diagnostic that would have to guess a source.
- **Isolation of the ledger.** RLS read via `can_read_tenant`, insert/update via
  `can_write_tenant`, a RESTRICTIVE `for delete using (false)`, and `revoke all
  from anon`. Deleting audit history is never permitted.
- **Proven by execution:** migration 006 applies twice cleanly and its unique
  claim (tenant + NULL-tenant), RLS read isolation and anon denial were verified
  on an isolated PostgreSQL 17 (`docker`). Tests:
  `tests/exec23-persistent-ai-repair.test.ts`, `tests/exec23-migration.test.ts`.
- **Local build needs env.** `npm run build` requires the Supabase env vars;
  without `.env.local` it fails at page-data collection (`supabaseUrl is
  required`). This is environmental, not a code regression.


## Execution 24 invariants (Excel/VAT closure — reference files absent)

- **The reference files named in the task were not present** (`speed_erp_progress(1).xlsx`,
  `VAT Report format-template for Bahrain.xlsx`); they were never tracked in Git. Do not
  claim to reproduce them. The updated inventory is an independent, code-grounded audit
  (`speed_erp_progress_execution24_review.xlsx`), and the Bahrain VAT comparison is derived
  from the implemented return structure + public Bahrain VAT rules, not from the template.
- **There is no Excel data-import (Excel -> ERP) path in this snapshot.** The only Excel
  capability is the reporting engine (`src/lib/reporting/`) plus format-template import.
  Building a data importer is a new engine and needs its own execution.
- **VAT section subtotals are driven by `ReportDefinition.groupColumn`.** The VAT
  definition declares `groupColumn: "section"`; the workbook engine emits a real `SUM`
  subtotal row per contiguous group before the grand total, and `validateReport` flags
  (error, class 2, `calc-subtotal-sum-*`) subtotals that do not add up to the total.
  Adding a subtotal group means setting `groupColumn` — never hardcoding rows.
- **The taxable base is a first-class VAT column.** `taxable_amount` and `vat_amount` are
  separate columns on both the screen and the export; never collapse them into one number.
- **The fixed-report preview runs the deterministic validator.** `buildPreview` returns
  `issues` + `summary`; `ReportFormatAssistant` renders them. The preview numbers are
  computed by `validateReport`, never by the model.
- **ExcelJS writes a text cell beginning with `=`/`+`/`-`/`@` as text, not a formula**
  (verified empirically). Keep it that way — do not "fix" this by interpolating user text
  into a formula string.
- **No second engine, no inventory.** Exec 24 changed only `src/lib/reporting/*`,
  the VAT page export, the assistant UI and tests. `tests/exec24-vat-template-closure.test.ts`
  (14 tests) is part of `test:core`. Baseline after Exec 24: 549 tests / 543 pass / 6 skipped.


## Execution 25 invariants (universal Excel data import)

- **One import engine, one action surface.** `src/lib/import/` is the only
  Excel→ERP path. It reuses the existing stack (ExcelJS for templates/reports,
  `xlsx` for parsing, `requireContext`/`logAudit`/`supabaseAdmin`) — do not add a
  second spreadsheet library or a per-page importer. Adding a module = one entry
  in `registry.ts`; nothing else hardcodes module knowledge.
- **`/api/import` (GET template + module list, POST preview/commit) is the only
  import route.** It requires `<module>.create`; reference reads additionally
  require the referenced module's `view`. `tenant_id` comes from the session,
  never the file. Commit **re-parses and re-validates the uploaded file
  server-side** — a client-supplied preview is never trusted.
- **Import is fail-closed and all-or-nothing.** `importSafety()` refuses any
  module without a `tenantColumn` (a tenant-less module would scope by `id` and
  let one tenant overwrite another). `commitImport` refuses the whole batch when
  any row is invalid or a duplicate (mode `all`), unless `valid` is explicit.
- **Shared charts are a deliberate exception.** `accounts.tenant_id` is nullable
  (shared chart), so its reference is declared `shared: true`: a NULL-tenant
  account resolves for any caller, a per-tenant account only for its tenant.
  Never widen this to other reference tables.
- **Two duplicate levels.** LEVEL 1 = same key earlier in the file; LEVEL 2 =
  existing DB row, tenant-scoped. Both block commit. A tenant must not see
  another tenant's key as a duplicate (regression-guarded).
- **The reference template file named in the task was absent again**
  (`System_Action_Items_Professional (2)(1).xlsx`); the 13 items are treated as
  prior work and were not re-opened without a failing test.
- Baseline after Exec 25: 568 tests / 562 pass / 6 skipped / 0 fail; typecheck
  129 (unchanged); lint clean; build OK (with placeholder env only).

## Execution 27 invariants (duplicate preflight + frozen 005/006 bundle)

- **R1 (005 can abort):** `005_accounting_integrity.sql` creates a PARTIAL UNIQUE
  index `journal_entries_one_posted_per_doc_uidx` on
  `(entry_type, reference_number) where status='posted' and reference_number is
  not null and reference_number <> '' and entry_type in ('sale_invoice',
  'supplier_payment')`. 005 runs in ONE transaction, so a pre-existing duplicate
  aborts the whole migration. ALWAYS run
  `supabase/EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql` (read-only, same predicate)
  first; it must return ZERO rows. Never widen the predicate to "fix" it.
- **R2 (no frozen artifact):** `supabase/PRODUCTION_ACTIVATION_005_006.sql` is the
  reviewed bundle for 005→006. It is GENERATED, never hand-edited:
  `node scripts/generate-activation-bundle.mjs`, then `npm test`
  (`tests/activation-package-integrity.test.ts` recomputes every SHA-256 banner
  from the actual bytes). Bodies must stay byte-identical to
  `supabase/migrations/005…`/`006…`.
- **Order is fixed:** 001 → 002 → 003 → 004 → 005 → 006. 005 needs 003's journal
  columns; 006 needs 002's `can_read_tenant`/`can_write_tenant`.
- **Local execution harness:** `supabase/tests/activation_005_006_harness/run.sh`
  runs the bundle on a throwaway PostgreSQL 17 in three scenarios — clean apply,
  idempotent re-apply, and pre-existing-duplicate abort (proving the transaction
  leaves NO partial index/view). 24/24 assertions pass locally. Migrations remain
  NOT applied to production.
- Baseline after Exec 27: 575 tests / 569 pass / 6 skipped / 0 fail; typecheck
  129 (unchanged).


## Execution 30 invariants (purchase ↔ credit-sale analytical linking — Item 6)

- **Reporting/analysis only.** `src/lib/accounting/purchase-sale-links.ts` records
  that a supplier bill relates to a sale. It NEVER creates inventory, a stock
  movement, a cost allocation or a journal entry, and never changes a document's
  amounts. `tests/exec30-purchase-sale-links.test.ts` asserts the service writes
  no `journal_entries`/`journal_lines`/`payments` and references no posting path.
- **No inventory/warehouse.** SPEED ERP has no stock subsystem; this feature does
  not add one. The negative test asserts no inventory/stock/warehouse table or
  query appears in the new files.
- **Many-to-many by design.** One purchase may back several sales and one sale may
  be backed by several purchases, so no one-to-one constraint is imposed. The
  report summary (`summarizeLinks`) de-duplicates by id before summing, so a
  many-to-many relationship cannot inflate a total, and purchase value is never
  folded into revenue.
- **Tenant isolation is the same model as everything else.** Migration
  `007_purchase_sale_links.sql` uses `can_read_tenant` (SELECT/DELETE) and
  `can_write_tenant` (INSERT/UPDATE), enables RLS, and revokes `anon`. Two partial
  unique indexes prevent duplicate pairs for a real tenant and for the NULL tenant
  (a plain UNIQUE treats NULLs as distinct). The API scopes every query on the
  server (`.eq("tenant_id", ...)` / `.is("tenant_id", null)`).
- **The link is not a financial event.** Deleting a link removes only the link
  row; the purchase and the sale are never touched.
- **Migration 007 verified by execution:** `supabase/tests/007_harness/run.sh`
  applies it to a throwaway PostgreSQL 17 with two tenants and asserts 15/15
  (clean apply, idempotent re-apply, cross-tenant read/insert/update/delete
  denied, NULL-tenant not a cross-tenant path, duplicate blocked, anon denied).
  Like 001-006, it is NOT applied to the live database (DDL is an operator step).
- Baseline after Exec 30: 651 tests / 645 pass / 6 skipped / 0 fail; typecheck 129
  (unchanged); lint clean; production build green.

## Execution 31 invariants (single financial posting path + admin closure)

- **`sales/new` is server-authoritative.** It POSTs to `/api/invoices`; it never
  inserts `invoices`, `journal_entries` or `journal_lines` itself. The browser path
  had no `tenant_id`, no idempotency guard and no financial-year check.
  `tests/exec16` and `tests/exec18` assert this and would fail on a regression.
- **`/api/invoices` is the one endpoint that issues a sale OR a rental.** Pass
  `invoice_type: "rental"` to post to the rental revenue account (41001,
  `entry_type='rental_invoice'`); the default is a sale (41002, `sale_invoice`).
  It accepts both `discount` and `discount_amount`, and stores `vat_tax_id`.
- **`sales-posting.ts` stays the single posting service.** Rental support is a
  parameter (`entryType` + `revenueCode`), not a second module. `reverseSaleInvoice`
  mirrors the invoice's own type (`rental_reversal` for a rental).
- **A customer receipt is `Dr Cash/Bank, Cr AR (12001)`** - never `Cr Revenue`.
  Revenue is recognised once, at invoice issue. Use
  `postCustomerReceipt` (`src/lib/accounting/receipt-posting.ts`); the rental pages
  used to credit revenue on collection (double-count) and write the orphan
  `entry_number`/`date`/`reference_no` columns.
- **Canonical `journal_entries` columns only:** `journal_number`, `entry_date`,
  `reference_number`, `entry_type`. `entry_number`/`date`/`reference_no` are read by
  no report; do not reintroduce them.
- **Document numbers come from `nextDocumentNumber`** (`generate_document_number`
  RPC). `Date.now()`/row-count numbering (`INV-<n>`) defeats the duplicate guard.
- **Admin provisioning is one script:** `scripts/provision-admin-accounts.mjs`
  (`npm run provision:admins`), verified by `scripts/verify-admin-accounts.mjs`.
  It reuses the existing Auth API + `public.users`; company admin `admin` +
  tenant-scoped, super admin `super_admin` + tenant-less. Re-running repairs the
  mapping without rotating a password (use `--rotate-passwords` to rotate).
- Baseline after Exec 31: 653 tests / 647 pass / 6 skipped / 0 fail; typecheck 129
  (unchanged); lint clean; production build green.

## Execution 36 invariants (release audit fixes)

- **`DELETE`/`PUT /api/journal-entries` are tenant-scoped and manual-only.** They
  load the row first with `.eq("tenant_id", ...)`/`.is("tenant_id", null)`, so a
  foreign id is a `404`. They refuse any `entry_type` outside the manual
  allow-list (`MANUAL_ENTRY_TYPES`): a system-posted entry (sale, purchase,
  receipt, payment, payroll, transfer, refund) is corrected by reversing the
  source document, never deleted or rewritten from this screen. Previously the
  service-role delete had no tenant filter and could destroy another tenant's
  ledger.
- **A route's catch-block compensation may only delete what that call created.**
  `/api/invoices` sets `createdJournalId` only when `postSaleInvoice` returned
  `created:true`; an idempotent retry (journal already existed) must never be
  rolled back, or the compensation deletes a real posting.
- **Payroll idempotency is keyed by the run reference, never the date.** Two
  legitimate runs can share a date, so `reference` is required and the form sends
  `PAYROLL-<date>-<runId>` (stable per submission, rotated after success).
- **Lint is not broken.** `npm run lint` (`next lint`) is clean today; the older
  "circular structure to JSON" note is stale.
- **Middleware gates pages, not only `/api/*`.** `PROTECTED_PAGE_PREFIXES` in
  `src/middleware.ts` redirects an anonymous `/dashboard` (and the other ERP
  prefixes) to `/login`; `tests/login-flow.test.ts` asserts both the API `401`
  and the page redirect. The older "page routes return 200 to anonymous callers"
  note is stale.
- Baseline after Exec 36: 776 tests / 770 pass / 6 skipped / 0 fail; typecheck 125
  (unchanged); lint clean; production build green.


## Execution 37 invariants (release packaging + hygiene)

- **Every migration that backs a live route has a frozen activation package.**
  007 was the last gap; `supabase/PRODUCTION_ACTIVATION_007.sql` now exists and is
  emitted by `scripts/generate-activation-bundle.mjs`. Apply order is
  001→002→003→004→005→006→007. `tests/activation-package-integrity.test.ts`
  recomputes every embedded SHA-256 (20 assertions), so a stale banner fails CI.
- **`EXEC07_1_TENANT_POLICY_FIX.sql` is not a file in this repo.** The tenant-policy
  fix it names (restrictive `activity_logs_no_update`/`_delete`) lives in migration
  002 and is guarded by `tests/security-tenant-isolation.test.ts`.
- **Editor-backup files are never tracked.** `*.backup`, `*.backup2`,
  `*.backup.<ts>` are git-ignored; `git ls-files | grep -c "\.backup"` must stay 0.
- **Anonymous `/api/*` always returns 401 from middleware**, so a route's presence
  cannot be fingerprinted with an unauthenticated request — a nonexistent API path
  also returns 401. Confirm the deployed commit on the VM, not by probing.
- Production is read-only-reachable over HTTPS: protected pages 307→`/login`,
  protected APIs 401, `/api/public/*` 200. Deploy + DDL remain operator steps
  (no `/var/www`, `pm2`, `ssh`, or DDL connection in the sandbox).


## Execution 38 invariants (deployment handoff)

- **The deployable release is frozen at `dd28b5e`** (branch
  `feat/final-hardening-round5`, 22 ahead / 0 behind `origin/main`). Release
  archive `release/speed-dd28b5e.tar.gz` sha256
  `5a4c38b40ddd5eca089daa41929dfdad12707e7f8d09e3367a5c6b3c8bce4a7a`, 462 files
  (== `git ls-files`), git-ignored. Exec 38 handoff docs are a docs-only commit
  after it, so the checksum stays non-circular.
- **The release lives only on the feature branch.** `origin/main` does not
  contain Exec 33–37; the server deploys from `main`. Publishing is a
  fast-forward: `merge --ff-only feat/final-hardening-round5` then a plain push.
  Guard that Exec 33–37 cannot be dropped: assert each of
  `bbc5e3a 795292f f008ec7 595e7d4 dd28b5e` is an ancestor of the release commit.
  Never `--force`, never `reset --hard`.
- **All 7 migrations have a checksum-verified activation package**
  (`PRODUCTION_ACTIVATION_001_002_003/004/005_006/007.sql`). Apply order
  001→002→003→004→005→006→007 via the Supabase SQL Editor on
  `chlkmdobhvfnldqkgdji`; run the 005 duplicate pre-check first (must return zero
  rows). Never continue past a failed statement.
- **Rollback never restores an old DB over newer transactions** and never edits
  journals manually — reverse via in-app documents. Each migration has a
  non-destructive `*_rollback.sql`.
- Handoff docs: `SPEED_EXECUTION_38_DEPLOYMENT_HANDOFF_AR.md` (Arabic operator
  runbook) + `SPEED_EXECUTION_38_HANDOFF_REPORT.md`.


## Execution 39 invariants (GitHub release promotion)

- **The release is fast-forward-safe onto `origin/main`.** `origin/main` is
  `29a005c4a9ddc964f6d92662c25ca991ca7fb477`, a direct ancestor of the branch tip.
  Promotion is `merge --ff-only` + a plain push — never `--force`, `reset --hard`,
  `clean`, or a branch delete.
- **The remote release branch is stale.** `origin/feat/final-hardening-round5`
  still points at `29a005c`; the local commits have never been pushed. Publish the
  branch (`git push origin feat/final-hardening-round5`) before/with promoting main.
- **Changes after the frozen release `dd28b5e` are docs-only** (Exec 38/39 reports +
  AGENTS.md). Never fold a runtime change in without re-freezing and re-checksumming.
- **Ancestor guard before promoting:** assert `bbc5e3a 795292f f008ec7 595e7d4
  dd28b5e` are each ancestors of the target, so Exec 33–37 cannot be dropped.
- `origin/feat/exec07-admin-superadmin-hardening` (`a9f9a9a`) differs from the local
  branch (`f02125d`) but both are ancestors of the release tip — nothing is lost.
- The push requires explicit owner authorization (Phase 3); report
  `SPEED_EXECUTION_39_GITHUB_RELEASE_REPORT.md`. This execution is GitHub-only — no
  deploy, no SQL, no production contact.
- **Promotion executed (owner-authorized, 2026-10):** `refs/heads/main` and
  `refs/heads/feat/final-hardening-round5` were both fast-forwarded from `29a005c`
  to the release tip. `dd28b5e` (frozen operational release) is an ancestor of
  `main`. The final tip is stated in the Exec 39 delivery summary; everything after
  `dd28b5e` is docs-only. Deployment to the server is still a separate step.

## Execution 48 invariants (phantom-column + nav-link hygiene)

- The live `customers` table exposes **`full_name`, not `name`** (evidence:
  `SPEED_PRODUCTION_READINESS_CHECK.md`, `src/lib/supabase.ts` `Customer` type,
  `src/lib/reporting/catalog.ts`). PostgREST **fails the whole `select`** when any
  listed column is unknown, so one phantom `name` silently breaks the entire query
  (empty dropdown, failed insert, null relation). Never select/insert a
  `customers.name`; use `customers.full_name`.
- `journal-entries` reference data must query the **`drivers`** table for the driver
  dropdown (`drivers.full_name`), not `customers`. A copy-paste bug had the driver
  slot fetching `customers(...).limit(1)`.
- `tests/exec48-customer-schema-and-links.test.ts` (in `test:core`) enforces this
  repo-wide: no standalone `name` in a `customers` select/relation/insert, the
  driver query targets `drivers`, and `DashboardLayout` / dashboard-KPI / reports
  hub hrefs resolve against the real `src/app/**/page.tsx` route tree.
- **Dead nav links corrected:** `/users` → `/settings/users`,
  `/rental-contracts` → `/rentals`, `/loans/new` → `/cars/new` (financing lives on
  the car form). Verify a nav href against the route tree before adding it; there
  is no `/loans/new` or `/rental-contracts` page.

## Execution 49 invariants (final functional gap audit)

- **`invoices` has `total_amount`, not `total`, and has no `customer_name`.**
  The customer name is the `customers(full_name)` relation. A `select` listing a
  phantom column fails the **whole** PostgREST request, so this silently broke the
  assistant's `receivables_summary` and `invoice_lookup` tools
  (`src/lib/ai/tools.ts`). Never select `invoices.total` / `invoices.customer_name`.
- **The fleet table is `cars`; there is no `vehicles` table.** A relation
  projection `vehicles(*)` (e.g. the old `rentals/[id]/payment` query) fails the
  request. `tests/exec49-functional-gap-closure.test.ts` rejects any
  `vehicles(...)` relation repo-wide.
- **Quotation print** lives at `/quotations/[id]/print` (added), mirroring
  `payments/[id]/print`. The list links to it; do not reintroduce a
  `/quotations/print?id=` target — there is no such route.
- **`/accounting`, `/hr`, `/vehicles`, `/analytics`, `/journal`,
  `/settings/website`, `/settings/integrations` are not pages.** Back buttons and
  the sidebar-settings default tree must target a real page
  (`/accounting/journal-entries`, `/accounting/expenses`, `/hr/employees`,
  `/cars`, `/financial-dashboard`, `/settings/company`,
  `/settings/integrations/whatsapp`).
- `tests/exec49-functional-gap-closure.test.ts` (in `test:core`) enforces all of
  the above, including a **whole-tree** scan that every `href` /
  `router.push` / `router.replace` / `redirect` literal (object-form `href:`
  included) resolves to a real `src/app/**/page.tsx`. Add any new page link to the
  route tree before shipping it.
- `npm run lint` currently passes (`No ESLint warnings or errors`) in this
  environment; the "broken ESLint config" note no longer reproduces.



## Execution 50 invariants (final completion audit)

- **The `cars` plate column is `plate_number`; `license_plate` does not exist.**
  Three projections (`bookings/page.tsx`, `invoices/[id]/page.tsx` x2) requested
  `license_plate`, which failed the whole PostgREST request (42703) so those pages
  silently loaded no car/contract rows. Fixed in Exec 50; the Exec 49 guard now
  also rejects `license_plate` repo-wide.
- **Not every `.from("...")` table is enumerated in repo SQL.** `contracts`,
  `depreciation_schedules`, `expense_categories`, `leaves`,
  `payroll_adjustments`, `payroll_records`, `financial_ratios` and the
  `financial_*` tables exist live but are absent from the migrations/harness, so
  an "unknown table" scan flags them as false positives. Verify a column/table
  against the live schema or the app's own insert payloads before calling it a
  phantom.
- **The partial TS types in `src/lib/supabase.ts` are not the full column set.**
  `rental_contracts.daily_rate/deposit_amount/total_days/subtotal/vat_amount`,
  `invoices.paid_amount/discount_amount/invoice_type` and `expenses.vat_amount`
  are real (written by `rentals/new`, read by `api/financial/calculate`); a scanner
  that trusts only those types reports them as false positives.
- **The Excel import engine is `src/lib/import/*` (Exec 25), not `src/lib/excel/`.**
  The "Execution 04 (universal Excel engine)" section describes a `src/lib/excel/`
  tree that is not in this snapshot; the working importer is
  `src/lib/import/registry.ts` + `engine.ts` + `template.ts` + `export.ts`,
  proven by `tests/exec25-universal-import.test.ts`.
- **The original 13-item checklist** (`speed_erp_progress(1)/(2).xlsx`) was never
  accessible in this environment (Exec 41); the authoritative list audited in
  Exec 50 is Exec 33's "the Original 13 Items".

## Execution 51 invariants (public.users role-escalation hardening)

- Migration `008_user_role_hardening.sql` (additive, idempotent, depends on
  `004`) replaces `prevent_role_escalation()`. It closes the two paths 004 left
  open: (a) `auth.uid() is null` was treated as proof of the service role, and
  (b) only `super_admin` was guarded, so a `staff`/`client` row could set its own
  role to `admin`, and any caller could change `tenant_id`.
- **Never treat `auth.uid() is null` alone as the service path.** The trust test
  is `is_trusted_service_context()`: trusted only when there is no uid AND the
  signed JWT role claim is absent (direct connection) or `service_role`.
  `authenticated`/`anon` sessions are never trusted. The predicate is revoked
  from `anon` and `authenticated` (the trigger runs as SECURITY DEFINER).
- For untrusted sessions the trigger now enforces: no self-promotion from a
  non-admin role to `admin`/`super_admin`; cross-user role edits require an
  administrator; `tenant_id` reassignment is super-admin only; grant/revoke of
  `super_admin` stays super-admin only. The trusted provisioning path is
  unchanged.
- Verify by execution, not parsing: `supabase/tests/008_harness/run.sh` applies
  base -> 004 -> 008 on PostgreSQL 17 and asserts 18 cases (incl. the null-uid
  session being refused and the service path being allowed). Re-apply is
  idempotent; `008_user_role_hardening_rollback.sql` restores 004 semantics.
- `tests/exec51-role-hardening.test.ts` guards the migration's intent; it is in
  `test:core`. Do not re-introduce an `auth.uid() is null` service check.


## Execution 52 invariants (customer booking flow — car must appear)

- **One customer booking path.** `src/lib/rental/booking-service.ts` owns the
  customer portal's car list and booking creation. The browser never reads `cars`
  or inserts `rental_contracts`; it calls `GET /api/customer/available-cars` and
  `POST /api/customer/bookings`. Both are `requireContext(..., { allowRoles:
  ["client"] })` and take the tenant/customer from the session, never the body.
- **Root cause fixed:** the portal used the browser client with
  `.eq('status','available')` and **no tenant filter**, while a customer account
  had no `tenant_id`. A tenant-less customer therefore saw every company's cars
  (and, if RLS were enabled, would have seen none). `customer-signup` now stamps
  the resolved company (unambiguous: the sole car-owning tenant, else the sole
  `tenants` row) onto the `customers`/`users` rows.
- **Scoping mirrors the RLS predicate:** tenant-bound callers get
  `.eq('tenant_id', t)`, tenant-less callers get `.is('tenant_id', null)`. Do not
  replace this with an unscoped read.
- **Availability is status + category + window.** Only `status='available'` and
  `category in ('rental','both')` are rentable (a `sale` car is not). A booking
  occupies a half-open `[start,end)` interval; an overlapping `pending/active/
  confirmed/reserved/approved/ongoing/rented` contract hides the car and rejects a
  duplicate with **409**.
- **Price is computed server-side** from the car's own rates; a client-supplied
  amount is never trusted. The booking is stamped with the **car's** tenant (which
  the scoped read proved is the caller's), so `tenant_id` cannot be smuggled in.
- `/customer-dashboard` and `/booking` are in `PROTECTED_PAGE_PREFIXES`.
  `tests/customer-booking-flow.test.ts` (in `test:core`) guards all of the above.

## Execution 41 invariants (routes, global Super Admin console, AI, formats)

- **`/erp` is a public marketing page, not a gated ERP route.** It was wrongly in
  `PROTECTED_PAGE_PREFIXES`, so anonymous visitors got a 307 to `/login`.
  `tests/login-flow.test.ts` now asserts `/erp` stays public and that
  `/super-admin` is protected while `/super-admin-login` stays public.
- **Two sign-in doors, one authorization source.** `/login` is for company
  administrators/staff (and routes customers to `/customer-dashboard`); a genuine
  `super_admin` is routed to `/super-admin`. `/super-admin-login` is the operator
  door. Both decide the role from **`/api/me`** (server-resolved), never from an
  email, `user_metadata` or a browser-fetched role. `isSuperAdmin` is the only
  signal that admits a caller to the global console.
- **The global console reads through guarded routes only.** `src/app/super-admin/`
  calls `/api/super-admin/{overview,ai,tenants/[id],users/[id]}`, each of which
  requires `requireSuperAdmin`. The page never queries an ERP table with the
  browser client (the browser client is used only to sign out).
- **The console can never mint a `super_admin`.** `assertRoleChangeAllowed`
  rejects it; only `admin`/`staff`/`client` are assignable from the console.
  Migration 004/008 enforce the same in the database.
- **`/settings/ai-control` is linked from the sidebar** (`DashboardLayout`), so the
  existing AI Control surface is reachable, not orphaned. The company-facing
  `AiAssistantPanel` on `/dashboard` reuses the shared `repair-client` and the
  existing `/api/ai/*` endpoints - no second AI pipeline.
- **One format helper set.** `src/lib/utils.ts` owns `formatCurrency`,
  `formatNumber`, `formatDate` and `formatDateTime`. `formatDate`/`formatDateTime`
  default to `ar-BH` (Western digits, `d MMM y`) instead of `ar-SA`, whose default
  calendar is Hijri. Ad-hoc `new Date().toLocaleString()` in print headers was
  replaced with `formatDateTime` so the same screen prints identically everywhere.
- **`RecordSelect` / `QuickCreateModal` / `sources.ts`** are the single reusable
  record picker. `sales/new`, `purchases/new`, `invoices/new` and `rentals/new`
  use it; the inline ad-hoc customer/supplier modals were removed. A field's
  options come from the module that owns the record (`RECORD_SOURCES`).
- **`tests/exec41-super-admin-console.test.ts`** guards the console policy, the
  per-tenant isolation of the overview, and the "no direct browser DB access"
  rule. `tests/exec31-receipt-and-rental-posting.test.ts` was moved into
  `test:core` so every suite runs under `npm test`.

## Execution 53 invariants (shared ledger engine + depreciation posting)

### Stage 2 - shared ledger engine and statements

- **One ledger read model.** `src/lib/reporting/ledger.ts` (`buildLedger`,
  `summarizeAccounts`, `accountBalances`) is the single place that turns
  `journal_entries` + `journal_lines` + `accounts` into balances. The General
  Ledger, Trial Balance, P&L, Balance Sheet and Cash Flow screens consume it; do
  not re-derive balances per page (that is how the four statements drifted apart).
- **A contra-asset is still an asset.** `Accumulated Depreciation` (14001) has
  `type='asset'`, so the balance-sheet section total is **cost less accumulated**
  only if the section sums signed balances (debit - credit). A section that sums
  `abs(balance)` shows accumulated depreciation as an increase in assets. Section
  totals are `SectionTotal { debit, credit, balance }` - assert on `.balance`, not
  on a bare number.

### Stage 3 - depreciation posting (`src/lib/accounting/depreciation-posting.ts`)

- **A schedule is a calculation; posting is a ledger event.** The depreciation
  screen computed a schedule in the browser and wrote nothing, so the expense was
  never in the P&L and the contra-asset never on the balance sheet. Posting is now
  the single path `POST /api/depreciation/post` -> `postDepreciation`:
  `Dr Depreciation expense (52001) / Cr Accumulated depreciation (14001)`.
- **The server computes the charge, never the browser.** The route recomputes the
  amount from the schedule (method, cost, salvage, life) and the accumulated
  depreciation read from the **ledger**, clamped so accumulated never exceeds the
  depreciable base. A client-supplied amount is ignored.
- **Idempotent by `(entry_type='depreciation', reference_number)`.** The reference
  is `DEP-<car_id>-<period_end>`; re-posting returns the existing journal
  (`created:false`). Migration 009 adds a supporting lookup index; the partial
  unique index pattern used by 005 covers the sale/payment types.
- **An idempotent re-post reports no second charge.** When `created:false`, the
  route returns `accumulated_after`/`book_value_after` unchanged - reporting
  `accumulated + amount` would imply a charge that never happened.
- **Both lookups are tenant-scoped, and a super admin is the only caller not
  scoped** (`if (!context.isSuperAdmin)`), matching `scopeToCompany`. The
  accumulated-depreciation query is scoped too: reading another tenant's
  depreciation for the same asset id would suppress this tenant's charge.
- **Accounts are seeded by migration 009** (`14001` asset-contra, `52001`
  expense), idempotently (`where not exists`). The rollback drops only the index
  and **never deletes a seeded account** (a posted journal may reference it).
- **`supabase/PRODUCTION_ACTIVATION_009.sql` is generated, never hand-edited** -
  `node scripts/generate-activation-bundle.mjs` embeds migration 009 verbatim and
  records its SHA-256. `tests/activation-package-integrity.test.ts` recomputes it.
  Migration 008 has no package (pre-existing gap, not introduced here).

### Proving it (do not claim DDL or UI works from parsing)

- **Migration 009 is verified by EXECUTION** on real PostgreSQL: the PGlite test
  in `tests/exec53-stage3-depreciation.test.ts` applies it, re-applies it
  (idempotent), and rolls it back against a schema mirroring the live tables.
  `scripts/dev/verify-migration.mjs` (`npm run verify:migration`) is the same
  proof as a standalone harness.
- **The posting flow is verified in a REAL browser.** `npm run shots:e2e`
  (`scripts/dev/e2e-depreciation.mjs`) signs in through the real login form,
  clicks Post on the depreciation screen, and asserts the journal exists,
  balances, references the asset, is not duplicated on re-post, and **appears on
  the P&L and the balance sheet**. Screenshots are written to `docs/screenshots/`.
- **Bilingual digits break naive assertions.** The Arabic locale renders
  Arabic-Indic digits (`١٬٨٠٠٫٠٠٠`); normalize `[\u0660-\u0669]`/`[\u06f0-\u06f9]`
  and the Arabic separators before matching a figure, or a correct number reads as
  absent.
- **Local-only tooling.** `scripts/dev/local-supabase-stub.mjs` serves the fixed
  dataset; nothing here touches a real Supabase project. Run it via
  `bash scripts/dev/run-dev.sh <port>` (which clears a stale `.next` first - a
  stale cache serves dead chunk URLs and the page never hydrates).

## Execution 54 invariants (purchasing/accounting closure + 9 purchasing reports)

- **Every purchasing mutation is server-authoritative.** One route per document:
  `POST /api/purchases` (bill), `POST /api/supplier-payments` (+
  `[id]/reverse`), `POST /api/debit-notes`, and `DELETE /api/purchases`. The
  screens POST to these routes; they never insert or delete the document row
  themselves. Before Exec 54 the browser wrote `purchase_invoices`,
  `debit_notes` and the payment/bill updates directly, with no `tenant_id`, no
  journal and no duplicate guard — a document could exist with no ledger entry.
- **A document and its journal are written together, or neither.** Each route
  compensates by removing what *it* created when posting fails; a route's
  catch-block must never roll back a journal an idempotent retry found already
  present. The document number is the idempotency key.
- **A posted supplier bill is never deleted from the UI.**
  `src/lib/accounting/invoice-guards.ts` now mirrors the sales guard:
  `isPurchaseBillPosted` (a `purchase_invoice` journal exists for the bill number)
  and `hasPurchaseBillDependents` (payments, debit notes or line items point at
  the bill). `DELETE /api/purchases` loads the row tenant-scoped (a foreign id is
  a 404), refuses a posted bill and a bill with dependents (403), then audits.
  An unreadable dependent table counts as zero so the guard never blocks a
  legitimate delete. `src/app/purchases/page.tsx` surfaces the server's refusal.
- **Nine purchasing/expense reports live in one pure module.**
  `src/lib/reporting/purchasing-reports.ts` (`PURCHASING_REPORT_KINDS`:
  `purchase_register`, `supplier_ledger`, `supplier_aging`,
  `expenses_by_vehicle`, `expenses_by_branch`, `expenses_by_category`,
  `vat_purchases`, `monthly_expenses`, `vehicle_profitability`). One route
  (`GET /api/reports/purchasing?kind=…`, permission `reports.view`) and one screen
  (`src/components/reports/PurchasingReportPage.tsx`) serve all nine. Add a kind
  to the list and a builder — never a per-report page or a second engine.
- **The purchasing tax base is NOT uniform and is encoded once.**
  `purchase_invoices.total_amount` is VAT-inclusive (taxable = total − vat);
  `expenses.amount` is stored pre-VAT (taxable = amount). `billTaxableBase` /
  `billOutstanding` own this; a screen must not re-derive it. Cancelled documents
  contribute nothing, everywhere.
- **Purchasing reports are fail-closed.** `src/app/api/reports/purchasing/route.ts`
  reads unfiltered only for `context.isSuperAdmin`; every other caller is scoped
  to its tenant (`q.eq("tenant_id", …)`, `q.is("tenant_id", null)` on the
  single-tenant install). Never reintroduce a `if (!tenant) return query` helper.
- **Migration 010** (`supabase/migrations/010_purchasing_accounts.sql`) seeds input
  VAT `24001`, other expenses `51099` and the `debit_note` sequence, idempotently
  (`where not exists`). Frozen package `supabase/PRODUCTION_ACTIVATION_010.sql`
  embeds the body byte-identically (SHA-256 in its banner, guarded by
  `tests/activation-package-integrity.test.ts`); the rollback refuses to orphan a
  posted line. **Not applied live** — DDL is an operator step.
- **The screenshot harness must fail, not warn, on a wrong shot.**
  `scripts/dev/capture-screenshots.mjs` takes an `expect` marker per shot and
  throws when that text never renders; a tab click is retried until the target
  panel's own text appears (`pageHasText`), because a click landing before React
  hydration is silently dropped; a byte-identical screenshot fails the run.
  A plain `innerText.length > 80` check is NOT sufficient — the page shell
  (header + tab bar) already satisfies it, which is how six super-admin tabs were
  once committed as the same frame under six names.
- **Verify the images, not the run exit code.** The duplicate-hash guard passed
  while five of six tab shots were the same frame; only a pairwise pixel diff
  exposed it. Check `PIL.ImageChops.difference` (or equivalent) before treating
  screenshots as evidence.
- Baseline after Exec 54: 1012 tests / 1006 pass / 6 skipped / 0 fail; typecheck
  0 errors; lint clean; production build green. 56 committed screenshots, all
  distinct.

## Execution 55 invariants (Super Admin production 404 diagnosis)

- **The production 404 on `/super-admin` and `/super-admin-login` is a release
  gap, not a code fault.** `main` (`d6788be`) never received Exec 41 onward; the
  Super Admin console was added by `c536858` and is absent from `main` entirely.
  The server deploys `main`, so the running build has no such routes. Confirmed
  by `git ls-tree -r --name-only origin/main | grep '^src/app/super-admin'`
  returning nothing, while the branch has both pages.
- **Exec 39 was the last promotion.** Everything from Exec 41 onward (Super Admin
  console, General Ledger, the nine purchasing reports, the purchasing APIs,
  migrations 008–010 and their activation packages) is missing from production.
- **`main` is a direct ancestor of the branch**, so the release is a clean
  fast-forward: `git merge --ff-only feat/final-hardening-round5` then a plain
  push. Never `--force`, never `reset --hard`.
- **Diagnosing a production 404: check who answered it.** `x-powered-by: Next.js`
  plus the app's own RTL not-found shell means Next.js served it (a missing
  route), not nginx (a proxy/`try_files` miss). Response headers settle this in
  one request.
- **A `307` on a protected path only proves the middleware knows the prefix, not
  that the page exists** — those prefixes predate Exec 41. Route presence cannot
  be established from an unauthenticated request; verify on the VM after deploy.
  Expected post-deploy: `/super-admin-login` = 200, anonymous `/super-admin` = 307.
- **`/super-admin` needs migration 004** (`is_super_admin()` + the extended tenant
  predicates). Code without 004 gives a console that loads but cannot read across
  tenants.
- See `SPEED_SUPER_ADMIN_404_DIAGNOSIS.md` for the full evidence and the
  backup/migration/rollback checklist. **Nothing was deployed and no database or
  administrator account was touched** — the probes were read-only HTTP GETs.
