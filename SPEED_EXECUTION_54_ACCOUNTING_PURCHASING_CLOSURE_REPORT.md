# SPEED ERP — Execution 54
## Final Accounting, Purchasing & Functional Closure

**Repository:** `github.com/mohammadaljallad079-rgb/speed`
**Branch:** `feat/final-hardening-round5`
**Base commit:** `127ead3cfe7294fd16ac52f5275741405c8e3488` (Exec 53, last verified)
**Functional commits:** `318e0ae` (purchasing/accounting closure) → `9348ad7`
(screenshot fix). Documentation commits (this report + AGENTS.md) follow and change
no code. The exact pushed tip is reported in the delivery summary and is an ancestor
chain of `9348ad7`.
**Pushed:** fast-forward to `origin/feat/final-hardening-round5` (no force)
**Scope:** close the remaining accounting-integrity, purchasing and reporting gaps,
add the nine missing purchasing/expense reports, and prove every screen in a real
Chromium browser.

---

## 1. What was wrong before this execution

Exec 41/52/53 delivered the Super Admin console, the Smart Forms and the Stage 2
ledger engine. Four purchasing defects and one reporting gap were still open, all
of the same shape: **the browser was the writer**, so a document could exist
without a matching ledger entry, without a tenant and without a duplicate guard.

| # | Defect | Consequence |
|---|--------|-------------|
| 1 | A purchase order converted to a bill inserted `purchase_invoices` + items in the browser, with no journal and no `tenant_id` | An unposted bill; the ledger never saw the purchase |
| 2 | The debit-notes screen inserted `debit_notes` in the browser with no journal, no `tenant_id` and a hard `delete` | A supplier credit reduced nothing in the GL while statements still showed it |
| 3 | Supplier payments were four independent browser writes (insert → post → read bill → update bill), no tenant, no overpayment guard, destructive journal delete | Two concurrent payments clobbered the bill balance; a failure mid-way left the GL, the supplier ledger and the bill disagreeing |
| 4 | The cash-flow report restated accrual P&L instead of reporting cash | A "cash flow" statement that never looked at a cash account |
| 5 | Nine purchasing/expense report kinds were referenced in the UI with no implementation | Dead links; no purchase register, no supplier ledger/aging, no expense allocation reports |

A sixth gap was found and closed during this execution:

| 6 | `purchases/page.tsx` deleted a supplier bill **directly from the browser**, with no posted-journal check and no dependent check | Deleting a posted bill orphaned its journal; deleting a bill with payments/debit notes orphaned those rows |

---

## 2. Stage 1 — Super Admin, premium UI, screenshots

Already delivered in Exec 41/52 and preserved unchanged (not re-implemented).
Exec 54 re-verified it in a real browser and captured fresh evidence.

* `/super-admin` renders all six tabs (`Overview`, `Companies`, `Users`,
  `AI Management`, `Subscriptions`, `Settings`); each tab is a distinct, populated
  panel — verified by 6 unique desktop and 6 unique mobile screenshot hashes, with
  5–60 % pairwise pixel difference between tabs.
* `super_admin` is the global, tenant-less operator; a company `admin` is refused
  by `requireSuperAdmin`.
* Screenshots are captured through the **real** `/super-admin-login` form (which
  calls Supabase sign-in and then `/api/me`), never by injecting a session.

**Screenshot evidence (all committed, desktop 1440×1000 + mobile 390×900):**

| Screen | Files |
|--------|-------|
| Super admin login | `super-admin-login-desktop.png`, `super-admin-login-mobile.png` |
| Super admin overview | `super-admin-overview-desktop.png`, `super-admin-overview-mobile.png` |
| Companies tab | `super-admin-companies-desktop.png`, `super-admin-companies-mobile.png` |
| Users tab | `super-admin-users-desktop.png`, `super-admin-users-mobile.png` |
| AI Management tab | `super-admin-ai-desktop.png`, `super-admin-ai-mobile.png` |
| Subscriptions tab | `super-admin-subscriptions-desktop.png`, `super-admin-subscriptions-mobile.png` |
| Settings tab | `super-admin-settings-desktop.png`, `super-admin-settings-mobile.png` |

Manifest: [`docs/screenshots/MANIFEST.json`](docs/screenshots/MANIFEST.json) — 56 files.

### Capture hardening (real fix, not cosmetics)

The earlier capture run silently produced **byte-identical** screenshots for every
super-admin tab: it clicked the tab before the client-rendered tab bar existed and
captured the default panel six times. Fixed in
`scripts/dev/capture-screenshots.mjs`:

* `waitFor` the tab control before clicking, and **fail** if it never appears
  (a warning is not enough — a wrong screenshot is worse than no screenshot);
* `waitFor` the record `<select>` before choosing an option, so a statement shot
  shows a populated screen rather than the empty state;
* navigate with `domcontentloaded` + the existing content poll instead of
  `networkidle` (the dev HMR socket keeps `networkidle` from settling);
