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

- `npm run typecheck` reports **129 errors** in the legacy ERP pages. This is the
  baseline; new code must not increase it. Verify with
  `npm run typecheck 2>&1 | grep -c "error TS"`.
- `npm run lint` fails with `Converting circular structure to JSON` — a broken
  ESLint config, unrelated to source code. Lint is **not usable** as a gate here.

## Architecture that must not be bypassed

```
src/lib/auth/api-guard.ts   requireContext / withAuth — the only entry point for API auth
src/lib/auth/policy.ts      can(), tenant/branch/financial-year assertions (pure)
src/lib/auth/context.ts     resolveAuthContext, getActiveFinancialYear (server-only)
src/lib/auth/permissions.ts module x action catalogue
src/lib/auth/audit.ts       logAudit — sanitises metadata before writing
src/lib/supabase-admin.ts   service-role client (server-only)
```

Rules learned the hard way:

- **Never trust the request body for identity.** `tenant_id`, `branch`, `role` come
  from the session via `requireContext`, never from client input.
- **`resolveAuthContext` always starts from `DEFAULT_ROLE_PERMISSIONS[role]`** and
  only then merges DB overrides. A test that constructs a context with an empty
  permission map tests a state that cannot occur in production.
- **Split pure logic from DB-bound logic.** `validator.ts` (rules) vs
  `references.ts` (lookups), `gates.ts` (authorization) vs `http.ts` (scope).
  Importing the `@/lib/auth` barrel pulls `server-only` and breaks client
  components. Import `policy.ts` / `errors.ts` / `types.ts` directly instead.
- **Tenant filters are applied before any narrowing filter**, so `ids`/`filters`
  can only reduce a result set, never widen it.

## Excel service (`src/lib/excel/`)

Reusable CORE capability — import/export for any module, not a business module.

- `registry.ts` — module specs (fields, labels, aliases, types, permissions).
  Add a module here; nothing else hardcodes module knowledge.
- Pipeline: `parse` → `mapper` → `normalize` → `validateRow` → `references` →
  `duplicates` → `importer`.
- `client.ts` exposes an injectable `ExcelDb`; production passes nothing and gets
  `supabaseAdmin`. Tests inject a recording stub.
- Import is limited to modules whose table has a `tenant_id` column. Tables without
  one are export-only until the RLS migration adds it.
- `src/components/excel/` — `<ExcelImportButton />` and `<ExcelExportButton />`,
  both driven by `use-excel.ts`. `Toaster` (sonner) is mounted in `src/app/layout.tsx`.

### Wiring into module pages (Phase 3)

- A page adds exactly one thing to its header:
  `<ExcelModuleActions module="customers" filters={...} onImported={reload} />`.
  Do not call the lower-level buttons directly from pages.
- Pass the page's own filter so "export" matches what the user sees, and the page's
  reload function so an import refreshes the list.
- `ExcelModuleActions` renders nothing until `/api/excel/*` confirms the caller's
  permissions, so a page cannot show a control the user may not use. A module that
  is export-only shows an "Export only" hint using the registry's `notes`.
- **Templates are gated by `resolveTemplateModule`**, not the import gate: importable
  modules use the import permission, export-only modules use the export permission.
  Never grant `import` permission just so a template can be downloaded.
- The module list is cached per session in `use-excel.ts`. Clear that cache if a role
  change must take effect without a reload.
- `tax_settings` and `tax_rates` are **different real tables**. The Tax Settings pages
  use `tax_settings`. Verify a table's live columns before wiring a module.
- 20 pages are wired; `tests/excel-module-integration.test.ts` asserts the page↔module
  mapping. Adding a wired page means updating that list.

### Import safety invariant (do not weaken)

- **A module may only be importable if it declares a `tenantColumn`.** The importer
  scopes writes with `if (tenantId && module.tenantColumn)`, so a tenant-less module
  would scope updates by `id` alone — letting one tenant overwrite another's row.
  `importSafety()` in `gates.ts` enforces this fail-closed, and
  `tests/core-security-migration.test.ts` asserts every importable module passes it.
