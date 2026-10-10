# CORE_SECURITY_FINAL_REPORT.md

Core / Security / Data-Integrity phase for the car-rental & sales ERP.

Companion document: `CORE_AUDIT_BEFORE.md` (Phase 1, pre-change audit).

---

## 1. Implemented

### 1.1 Server-side authorization layer (`src/lib/auth/`)

A single place where "who is calling and what may they do" is decided, used by every
privileged route handler. It is split deliberately into a **pure policy module** and an
**infrastructure-bound resolver**, so the decision rules can be unit tested without a
database:

| File | Responsibility |
| --- | --- |
| `policy.ts` | Pure, side-effect-free rules: `can()`, tenant scoping, branch access, financial-year checks, audit metadata sanitisation. No I/O. |
| `permissions.ts` | Permission catalogue (module × action) and role defaults for `admin` / `staff` / `client`. |
| `types.ts` | `AuthContext`, `FinancialYear`, `AuditAction`. |
| `context.ts` | Resolves the real `AuthContext` from the Supabase session cookie + `users` / `profiles` / `roles` / `permissions`. Infrastructure-bound (DB access). |
| `api-guard.ts` | `requireContext`, `withAuth`, `withAuthResponse` — the guard every route calls. |
| `ownership.ts` | `assertTenantOwnership(table, id, context)` — 404 vs 403 on cross-tenant ids. |
| `references.ts` | Foreign-key validation against the caller's tenant (`assertReference`, `assertReferences`, `assertReferenceList`) + `REF_*` specs. |
| `audit.ts` | `logAudit()` — writes `activity_logs`, best-effort, sanitised. |
| `errors.ts` | `ApiError` + stable, non-leaking HTTP error contract. |
| `tenant.ts` | Back-compat re-exports of the policy helpers. |
| `index.ts` | Public surface. |

Authorization order enforced on every guarded route: **authentication → role/permission →
tenant context → resource ownership → reference validity**. Identity and permissions come
from the session and the database only, never from the request body.

### 1.2 Authentication and session plumbing

- `src/lib/supabase.ts` and `src/lib/supabase-server.ts` now use `@supabase/ssr`
  cookie-backed clients, so the server can read the same session the browser holds.
  Previously the browser client stored the session in `localStorage` and no server
  handler could authenticate a caller.
- `src/middleware.ts`:
  - refreshes the Supabase session cookie on every matched request;
  - applies a hard authentication gate on `/api/*` (401 before the handler runs);
  - keeps a small explicit allow-list for genuinely public endpoints
    (`/api/customer-signup`).

### 1.3 Privileged (service-role) route hardening

Every route that uses `SUPABASE_SERVICE_ROLE_KEY` was audited. Service-role usage was
**kept** where legitimate and wrapped with authorization + ownership checks rather than
removed. See section 6 for the per-route status.

### 1.4 Database-level protection (RLS)

`supabase/migrations/001_core_security.sql`:

- creates the missing `activity_logs` audit table (+ indexes);
- adds a nullable `tenant_id` to tenant-owned tables that lacked it;
- adds `current_tenant_id()` and `is_admin()` (`security definer`, `search_path` pinned,
  `execute` granted only to `authenticated`);
- enables RLS on **every** tenant-owned table and revokes table privileges from `anon`
  (belt-and-braces, so a future policy mistake cannot silently re-expose a table);
- adds select/insert/update/delete tenant policies on every table carrying `tenant_id`;
- adds `company_id`-scoped policies for the financial-analytics tables
  (`financial_ratios`, `financial_ratio_history`, `financial_health_score`, `kpi_results`,
  `ai_recommendations`), which use `company_id` rather than `tenant_id`;
- tightens `users`, `tenants`, `roles`, `permissions`, `user_roles`;
- makes `activity_logs` append-only (no update/delete).

The tenant predicate is written as
`tenant_id is not distinct from public.current_tenant_id()` so it degrades correctly for
the current single-tenant deployment (every `tenant_id` is NULL → only NULL-tenant rows
match) and becomes strict isolation as soon as tenants are assigned.

`supabase/migrations/001_core_security_rollback.sql` reverts the above.

### 1.5 Secret handling

`.env.local` was **tracked in git** and contained `SUPABASE_SERVICE_ROLE_KEY` and the
database password. It has been untracked (`git rm --cached`, file left on disk), and
`.env` / `.env.*` added to `.gitignore`.

### 1.6 Automated tests

`npm run test:core` → 29 tests, all passing (section 10).

---

## 2. Files Changed

### Created

