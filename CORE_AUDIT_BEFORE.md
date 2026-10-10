# CORE_AUDIT_BEFORE.md

Audit of the existing project **before** any core/security change.
Source of truth: the actual repository code plus a live schema introspection of the
configured Supabase project (PostgREST OpenAPI spec).

Date: 2026-09-30
Commit inspected: `698ea24` (shallow clone)

---

## 0. Stack summary

| Item | Reality found in code |
| --- | --- |
| Framework | Next.js 15.3.6 (App Router) + React 19.2 + TypeScript 5 |
| Backend | Supabase (Postgres + PostgREST + GoTrue auth). No custom Node API layer for most modules. |
| DB access (browser) | `src/lib/supabase.ts` → `createClient(url, NEXT_PUBLIC_SUPABASE_ANON_KEY)`, used **directly from client components** |
| DB access (server) | `src/lib/supabase-admin.ts` → service-role client; plus **13 route files that create their own inline service-role client** |
| ORM | `drizzle-orm` is in `package.json` but **not used anywhere in `src/`** |
| Middleware | **None** (`src/middleware.ts` does not exist) |
| RLS | **None enabled** — anon key can SELECT/INSERT/UPDATE/DELETE every table (proven, see §4) |
| Tests | **None** — no jest/vitest/playwright config, no `*.test.*`, no `test` script |
| Tenant model | `tenants` table exists but is **empty (0 rows)**; `tenant_id` columns exist on ~20 tables and are **NULL in every row** |

---

## 1. Authentication

**What exists**

- Supabase Auth (email + password). `supabase.auth.signInWithPassword` in
  `src/app/login/page.tsx` (admin/staff) and `src/app/customer-login/page.tsx` (client).
- Admin login performs a client-side role gate: it reads `users.role` and rejects
  anything not in `['admin','staff']` (`src/app/login/page.tsx:50`).
- Customer login reads `users.role` (`src/app/customer-login/page.tsx:34`).
- `getAppUser()` is duplicated:
  - `src/lib/supabase.ts:219` (client) → reads `users` ✅
  - `src/lib/supabase-server.ts:12` (server) → reads **`app_users`**, a table that does
    not exist ❌ and imports `@supabase/ssr`, which was **not in `package.json`** ❌

**What is missing**

- No server-side session verification anywhere. Every API route trusts the caller.
- No `src/middleware.ts`, so no route protection and no auth-cookie refresh.
- The browser client stores the session in `localStorage`, so **no cookie session
  exists for the server to read** — server-side authorization was never possible as built.
- No login/logout audit trail.
- `POST /api/customer-signup` will **reset the password of any existing auth user**
  whose e-mail is submitted (`src/app/api/customer-signup/route.ts:29`).

**Status: PARTIAL** (client-side only, trivially bypassable).

---

## 2. User model / profile

Three overlapping identities:

| Source | Table | Fields | Used by |
| --- | --- | --- | --- |
| App user | `users` | `id, email, full_name, role, tenant_id, customer_id, permissions (jsonb), is_active, phone` | login, cars/new, customer portal |
| Profile | `profiles` | `id, full_name, phone, email, role_id, branch_id, is_active` | settings/users, /api/users |
| Auth | `auth.users` | Supabase managed | everywhere |

`users` and `profiles` are **never reconciled**. `settings/users` writes to `profiles`;
login reads from `users`. A user created through `settings/users` (via
`supabase.auth.signUp` from the browser) gets **no `users` row** and therefore
**cannot log in**.

Live data: `users` = 1 row (role `client`, `tenant_id` NULL), `profiles` = 0 rows.

**Status: PARTIAL / inconsistent.**

---

## 3. Roles, permissions, tenant, branch, financial year

### Roles
- `users.role` (text, default `staff`): `admin | staff | client`.
- `roles` table (`name`, `label_ar`, `label_en`, `is_active`) — **0 rows**.
- `profiles.role_id` → `roles.id`.
- **Two parallel, disconnected role systems.**

### Permissions
- `permissions` table exists: `role_id, module, can_view, can_create, can_edit, can_delete`
  — **0 rows**.
- `user_roles` table exists — **0 rows**.
- **No code reads `permissions` or `user_roles` anywhere.** The only occurrence of the
  word "permission" in `src/` is a translated UI string.
- The UI hides nothing by permission either; the sidebar is fetched from
  `settings.sidebar_menu_v2` and shown to everyone.

### Tenant
- `tenants` (id, name, name_en, created_at) — **0 rows**.
- `tenant_id` present on: `accounts, branches, car_loan_installments, car_loans, cars,
  credits, customers, documents, drivers, expenses, invoices, maintenance,
  oil_service_records, payments, rental_contracts, sales, settings, suppliers,
  support_tickets, tax_rates, tax_settings, users` — **all NULL**.
- Only two lines in the whole codebase write `tenant_id`
  (`src/app/rentals/new/page.tsx:517,538`) and both copy it from
  `users.tenant_id`, which is NULL.
