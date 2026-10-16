# SPEED ERP — Execution 15: System Action Items Verification Report

**Branch:** `feat/final-hardening-round5` (working tree only — nothing pushed, nothing deployed)
**Repo:** `https://github.com/mohammadaljallad079-rgb/speed`
**Date of run:** 2026-10-16
**Authoritative checklist:** `System_Action_Items_Professional.xlsx`

---

## 0. Important baseline facts (read first)

- **The checklist file is not present.** `System_Action_Items_Professional.xlsx`
  does not exist anywhere in the sandbox, the repository, or any branch/ref
  (`find / -iname "*.xlsx"` → no result; `git ls-files | grep -i xlsx` → none).
  The 13 item titles below are taken from the task text. The audit proceeds on
  those titles and is not blocked by the missing binary, but the mapping is
  therefore to the *stated* items, not to the spreadsheet cells.
- **There is only one application variant.** Local branches are `main`,
  `feat/final-hardening-round5` (HEAD), and `feat/exec07-admin-superadmin-hardening`
  (`f02125d`, older). Remote has `main` + `feat/final-hardening-round5` only.
  No branch or directory contains an alternative "complete ERP". The current
  branch **is** the complete application (121 pages, 24 API routes, 13 test
  files). Nothing was reconciled from another source because none exists.
- **Architecture note (drives many findings):** this variant posts accounting
  **from the browser** on each page (`supabase.from('journal_entries').insert(...)`)
  — there is **no** shared `postJournalEntry` service. `src/lib/numbering.ts`
  wraps the row-locked `generate_document_number` RPC. Therefore fixes were made
  **in the existing pages**, never by adding a second posting engine.
- **No inventory/warehouse subsystem exists** and none was added (verified).

---

## 1. Initial checklist (Phase 1 audit)

| # | Item | Initial status |
|---|------|----------------|
| 1 | VAT Report | PARTIAL |
| 2 | Sales Serial Numbers | FAIL (timestamp numbers) |
| 3 | Date Filters | FAIL (auto-search) |
| 4 | Sale Edit | PARTIAL (no posted-invoice protection) |
| 5 | Payments for Purchases/Suppliers | PARTIAL (no GL posting) |
| 6 | Purchases ↔ Credit Sales Link | PARTIAL (no link field; by design) |
| 7 | Sales Discounts & Advance Payments | PASS (implemented & balanced) |
| 8 | Dashboard Revenue | FAIL (summed receipts) |
| 9 | Automatic Financial Report Updates | PARTIAL (re-fetch only, no txn refresh) |
| 10 | General Ledger Transaction Flow | PARTIAL (no idempotency; no unified service) |
| 11 | Transaction Files & Records | PARTIAL (orphan/duplicate risk on delete) |
| 12 | Report Data Sources | PARTIAL (undocumented) |
| 13 | End-to-End Flow | BLOCKED (no live DB / no test DB) |

---

## 2. What was implemented and verified locally