* the existing SHA-256 duplicate guard now passes: **0 duplicate images**.

The tab-panel fix was found by **verifying the images, not the run exit code**: the
first corrected run exited 0 with six unique files, yet a pixel diff showed five of
them were the same frame (0.3–0.7 % difference, confined to the tab-bar highlight).
The real cause was a click landing before hydration; the script now retries the
click until the target panel's own text is on screen and fails otherwise. The six
tab images now differ by 5–60 %.

---

## 3. Stage 2 — financial posting integrity, GL/TB/P&L/BS/CF, BD 99 scenario

Delivered in Exec 53 and preserved. Exec 54 adds the purchasing half and re-proves
the whole chain.

* One shared ledger engine; General Ledger, Trial Balance, Profit & Loss, Balance
  Sheet and Cash Flow all read `journal_lines` (the only canonical line table).
* The cash-flow report now **is** a cash statement:
  `buildCashFlowStatement` (`src/lib/reporting/cash-flow.ts`) classifies every
  journal line against the real cash/bank accounts (11-prefixed), separates
  operating / investing / financing, and reconciles opening + movement = closing.
  A credit sale is not a cash flow; only the settled receipt is. A bank transfer
  is cash-to-cash and contributes nothing.
* The **BD 99 invoice-to-collection acceptance scenario** (Exec 53) still passes:
  issue → post → collect → the ledger, the GL, the TB, the P&L, the BS and the
  customer statement all agree.

---

## 4. Stage 3 — Purchases, supplier bills, payments, debit notes, statements, aging, allocation, reports

### 4.1 One server path per document

| Document | Route | Journal |
|----------|-------|---------|
| Purchase / supplier bill | `POST /api/purchases` | `Dr expense/asset, Cr cash/bank + Cr AP (21001)` |
| Supplier payment | `POST /api/supplier-payments` | `Dr AP (21001), Cr Cash (11001) / Bank (11002)` — never revenue |
| Supplier payment reversal | `POST /api/supplier-payments/[id]/reverse` | Mirror of the payment, own `entry_type` |
| Debit note | `POST /api/debit-notes` | `Dr AP (21001), Cr expense, Cr Input VAT (24001)` |
| Bill delete | `DELETE /api/purchases` | **New in Exec 54** — refuses a posted bill and any bill with dependents |

Each route takes identity, tenant, permission and the financial year from the
session; each uses the document number as its idempotency key; each compensates by
removing what *it* created if posting fails.

### 4.2 New: supplier-bill deletion guard (Exec 54)

`src/lib/accounting/invoice-guards.ts` gains the purchase mirror of the sales guard:

* `findPostedPurchaseJournal` / `isPurchaseBillPosted` — does a
  `purchase_invoice` journal exist for this bill number?
* `countPurchaseBillDependents` / `hasPurchaseBillDependents` — how many
  `supplier_payments`, `debit_notes` and `purchase_invoice_items` point at the bill?
  An unreadable table counts as zero, so the guard never blocks a legitimate delete.

`DELETE /api/purchases` loads the row tenant-scoped (a foreign id is a `404`),
refuses a posted bill (`403`) and a bill with dependents (`403`), deletes only when
both checks pass, and writes an audit row. `src/app/purchases/page.tsx` now calls
the route and surfaces the server's refusal instead of deleting the row itself.

### 4.3 Nine purchasing / expense reports

`src/lib/reporting/purchasing-reports.ts` — pure builders, no DB access:

1. `buildPurchaseRegister` — bills with taxable base, VAT and outstanding
2. `buildSupplierLedger` — running balance across bills, payments and debit notes
3. `buildSupplierAging` — `current / 1-30 / 31-60 / 61-90 / 90+`, buckets sum to total
4. `buildExpensesByVehicle` — bills + expenses allocated to a vehicle
5. `buildExpensesByBranch` — allocation by branch
6. `buildExpensesByCategory` — allocation by expense category
7. `buildVatPurchases` — input VAT, taxable base separated from VAT per source
8. `buildMonthlyExpenses` — month buckets across both sources
9. `buildVehicleProfitability` — net revenue minus allocated cost

The tax-base convention is **not uniform** and is encoded once:
`purchase_invoices.total_amount` is VAT-inclusive (taxable = total − vat), while
`expenses.amount` is stored pre-VAT (taxable = amount). Cancelled documents are
excluded everywhere. One generic screen
(`src/components/reports/PurchasingReportPage.tsx`) renders all nine; one route
(`GET /api/reports/purchasing?kind=…`) serves them, permission-gated on
`reports.view`.

### 4.4 Super-admin scoping fix

`src/app/api/reports/purchasing/route.ts` used a fail-open helper. It now reads
unfiltered only for `context.isSuperAdmin`; every other caller is scoped to its
tenant (`q.eq("tenant_id", …)`, or `q.is("tenant_id", null)` on the single-tenant
install). This is the same fail-closed shape as `scopeToCompany`.

