# SPEED ERP — Execution 57: Final Audit, Verification & Completion

**Branch:** `feat/final-hardening-round5`
**Continuation point:** `c536858a6e629c495b4d3b6b294cfa54c1424bd0` (confirmed ancestor of HEAD)
**Work commit:** `fa7d7a5555891593644cda463886b5934bfd59dc`
**Repository:** https://github.com/mohammadaljallad079-rgb/speed

---

## 1. Continuation point — confirmed

The stated last-pushed commit `c536858` **is** an ancestor of the current tip.
HEAD was already **16 commits ahead** of it (Exec 52 → Exec 56):

```
c536858  (stated continuation point)
   ↓ 16 commits
c52224d feat(exec52): Super Admin premium responsive UI, record pickers, real screenshots
eca5c75 feat(exec53): shared ledger engine, General Ledger, balance-sheet correctness
6684084 feat(exec53): depreciation posting + real browser proof
127ead3 docs(exec53): Stage 3 implementation report
318e0ae feat(exec54): purchasing/accounting closure + 9 purchasing reports
9348ad7 fix(exec54): super-admin tab screenshots were mislabeled
9925845 docs(exec54): final report + corrected evidence summary
aaa0fab docs(exec54): state the actual pushed branch tip
8e06dcc docs(exec54): describe the commit range without a self-referential tip
0a9f17e fix(guards): fail closed on unverifiable posting/dependency checks
2d4761b docs(exec55): diagnose the Super Admin production 404
a221a5e feat(exec55): atomic journal posting via post_journal_entry (migration 011)
6a34e10 fix(middleware): send an anonymous operator to /super-admin-login
4fdf482 fix(public): open the marketing fleet pages
934af3d docs(exec56): record the public-surface and operator-door invariants
404f06a test(public-api): do not treat placeholder credentials as a live database
```

**No prior work was recreated.** Stages 1–3 of the agreed plan were already
substantially implemented in Exec 52–56. This execution **audited** that work,
**found one real functional defect**, fixed it, and verified everything else
against the actual code and tests.

---

## 2. Audit result — Stage 1 (Super Admin, UI, screenshots, Smart Forms)

| Requirement | Status | Evidence |
|---|---|---|
| Global Super Admin functionality | ✅ Done (Exec 41/51/52) | `src/lib/super-admin/*`, `/api/super-admin/*`, `tests/exec41-super-admin-console.test.ts`, `tests/super-admin-policy.test.ts`, `tests/exec51-role-hardening.test.ts` |
| Global-only boundary (`requireSuperAdmin`) | ✅ Done | `src/lib/auth/api-guard.ts`; a company `admin` is rejected 403 |
| Premium responsive UI | ✅ Done (Exec 52) | `src/app/super-admin/page.tsx`; desktop + mobile shots for every tab |
| Actual browser screenshots committed | ✅ Verified | **14 Super Admin shots**, all real PNGs 16 KB–146 KB (not blank), asserted by `tests/exec53-stage2-ledger-and-acceptance.test.ts` ("no screenshot is a blank or duplicated frame") |
| Smart Forms + Quick Create modals | ✅ Done (Exec 52/55) | `src/components/records/RecordSelect.tsx`, `src/app/api/records/create/route.ts`, `tests/exec52-super-admin-smart-forms.test.ts`, `tests/exec55-smart-forms-inline-create.test.ts` |
| DB-backed Chart of Accounts selectors | ✅ Done | `kind="account"` source in `src/lib/records/sources.ts` → table `accounts`; used in `accounting/petty-cash`; the journal editor reads `accounts` and builds the account tree |

### Super Admin screenshots (committed, clickable)

