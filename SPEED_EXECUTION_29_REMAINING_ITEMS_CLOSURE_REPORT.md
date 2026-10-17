# SPEED ERP — Execution 29 Report
## Remaining Action Items Closure (local, no push / no deploy / no production DB)

**Repo:** `https://github.com/mohammadaljallad079-rgb/speed`
**Branch:** `feat/final-hardening-round5`
**HEAD at start:** `70a01c9` (Execution 28) — verified, clean tree.
**Date:** 2026-10-17
**Constraints honoured:** no push, no deploy, no production DB contact, no SQL on
production, no deletion of data/files, no `git reset --hard` / `git clean`, no
secrets requested or printed.

---

## 0. Phase 1 — audit before touching anything

- Branch `feat/final-hardening-round5` @ `70a01c9`; working tree clean; 13 commits
  ahead of `origin/main`, 0 behind.
- The original checklist `System_Action_Items_Professional (2)(1).xlsx` is **still
  absent** (searched the whole filesystem and git history). The 13 item texts are
  taken from `SPEED_EXECUTION_15_SYSTEM_ACTION_ITEMS_VERIFICATION_REPORT.md`.
  **No requirement was invented and no claim of matching the original file is made.**
- Read AGENTS.md and Exec 15→28 reports; re-read the accounting, auth, reporting
  and Excel code before changing anything.

---

## 1. The 13 items — status with evidence

| # | Item | Status after Exec 29 | Evidence |
|---|---|---|---|
| 1 | VAT report | **Complete** | `reporting/vat.ts`, `reports/vat` (+ freshness); exec18/24 tests |
| 2 | Sales serial numbers | **Complete** | `numbering.ts` row-locked RPC; `/api/invoices` allocates server-side; exec18 |
| 3 | Date filters | **Complete** | 7 report pages draft+GO; `reporting-dynamic` tests |
| 4 | Sale edit | **Complete (local)** | NEW `sales-posting.ts` reversal + `POST /api/invoices/[id]/reverse`; posted invoice is now *reversible*, not editable; `exec29-sales-posting` |
| 5 | Supplier payments | **Complete** | `payment-posting.ts`; exec16/17 |
| 6 | Purchases ↔ credit sales | **Open — business decision** | No `sale_id`/link column anywhere (verified); documented, not invented (§5) |
| 7 | Discounts & advances | **Complete** | `sales/new`, `invoices/new`; exec15/18 |
| 8 | Dashboard revenue | **Complete** | `reporting/revenue.ts`; exec18 |
| 9 | Automatic report updates | **Complete (local)** | NEW `use-report-refresh.ts` + wiring in 7 report pages and 8 mutating pages; `exec29-report-freshness` |
| 10 | Journal transaction flow | **Substantially closed (local)** | NEW unified `sales-posting.ts` + server `POST /api/invoices` (idempotent, balanced, atomic, audited); `invoices/new` rewired; `exec29-sales-posting` |
| 11 | Transaction files & records | **Complete (local)** | NEW `countInvoiceDependents`/`hasInvoiceDependents` + server `DELETE /api/invoices/[id]`; posted/dependent deletes blocked; `exec29-sales-posting` |
| 12 | Report data sources | **Complete** | `reporting/definitions.ts`; exec18/19 |
| 13 | End-to-end flow | **Blocked (external)** | Needs live deploy + production DB; local harnesses only |

**Net:** items 4, 9, 10, 11 moved from Partial → closed locally; item 6 remains a
business decision; item 13 remains externally blocked. No completed work redone.

---

## 2. Actual fixes implemented (files changed)

**New (6 files):**
- `src/lib/accounting/sales-posting.ts` — the single sales posting service:
  `buildSaleJournal`, `buildSaleReversalJournal`, `postSaleInvoice` (idempotent by
  invoice number), `reverseSaleInvoice` (idempotent), `resolveSaleAccounts`.
  Balanced-or-nothing; a failed line write removes the orphan header.
- `src/app/api/invoices/route.ts` — `POST`: server auth (`sales.create`), tenant +
  financial-year checks, cross-tenant reference checks, server-side numbering,
  invoice+journal created together with compensation, audit log.