- Import safety needs three things to agree at once: the registry marks the module
  `importable: true`, it declares a `tenantColumn`, and **the live table actually has
  that column**. Never enable import from the registry alone — confirm the column
  exists in the live database first.

### Database access from this environment

- DDL is **not executable** here: `DATABASE_URL`'s pooler region does not serve the
  project (every region returns `(ENOTFOUND) tenant/user postgres.<ref> not found`),
  `db.<ref>.supabase.co` does not resolve, and PostgREST exposes no `exec_sql` RPC.
  Migrations are delivered as files for an operator to apply, and their application
  is reported `NOT VERIFIED`.
- PostgREST **is** reachable with the service key, so the live schema and the current
  RLS state can be verified at the data level. A useful read-only probe: `GET
  /rest/v1/<table>?select=id&limit=1` with the anon key — a `content-range` header on
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

- `src/lib/auth/session-context.ts` is the **only** client-safe way for a browser
  page to learn its `tenant_id` and active `financial_year_id`. It derives both
  from the authenticated session; neither may ever be read from a form field,
  query string or other caller input.
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
    single-tenant install — every `tenant_id` NULL — keeps working unchanged.
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

## Execution 04 invariants (universal Excel engine)

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
  Never write `journal_entries`/`journal_lines` directly from the engine — a second
  accounting path is exactly what the core forbids.
- `postJournalEntry` resolves the tenant **before** its duplicate guard, and scopes the
  guard by `tenant_id` (`.is("tenant_id", null)` for a tenant-less caller). Matching on
  `reference_number` alone leaked one tenant's entry to another.
- `assertAccountsUsable` in `posting.ts` rejects an account id that does not exist or
  belongs to another tenant. `accounts.tenant_id` is nullable (shared chart), so the
  tenant-less chart is accepted for any caller.
- `GET /api/excel/import-history` reads the existing `activity_logs` audit trail; do not
  create a second import-history store.
- The error report carries a "الحل المقترح" / "Resolution" column sourced from the
  `RESOLUTIONS` map in `exporter.ts`; add a code there when adding an error code.
- `npm run test:excel` includes `tests/excel-duplicates-and-groups.test.ts`;
  `npm run test:accounting` includes `tests/accounting-tenant-guard.test.ts`.


## Execution 05 invariants (sales + invoices + payments + returns)

- **One sales engine.** `src/lib/sales/service.ts` owns every financial sales
  mutation: `createSalesInvoice`, `recordPayment`, `createSalesReturn`,
  `assertInvoiceMutable`. Pages and routes call it; nothing posts a sales journal
  entry directly. A second sales/posting path is what this execution forbids.
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
  `REC-${Date.now()}`-style numbers — a timestamp changes on retry and defeats the
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
  after the migration — writes drop only columns the DB lacks instead of failing.
- **Tests need the server condition.** `npm test` uses
  `node --conditions=react-server --import tsx ...` so `server-only` modules
  (`supabase-admin`) load. `tests/sales-lifecycle.test.ts` runs the real service
  against a PostgREST stub; `supabaseAdmin` and `assertReference` take an injectable
  client for this.

## Execution 05.1 — Financial-year enforcement (server side)

- `resolveAuthContext` (`src/lib/auth/context.ts`) now resolves the tenant's
  active financial year and puts it on `AuthContext.financialYearId`. It used to
  be hardcoded `null`, which silently disabled year validation on every API
  route. Do not revert it to `null`.
- `src/lib/sales/service.ts` calls `assertPostingYear(client, context, date)`
  before every financial write (invoice, payment, return). It resolves the year
  through the caller's own client, tenant-scoped, and skips validation when the
  tenant has no year (backward compatible). Any new financial service must call
  it too.
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

