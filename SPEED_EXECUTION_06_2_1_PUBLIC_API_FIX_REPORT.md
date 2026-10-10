# SPEED ERP — EXECUTION 06.2.1
## FIX MISSING PUBLIC MARKETING API ROUTES — REPORT

Date: 2026-09-30
Repo: `aljallad2025/orchids-remix-of-car-rental---sales-system2026`
Fix commit: **`2cc0e05`** (`fix(public-api): restore GET /api/public/vehicles and /api/public/company-profile`)
Base: `73f42be` (production) → `2cc0e05`

---

## 1. Root cause

`src/app/api/public/vehicles/route.ts` and
`src/app/api/public/company-profile/route.ts` **already existed in the working
tree** — they were written during Execution 05.5 — but they were **never
committed to git** (they showed as untracked: `?? src/app/api/public/`).

Consequences:

- No deployed commit ever contained the two route files.
- The **built/deployed** app therefore had no `/api/public/*` handlers, so
  production returned **404** for both endpoints, even though the middleware
  allow-list (`PUBLIC_API_PREFIXES` includes `"/api/public/"`) and every
  consumer page (`src/app/fleet/page.tsx`, `src/app/cars/[id]/page.tsx`,
  `src/components/PublicNavbar.tsx`, `src/app/contact/page.tsx`) already
  pointed at them.

**The fix was to commit the existing, already-correct routes** — not to write
new behavior. No page, middleware, RLS, auth, signup, onboarding, accounting,
sales, Excel, or schema code was changed.

---

## 2. Exact files added / changed

| File | Change |
| --- | --- |
| `src/app/api/public/vehicles/route.ts` | **Added to git** (untracked → committed; content unchanged) |
| `src/app/api/public/company-profile/route.ts` | **Added to git** (untracked → committed; content unchanged) |
| `tests/public-api-routes.test.ts` | **New** focused test file (190 lines, 13 tests) |
| `package.json` | **Modified** — `test:core` extended to include `tests/security-tenant-isolation.test.ts` and the new `tests/public-api-routes.test.ts`, and given `--conditions=react-server` so the route handler imports resolve |

Commit contains exactly these 4 files (`git show --stat 2cc0e05`).
No other file was touched. No migration was created. No production data changed.

> Note: the wider working tree carries large **uncommitted Exec 01–05** work
> (accounting, sales, Excel, many routes/tests). It was deliberately **left
> uncommitted**; only the focused fix was committed.

---

## 3. Security model

Both routes run **server-side only** and read the RLS-protected tables through
the server service-role client (`supabaseAdmin`), which bypasses RLS. That is
safe **because the response is an explicit public projection**, not a table
dump:

- **No `select('*')`** — both routes name an exact column list.
- **No caller-supplied identity** — `tenant_id` / `role` / `company_id` are
  never read from the query string as a trust mechanism.
- **Service-role key never reaches the browser** — it is used only in the route
  module (`server-only`); it is not imported by any client component and does
  not appear in `.next/static`.
- **No RLS change** — no policy is created/dropped and no table privilege is
  granted; `cars` and `settings` stay RLS-protected with no `anon` grant.
- **Anonymous reachability is scoped** — only `/api/public/*` (plus the
  sanctioned `/api/saas/signup` and `/api/customer-signup`) bypass the auth
  gate; every other `/api/*` route still requires a session.

### `/api/public/vehicles`
- Reads `cars` with a fixed **public-safe column list**.
- The list branch always filters `.eq("status", "available")` and orders by
  `created_at`; a caller cannot request another lifecycle state.
- Supports `?id=` (single row) and `?limit=` (clamped to max 100). The
  `?status=` param the fleet page sends is ignored by design — the public list
  is always the available fleet.

### `/api/public/company-profile`
- Reads **only** the `settings` row where `key = 'company_profile'`.
- Returns an explicit literal object with five fields; it never returns the raw
  settings row (`value`), so private settings keys (`ai_settings`, keys, etc.)
  cannot leak.

---

## 4. Approved response fields

### `GET /api/public/vehicles`
Response: `{ "data": [ …rows… ] }` (list) or `{ "data": { …row… } | null }` (`?id=`).
Each row contains **only**:

```
id, make, model, year, color, category, mileage, status, created_at,
daily_rate, weekly_rate, monthly_rate, sale_price, fuel_type, transmission,
seats, location, image_url, gallery_images, plate_number
```

**Explicitly excluded** (verified live): `tenant_id`, `purchase_price`,
`purchase_costs`, `maintenance_costs`, `salvage_value`, `supplier_id`, `vin`,
`chassis_number`, `engine_number`, `insurance_policy_number`,
`insurance_company`, `insurance_expiry`, `bank_name`, `interest_rate`,
`down_payment`, `monthly_installment`, `remaining_installments`,
`total_installments`, `registration_expiry`, `notes`.

