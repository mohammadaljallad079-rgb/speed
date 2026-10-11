# SPEED ERP — Final Features & Test Coverage Inventory

Read-only audit. No publish, no build change, no migration, no RLS change, no
password/data change, no file deletion. Everything below is grounded in the code
at the actual commit, not in prior reports.

---

## 0. Commit inspected & method

- `origin/main` = **`f02125d`** (`docs: deployment readiness review of the AI
  reporting updates`), verified with `git fetch origin` + `git rev-parse origin/main`.
- Sandbox `HEAD` = `f02125d` (aligned). Untracked: only
  `SPEED_PRODUCTION_READINESS_CHECK.md` (previous step). No tracked tree changes.
- Method: direct file inventory, `grep` of the real code paths, and the actual
  test runners. **A feature is not marked present because a page/route exists;**
  it is marked present only where implementation logic was located in the source.

### Important: prior reports over-claim vs. this snapshot
Several documents in the repo (`AGENTS.md`, `SPEED_AI_REPORTING_*`,
`SPEED_FINAL_*`) describe modules that **do not exist in this snapshot**:

| Claimed by prior reports | Reality at `f02125d` |
|---|---|
| `src/lib/excel/` (universal Excel engine, registry, importer) | **absent** |
| `src/components/excel/ExcelModuleActions` | **absent** |
| `src/lib/sales/service.ts` (one sales engine) | **absent** |
| `src/lib/documents/numbering.ts` (`nextDocumentNumber`) | **absent** |
| `src/lib/accounting/posting.ts` (`postJournalEntry`, `ACCOUNT_CODES`) | **absent** |
| `supabase/migrations/005`… claimed applied | only 001–004 present |

There is **one Excel feature** (`src/app/reports/import/page.tsx` +
`src/lib/reporting/workbook.ts`) and **no server-side sales/accounting engine**:
journal/sales/purchase writes happen **in the browser** through the anon client.
The inventory below reflects the snapshot, and this divergence is the single
biggest item in the "remaining work" list.

---

## 1. Gate results (actually executed)

| Gate | Result | Note |
|---|---|---|
| `npm run test:core` | **209 tests · 203 pass · 0 fail · 6 skipped** | exit 0 |
| `tests/saas-signup.test.ts` (NOT in `test:core`) | **13 pass · 0 fail** | run manually |
| `npm run typecheck` | **129 errors** (baseline) | all in legacy pages, none in reporting/auth/saas/api |
| `npm run build` | **exit 0**, "Compiled successfully in 8.0s" | placeholder env; no code change |
| `npm run lint` | **fails** — `Converting circular structure to JSON` | pre-existing broken ESLint config; unusable |
| Inventory/warehouse/stock module | **none** (only doc strings) | constraint respected |
| `src/lib/supabase.ts.bak` | stale backup file tracked in `src/` | hygiene issue |

**Baseline vs. new:** the 129 typecheck errors are concentrated in legacy
client pages (`quotations/new/rental` 33, `customers` 16, `customer-dashboard`
16, `fleet` 8, `rentals` 6, `dashboard` 5, `DashboardLayout` 4, reports pages…).
No error is in `src/lib/reporting`, `src/lib/auth`, `src/lib/saas`, or
`src/app/api`. New reporting work added **no** typecheck errors.

---

## 2. Module-by-module inventory

Legend — **Real path tested**: ✔ the test drives production code (service/guard/
pure function) with a stub DB or representative input; ✖ static source assertions
only.

### 2.1 Login, users, roles, permissions
- **Implemented:** `src/lib/auth/` (`api-guard.ts`, `policy.ts`, `context.ts`,
  `permissions.ts`, `audit.ts`, `errors.ts`, `ownership.ts`, `references.ts`),
  `src/app/login/page.tsx`, `src/app/api/me/route.ts`, `src/app/api/users/route.ts`.
  Login resolves role/tenant **server-side** via `/api/me`; client never decides
  role. Distinct failure modes: 401 `unauthenticated` vs 403 `account_not_provisioned`.
