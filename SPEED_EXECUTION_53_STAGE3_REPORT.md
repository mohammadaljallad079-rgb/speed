# SPEED ERP — Execution 53 Stage 3 implementation report

Depreciation posting to the ledger, with real-browser proof that the charge
reaches the financial statements.

- Repository: `github.com/mohammadaljallad079-rgb/speed`
- Branch: `feat/final-hardening-round5`
- Continuation point: `c536858` (Exec 41) → this work lands on top of `eca5c75`
- Commit for this stage: **`6684084`** (`66840844c0dde9505415371dd704837becbde402`)
- Pull request: <https://github.com/mohammadaljallad079-rgb/speed/pull/1>

## 1. Continuation point confirmed

`git ls-remote` showed the remote branch already at `eca5c75` (not `c536858`), so
Exec 52 (`c52224d`, Super Admin UI) and the first Exec 53 commit (`eca5c75`,
shared ledger engine) were already published. `c536858` is an ancestor of the
branch tip. No completed work was recreated and no administrator account was
touched.

`origin/main` (`d6788be`) is an ancestor of the branch: 23 ahead, 0 behind, so a
fast-forward promotion remains possible.

## 2. The defect Stage 3 fixes

The depreciation screen computed a schedule **in the browser and wrote nothing**.
A schedule was a calculation with no ledger event behind it, so:

- the depreciation expense never appeared in the Profit & Loss;
- the accumulated-depreciation contra-asset never appeared on the Balance Sheet;
- the books disagreed with the screen.

## 3. What was implemented

### 3.1 One posting path

`POST /api/depreciation/post` → `postDepreciation`
(`src/lib/accounting/depreciation-posting.ts`):

```
Dr Depreciation expense (52001)                1,800
    Cr Accumulated depreciation (14001)                    1,800
```

Accumulated depreciation is a **contra-asset** (credit-nature, `type='asset'`),
which is what lets the balance sheet show cost less accumulated without a second
asset account per vehicle.

| Rule | Where it is enforced |
|---|---|
| The server computes the charge; a client amount is ignored | route recomputes from the schedule |
| Charge clamped so accumulated never exceeds the depreciable base | `calculateDepreciation` |
| A journal is written only if it balances | `buildDepreciationJournal` returns `null` otherwise |
| Idempotent by `(entry_type='depreciation', reference_number)` | `postDepreciation` returns the existing journal |
| No half-posted entry survives | the header is deleted if the lines fail |
| Both lookups tenant-scoped; super admin is the only unscoped caller | `if (!context.isSuperAdmin)` |

Reference format: `DEP-<car_id>-<period_end>`.

An **idempotent re-post reports the unchanged** accumulated/book value.
Returning `accumulated + amount` would imply a charge that never happened.

### 3.2 Migration 009 (generated activation package)

`supabase/migrations/009_depreciation_accounts.sql`:

- seeds `14001` (asset-contra) and `52001` (expense) idempotently
  (`where not exists` on `code`, explicit `gen_random_uuid()`);
- adds `depreciation_schedules.tenant_id` when the table exists and the column
  is absent (a clean no-op otherwise);
- adds a lookup index on `journal_entries (entry_type, reference_number)`.

`supabase/migrations/009_depreciation_accounts_rollback.sql` drops **only** the
index. It never deletes a seeded account, because a posted journal may reference
it.

`supabase/PRODUCTION_ACTIVATION_009.sql` is **generated**, never hand-edited:

```bash
node scripts/generate-activation-bundle.mjs
```

It embeds migration 009 verbatim and records its SHA-256
(`c3b81087bd74e63c79a6e035c4c1618e5b663dc695d5dd8982c02bf5dc7e97a5`).
`tests/activation-package-integrity.test.ts` recomputes every hash and asserts
byte-identity (24/24 pass).

Migration 008 has no activation package. That gap is pre-existing and was not
introduced here.

## 4. Verification (executed, not parsed)

### 4.1 Migration 009 on real PostgreSQL

Proving DDL by parsing is not accepted in this repository. `@electric-sql/pglite`
(PostgreSQL compiled to WASM) runs the migration for real:

```
apply        -> accounts 14001 (type=asset) and 52001 (type=expense) exist
re-apply     -> still exactly 2 rows (idempotent)
rollback     -> lookup index dropped; both accounts retained
no-op        -> clean when depreciation_schedules is absent
```

Reproduced as a standalone harness: `npm run verify:migration`
(`scripts/dev/verify-migration.mjs`).

### 4.2 Real-browser end-to-end