### `GET /api/public/company-profile`
Response: `{ "data": { name, phone, email, address, crNumber } | null }`.

---

## 5. Tests

New file `tests/public-api-routes.test.ts` — **13 tests, all passing**. It
covers exactly the required cases:

| Requirement | Test |
| --- | --- |
| `GET /api/public/vehicles` is intentionally public | middleware → 200 |
| `GET /api/public/company-profile` is intentionally public | middleware → 200 |
| `/api/customers` stays protected | middleware → 401 |
| `/api/saas/onboarding` stays protected | middleware → 401 |
| other APIs stay protected | `/api/invoices`, `/api/expenses`, `/api/users`, `/api/suppliers`, `/api/excel/export` → 401 |
| response contains only approved public fields | live list + `?id=` + profile shape assertions |
| no service-role secret/API key in either response | JWT / `service_role` / env-key-name scan |
| no RLS weakening | source asserts no `create/drop policy`, no `alter table`, no `grant … on` |
| safe projection | no `select('*')`, no spread of raw settings value, forbidden columns absent |
| no caller-trusted identity | no `searchParams.get('tenant_id'/'role'/'company_id')` |

Results:

| Command | tests | pass | fail | skipped |
| --- | --- | --- | --- | --- |
| `tests/public-api-routes.test.ts` | 13 | **13** | 0 | 0 |
| `npm run test:core` | 150 | 144 | **0** | 6 |
| `npm test` (full) | 392 | 386 | **0** | 6 |
| `npm run test:accounting` | 30 | 30 | 0 | 0 |
| `npm run test:excel` | 167 | 167 | 0 | 0 |
| `npm run test:sales` | 21 | 21 | 0 | 0 |

The new test was added to the **committed** `test:core` suite, so it runs in CI
from a clean checkout.

---

## 6. Build result

- `npm run build` → **PASS** (compiled successfully in ~13 s).
- Both routes emitted in the route table:
  `ƒ /api/public/company-profile` and `ƒ /api/public/vehicles`.

### Live HTTP verification (local production mode, `next start`)

| Request | Result |
| --- | --- |
| `GET /api/public/vehicles` | **200** |
| `GET /api/public/vehicles?limit=2` | **200** |
| `GET /api/public/vehicles?id=<car>` | **200** — returned exactly the 20 approved fields, **0 leaked** |
| `GET /api/public/company-profile` | **200** (`{"data":null}` — no `company_profile` settings row exists yet) |
| `GET /api/customers` | **401** |
| `GET /api/invoices` / `/api/expenses` / `/api/users` / `/api/suppliers` / `/api/excel/export` / `/api/saas/onboarding` | **401** |
| secret scan of both public bodies | **0 hits** |

Read-only check of the live data: `cars` has 1 row with `status = 'rented'`, so
the available-only list is legitimately empty (the projection itself was proven
via the `?id=` branch, which returned only approved fields). No write, no
migration, no data change was performed.

---

## 7. Known pre-existing issues (NOT caused by this fix)

- **TypeScript:** `npm run typecheck` → **119 errors**, identical to the known
  pre-existing baseline. **0 new errors.**
- **Lint:** `npm run lint` crashes in the ESLint/`next lint` tooling
  (circular-structure serialization). Pre-existing; not touched.
- **Middleware page gating:** middleware enforces auth only on `/api/*`; page
  routes (e.g. `/dashboard`) return 200 to anonymous callers and rely on
  client-side gating. Pre-existing; out of scope; unchanged.
- **`next.config.js`:** `experimental.missingSuspenseWithCSRBailout`
  unrecognized key warning. Pre-existing; unchanged.
- **Orchids platform scripts** in `src/app/layout.tsx` reference
  `slelguoygbfzlpylpxfs.supabase.co` (script host, not a database). Pre-existing;
  unchanged.
- **Repo completeness:** Exec 01–05 remain uncommitted, so a fresh clone /
  `origin/main` checkout does not contain the full application. Out of scope for
  this focused fix.

---

## 8. Git

- **Commit hash:** `2cc0e05e8d57c2e0dfb1bb23933091ca92f8c8fc`
- Message: `fix(public-api): restore GET /api/public/vehicles and /api/public/company-profile`
- Pushed to `origin/main` (see §9).
- No force push, no amend, no reset. `73f42be` untouched.

---

## 9. Deployment (per instruction: NOT deployed from here)

Per the task rule, **no deployment was performed from OpenHands** and **no
production database change** was made. To activate the fix on the server:

```
cd /var/www/speed.harbourconsultancies.com
git pull --ff-only origin main      # 73f42be -> 2cc0e05
npm run build
pm2 restart speed --update-env
```

Then expect `GET /api/public/vehicles` and `GET /api/public/company-profile`
to return **200** (previously 404), with `/api/customers` etc. still **401**.