- **Tests:** `auth-permissions.test.ts` (35), `login-flow.test.ts` (49),
  `super-admin-policy.test.ts` (41). Real path: ✔ (pure policy + login-error mapper
  + `/api/me` shape driven directly; 1 test actually invokes the middleware).
- **Gaps / risks:** role from client metadata is not possible (good); but most
  ERP pages do not call `/api/me` — authorization is enforced only on the API
  surface. `api-guard` is `server-only`; it cannot be imported by client pages.
- **Verified on:** local (stub) only. Live behaviour depends on migrations 001–004
  being applied (they are not).
- **To close:** apply 001–004; add a live E2E login test with both admin identities.

### 2.2 Companies, tenants, isolation, RLS
- **Implemented:** `policy.ts` (`assertWritableTenant`, `scopeToTenant`,
  `assertBranchAccess`, `canAccessBranch`, `isDateInFinancialYear`),
  `ownership.ts`, migrations `001`–`004`, `supabase/*.sql`.
- **Tests:** `tenant-isolation.test.ts` (48), `security-tenant-isolation.test.ts`
  (69), `super-admin-policy.test.ts`. Real path: ✔ for the **pure policy**
  (tenant write/loss, branch, financial-year, audit sanitisation). The RLS/anon
  probes are **skipped** without live env (`6 skipped`).
- **Gaps / risks:** RLS migrations **not applied** on live → anon remains
  privileged (per prior confirmed live probes). Cross-tenant FK checks are
  application-layer and are **not wired into the browser writes**.
- **Verified on:** policy = local; RLS = **not verified** (no live access).
- **To close:** operator applies 001–004; re-run the anon probes live (they are
  currently skipped).

### 2.3 Customers & suppliers
- **Implemented:** `src/app/customers/`, `src/app/suppliers/`,
  `src/app/api/suppliers/route.ts`. Customer portal: `customer-dashboard`,
  `customer-login`, `customer-signup` (+ `/api/customer-signup`).
- **Tests:** `car-rental-homepage-erp.test.ts`, `saas-signup.test.ts`,
  `public-api-routes.test.ts`. Real path: ✖ mostly static/route-shape; signup API
  is exercised.
- **Gaps / risks:** direct anon writes; no server-side guard on customer edits.
- **Verified on:** local.

### 2.4 Sales & credit sales invoices
- **Implemented:** `src/app/sales/*` (`new`, `dashboard`, `returns`),
  `src/app/invoices/*`. **No `sales/service.ts`** — `sales/new` writes
  `invoices`/`invoice_lines` and posts a journal entry **from the client**.
- **Tests:** none dedicated to the sales write path. `reporting-*` covers reading
  sales data. Real path: ✖.
- **Gaps / risks (high):** revenue recognition, paid-amount recomputation and
  immutability are **not enforced server-side**; `REC-${Date.now()}` receipt
  numbers are still generated in `sales/new` and `invoices/new` (non-idempotent
  numbering → duplicate-guard failure). `assertInvoiceMutable`/`recomputeInvoicePaid`
  **do not exist**.
- **Verified on:** local only.
- **To close:** build the single sales service server-side; route invoice/payment/
  return mutations through guarded APIs; remove timestamp numbering.

### 2.5 Purchases & expenses
- **Implemented:** `src/app/purchases/*`, `src/app/expenses/*`,
  `/api/expenses`, `/api/expense-accounts`, `/api/financial/ai-excel-analysis`.
  Expenses API is guarded + audited.
- **Tests:** none dedicated to purchases/expenses write path. Real path: ✖.
- **Gaps / risks:** `purchases/new` posts journals client-side; expenses route
  guarded but the modular accounting flow is not unit-tested.
- **Verified on:** local only.

### 2.6 Accounting, journal entries, payments, transfers
- **Implemented:** `src/app/accounting/*` (`journal-entries`, `bank-transfer`,
  `petty-cash`, `chart-of-accounts`, `depreciation`, `tax-settings`,
  `expenses`, `reports`), `src/app/payments/*`, `src/app/loans/*`,
  `src/app/credits/*`, `src/app/supplier-payments/*`.