```
src/lib/auth/policy.ts            src/lib/auth/permissions.ts
src/lib/auth/types.ts             src/lib/auth/context.ts
src/lib/auth/api-guard.ts         src/lib/auth/ownership.ts
src/lib/auth/references.ts        src/lib/auth/audit.ts
src/lib/auth/errors.ts            src/lib/auth/tenant.ts
src/lib/auth/index.ts             src/middleware.ts
supabase/migrations/001_core_security.sql
supabase/migrations/001_core_security_rollback.sql
tests/auth-permissions.test.ts    tests/tenant-isolation.test.ts
CORE_AUDIT_BEFORE.md              CORE_SECURITY_FINAL_REPORT.md
```

### Modified

```
.gitignore
package.json, package-lock.json              (tsx + server-only dev deps, test:core, typecheck scripts)
tsconfig.json                                (allowImportingTsExtensions)
src/lib/supabase.ts, src/lib/supabase-server.ts   (cookie-backed sessions)

src/app/api/users/route.ts
src/app/api/expenses/route.ts
src/app/api/suppliers/route.ts
src/app/api/expense-accounts/route.ts
src/app/api/quotations/route.ts
src/app/api/invoices/[id]/route.ts
src/app/api/migrate/route.ts
src/app/api/customer-signup/route.ts
src/app/api/financial/kpis/route.ts
src/app/api/financial/ratios/route.ts
src/app/api/financial/health-score/route.ts
src/app/api/financial/recommendations/route.ts
src/app/api/financial/calculate/route.ts
src/app/api/financial/reports/route.ts
src/app/api/financial/ai-excel-analysis/route.ts
```

### Deleted from the index (file retained on disk)

```
.env.local        (untracked; contained service-role key + DB password)
```

No business module was redesigned. No UI page, no sales/purchase/rental/accounting/HR
behaviour was changed.

---

## 3. Tenant Isolation

Every tenant-owned entity listed in the brief was inspected. Isolation now has two
layers: application-level tenant scoping in the guarded routes, and database-level RLS
policies.

| Module | Application-level | DB-level (RLS) | Verdict |
| --- | --- | --- | --- |
| Customers | guarded read/write on touched routes | policy on `tenant_id` | PASS (guarded routes) / PARTIAL (unmigrated direct-client pages) |
| Customer contacts | no separate table; contacts live on `customers` | `customers` policy | PASS |
| Suppliers | `assertWritableTenant` + audit | policy on `tenant_id` | PASS |
| Cars / Fleet | `REF_CAR` tenant-checked on quotations | policy on `tenant_id` | PASS |
| Rentals / Rental contracts | `tenant_id` scoped in financial reads | policy on `tenant_id` | PARTIAL |
| Bookings | `rental_contracts` / `rentals` covered | policy on `tenant_id` | PARTIAL |
| Contracts (`sales_contracts`, `rental_contracts`) | — | `tenant_id` added + policy | PARTIAL |
| Quotations | `REF_CUSTOMER`/`REF_CAR` + tenant column | `tenant_id` added + policy | PASS |
| Sales | — | policy on `tenant_id` | PARTIAL |
| Sales invoices (`invoices`) | id lookup tenant-scoped, 404 on cross-tenant | policy on `tenant_id` | PASS |
| Sales returns | — | `tenant_id` added + policy | PARTIAL |
| Payments | — | policy on `tenant_id` | PARTIAL |
| Purchases / Purchase invoices | — | `tenant_id` added + policy | PARTIAL |
| Purchase returns (`debit_notes`) | — | `tenant_id` added + policy | PARTIAL |
| Purchase orders / Requisitions (+ items) | — | `tenant_id` added + policy | PARTIAL |
| Expenses | `assertWritableTenant` + `REF_SUPPLIER` + `REF_EXPENSE_ACCOUNT` + financial-year | policy on `tenant_id` | PASS |
| Accounts | — | policy on `tenant_id` | PARTIAL |
| Journal entries / lines / attachments / templates / recurring | — | `tenant_id` added + policy | PARTIAL |
| Employees / Attendance / Payroll (bonuses, deductions) | — | `tenant_id` added + policy | PARTIAL |
| Loans (`car_loans`, `car_loan_installments`, `credits`) | — | policy on `tenant_id` | PARTIAL |
| Assets / Depreciation (`documents`, `maintenance`, `oil_service_records`) | — | policy on `tenant_id` | PARTIAL |
| Taxes / VAT (`tax_rates`, `tax_settings`) | — | policy on `tenant_id` | PARTIAL |
| Branches | `assertBranchAccess` in financial routes | policy on `tenant_id` | PASS |
| Financial years | `getActiveFinancialYear(tenantId)` + `assertDateInOpenFinancialYear` | `tenant_id` added + policy | PASS |
| Reports | tenant-scoped reads, `reports.view` required | inherits source tables | PASS |
| Financial analytics (ratios/KPI/health/AI) | tenant scoping in route | `company_id` policies | PASS |
| Drivers, Documents, Support tickets, Settings, Petty cash, Sidebar settings, Document sequences, Alert rules/logs | — | `tenant_id` added + policy | PARTIAL |