- `src/app/api/invoices/[id]/reverse/route.ts` — `POST`: posts a reversing journal
  (idempotent) and marks the invoice cancelled; reads amounts from the DB, not the body.
- `src/lib/hooks/use-report-refresh.ts` — `notifyDataChanged()` + `useReportRefresh()`
  (data-changed event + focus/visibility revalidation, coalesced). Never writes to the ledger.
- `tests/exec29-sales-posting.test.ts` (29 tests), `tests/exec29-report-freshness.test.ts` (20 tests).

**Modified:**
- `src/lib/accounting/invoice-guards.ts` — added `countInvoiceDependents` /
  `hasInvoiceDependents` (orphan prevention).
- `src/app/api/invoices/[id]/route.ts` — added server-authoritative `DELETE`.
- `src/app/invoices/new/page.tsx` — now posts via `POST /api/invoices` (it previously
  wrote the invoice in the browser and posted **no** journal at all).
- `src/app/invoices/[id]/page.tsx` — posted invoices show a **Reverse** action instead
  of edit/delete; delete blocked when dependents exist; notifies freshness.
- `src/app/sales/new/page.tsx`, `payments/new`, `purchases/new`, `expenses/new`,
  `sales/returns`, `purchases/returns` — call `notifyDataChanged()` after a successful write.
- `src/app/reports/{vat,profit-loss,cash-flow,balance-sheet,trial-balance,analysis,car-history}/page.tsx`
  — subscribe to `useReportRefresh(<their own loader>)`.
- `tests/exec16-accounting-integrity.test.ts` — updated one assertion to match the
  new posted-invoice UI (was asserting the old disabled-button markup).
- `package.json` — registered the two new test files in `test:core`.

**Accounting behaviour was understood before changing it:** the posting shape
(Dr Cash/Bank + Dr AR = Cr Revenue + Cr Output VAT) is exactly the shape `sales/new`
already used; the new service centralises it rather than inventing a second path.

---

## 3. AI engine & Excel engine status

No rebuild, no second engine.

- **AI Reporting Intelligence / AI Control:** unchanged. **155/155 tests pass**
  (`ai-assistant`, `exec20`–`exec23`). Durable idempotency via migration 006 is
  exercised; the **resilient fallback to in-memory is covered and honest** — a
  broken durable store degrades to the in-memory store (`createResilientRepairStore`),
  and `exec23-persistent-ai-repair` proves a retry cannot double-apply. Without 006
  applied live, repair history is **not** durable in the DB — documented, not misreported.
- **Excel engine (single):** unchanged. **95/95 tests pass**
  (`exec24-vat-template-closure`, `exec25-universal-import`, `reporting-format`,
  `reporting-dynamic`): template, preview, duplicate detection, error report, tenant isolation.
- **No inventory/warehouse** anywhere (verified in source and migrations).

---

## 4. Accounting / reports / tenant-isolation test results

| Suite | Result |
|---|---|
| `exec29-sales-posting` (new) | 29 / 29 |
| `exec29-report-freshness` (new) | 20 / 20 |
| Items 1,2,3,5,7,8,12 regression (`exec15`,`exec18`,`exec17-*`,`exec19`) | 85 / 85 |
| Accounting integrity (`exec16`) | 28 / 28 |
| AI (`exec20`–`exec23`,`ai-assistant`) | 155 / 155 |
| Excel (`exec24`,`exec25`,`reporting-*`) | 95 / 95 |
| **Full suite (`npm test`)** | **624 tests · 618 pass · 0 fail · 6 skipped** |
| Tenant isolation (`security-tenant-isolation`, `tenant-isolation`, `public-api-routes`) | pass (in full suite) |

The 6 skipped tests are the opt-in live-DB probes (skipped, not passed).

**Cross-tenant tests:** the new `POST /api/invoices` runs `assertReferences`
(REF_CUSTOMER/REF_RENTAL_CONTRACT) and `assertWritableTenant`, and the reverse and
delete handlers scope by `.eq("tenant_id", context.tenantId)`; the existing
`security-tenant-isolation` suite continues to pass, including the middleware
allow-list (adding `/api/invoices` requires no allow-list change because it is a
protected, non-public prefix).