- **No read is ever filtered by `tenant_id`. Zero `eq('tenant_id', ...)` filters exist.**

### Branch
- `branches` (id, name, location, tenant_id) — **0 rows**.
- `profiles.branch_id` exists — never read or written.
- Branches are **hardcoded** in the UI:
  - `src/app/purchases/new/page.tsx:27` → `const BRANCHES = ['Manama','Airport','Muharraq','Riffa']`
  - `src/app/purchase-orders/page.tsx:25`, `src/app/purchase-orders/requisitions/page.tsx:24`
  - `src/app/accounting/journal-entries/page.tsx:16,24`
  - `src/app/cars/page.tsx:335`
- `src/app/expenses/new/page.tsx:129` **does** load branches from the DB — the only
  correct pattern in the project.
- `expenses.branch` and `journal_lines.branch` are **text**, not FK to `branches.id`.
- No branch filtering exists on any query, and no user→branch assignment exists.

### Financial year
- `financial_years` (id, name, start_date, end_date, is_current, status) — 1 row
  (`2026`, current).
- `financial_year_id` FK columns exist on `invoices, expenses, payments,
  rental_contracts, journal_entries` — never written, never validated.
- `settings/financial-year` CRUD exists and works.
- **Nothing checks that a transaction date falls inside an open financial year.**

---

## 4. Database-level protection (verified live)

Using the public anon key against `https://chlkmdobhvfnldqkgdji.supabase.co`:

| Probe | Result |
| --- | --- |
| `GET /rest/v1/customers` (anon) | **HTTP 200**, rows returned |
| `GET /rest/v1/invoices`, `/accounts`, `/journal_entries`, `/payments`, `/rental_contracts`, `/tax_settings`, `/users`, `/financial_years` (anon) | **HTTP 200** each |
| `POST /rest/v1/suppliers` (anon) | **HTTP 201** — row created |
| `DELETE /rest/v1/suppliers?id=…` (anon) | **HTTP 204** — row deleted |
| `PATCH /rest/v1/customers?id=eq.<nonexistent>` (anon) | **HTTP 204** |

The probe row was deleted immediately after creation; no real data was modified.

**Conclusion: there is no row-level security. Anyone holding the anon key
(which is shipped to every browser) has full read/write/delete access to every
table, including `users`, `profiles`, `settings` and all financial data.**

This is the single highest-severity finding. It also means the ~100 direct
`supabase.from(...).insert/update/delete` calls in client components currently
"succeed" only because no authorization exists at all.

---

## 5. Service-role / privileged API surface

Every route below creates a **service-role client that bypasses RLS** and performs
**zero authentication and zero authorization**:

| Route | Methods | What it does | Auth today |
| --- | --- | --- | --- |
| `/api/users` | GET | `auth.admin.listUsers()` — dumps **all** auth users + profiles + roles | ❌ none |
| `/api/users` | POST | `auth.admin.createUser()` — creates privileged users | ❌ none |
| `/api/expenses` | POST | inserts into `expenses` | ❌ none |
| `/api/suppliers` | POST | inserts into `suppliers` | ❌ none |
| `/api/quotations` | POST | inserts into `quotations` | ❌ none |
| `/api/expense-accounts` | POST | inserts into `expense_accounts` | ❌ none |
| `/api/invoices/[id]` | GET | reads any invoice + its items by id | ❌ none |
| `/api/financial/kpis` | GET | reads all KPI rows | ❌ none |
| `/api/financial/ratios` | GET | reads all ratio rows | ❌ none |
| `/api/financial/health-score` | GET | reads health score | ❌ none |
| `/api/financial/recommendations` | GET | reads AI recommendations | ❌ none |
| `/api/financial/reports` | POST | builds a financial report from all tenant data | ❌ none |
| `/api/financial/calculate` | POST | reads revenue/expenses/cars/payments, **writes** ratios/KPIs/health/recommendations | ❌ none |
| `/api/financial/ai-excel-analysis` | POST | reads `settings.ai_settings` (**API key**) and calls Anthropic with it | ❌ none |
| `/api/migrate` | GET | runs **DDL** through `rpc('exec_sql')` | ❌ none |
| `/api/customer-signup` | POST | public customer signup — **legitimately public** | n/a (public) |

`/api/financial/*` reads `rental_contracts`, `invoices`, `expenses`, `cars`, `payments`
with no tenant or branch filter — i.e. it aggregates **all** tenants' data.

`/api/financial/calculate` accepts `company_id` / `branch_id` **from the request body**
and writes them as-is (untrusted input written to privileged columns).

`rpc('exec_sql')` no longer exists in the schema, so `/api/migrate` currently returns
per-statement errors — but the route is still an unauthenticated privileged surface.

---

## 6. Client-side direct DB access (RLS-dependent)

~100 write calls and far more reads happen **directly from browser components**
using the anon key. Examples by density:
`purchase-orders/requisitions` (10), `purchase-orders` (8), `rentals` (7),
`rentals/[id]` (7), `accounting/journal-entries` (7), `rentals/new` (6),
`accounting/expenses` (6), `purchases/new` (5), `expenses` (5), `cars/new` (5),
`settings/*` (14 across 5 files).