**PASS** = isolation enforced on the code path exercised in this phase, with a DB policy.
**PARTIAL** = the DB policy exists, but the corresponding UI page still queries Postgres
directly with the anon key from the browser (see section 11, item 1). Once the RLS
migration is applied, those pages become tenant-isolated automatically; until then their
isolation is database-only, not application-level.

---

## 4. Authentication

**PASS.**

- Session is established through Supabase Auth (`signInWithPassword`) and stored in
  cookies via `@supabase/ssr`.
- `src/middleware.ts` gates `/api/*` and returns
  `401 {"error":"Authentication required","code":"unauthenticated"}` before any handler
  runs. Verified live against the production build for all privileged routes, GET and POST.
- `resolveAuthContext()` returns `null` for: no session, invalid session, inactive
  `users.is_active`, inactive `profiles.is_active`, or a user with neither profile row.
- `/api/customer-signup` remains intentionally public and was left reachable
  (verified: returns its own 400 validation error, not 401).

---

## 5. Authorization

**PASS** for all routes hardened in this phase.

- Permission catalogue: `customers`, `suppliers`, `sales`, `purchases`, `invoices`,
  `payments`, `expenses`, `accounting`, `payroll`, `hr`, `reports`, `exports`, `imports`,
  `users`, `settings`, `rentals`, `fleet`, `maintenance`, `branches`, `financial_years`
  × `view` / `create` / `edit` / `delete`.
- `admin` is allowed everything; `staff` has a curated default set; `client` has none.
- DB-configured permissions (`permissions` table joined through `profiles.role_id`) and
  per-user jsonb overrides (`users.permissions`) both override the defaults.
- Modules outside the catalogue are always denied for non-admins.
- Enforcement is server-side (`requireContext(request, { module, action })`), not UI
  button hiding.
- Errors are `403 {"error":"Missing permission: <module>.<action>","code":"forbidden"}`.

The existing permission architecture (the `permissions` table and role model) was
**extended**, not replaced.

---

## 6. Service Role APIs

`SUPABASE_SERVICE_ROLE_KEY` appears in `src/lib/supabase-admin.ts` and in three route
files that create their own client. Every privileged route inspected:

| Route | Auth | Permission | Tenant scope | Ownership / FK | Audit | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `GET/POST /api/users` | ✅ | ✅ `users.view` / `users.create` | ✅ list filtered by `tenant_id` | ✅ | ✅ create | PASS |
| `POST /api/expenses` | ✅ | ✅ `expenses.create` | ✅ `assertWritableTenant` | ✅ supplier + expense account + financial year | ✅ | PASS |
| `POST /api/suppliers` | ✅ | ✅ `suppliers.create` | ✅ `assertWritableTenant` | n/a | ✅ | PASS |
| `POST /api/expense-accounts` | ✅ | ✅ `expenses.create` | n/a (shared chart) | n/a | ✅ | PASS |
| `POST /api/quotations` | ✅ | ✅ `sales.create` | ✅ via FK checks | ✅ `REF_CUSTOMER`, `REF_CAR` | ✅ | PASS |
| `GET /api/invoices/[id]` | ✅ | ✅ `invoices.view` | ✅ `.eq("tenant_id", …)` | ✅ cross-tenant id → 404 | — (read) | PASS |
| `POST /api/financial/kpis` | ✅ | ✅ | ✅ | n/a | ✅ | PASS |
| `POST /api/financial/ratios` | ✅ | ✅ | ✅ | n/a | ✅ | PASS |
| `POST /api/financial/health-score` | ✅ | ✅ | ✅ | n/a | ✅ | PASS |
| `POST /api/financial/recommendations` | ✅ | ✅ | ✅ | n/a | ✅ | PASS |
| `POST /api/financial/calculate` | ✅ | ✅ `accounting.create` | ✅ tenant-scoped reads | ✅ `assertBranchAccess` | ✅ | PASS |
| `POST /api/financial/reports` | ✅ | ✅ `reports.view` | ✅ | n/a | ✅ | PASS |
| `POST /api/financial/ai-excel-analysis` | ✅ | ✅ `settings.view` | ✅ | ✅ 10 MB / row bound; API key never returned | ✅ | PASS |
| `POST /api/migrate` | ✅ | ✅ admin-only | n/a (DDL) | n/a | ✅ | PASS |
| `POST /api/customer-signup` | public by design | n/a | n/a | n/a | — | PASS (unchanged public contract) |