- **Deliverable:** `supabase/PRODUCTION_ACTIVATION_001_002_003.sql` — the frozen
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





## Execution 06 — Public SaaS + Free Account (invariants)

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


## Execution 07 — administrator accounts, global super admin, login hardening

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
  identity-policy change** — parsing alone would not have caught these.
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
    if its `public.users` mapping fails — no half-provisioned privileged account.
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
  11/11 assertions) — see `supabase/tests/004_harness/`.

## AI report formatting (`src/lib/reporting/`)

- **Formatting/structure only.** The assistant renders EXISTING report data; it
  never writes invoices, journals, balances or tax values. A request that asks to
  change amounts is classified as `intent: "data"`, flagged
  (`dataChangeRequested`) and never executed — real data changes must go through
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
  tenant-scoped from the session — no new table.
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
  whose column exists — never a schema change for a report request.
- **`report-def.ts`** parses Arabic/English requests deterministically (dataset,
  fields, filters, group-by, aggregates, sort). `findTerm` is Arabic-prefix aware
  (`و`/`ال` attach without a space). Only a closed set of filter ops
  (`eq/gte/lte/overdue/contains`) is emitted — no SQL is built from the prompt.
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
  leak detail). `loginErrorMessage` maps `invalid_credentials`/400/429/… to safe,
  localized strings.
- **Credentials are normalised** (`.trim()`) and the email input sets
  `autoCapitalize="none" autoCorrect="off"` — an autocapitalized or space-padded
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
  `completeWithFallback` — never reintroduce a hard-coded `new Anthropic(...)`.
- **Read-only by construction.** The assistant's tool set (`AI_TOOLS` in
  `src/lib/ai/policy.ts`) is closed and every tool is `kind: "read"`. A request
  to post/edit/delete accounting data is refused by `detectWriteIntent` before
  any model call. Never let the assistant write `journal_entries`,
  `invoices`, `payments` or any financial row — mutations stay on the existing
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
  never returned — `toPublicSettings` exposes only `hasApiKey`.
- **The AI never self-applies.** Development requests
  (`src/lib/ai/dev-requests.ts`) are a review-only pipeline: create → plan →
  approve/reject → artifact. `isForbiddenPath` / `assertChangeSetSafe` block any
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
  embedded body by hand — a stale hash is a trust failure.
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
  (`npm run verify:admins`) proves the sign-in → `public.users` → role/tenant flow
  end-to-end. Both require real Supabase credentials, which the sandbox lacks.

## Execution 10 invariants (final closure)

- **Financial tenant scope is fail-closed, everywhere.** `scopeToCompany`
  (`src/lib/auth/policy.ts`) confines a tenant-less caller to `IS NULL`; only a
  super admin reads unfiltered. `financial/reports` and `financial/calculate`
  once used a local `if (!tenantId) return query` helper � that is the exact
  fail-open shape to never reintroduce. `tests/tenant-isolation.test.ts`
  ("financial routes scope fail-closed") scans every `financial/*/route.ts` and
  fails if any uses a helper other than `scopeToCompany` or re-adds the
  `if (!tenant) return query` pattern.
- **Tenant-owned inserts must set `tenant_id` from the session.** A row written
  into a tenant-owned table (per migration 002's `tables text[]` column list)
  without a `tenant_id` is an orphan visible to the single-tenant install. Use
  `assertWritableTenant(context, body.tenant_id)` then `if (tenantId) payload.tenant_id = tenantId`
  � as `suppliers`, `expenses`, `quotations` and `expense-accounts` now do.
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
- **Live activation is still an operator step.** Migrations 001�004 are not
  applied on the live project and cannot be from the sandbox (no credentials, no
  DDL path). The isolation + 004 harnesses (local PostgreSQL 17) prove the SQL;
  they do not prove the live database. `EXEC07_1_TENANT_POLICY_FIX.sql` does not
  exist in this branch � 002 is the authoritative isolation model.
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