`npm run shots:e2e` (`scripts/dev/e2e-depreciation.mjs`) drives headless
Chromium against the running application. It signs in through the **real login
form**, opens the depreciation screen, clicks **Post**, and asserts:

```
 PASS | signed in (url http://localhost:3099/super-admin)
 PASS | schedule row rendered (1)
 PASS | Post button is present
 [api] 200 /api/depreciation/post :: {"journal_created":true,"reference":"DEP-car1-2026-12-31","amount":1800,"accumulated_before":0,"accumulated_after":1800,"book_value_after":8200}
 PASS | the screen reported a posting outcome
 PASS | one depreciation journal exists in the ledger
 PASS | the journal is balanced
 PASS | it references the asset
 PASS | the journal lines balance
 [api] 200 /api/depreciation/post :: {"journal_created":false,"accumulated_before":1800,"accumulated_after":1800}
 PASS | re-posting creates no second journal
 PASS | the P&L shows the 1,800 depreciation expense
 PASS | the balance sheet shows accumulated depreciation 1,800
 PASS | mobile screenshot captured
RESULT: 12 passed, 0 failed
```

The last two assertions are the point of the whole stage: the charge is visible on
the **statements**, not only in the ledger.

### 4.3 Gates

| Gate | Result |
|---|---|
| `npm test` | **959 tests, 953 pass, 0 fail, 6 skipped** |
| `npx tsc --noEmit` | **0 errors** |
| `npm run lint` | **clean** |
| `npm run build` | **green** |

## 5. Screenshots (real Chromium, committed)

Depreciation screen — Manual Schedules tab:

- [before posting](https://github.com/mohammadaljallad79-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/accounting-depreciation-before-post-desktop.png)
- [after posting](https://github.com/mohammadaljallad79-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/accounting-depreciation-after-post-desktop.png)
- [mobile](https://github.com/mohammadaljallad79-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/accounting-depreciation-mobile.png)

The charge on the statements:

- [Profit & Loss](https://github.com/mohammadaljallad79-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/accounting-depreciation-in-profit-loss.png)
- [Balance Sheet](https://github.com/mohammadaljallad79-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/accounting-depreciation-in-balance-sheet.png)

Super Admin console (Exec 52, desktop + mobile):

- [overview](https://github.com/mohammadaljallad79-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-overview-desktop.png)
- [companies](https://github.com/mohammadaljallad79-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-companies-desktop.png)
- [users](https://github.com/mohammadaljallad79-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-users-desktop.png)
- [AI management](https://github.com/mohammadaljallad79-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-desktop.png)
- [subscriptions](https://github.com/mohammadaljallad79-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-subscriptions-desktop.png)
- [settings](https://github.com/mohammadaljallad79-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-settings-desktop.png)

All are indexed in `docs/screenshots/MANIFEST.json`.

## 6. Plan status

| Stage | Scope | Status |
|---|---|---|
| 1 | Global Super Admin console, record pickers + Quick Create, Chart of Accounts selectors, purchases / supplier statements | **Complete** (Exec 41/52, commits `c536858`, `c52224d`; screenshots above) |
| 2 | Shared ledger engine, General Ledger, Trial Balance, P&L, Balance Sheet, Cash Flow, BD 99 invoice-to-collection acceptance | **Complete** (`eca5c75`; 29/29 in `tests/exec53-stage2-ledger-and-acceptance.test.ts`) |
| 3 | Depreciation posting + accounts, verified end-to-end | **Complete** (`6684084`) |

## 7. Not done here (honest limits)

- **Migration 009 is NOT applied to production.** DDL is an operator step; this
  environment has no DDL-capable Postgres connection. Apply order stays
  001→002→003→004→005→006→007→009 using the generated activation packages.
- **No production deployment was performed**, and no live financial data was
  modified. The screenshots come from the local stub dataset
  (`scripts/dev/local-supabase-stub.mjs`), which touches no real Supabase project.
- **`origin/main` was not promoted.** The branch is fast-forward-safe onto `main`
  (23 ahead, 0 behind) but promotion was not requested and was not performed.
- **Migration 008 has no activation package.** Pre-existing gap, unchanged here.
- The E2E and screenshot tooling is **local-only**; it is evidence of correct
  behaviour on a controlled dataset, not a production smoke test.

## 8. Reproducing

```bash
bash scripts/dev/run-dev.sh 3099      # stub + app (clears a stale .next first)
npm run verify:migration              # migration 009 on real PostgreSQL
npm run shots:e2e                     # real-browser acceptance + screenshots
npm run shots                         # full screenshot set
npm test                              # 959 tests
```