### 4.5 Migration 010

`supabase/migrations/010_purchasing_accounts.sql` seeds the accounts and sequence
the purchasing path needs — input VAT `24001`, other expenses `51099`, and the
`debit_note` document sequence — idempotently (`where not exists`, no `delete`/
`truncate`). Frozen package `supabase/PRODUCTION_ACTIVATION_010.sql` embeds the body
byte-identically with its SHA-256 in the banner; a non-destructive rollback
(`010_purchasing_accounts_rollback.sql`) refuses to orphan a posted line.

> **Not applied to production.** DDL remains an operator step (no reachable DDL path
> from this environment). The migration is delivered as a file plus an activation
> package; its application is **NOT VERIFIED**.

---

## 5. Verification

### 5.1 Automated

```
npm test        → 1012 tests, 1006 pass, 0 fail, 6 skipped
npx tsc --noEmit → 0 errors
npm run lint     → ✔ No ESLint warnings or errors
npm run build    → ✓ Compiled successfully (exit 0)
```

`tests/exec54-purchasing-integrity.test.ts` — **40 tests**, all passing:
cash-flow engine (8), debit-note posting (5), supplier-payment integrity (5),
purchasing reports (9), supplier-bill deletion (3), PO conversion (3),
account provisioning (3), plus the route/page contracts.

### 5.2 Real browser verification (Chromium / Playwright)

Dev server on `:3099` against the local Supabase stub; sign-in through the real
form. Every report was probed for **rendered table rows**, not just HTTP 200:

| Route | Rows rendered |
|-------|---------------|
| `/reports/purchase-register` | 3 |
| `/reports/supplier-ledger` | 6 |
| `/reports/supplier-aging` | 1 |
| `/reports/expenses-by-vehicle` | 3 |
| `/reports/expenses-by-branch` | 2 |
| `/reports/vat-purchases` | 2 |
| `/reports/vehicle-profitability` | 2 |
| `/purchases` | 4 |
| `/supplier-statements` (after selecting a supplier) | 4 |

### 5.3 Screenshots

56 PNGs in `docs/screenshots/`, all distinct (0 duplicate hashes), none near-blank
(verified by pixel-range, not by file size). The six super-admin tab shots were
re-captured after the harness fix and are now genuinely different frames.
Purchasing screens added in Exec 54:

* `report-purchase-register-{desktop,mobile}.png`
* `report-supplier-ledger-{desktop,mobile}.png`
* `report-supplier-aging-{desktop,mobile}.png`
* `report-expenses-by-vehicle-{desktop,mobile}.png`
* `report-expenses-by-branch-{desktop,mobile}.png`
* `report-vat-purchases-{desktop,mobile}.png`
* `report-vehicle-profitability-{desktop,mobile}.png`
* `purchases-bills-{desktop,mobile}.png`
* `purchases-new-bill-{desktop,mobile}.png`
* `purchases-returns-{desktop,mobile}.png`
* `supplier-statements-{desktop,mobile}.png`
* `supplier-payments-{desktop,mobile}.png`

GitHub links (branch `feat/final-hardening-round5`):

* Super admin overview — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-overview-desktop.png
* Super admin companies — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-companies-desktop.png
* Super admin users — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-users-desktop.png
* Super admin AI — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-desktop.png
* Super admin subscriptions — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-subscriptions-desktop.png
* Super admin settings — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-settings-desktop.png
* Purchase register — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/report-purchase-register-desktop.png
* Supplier ledger — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/report-supplier-ledger-desktop.png
* Supplier aging — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/report-supplier-aging-desktop.png
* Expenses by vehicle — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/report-expenses-by-vehicle-desktop.png
* Expenses by branch — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/report-expenses-by-branch-desktop.png
* VAT purchases — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/report-vat-purchases-desktop.png
* Vehicle profitability — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/report-vehicle-profitability-desktop.png
* Supplier bills — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/purchases-bills-desktop.png
* Supplier statements — https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/supplier-statements-desktop.png

---

## 6. Honest status — what is NOT done

* **Migrations 001–010 are not applied to the live database.** There is no
  reachable DDL path from this environment (the direct host is IPv6-only, the
  configured pooler host is stale, no `exec_sql` RPC). Applying them is an operator
  step; their application is **NOT VERIFIED**. Until then the anon key retains its
  default Supabase privileges.
* **No production deployment** was performed and no live financial data was
  modified.
* **Administrator accounts were not recreated or reset** — they were already
  provisioned by the project owner.
* `/purchases/dashboard` and `/supplier-statements` still read their lists with the
  browser client. They are read-only views (RLS is the boundary) and were not
  rewritten in Exec 54; the *mutating* paths are now server-authoritative.
* The `purchases ↔ credit-sale link` (Item 6) remains reporting-only by design; no
  inventory subsystem was added.