- **Tests:** none dedicated. Real path: ✖.
- **Gaps / risks (high):** **there is no server-side `postJournalEntry`** — every
  journal write is an unguarded client insert; there is no double-entry balance
  assertion. `generate_document_number` exists in only 4 files; receipts use
  timestamps.
- **Verified on:** local only.
- **To close:** centralise posting server-side with balance/tenant/year
  assertions; add accounting tests.

### 2.7 Cars, rental, insurance, deposits, refunds
- **Implemented:** `src/app/cars/*`, `src/app/rentals/*` (new, `[id]`,
  `refund-deposit`, `expiring`, `invoices`, `copies`, `print`), `src/app/fleet/*`,
  `src/app/maintenance/*`, `src/app/bookings` & `booking`, `src/app/loans`.
- **Tests:** `car-rental-homepage-erp.test.ts` (static/integration-ish).
- **Gaps / risks:** deposit/refund and rental journal posting happen client-side;
  no server guard. `rentals/new` uses `REC-${Date.now()}` numbering.
- **Verified on:** local.

### 2.8 Payroll, banks, cash (petty cash)
- **Implemented:** `src/app/hr/payroll/page.tsx` (references `journal_entries`
  once), `src/app/accounting/bank-transfer`, `src/app/accounting/petty-cash`,
  `src/app/hr/*`.
- **Tests:** none. Real path: ✖.
- **Gaps / risks:** posting client-side; no payroll journal tests.
- **Verified on:** local.

### 2.9 Financial reports, P&L, AR/AP, VAT
- **Implemented:** `src/app/reports/*` (23 pages incl. balance-sheet,
  profit-loss, cash-flow, trial-balance), `src/app/api/financial/*`
  (`reports`, `calculate`, `kpis`, `ratios`, `health-score`, `recommendations`).
  VAT logic in `src/lib/reporting/vat.ts` (Bahrain 10%).
- **Tests:** `reporting-format.test.ts` (75), `reporting-dynamic.test.ts` (73).
  Real path: ✔ for report read/aggregate/validation. Financial ratio routes: ✖.
- **Gaps / risks:** **fail-open tenancy** — `financial/{kpis,ratios,health-score}`
  do `if (context.tenantId) q = q.eq("company_id", tenantId)`; when `tenantId`
  is null the filter is skipped, so a tenant-less caller reads all rows. Live is
  single-tenant today (latent, not exploited). VAT rate is a constant — confirm
  against the approved rate.
- **Verified on:** local only.

### 2.10 Unified Excel engine (import/export/history)
- **Implemented:** **one** Excel feature: `src/app/reports/import/page.tsx` +
  `src/lib/reporting/workbook.ts` (+ `ai-excel-analysis` route). There is **no**
  `src/lib/excel/` engine, **no** registry, **no** `ExcelModuleActions`, **no**
  import-history store.
- **Tests:** `reporting-format.test.ts` exercises the workbook builder. Real
  path: ✔ for generation; ✖ for a generic multi-module import pipeline (it does
  not exist).
- **Gaps / risks:** prior claims of a "universal engine wired into 20 pages" are
  **not present**. Import is report-oriented, not a per-module tenant-scoped
  importer; no duplicate-detection levels, no error-report/`RESOLUTIONS` map.
- **Verified on:** local.
- **To close:** if the universal engine is required, it must be **built**
  (server-side, tenant-scoped, one path) — not merely re-enabled.

### 2.11 AI reporting, report builder, validation/repair
- **Implemented:** `src/lib/reporting/*` (`assistant`, `catalog`, `data`,
  `definitions`, `dynamic`, `intent`, `plan`, `report-def`, `templates`,
  `validation`, `vat`, `workbook`), `src/app/api/financial/report-format/route.ts`,
  `src/components/reporting/DynamicReportBuilder.tsx`, wired in
  `financial-dashboard`.