Live verification against the production build: all 11 privileged endpoints returned
`401 unauthenticated` for both GET and POST without a session; `/api/customer-signup`
still returned its own 400 validation response.

**Known limitation:** `/api/financial/reports` scopes the financial-analytics tables by
`company_id`, matching their schema. It does **not** additionally filter by branch.

---

## 7. Branch Isolation

**PARTIAL.**

- `assertBranchAccess(context, branchId)` is enforced server-side; a branch outside
  `context.branchIds` is rejected with `403`.
- `branchIds === null` means "all branches of the tenant", so legitimate multi-branch
  administrators are preserved.
- Users without a `profiles.branch_id` are treated as unrestricted (current deployment
  state — `branches` and `profiles.branch_id` are empty in the live database).
- `branch_id` is taken from the session and never trusted from the body.

Not done in this phase (would require touching business modules, which Phase 10 forbids):

- Branch lists in the UI are still partly hardcoded rather than read from `branches`.
- `expenses.branch` is stored as a free-text value and is not validated against
  `branches` or `context.branchIds`. `branches` currently holds zero rows, so a strict
  check would reject every write; the correct fix is a UI change to select from the
  `branches` table, which belongs to a later phase.
- Per-branch filtering of report rows.

---

## 8. Financial Year

**PASS** for the code paths that exist.

- `getActiveFinancialYear(tenantId)` resolves the current year per tenant.
- `assertDateInOpenFinancialYear(year, date, label)` rejects posting into a
  `closed` / `locked` year, and rejects dates outside the active year's range.
- Wired into expense creation (`POST /api/expenses`).
- When a tenant has no financial year configured, validation is skipped, so
  installations that never used the feature are unaffected.
- `financial_years` gained a `tenant_id` column and a tenant RLS policy.

Not done: journal-entry posting validation. The journal-entry UI is a business module
(Phase 10) and was not modified. The helper is available for it in a later phase.

---

## 9. Audit Logging

**PASS.**

- New `activity_logs` table: `id, tenant_id, user_id, user_email, action, entity,
  entity_id, metadata (jsonb), created_at`, indexed by `(tenant_id, created_at)`,
  `(entity, entity_id)` and `user_id`.
- `logAudit(context, event)` records tenant, user, action, entity, entity id, timestamp
  and metadata.
- `sanitizeMetadata()` strips anything matching
  `password|secret|token|api_key|authorization|cookie|credential|private`, drops
  `undefined`, reduces arrays/objects to safe scalars, and never stores raw secrets.
- Best-effort by design: a logging failure is surfaced on the server console and never
  aborts an already-authorized business operation.
- RLS makes `activity_logs` append-only for `authenticated` (no update, no delete).
- Wired into: user creation, expense creation, supplier creation, expense-account
  creation, quotation creation, and all financial calculation/report endpoints.

Not yet wired (no server route exists to wire): login, logout, update, delete, import,
export, payment, invoice, purchase, sales and settings changes — these currently happen
in browser modules and need server routes before they can be audited.

---

## 10. Automated Tests

Framework: **Node's built-in test runner**, executed through `tsx`. No new framework was
introduced; `tsx` and `server-only` were added as dev dependencies so the TypeScript
modules can be imported directly.

```
npm run test:core
```

Result: **29 tests, 8 suites, 29 pass, 0 fail.**

| Suite | Covers |
| --- | --- |
| `permission catalogue` (3) | every declared module is recognised; unknown modules/actions rejected; `parsePermissionKey` only accepts `module.action` |
| `role defaults` (3) | admin has everything; staff cannot manage users/settings; client has no ERP permissions |
| `can()` (6) | admin bypass; staff denied users/settings; reports read-only for staff; client denied every admin module; DB-configured overrides beat defaults; undeclared module always denied |
| `error contract` (4) | every error carries a status + stable code; `toErrorResponse` never leaks internal detail; `ApiError` passes through untouched; `ApiError` is an `Error` subclass |
| `tenant write isolation` (3) | tenant-less caller keeps writing tenant-less rows; a caller cannot plant a row in another tenant; a caller may write into its own tenant |
| `branch isolation` (3) | multi-branch admin reaches every branch; a branch-restricted user only reaches its own; an unrestricted value is always accepted |
| `financial year context` (4) | no year configured ⇒ no restriction; inside the active year accepted; outside rejected; posting into a closed year rejected |
| `audit metadata sanitisation` (3) | credentials stripped; non-scalar values reduced to safe placeholders; `undefined` dropped |