These are unfiltered by tenant and unprotected by RLS. They are the reason the app
"works" today and the reason it cannot be secured without RLS.

---

## 7. Audit / activity logging

**Missing entirely.** No `activity_logs` / `audit_log` table exists in the schema, and
there is no logging helper. There is no record of logins, deletions, payments,
journal postings or permission changes.

Tables that look adjacent but are unrelated: `alert_logs` (business alerts),
`documents`, `support_tickets`.

---

## 8. Existing tests

**None.** No test framework, no test files, no `test` script in `package.json`.

Baseline `npx tsc --noEmit`: **131 pre-existing errors** (Next.js build ignores them
because `next.config.js` sets `typescript.ignoreBuildErrors: true` and
`eslint.ignoreDuringBuilds: true`).

---

## 9. Existing helper functions / shared services

| Path | Purpose | State |
| --- | --- | --- |
| `src/lib/supabase.ts` | browser client, types, `getAppUser`, number generators | used |
| `src/lib/supabase-admin.ts` | service-role client | used by 2 routes |
| `src/lib/supabase-server.ts` | server `getAppUser` | **broken** (`app_users`, missing dep) |
| `src/lib/utils.ts` | `cn`, formatting, number generators | used |
| `src/lib/i18n.ts`, `LanguageContext.tsx` | ar/en translation | used |
| `src/visual-edits/*` | build-time loader | build only |

There is **no authorization layer, no tenant layer, no audit layer, no validation layer**.

---

## 10. Summary of findings

### Works today
- Supabase Auth sign-in / sign-out for admin, staff and client.
- Full CRUD for cars, customers, rentals, sales, purchases, quotations, invoices,
  payments, expenses, journal entries, HR, reports — via direct client queries.
- Branch and financial-year **configuration** screens.
- `/api/customer-signup` end-to-end signup.
- `/api/users` list/create UI.

### Partially implemented
- Authentication: real, but client-side only.
- Roles: two disconnected systems (`users.role` vs `profiles.role_id` + `roles`).
- Branch: configurable table exists but is bypassed by hardcoded lists.
- Financial year: configurable, never applied to postings.
- Tenant: schema exists, unused.

### Missing
- Any server-side authorization on 15 privileged route handlers.
- Any row-level security (verified: anon key has full write access).
- Tenant enforcement (read or write).
- Branch access control.
- Financial-year posting validation.
- Permission enforcement (tables empty, no code).
- Audit logging.
- Automated tests.

### Security risks (ordered)
1. **CRITICAL** — No RLS: anon key can read/write/delete every table.
2. **CRITICAL** — `/api/users` GET/POST unauthenticated; leaks all users, allows
   privileged account creation.
3. **CRITICAL** — `/api/financial/*` unauthenticated; cross-tenant financial aggregation
   and writes; `/api/financial/ai-excel-analysis` leaks the stored Anthropic API key usage.
4. **HIGH** — `/api/migrate` unauthenticated DDL endpoint.
5. **HIGH** — `/api/expenses`, `/api/suppliers`, `/api/quotations`,
   `/api/expense-accounts`, `/api/invoices/[id]` unauthenticated read/write.
6. **HIGH** — `/api/customer-signup` can overwrite an existing user's password.
7. **HIGH** — No tenant isolation anywhere; `tenant_id` is always NULL.
8. **MEDIUM** — Two conflicting role models; `settings/users` creates users who cannot log in.
9. **MEDIUM** — No permission enforcement; UI-only gating.
10. **MEDIUM** — `service_role` key and DB password committed in a tracked `.env.local`.
11. **MEDIUM** — No audit trail.
12. **LOW** — 131 pre-existing TypeScript errors masked by `ignoreBuildErrors`.

### Files requiring modification
- **New**: `src/lib/auth/*` (context, guards, permissions, tenant, branch, financial-year,
  audit, api wrapper), `src/middleware.ts`, `supabase/migrations/*.sql`, `tests/*`.
- **Modify**: all 15 route files under `src/app/api/`, `src/lib/supabase-server.ts`,
  `src/lib/supabase.ts` (cookie session), `package.json` (test script).

### Tests currently available
None.

---

## 11. Environmental limitations discovered

- `DATABASE_URL` in `.env.local` is **not usable**: every Supabase pooler region
  returns `(ENOTFOUND) tenant/user postgres.chlkmdobhvfnldqkgdji not found`, and
  `db.<ref>.supabase.co` does not resolve.
- `rpc('exec_sql')` does **not exist** in the schema, so `/api/migrate` cannot apply DDL.
- Consequently **DDL cannot be executed from this environment**. SQL migrations are
  therefore delivered as files to be applied by the operator, and this is reported
  as `NOT VERIFIED` where relevant.
- PostgREST (service role) *is* reachable, so data-level verification is possible.