### Item 2 — Sales Serial Numbers → **PASS (locally)**
- **Root cause found:** `src/app/invoices/new/page.tsx` minted the invoice number
  as `"INV-" + Date.now().toString().slice(-6)` — a 6-digit millisecond suffix
  that collides under concurrency and on retry (the same class of defect the
  codebase's own `numbering.ts` warns about).
- **Fix:** the page now takes its number from the row-locked
  `generate_document_number` RPC (`p_doc_type: "sale_invoice"`), with a
  submit-time fallback via `nextDocumentNumber(supabase, "sale_invoice", "INV")`
  so an empty field can never be saved. `sales/new` already used the RPC.
- **Files:** `src/app/invoices/new/page.tsx`; `src/lib/numbering.ts` (used).
- **Tests:** `tests/exec15-financial-remediation.test.ts` → 3 tests pass
  (no timestamp pattern; RPC value used; graceful fallback).
- **Remaining gap:** other document types still mint `Date.now()` numbers
  (`purchases/new` PAY-, `purchase-orders` INV-/PO-, `supplier-payments` SP-,
  `quotations` QT-, `purchases/returns` DN-). These are **not sales serials**, so
  they are out of Item 2's scope, but they are the same defect class and are
  listed as recommended follow-up. Historical invoices were **not** renumbered.

### Item 3 — Date Filters → **PASS (locally)**
- **Root cause found:** 7 report pages ran their query inside a
  `useEffect(..., [dateFrom, dateTo])`, so *changing a date auto-searched*.
  Only `payments` and `invoices` already used the correct draft+button pattern.
- **Fix:** every affected page now binds the date inputs to `*Draft` state and
  applies the range only when a **GO / عرض** button is pressed (`applyDates`),
  matching the established pattern:
  - `reports/vat`, `reports/profit-loss` (From/To + GO)
  - `reports/cash-flow`, `reports/balance-sheet`, `reports/trial-balance`
    (From/To + GO)
  - `reports/analysis`, `reports/car-history` (car + range + presets + GO)
- **Tests:** 7 tests pass — each page must have `applyDates` and must not bind a
  `type="date"` input directly to the applied filter.
- **Note:** `customer-dashboard` uses start/end dates as a *booking form*
  (creates a contract), not as a search filter — no GO button applies there.

### Item 8 — Dashboard Revenue → **PASS (locally)**
- **Root cause found:** `src/app/dashboard/page.tsx` computed
  `revenue = sum(payments.amount where status='completed')` — i.e. it counted
  **customer receipts** (which only settle receivables) as revenue, and would
  count an invoice twice (once at issue, once when paid).
- **Fix:** revenue is now derived from **issued invoices**, excluding cancelled
  documents and excluding VAT:
  `invoiceRevenue = total_amount − vat_amount`, summed over non-cancelled
  invoices, for both the total and the monthly earnings chart. The payments
  query is retained solely for the (previously broken) overdue-payment alert.
- **Formula documented:** *Revenue = Σ (invoice.total_amount − invoice.vat_amount)
  over invoices where status ≠ 'cancelled'*. Excludes: customer receipts,
  supplier payments, transfers, deposits, advances-as-receipts.
- **Tests:** 2 tests pass (revenue reduces over invoices net of VAT; receipts are
  not summed into revenue).

### Item 1 — VAT Report → **PARTIAL → improved, verified as far as source allows**
- The report already computes output VAT (invoices, excluding `cancelled`),
  input VAT (expenses + purchase invoices, excluding `cancelled`), monthly
  breakdown, net payable, print and Excel export, with the Bahrain template.
- **Change made:** date filter corrected (Item 3) so the period is explicit.
- **Tests:** 1 test asserts cancelled documents are excluded and VAT is read from
  `vat_amount`.
- **Remaining gap:** true reconciliation to GL (`24000` output VAT /
  input-VAT accounts) and against real credit-note/return rows **cannot be
  executed here** — no live or test database is reachable. Marked PARTIAL.

---

## 3. Implemented but only partially verified

- **Item 7 — Discounts & Advance Payments (PASS by code review):**
  `sales/new` computes `discount` (fixed/percentage), `vat`, `advancePayment`
  (clamped to total), `remaining`; the journal is balanced
  (Dr Cash + Dr AR = Cr Revenue + Cr VAT). `invoices/new` has the same
  discount/advance model. No source change needed. **Not executed** against a DB.
- **Item 9 — Automatic Report Updates (PARTIAL):** reports re-fetch on
  mount/GO, and the financial routes are `force-dynamic`, but there is no
  cross-page refresh/invalidation after a transaction; a report opened in
  another tab will not auto-refresh. No failed-transaction transaction wrapper
  exists, so a mid-sequence failure can leave partial records. **Not fixed** —
  requires an atomic server-side posting service, which the architecture
  deliberately lacks.

---

## 4. Blocked / not implemented (with exact next action)

| # | Item | Status | Blocker / next action |
|---|------|--------|-----------------------|
| 4 | Sale Edit | PARTIAL | `invoices/[id]` updates `invoices` from the browser incl. client-supplied `paid_amount`, and can `delete()` a posted invoice, with no GL reversal or posted-lock. Fixing this correctly needs a server posting/reversal service. Next action: add `assertInvoiceMutable` + reversal via the existing posting mechanism, and a DB trigger preventing edits when a `sale_invoice` journal exists. |
| 5 | Supplier Payments | PARTIAL | `supplier-payments` inserts a row and updates the bill, but posts **no journal** (AP/cash GL not updated). Next action: add `Dr AP (21001) / Cr Cash-Bank` posting on the same page, reusing the existing pattern. |
| 6 | Purchases ↔ Credit Sales | PARTIAL | No `sale_id`/linked-document column exists; no relationship is defined in the schema. Per rules, none was invented. Next action: confirm the intended business relationship with the owner before adding a link field. |
| 10 | GL Transaction Flow | PARTIAL | Posting is per-page browser writes with no idempotency guard (a retry can duplicate a journal) and no unified service. Next action: introduce a single server-side posting function with a duplicate guard (by reference) — a larger, architecture-level change. |
| 11 | Transaction Files & Records | PARTIAL | Deleting an invoice leaves its `journal_entries`/`payments` orphaned. Next action: cascade-or-reverse on delete. |
| 12 | Report Data Sources | PARTIAL | Data-source map produced (see §6). Verification of each figure against GL is blocked by no DB. |
| 13 | End-to-End Flow | BLOCKED | No isolated test database and no live credentials; the 6 skipped tests are the live probes. Next action: provide a disposable Supabase project or local Postgres with the live schema. |
| 9 | Report auto-update | PARTIAL | No atomic transaction wrapper. See §3. |

---

## 5. Test / typecheck / lint / build results (actual, this run)

| Gate | Command | Result |
|------|---------|--------|
| New regression tests | `tsx --test tests/exec15-financial-remediation.test.ts` | **13 / 13 pass** |
| Full suite | `npm test` | **323 tests, 73 suites, 317 pass, 0 fail, 6 skipped** |
| TypeScript | `npm run typecheck` | **129 errors — unchanged from the documented baseline** (verified by diffing error *types*, not line numbers; my edits add lines and shift numbers) |
| Lint | `npm run lint` | **clean — no warnings or errors** |
| Production build | `npm run build` | **success — 131/131 static pages** |

**Build caveat (honest):** this fresh sandbox has **no `.env.local`**, so a bare
`npm run build` fails at `/api/financial/*` with `supabaseUrl is required.` (those
routes create a Supabase client at module scope). The build was verified to pass
using **placeholder** env values only (`NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co`,
etc.). No real secret was created, printed, or committed. This is an environment
gap, not a code regression.

The 6 skipped tests are the opt-in live-DB probes; they are **skipped, not passed**.

---

## 6. Report data-source map (Item 12)

| Report | Authoritative source | Filter | Calculation | Reconciliation |
|--------|---------------------|--------|-------------|----------------|
| VAT Report | `invoices.vat_amount` (output), `expenses.vat_amount` + `purchase_invoices.vat_amount` (input) | `invoice_date`/`expense_date`/`bill_date` in period; exclude `status='cancelled'` | output − input per month | vs GL `24000` (VAT payable) |
| Dashboard Revenue | `invoices` | exclude `cancelled` | Σ(`total_amount − vat_amount`) | vs Income-Statement revenue |
| Income Statement | `journal_entries` + `journal_lines` (posted) | `entry_date` in period | sum by account type | self-balancing (Dr = Cr) |
| Trial Balance | `journal_entries` + `journal_lines` | `entry_date` in period | Σ debit / Σ credit per account | Dr total = Cr total |
| Balance Sheet | `journal_entries` + `journal_lines` | up to `toDate` | asset/liability/equity balances | assets = liab + equity |
| Cash Flow | `journal_entries` + `journal_lines` (cash/bank accounts) | `entry_date` in period | movement on cash/bank codes | vs bank/cash balances |
| Receivables | `invoices` | `total_amount − paid_amount` | outstanding AR | vs GL `12001` |
| Sales Report | `invoices` + `sales` | date/status | per-document | vs revenue GL |
| Purchases Report | `purchase_invoices` | date/status | per-document | vs AP GL `21001` |

Known inconsistency to correct (documented, not hidden): the Dashboard uses
`invoices` while the Income Statement uses `journal_entries`. They agree only if
every invoice is posted to the GL. This is the reconciliation Item 9/10 must close.

---

## 7. Explicit separation of status

- **Implemented and verified locally:** Items 2, 3, 8 (and 1 improved).
- **Implemented, partially tested:** Item 7 (code-reviewed, balanced; not DB-run).
- **Blocked (no DB/credentials):** Items 4, 5, 6, 9, 10, 11, 12, 13 — each has an
  exact next action in §4.
- **Verified in production:** **none** — production verification was not
  authorized/performed in this execution.

---

## 8. Files changed in this execution

- `src/app/reports/vat/page.tsx` — draft dates + GO
- `src/app/reports/profit-loss/page.tsx` — draft dates + GO
- `src/app/reports/cash-flow/page.tsx` — draft dates + GO
- `src/app/reports/balance-sheet/page.tsx` — draft dates + GO
- `src/app/reports/trial-balance/page.tsx` — draft dates + GO
- `src/app/reports/analysis/page.tsx` — draft dates + GO
- `src/app/reports/car-history/page.tsx` — draft dates + GO
- `src/app/invoices/new/page.tsx` — RPC invoice numbering + submit fallback
- `src/app/dashboard/page.tsx` — revenue from invoices (net of VAT), alert fix
- `tests/exec15-financial-remediation.test.ts` — new (13 tests)
- `package.json` — register the new test in `test:core`

**Nothing was pushed, deployed, or applied to any database.**

---

## 9. Compliance with the mandatory rules

- No rebuild, no duplicate module/engine, no new posting path. ✔
- No inventory/warehouse functionality introduced. ✔
- No tenant/company/role trusted from a request body; no auth weakened. ✔
- No secret printed or committed. ✔
- No production deploy / migration / restart. ✔
- No test claimed without execution. ✔