| View | Desktop | Mobile |
|---|---|---|
| Login | [super-admin-login-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-login-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-login-mobile.png) |
| Overview | [super-admin-overview-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-overview-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-overview-mobile.png) |
| Companies | [super-admin-companies-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-companies-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-companies-mobile.png) |
| Users | [super-admin-users-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-users-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-users-mobile.png) |
| AI Oversight | [super-admin-ai-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-ai-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-ai-mobile.png) |
| Subscriptions | [super-admin-subscriptions-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-subscriptions-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-subscriptions-mobile.png) |
| Settings | [super-admin-settings-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-settings-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/fa7d7a5555891593644cda463886b5934bfd59dc/docs/screenshots/super-admin-settings-mobile.png) |

All 14 files are tracked in git (`git ls-files`) and listed in
`docs/screenshots/MANIFEST.json` (58 files total).

---

## 3. Audit result — Stage 2 (posting integrity, ledger, BD 99 acceptance)

All five report pages exist and are tenant-scoped:
`reports/general-ledger`, `reports/trial-balance`, `reports/profit-loss`,
`reports/balance-sheet`, `reports/cash-flow`.

`tests/exec53-stage2-ledger-and-acceptance.test.ts` proves, by executing real
code against a PostgREST-like stub:

- the ledger engine's debit/credit nature, signed balances and period split;
- an unbalanced ledger is **reported**, never hidden;
- **BD 99 acceptance:** issue → collect leaves AR at zero, revenue recognised
  **once**;
- a **retried issue is idempotent** and cannot double revenue;
- a part-paid sale splits cash/AR and still balances;
- the balance sheet folds unclosed earnings into equity and **assets = liabilities + equity**.

---

## 4. Audit result — Stage 3 (purchases, supplier bills, payments, debit notes, aging, allocation, reports)

| Requirement | Status | Evidence |
|---|---|---|
| Purchases / Supplier Bills | ✅ | `purchases`, `purchases/new`, `purchases/dashboard`, `purchases/returns` |
| Supplier Payments | ✅ | `supplier-payments`; `postSupplierPayment` (Dr AP / Cr Cash/Bank, never revenue) |
| Debit Notes | ✅ | `purchases/returns` ("Debit Notes (Returns)") + `/api/debit-notes` → `postDebitNote`; the note and its journal are written together or neither |
| Supplier Statements | ✅ | `supplier-statements` |
| Aging | ✅ | `reports/supplier-aging` |
| Vehicle / branch expense allocation | ✅ | `reports/expenses-by-vehicle`, `reports/expenses-by-branch` |
| Purchasing reports (9) | ✅ | purchase register, supplier ledger, supplier aging, expenses by vehicle/branch, VAT purchases, vehicle profitability, etc. (Exec 54) |
| Integration tests | ✅ | `tests/exec54-purchasing-integrity.test.ts` |

---

## 5. The defect found and fixed — customer booking / car availability

This was the one **open** item (task T3). The reported symptom: *a car added by
the company did not appear to its own customer, and could not be booked.*

### Root cause A — availability was read off a flag that is never reset

`listAvailableCars` filtered `cars` with `.eq("status", "available")`, and
`isCarRentable` required `status === "available"`.

`cars.status` is a **denormalised display cache**. Auditing every writer showed
the application only ever sets it to `rented` (change-vehicle screen) and
**nothing ever resets it** when a rental is completed or cancelled. So any car
that had ever been rented stayed `rented` **permanently** and vanished from every
future booking list. The availability signal is the **rental contracts**.

Note the codebase already knew this: `src/app/cars/page.tsx:137` derives
"rented" from **active contracts**, not from the flag. The booking service was
the outlier.

### Root cause B — the customer could be assigned a tenant that owns no cars

`/api/customer-signup` assigned the customer a tenant. The portal scopes cars by
that tenant, so assigning the wrong one produces an **empty** booking list. The
old resolver preferred the tenant that owned `status='available'` cars, and when
there were none it fell back to a bare `tenants` row — a tenant that may own none
of the cars. Root cause A made this *reachable*: with every car stuck on
`rented`, no tenant was derivable from cars, so the bare-tenant fallback was
taken.

### The fixes

