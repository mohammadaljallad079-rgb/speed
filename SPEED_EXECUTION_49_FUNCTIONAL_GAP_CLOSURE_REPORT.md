# SPEED ERP — Execution 49 Report

**Scope:** Local-only functional gap audit and closure. No deployment, no
production DB contact, no migrations, no live credential creation, no
`reset --hard`/`clean`, no secrets committed or printed. Fast-forward push only,
to the feature branch.

**Branch:** `feat/final-hardening-round5`
**Commit before:** `797b4d5` (docs(agents): exec48 invariants)
**`origin/main`:** `d6788be` (untouched)
**HEAD after:** `4f54171` (fix(exec49) …)

---

## 1. Repository and commit inspected

| Item | Value |
|---|---|
| Working tree start | clean at `797b4d5` |
| Branch | `feat/final-hardening-round5` |
| `origin/main` | `d6788be` (not touched) |
| Shallow clone | no (full history) |
| Stack | Next.js 15.3.6, React 19.2.0, `@supabase/supabase-js`, `@supabase/ssr` |

Reports read: Exec 45, 46, 47, 48, plus `AGENTS.md`.

Authoritative live-schema facts used (from the archived Exec-20/24 OpenAPI
capture `conversations/cc134e07d3734a988bfe338a1a8c8ccf/`, which the earlier
executions used to build the 63-table harness):

- `invoices`: `id, invoice_number, invoice_date, vat_amount, status, customer_id,
  total_amount, paid_amount, due_date`; relations `customers(full_name)`,
  `rental_contracts`. **No `total` column. No `customer_name` column.**
- `customers`: `full_name` (no `name`).
- `cars`: `plate_number` (no `license_plate`).
- `purchase_invoices`: `total_amount` (no `total`).
- The fleet table is `cars`; there is **no `vehicles` table**.

---

## 2. Confirmed defects found and fixed

All defects below are confirmed by the live-schema evidence above and by the
project's own guards; none are speculative.

| # | File | Defect | Effect |
|---|------|--------|--------|
| 1 | `src/lib/ai/tools.ts` (`receivables_summary`) | `select("total, paid_amount, status, tenant_id")` on `invoices` | Phantom `total` column → the whole PostgREST request fails; the assistant's "what is owed" tool always errored |
| 2 | `src/lib/ai/tools.ts` (`invoice_lookup`) | `select("invoice_number, customer_name, status, total, …")` | Phantom `customer_name` **and** `total` → request fails; assistant invoice lookup always errored |
| 3 | `src/app/rentals/[id]/payment/page.tsx` | `select("*, customers(*), vehicles(*)")` | Phantom `vehicles` relation → "Record Payment" page never loaded the contract |
| 4 | `src/app/quotations/page.tsx` | `router.push("/quotations/print?id=…")` | No such route → the quotation "Print" button 404s |
| 5 | `src/app/accounting/bank-transfer/page.tsx` (×2) | back/cancel → `/accounting` | No `/accounting` page → dead link |
| 6 | `src/app/accounting/petty-cash/page.tsx` | back → `/accounting` | dead link |
| 7 | `src/app/hr/attendance/page.tsx` | back → `/hr` | No `/hr` page → dead link |
| 8 | `src/app/hr/payroll/page.tsx` | back → `/hr` | dead link |
| 9 | `src/app/settings/page.tsx` | redirect → `/settings/website` | No such page → redirect loop / 404 |
| 10 | `src/app/settings/sidebar/page.tsx` (default nav) | 9 dead hrefs: `/vehicles`, `/vehicles/status`, `/vehicles/types`, `/customers/groups`, `/expenses/categories`, `/reports/expenses`, `/journal`, `/analytics`, `/settings/integrations` | The sidebar-settings default tree offered 9 links that 404 |

Fixes:

1–2. Column projections corrected to `total_amount`; the customer name now comes
from the `customers(full_name)` relation (PostgREST to-one → object, with an
array-tolerant read).
3. `vehicles(*)` → `cars(*)` (matches every other rental query and the real FK).
4. New route `src/app/quotations/[id]/print/page.tsx` added (mirrors the
`payments/[id]/print` pattern: client component, RLS-scoped read, print toolbar);
the list now pushes `/quotations/<id>/print`.
5–8. Back buttons now point at the module's real list page
(`/accounting/journal-entries`, `/accounting/expenses`, `/hr/employees`).
9–10. `/settings/website` → `/settings/company` (the real company page); the
default sidebar tree now points at `/cars` (with status query), and the phantom
children were removed; `/journal` → `/accounting/journal-entries`; `/analytics`
→ `/financial-dashboard`; `/settings/integrations` →
`/settings/integrations/whatsapp`.

No accounting/sales/Excel service was touched. No duplicate module or auth path
was introduced. No inventory/warehouse subsystem was added.

---

## 3. Verified-correct areas (audited, no change needed)

- **Protected-page authorization incl. `/dashboard`** — `src/middleware.ts`
  gates an explicit `PROTECTED_PAGE_PREFIXES` list (which includes `/dashboard`)
  and redirects anonymous callers to `/login`; `/api/*` returns `401`; the
  `PUBLIC_API_PREFIXES` allow-list is exact. Covered by
  `tests/login-flow.test.ts`. No change was needed.
- **Four operations reports** — `monthly-receipts`, `monthly-invoices`,
  `rented-vehicles`, `outstanding-by-client` all route through
  `loadOperationsReport` (`src/lib/reporting/operations-reports.ts`), which uses
  `total_amount`, `full_name`, and relation-safe fallbacks; the page↔module
  mapping is asserted by `tests/exec45-operations-reports.test.ts`.
- **`cars`/`customers` phantom columns** — full-tree scans now report zero
  phantom `vehicles(...)` relations and zero unknown relation projections.

---

## 4. Regression guards added

`tests/exec49-functional-gap-closure.test.ts` (14 tests):

- no `from('invoices').select(...)` requests `total` or `customer_name`;
- the AI invoice tool uses `total_amount` + `customers(full_name)`;
- the quotation print route exists and reads the `customers` relation;
- the six previously-dead back-links no longer target missing routes;
- **every** `href` / `router.push` / `router.replace` / `redirect` literal under
  `src/` resolves to a real page (object-form `href:` included);
- no source file projects a `vehicles(...)` relation.

---

## 5. Test, typecheck, lint, build results

| Gate | Command | Result |
|---|---|---|
| Tests | `npm run test:core` | **818 tests / 812 pass / 0 fail / 6 skipped** (was 804/798 before this execution; +14 new) |
| Typecheck | `npm run typecheck` | **110 errors** — unchanged from the Exec 48 baseline of 110 (≤ the 125 documented baseline); **no new errors** |
| Lint | `npm run lint` | `✔ No ESLint warnings or errors` (works here; `AGENTS.md`'s note about a broken config did not reproduce) |
| Build | `npm run build` (with placeholder `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`) | **✓ compiled, exit 0**, including the new `ƒ /quotations/[id]/print` route |

The build fails without Supabase env vars at the "Collecting page data" step
(`supabaseUrl is required`), which is a **pre-existing** environment dependency,
not a code regression: `/api/financial/calculate` calls `createClient(...)` at
module scope. Placeholder (non-production) values let the build complete; no
production host was contacted.

---

## 6. Migrations applied vs prepared

**None applied.** This execution performed no DDL and did not contact the live
database. Migrations `001`–`007` remain operator-applied (unchanged from Exec 47).

---

## 7. Production deployment / live verification

**Not performed** (out of scope for this local-only execution). No commit was
deployed, no production host was contacted, no live credential was created.

---

## 8. Commit

```
HEAD before: 797b4d5
Commit:      4f54171  fix(exec49): close functional gaps …
Push:        fast-forward 797b4d5..4f54171 to origin/feat/final-hardening-round5 only
origin/main: d6788be (untouched)
```

---

## 9. Blockers / next action

- **Blockers:** none for this execution. Production migration application and
  live admin-account creation remain owner-executed steps (see Exec 47 runbook).
- **Next action (owner):** apply `supabase/PRODUCTION_ACTIVATION_001_002_003.sql`
  with the current pooler `DATABASE_URL`, then run the admin provisioning scripts.
- **No secrets** were printed or committed; the tree contains no `.env*` files.