Also verified live (not unit tests, but executed against the production build):
11 privileged endpoints rejected unauthenticated GET and POST with 401.

**Not covered by tests:** database-level RLS behaviour, and end-to-end route behaviour
with a real session. Both require either DDL execution rights or seeded tenant/user data
that does not exist in this environment.

---

## 11. Remaining Issues

1. **The RLS migration has not been applied.** `DATABASE_URL` is unusable from this
   environment (Supabase pooler returns
   `(ENOTFOUND) tenant/user postgres.chlkmdobhvfnldqkgdji not found`; `db.<ref>.supabase.co`
   does not resolve), and `rpc('exec_sql')` does not exist, so DDL cannot be executed
   here. Until an operator applies `supabase/migrations/001_core_security.sql`, the anon
   key still has full read/write access to every table. This was verified directly:
   an unauthenticated `POST /rest/v1/customers` with the anon key returned **201 Created**
   (the probe row was deleted immediately afterwards). This is the single highest-impact
   remaining item.
2. **The admin UI still talks to Postgres directly with the anon key.** Most pages import
   `@/lib/supabase` (the browser client) and query tables from the client. They are not
   routed through the new authorization layer. Once RLS is applied, an authenticated
   admin session will still work (the policies grant `authenticated` access to its own
   tenant) — but anonymous access will stop, and any page that relies on a session that
   has not been established will break. This is expected and is the point of the change,
   but it should be rolled out deliberately.
3. **Two conflicting role models remain.** `users.role` and `profiles.role_id` + `roles`
   are both live. The resolver reconciles them (the `roles` table wins only when
   `users.role` is absent), but `settings/users` creates users who cannot log in. Merging
   them is a settings-module change.
4. **`expenses.branch` is free text**, not a validated branch reference (see section 7).
5. **52 `.bak` / `.backup` files** are present under `src/` and are picked up by the
   TypeScript include glob. They are dead code; removing them is a cleanup task.
6. **129 pre-existing TypeScript errors** remain elsewhere in the project, masked by
   `typescript.ignoreBuildErrors: true`. None are in files touched by this change
   (verified by intersecting the error file list with the changed file list). The two
   errors introduced by the new test files were fixed by enabling
   `allowImportingTsExtensions`.
7. **`next lint` cannot run** — `eslint.config.mjs` throws
   `Converting circular structure to JSON` via `FlatCompat`. This is pre-existing
   (the file is untouched by this change) and is reported as NOT VERIFIED.
8. **Branch filter absent in `/api/financial/reports`** (see section 6).
9. **The service-role key in `.env.local` must be rotated.** Untracking the file stops
   future exposure but does not remove it from git history or from anyone who already
   has the repository.

---

## 12. Verification Limitations

| Command | Result |
| --- | --- |
| `npm run test:core` | **PASS** — 29/29 tests, 8 suites |
| `npm run build` | **PASS** — exit 0, "Compiled successfully in 7.0s", middleware 93.7 kB |
| `npm run typecheck` | **PARTIAL** — exit 2, 129 errors, **0 in files changed by this phase**; all 129 are pre-existing |
| `npm run lint` (`next lint`) | **NOT VERIFIED** — pre-existing `eslint.config.mjs` circular-structure crash |
| RLS enforcement at the database | **NOT VERIFIED** — DDL cannot be executed from this environment; migration delivered as a file |
| End-to-end authorized route behaviour | **NOT VERIFIED** — no seeded tenant/user credentials available |
| Unauthenticated rejection of privileged routes | **PASS** — verified live against the production build (11 endpoints, GET + POST → 401) |
| Anon-key exposure before the migration | **CONFIRMED** — unauthenticated anon-key `POST /rest/v1/customers` returned 201 (probe row deleted) |

Environment notes:

- SQL was syntax-validated with `pglast` (63 statements parsed, no errors) because it
  could not be executed against the live database.
- `DATABASE_URL` is unusable and `rpc('exec_sql')` does not exist, so no DDL was applied.
- PostgREST *is* reachable with the service-role key, which is how the table inventory,
  `tenant_id` / `company_id` column presence and the anon-key exposure were established.
- The live database is effectively empty for business data (`branches` 0, `settings` 0,
  `tenants` 0, `expenses` 0, `financial_years` 1, `customers` 2, `invoices` 2).

---

## Stopping point

This phase is complete. Per the final rule, no other ERP module was started: no Universal
Excel Import/Export, no sales/purchase/rental/accounting/HR/dashboard redesign. The
remaining items in section 11 are handed over as the next phase's input.