| File | Change |
|---|---|
| `src/lib/rental/booking-service.ts` | `UNRENTABLE_STATUSES` (maintenance/sold/inactive/out_of_service) replace the `status === "available"` rule; `rented` is transient. `listAvailableCars` drops `.eq("status","available")` and derives "out" from open contracts — by overlap with a date window, by "out today" with none |
| `src/lib/rental/customer-tenant.ts` (new, pure) | `resolveCustomerTenantId` follows the **rentable cars**; returns `null` (tenant-less scope) rather than guessing; a `tenants` row is a fallback only when no cars exist |
| `src/app/api/customer-signup/route.ts` | Uses the pure resolver; reads `tenant_id,status,category` and filters with `isCarRentable` |
| `src/lib/rental/car-status.ts` (new, pure) | `carStatusForContractChange` — a terminal transition releases the car |
| `src/app/rentals/[id]/change-car/page.tsx` | Same stale-flag defect: no longer filters candidates by `.eq("status","available")`; excludes cars on open contracts |
| `src/app/rentals/page.tsx`, `src/app/rentals/[id]/page.tsx` | Release the car on completion/cancellation |
| `src/app/customer-dashboard/page.tsx` | The empty-state copy no longer blames the dates before any date is chosen |

### Verification

`tests/exec57-booking-availability.test.ts` — **12 tests / 30 assertions**, all
passing, registered in `test:core`:

- a stale `rented` flag with no contract does **not** hide a free car;
- a car on an active contract **is** hidden for the overlapping window, and
  reappears for a later window;
- with no dates, a car out today is hidden — and reappears once the contract ends
  *even though its flag is still `rented`*;
- maintenance/sold/inactive are never offered; `rented` is;
- the tenant resolver follows the cars (single tenant → that tenant; split or
  all tenant-less → `null`; no cars → single `tenants` row, else `null`);
- the rental screens apply the release helper.

---

## 6. Verification performed

| Gate | Result |
|---|---|
| `npm test` (full suite, `test:core`) | **1065 tests / 1059 pass / 6 skipped / 0 fail** |
| Booking + rental suites | 30/30 pass |
| Stage 1–3 key suites (ledger, acceptance, depreciation, purchasing, Super Admin, Smart Forms, AI) | 217/217 pass |
| `npx tsc --noEmit` | **0 errors** |
| `npm run lint` | "No ESLint warnings or errors" |
| `npm run build` | **green** (all routes compiled) |
| Pushed to GitHub | `404f06a..fa7d7a5` on `feat/final-hardening-round5`, verified with `git ls-remote` |

---

## 7. Honest limitations (nothing claimed that was not tested)

- **AI provider calls are not exercised end-to-end here.** No provider key is
  configured in the sandbox, so the AI layer is verified through its
  deterministic path and the recording-stub tests (`tests/ai-assistant.test.ts`).
  The Open-Source/`openai_compatible` + `baseUrl` route is implemented in
  `src/lib/ai/providers.ts`; it was **not** called against a live model.
- **The database is not reachable** from this environment. Every DB-bound test
  runs against a PostgREST-like recording stub, not the live project. Migrations
  `001`–`011` remain **operator-applied**; none was applied by this execution.
- **No live financial data was written.** The only writes were source files,
  tests and the report.
- **Screenshots were not re-captured.** The existing 58 committed captures are
  verified as real (non-blank, non-duplicate) by test; re-capturing needs a live
  server and credentials the sandbox does not have.
- **`/purchases/bills` is not a route** — supplier bills are the `/purchases`
  screen. The `purchases-bills-*.png` shot is a capture label for `/purchases`,
  not a missing page.
- **Deployment was not performed** and was not requested.

---

## 8. Commits

| Commit | Subject |
|---|---|
| `7b2c1af` | fix(exec57): derive car availability from contracts, not a stale status flag |
| `fa7d7a5` | fix(exec57): release the vehicle flag on every terminal contract transition |

Both are pushed to `feat/final-hardening-round5`. `main` was **not** touched.
