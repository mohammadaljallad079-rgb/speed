# SPEED ERP — Execution 48 Report

**Scope:** Local-only continuation. No deployment, no production DB contact, no
migrations, no live credential creation. Fast-forward push only.

**Branch:** `feat/final-hardening-round5`
**Commit before:** `5cb732b` (docs(exec47))
**Commit after:** `f96852b` (fix(exec48))
**Pushed:** `5cb732b..f96852b` fast-forward to `origin/feat/final-hardening-round5`
**`origin/main`:** `d6788be` (untouched)

---

## 1. What this execution did

Executions 46–47 closed the reporting and operator-handoff work. This execution
audited the code for remaining **real** defects that can be resolved without an
owner accounting decision, and fixed a confirmed defect family: the app queried a
**non-existent `customers.name` column** in several live paths.

Authoritative evidence that `customers` exposes `full_name` (not `name`):

- `SPEED_PRODUCTION_READINESS_CHECK.md:58` — "`customers`: `full_name` (+ `tenant_id`, `id`)".
- `src/lib/supabase.ts` `Customer` type — has `full_name`, no `name`.
- `src/lib/reporting/catalog.ts:56` — joins `customers.full_name`.
- `SPEED_EXECUTION_46_PRODUCTION_PREFLIGHT_REPORT.md:317` — the same defect previously
  fixed for the outstanding-by-client report.

When a `select()` lists a column PostgREST cannot resolve, the **whole request
fails** (not just that column), so every one of these paths was silently broken.

## 2. Defects fixed

| # | File | Defect | Effect |
|---|------|--------|--------|
| 1 | `src/app/sales/new/page.tsx` | `select("id,full_name,name,phone")` | Customer dropdown always empty |
| 2 | `src/app/invoices/new/page.tsx` | same select **and** insert payload wrote `name:` | Dropdown empty; "add customer" insert failed |
| 3 | `src/app/accounting/journal-entries/page.tsx` | `select("id, full_name, name")` | Customer reference list never loaded |
| 4 | `src/app/accounting/journal-entries/page.tsx` | driver reference fetched `customers(...).limit(1)` | Driver dropdown held one customer, never drivers |
| 5 | `src/app/accounting/journal-entries/page.tsx` | `cust?.name` / `drv?.name` in export | Exported customer/driver blank |
| 6 | `src/app/quotations/new/rental/page.tsx` | `select("id, name, phone")` + `c.name` | Customer select returned no rows; print showed blank |
| 7 | `src/app/loans/page.tsx` | `customers(name,full_name,phone)` | Loan list customer name blank |
| 8 | `src/app/api/invoices/[id]/route.ts` | `customers(id, name, full_name, ...)` | Invoice detail customer null |

**Dead links fixed** (verified against the real route tree):

| Surface | Old | New | Why |
|---------|-----|-----|-----|
| `DashboardLayout` Settings → Users | `/users` | `/settings/users` | `/users` route does not exist; `/settings/users` does |
| Dashboard KPI "Bookings" | `/rental-contracts` | `/rentals` | `/rental-contracts` route does not exist |
| Loans page "+ New Loan" | `/loans/new` | `/cars/new` | No `/loans/new` route; financing fields live on the car form |

## 3. Tests added

`tests/exec48-customer-schema-and-links.test.ts` (8 tests, registered in `test:core`):

1. No `from('customers').select(...)` requests a standalone `name` (repo-wide scan).
2. No `customers(...)` relation projection requests a standalone `name`.
3. No customers insert payload writes a `name` key.
4. Regression lock on the specific files fixed.
5. Journal-entries driver reference loads from `drivers`, not `customers`.
6. `DashboardLayout` active-nav hrefs resolve to real routes.
7. Dashboard KPI hrefs resolve to real routes.
8. Reports hub links resolve to real routes.

The scans use a strict standalone-token check, so `full_name` / `company_name`
are never false positives, and the link tests resolve hrefs against the actual
`src/app/**/page.tsx` tree (route groups stripped).

## 4. Verification results

| Gate | Result |
|------|--------|
| Full test suite (`npm test`) | **803 tests — 797 pass / 0 fail / 6 skip** |
| New Exec 48 test file | **8 pass / 0 fail** |
| TypeScript (`tsc --noEmit`) | **110 errors vs 125 baseline — 0 new errors; net −15** |
| Lint (`npm run lint`) | Clean — no warnings or errors |
| Production build (`npm run build`) | **exit 0, compiled successfully** (placeholder env, `.env.local` removed after) |

The typecheck baseline was measured on the exact pre-change tree (git stash), and
the error lists were diffed line-by-line — the change introduced zero new errors
and resolved 15 pre-existing ones (the local `Customer`/`Driver` types now match
the real schema).

## 5. Security / repository hygiene

- Scanned tracked files for `.env*`, backups, private keys, and JWTs: none tracked.
- No service-role key, token, or credential is committed or printed.
- `.env.local` used for the build only; removed immediately after (not tracked).
- Push used a one-shot authenticated URL; no token stored in git config.
- No `reset --hard`, no `clean`, no force push.

## 6. Migrations

No migration was applied or authored this execution. Migrations 001–007 remain
**prepared but not applied** to the live database (unchanged from Exec 47 — the
dev environment has no DDL path). See `SPEED_EXECUTION_47_OPERATOR_HANDOFF.md`.

## 7. Deployment

Not performed (local-only constraint). The commit is pushed to the feature branch
for review; `origin/main` is untouched. Promotion to production remains an
operator step on the production VM (`git pull --ff-only` → `npm run build` →
`pm2 restart speed --update-env`).

## 8. Remaining work / blockers

- **Blocked (operator):** apply migrations 001 → 002 → 003 live and run the
  production isolation acceptance tests. No DDL path from this environment.
- **Known pre-existing:** page routes such as `/dashboard` still return 200 to
  anonymous callers (client-side gating only); middleware gates `/api/*`.
- **Deferred (needs owner decision):** placeholder report pages
  (`credits/print`, `reports/missing-purchase-info`, `reports/purchase-details`,
  `reports/write-offs`, `reports/new-receipts`, `reports/traffic`).
- **Not in scope / forbidden:** no inventory or warehouse subsystem was added.

## 9. Next action

1. Review/merge `f96852b` on `feat/final-hardening-round5`.
2. Operator applies migrations 001–003 and runs the acceptance suite.
3. Operator deploys to production and verifies the live app.

---

_No credentials are included in this report. No secret values were printed in any
command output or log during this execution._