- **Tests:** `reporting-format.test.ts` (75) + `reporting-dynamic.test.ts`
  (73) — the strongest suite in the repo. Real path: ✔ (stub DB, real functions:
  create, fields, filters, group-by, sort, aggregates, duplicates, validation,
  export, save/restore versions). I additionally fixed two real defects
  (`5016e0a`: grouped sums were 0; "sorted by" misread as group-by).
- **Gaps / risks:** writing only goes to `settings` (templates/definitions) and
  `activity_logs`; repair is classification-only (cannot mutate source data) —
  correct, but means "repair" does not fix ledger data. Confidence/approval have
  no dedicated test. 2 provider conditions may be skipped (LLM unavailable).
- **Verified on:** local only (no live Supabase).
- **To close:** live-schema column confirmation; a live E2E for save/restore.

### 2.12 Dashboard, AR/EN UI, mobile responsiveness
- **Implemented:** `src/lib/LanguageContext.tsx`, `src/lib/i18n.ts` (`ar`/`en`,
  RTL), `src/components/DashboardLayout.tsx`, `src/app/dashboard`,
  `src/components/*` (62 components).
- **Tests:** `car-rental-homepage-erp.test.ts` checks some UI content; no
  responsive/RTL tests. Real path: ✖.
- **Gaps / risks:** responsiveness is CSS-based (`md:`/`sm:` classes) — not
  automated. i18n has 2 typecheck errors (`i18n.ts`, `LanguageContext.tsx`).
- **Verified on:** local.

### 2.13 Public website, signup, onboarding, protected routes
- **Implemented:** public pages (`/`, `features`, `solutions`, `pricing`, `faq`,
  `privacy`, `terms`, `services`, `contact`), `Marketing*` chrome,
  `/api/saas/signup` + `/api/saas/onboarding` (`src/lib/saas/provisioning.ts`),
  `/api/public/vehicles` + `/api/public/company-profile`, `signup`/`onboarding`
  pages.
- **Tests:** `saas-signup.test.ts` (13, real path ✔), `public-api-routes.test.ts`
  (27; live probes skipped), `car-rental-homepage-erp.test.ts`.
- **Gaps / risks:** `/api/migrate` remains in the tree (guarded by
  `ENABLE_SCHEMA_MIGRATION_ENDPOINT` + super-admin) — a high-privilege DDL route
  worth removing/behind ops. Middleware gates **`/api/*` only**; **pages**
  (`/dashboard` etc.) return 200 to anonymous callers and rely on client-side
  gating (known gap).
- **Verified on:** local; live pages returned 200 (previous step).