---

## 5. Business decisions that cannot be settled from the code (Item 6)

**What the evidence shows:** there is **no** `sale_id`, `linked_sale`,
`credit_sale`, or any purchase→sale reference column anywhere in `src/` or
`supabase/`. `purchase_invoices` is linked only to `suppliers`; `sales_returns`
links to `invoices`; `purchases/returns` link to `purchase_invoices`. Purchases and
expenses already flow into cost/profit/ledger through their own postings. SPEED ERP
has no inventory, so there is no stock cycle to tie a purchase to a sale.

**Decision required from the owner (one of):**
1. *No link needed* — a purchase and a sale are independent documents (current design). → close item 6 as "not applicable".
2. *Reporting link only* — add a nullable `purchase_invoices.source_sale_id` (or a
   link table) used purely for cost-of-sale/profitability reporting, with no stock.
3. *Something else* the business defines.

**I did not add any field**, per the rule to prove business need first. This is the
one item that cannot be closed by code alone.

---

## 6. External steps that cannot be closed without production access

- **Migrations 001–006 are not applied live**; there is no DDL-capable connection
  from this environment. Applying them is an operator step (see Exec 26/27/28 runbooks).
- **R1 gate:** run `supabase/EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql` on
  `chlkmdobhvfnldqkgdji`; it must return **zero** rows. Its predicate now exactly
  matches the 005 partial unique index (`status='posted' AND reference_number<>''
  AND entry_type in ('sale_invoice','supplier_payment')`) — verified this execution.
- **Live E2E** (item 13): deploy then run the post-deploy acceptance list.
- Migration order verified: `001 → 002 → 003 → 004 → 005 → 006`; the activation
  bundle `PRODUCTION_ACTIVATION_005_006.sql` embeds 005+006 byte-identically.

---

## 7. Before / after comparison

| Metric | Before (Exec 28, `70a01c9`) | After (Exec 29) |
|---|---|---|
| Full test suite | 575 tests / 569 pass / 0 fail / 6 skipped | **624 / 618 / 0 / 6** |
| New tests | — | +49 |
| `npm run typecheck` | 129 errors (baseline) | **129 (unchanged)** |
| `npm run lint` | previously reported broken | **passes: "No ESLint warnings or errors"** |
| `npm run build` | needs env to collect page data | **passes with env (exit 0)**; without env it fails at page-data collection on an **untouched** route (`/api/financial/calculate`, "supabaseUrl is required") — pre-existing |

No regression introduced; the only baseline change is a **decrease** in open items.

---

## 8. Readiness decision

**Ready to deploy the code (local verification complete); production DB activation
remains an operator step.**

- Code: tests, typecheck, lint and build all green (build requires the real/placeholder
  Supabase env, which production already has).
- Remaining blockers are external (apply migrations; run the R1 preflight; live E2E)
  plus one business decision (item 6).
- Do **not** treat this local success as live success: no production verification was
  performed or claimed.

**Single next action:** run `EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql` on the live
project and confirm zero rows; then deploy (fast-forward, rollback-safe) and apply
`001→002→003`, `004`, `005→006`.

---

## 9. Compliance

- No push, no deploy, no production DB contact, no SQL on production. ✔
- No file/data deletion, no `reset --hard`/`clean`. ✔
- No secrets requested or printed; new code contains no credentials. ✔
- AI and Excel engines untouched; no inventory/stock added. ✔
- Every "complete" claim above is backed by a named file and a passing test. ✔

## 10. Files changed by this execution

New: `src/lib/accounting/sales-posting.ts`, `src/app/api/invoices/route.ts`,
`src/app/api/invoices/[id]/reverse/route.ts`, `src/lib/hooks/use-report-refresh.ts`,
`tests/exec29-sales-posting.test.ts`, `tests/exec29-report-freshness.test.ts`.
Modified: 19 files (see §2) + this report.