### 2.14 API surface, input validation, error handling, audit
- **Implemented:** 21 API routes; 17 guarded via `requireContext`/`withAuth`
  (4 intentionally public: customer-signup, saas/signup, public/*; `/api/me`
  authenticates directly). `errors.ts` (stable codes, no internal leak),
  `audit.ts` (`logAudit` + metadata sanitisation).
- **Tests:** covered across `tenant-isolation` (error contract, audit), `login-flow`
  (middleware gate), `security-tenant-isolation` (public allow-list). Real path: ✔.
- **Gaps / risks:** validation depth varies per route; audit writes exist on ~12
  files — not universal. Most ERP mutations bypass these routes entirely
  (browser-write problem).
- **Verified on:** local.

---

## 3. Cross-cutting risk register

1. **Browser-side privileged writes (critical).** ~86 of 120 pages use the anon
   browser client to read/write ERP tables. Middleware gates `/api/*` but **not
   pages' direct anon queries**, so with migrations unapplied the anon key can
   read/write financial data. Server guards protect only the API surface.
2. **RLS migrations 001–004 not applied live** → anon retains full grants
   (previously confirmed live). Not verified here (no access).
3. **No server-side accounting/sales engine.** `postJournalEntry`, `ACCOUNT_CODES`,
   `assertInvoiceMutable`, `nextDocumentNumber` are absent; the "single engine"
   invariant in `AGENTS.md` is not satisfied by this snapshot.
4. **Non-idempotent numbering.** `REC-${Date.now()}` in `sales/new`,
   `invoices/new`, `rentals/new` defeats duplicate guards.
5. **Fail-open financial tenancy** on `kpis`/`ratios`/`health-score` when
   `tenantId` is null.
6. **`/api/migrate` DDL endpoint** present in the tree.
7. **Repo hygiene:** `src/lib/supabase.ts.bak` tracked; `next-env.d.ts`
   generated but tracked; ESLint config broken (lint unusable).
8. **Test breadth vs. claim:** 222 tests exist and all pass, but they cover the
   **auth/tenant/reporting** cores well and the **transactional ERP** (sales,
   purchases, accounting, payroll, rentals) almost not at all — those write paths
   are untested.

---

## 4. Verification status

- **Live production DB / RLS:** **NOT VERIFIED** — no credentials, no reachable
  DDL/DML path from this environment (prior confirmed). Migrations 001–004 remain
  operator-applied.
- **Everything else:** verified **locally** (sandbox clone at `f02125d`) via the
  real test runners, typecheck, and production build.

---

## 5. Remaining work — ordered list

### A. Blocked on production access (need operator/host)
1. Apply migrations `001 → 002 → 003 → 004` (`supabase/PRODUCTION_ACTIVATION_*`),
   then re-run the currently-skipped live anon/RLS probes.
2. Confirm live column presence for the reporting catalog (section 3 of
   `SPEED_PRODUCTION_READINESS_CHECK.md`).
3. Deploy `f02125d` and run a live login E2E for **both** administrator accounts.
4. Decide and execute **anon-key privilege removal** (revoke grants) + RLS enable
   on all tables (part of 001/002), verified live.

### B. Completable in code (no production access needed)
5. **Build the server-side sales/accounting engine** (one path): `createSalesInvoice`,
   `recordPayment`, `createSalesReturn`, `assertInvoiceMutable`,
   `recomputeInvoicePaid`, `postJournalEntry`, `ACCOUNT_CODES`, `assertReference`,
   `assertPostingYear`, and centralised `nextDocumentNumber`. Route sales/purchase/
   journal pages through guarded APIs instead of browser writes.
6. **Remove `REC-${Date.now()}` numbering** in `sales/new`, `invoices/new`,
   `rentals/new`; use the single numbering function.
7. **Fix fail-open financial tenancy** (`kpis`/`ratios`/`health-score`): require a
   tenant or scope explicitly to NULL like `scopeToTenant`.
8. **Lock down `/api/migrate`** (remove from the app build, or keep strictly ops-gated).
9. **Add a hard page-level gate** so protected pages redirect unauthenticated users
   to `/login` (today only `/api/*` is gated; pages rely on client-side checks).
10. **Build the missing tests** for the transactional modules (sales, purchases,
    accounting/journal, payments, payroll, rentals/deposits) against an injectable
    stub, mirroring the reporting suite's quality.
11. **Repo hygiene:** delete tracked `src/lib/supabase.ts.bak`; fix or replace the
    broken ESLint config; reduce the 129 baseline typecheck errors (concentrated in
    `quotations/new/rental`, `customers`, `customer-dashboard`, `fleet`).
12. **Credentials:** generate the two administrator passwords via the existing
    `scripts/provision-admin-accounts.mjs` path and deliver them out-of-band; do
    not commit.
13. If the "universal Excel engine" is still required, **build it** as one
    tenant-scoped server pipeline (the prior claim is not in this snapshot).

---

## 6. Bottom line

The **authentication/authorization core, tenant policy, and AI reporting/validation**
modules are real, well-tested locally, and pass (`test:core` 203/203, build 0,
typecheck baseline unchanged). The **transactional ERP** (sales, purchases,
accounting, payroll, rentals) exists as UI that writes through the browser anon
client, with **no server-side engine and essentially no tests**; the **universal
Excel engine is absent**. Tenant isolation itself is implemented in policy and SQL
but **not applied or verified live**. Nothing here was completed merely because a
screen exists — the open items in section 5.B are the concrete path to closing the
project, and section 5.A is what only production access can unblock.
