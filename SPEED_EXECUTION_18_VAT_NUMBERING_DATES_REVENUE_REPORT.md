# Execution 18 — VAT Report, Sales Numbering, Date Filters & Dashboard Revenue

**Repository:** `https://github.com/mohammadaljallad079-rgb/speed`
**Branch:** `feat/final-hardening-round5`
**Base commit inspected:** `b4eb309` (Exec 17) — parent `722967f` (Exec 16), `origin/main` at `29a005c` (Exec 13)
**Scope:** the four items the owner listed for Execution 18. No rebuild, no new
engine, no inventory/stock.
**Environment:** sandbox has **no live Supabase access** (`DATABASE_URL` and the
project keys are not present in `.env.local`), so every claim below is either a
local execution result or is explicitly marked NOT VERIFIED against live data.

---

## 1. Pre-work audit

- Working tree was clean at `b4eb309`; `origin/main` is `29a005c`.
- The changes Exec 15 claimed for Items 1/2/3/8 (VAT cancelled filter, invoice
  numbering via the RPC, GO buttons on 7 report pages, revenue from invoices) **are
  present in this snapshot**. Exec 18 is a deeper follow-up, not a re-do.
- Files relevant to the four items: `src/app/reports/vat/page.tsx`,
  `src/lib/reporting/vat.ts`, `src/lib/numbering.ts`, the document-creation pages,
  `src/app/dashboard/page.tsx`, and the date-filter pages.

---

## 2. Item 1 — VAT Report: format & data source

### Findings

1. The report **format** was already correct (output VAT, input VAT, net,
   monthly breakdown, print, Excel). Two real defects remained:
   - It showed **only VAT totals**, never the **taxable base** — an Arabic VAT
     return needs both, per source.
   - The VAT **data source** (`invoices`, `expenses`, `purchase_invoices`) was
     read correctly, but the taxable base could not be shown because the
     `total_amount` columns were not even fetched.
2. The stored amounts are **not uniform**, which is why a naive
   `total_amount`-as-base would be wrong:
   - `invoices.total_amount` and `purchase_invoices.total_amount` are
     **VAT-inclusive** (`total = net + vat`; verified in `sales/new` and
     `purchases/new` inserts).
   - `expenses.amount` is stored **pre-VAT** (`total = amount + vat_amount`;
     verified in `accounting/expenses` and `expenses`).
3. The AI reporting engine (`src/lib/reporting/data.ts`) already computes the
   base correctly per source (`subtotal || total - vat` for invoices/purchases;
   `amount` for expenses). The screen had no equivalent.

### Change

- Added a **pure** aggregator `summarizeVatSources` to `src/lib/reporting/vat.ts`
  (same module as the existing `buildVatResult`, so no second VAT engine). It owns
  the per-source base rules above, excludes cancelled documents, totals output /
  input / net, and produces the sorted monthly rows.
- `src/app/reports/vat/page.tsx` now fetches the base columns
  (`total_amount` for invoices/purchases, `amount` for expenses) and delegates all
  aggregation to `summarizeVatSources`; it renders a new **Source Breakdown** card
  (taxable base vs VAT per source) above the monthly card.
- No tax treatment is invented: the recorded `vat_amount` is reported as-is (the
  schema has no recoverability/exempt flag).

### Status: **DONE (locally verified)** — GL reconciliation remains NOT VERIFIED
The report is now format-complete and source-correct against the schema. A true
reconciliation to the GL control accounts (`24000` output VAT / input VAT) and to
real credit-note/return rows **cannot be executed here** (no DB). Marked below.

---

## 3. Item 2 — Sales serial numbers

### Findings

1. The sales number mechanism is the row-locked `generate_document_number` RPC,
   called with `p_doc_type = "sale_invoice"`. `generate_document_number` is a
   **live-only** function: it is not defined anywhere in the repository, and no
   `document_sequences` seed for `sale_invoice` exists in any migration. Migration
   `003` / the activation package seed only **`receipt`** and **`sales_return`**.
2. Two real gaps were found in the client:
   - `sales/new` inserted `invoice_number: form.invoice_number` directly. If the
     **mount-time** RPC failed or had not resolved, the invoice could be saved with
     an **empty number** (the journal reference would then also be empty).
   - `src/lib/numbering.ts`'s fallback used `Date.now().slice(-8)`; two calls in
     the **same millisecond** produced the identical value (collision on retry).

### Change

- `sales/new`: the number is now allocated at submit time
  (`form.invoice_number || await nextDocumentNumber(supabase, "sale_invoice", "SI")`)
  and that single value is used for **both** the invoice row and the `sale_invoice`
  journal `reference_number`, so the invoice and its posted journal can never
  disagree.
- `src/lib/numbering.ts`: the fallback is now **monotonic within the process**
  (strictly increasing, zero-padded), so same-millisecond retries cannot collide.
- Regression tests assert the submit-time allocation, the shared reference, and
  the collision-safety of the fallback.

### "Last two affected operations" — investigation result

The reported symptom (the last two operations did not take a proper serial) is
**consistent with the empty-number path in `sales/new`** (gap 2a above), which is
now closed. Two other causes **cannot be excluded** without live data and are
**NOT VERIFIED**:

- Whether the `sale_invoice` sequence row actually exists in the live
  `document_sequences` (if it does not, **every** sale falls back to a local
  `SI-########` value, which is non-sequential by design).
- The **last two rows** in the live `invoices` / `document_sequences` (their
  `invoice_number` shape) — requires a DB read this environment does not have.

### Status: **PARTIAL** — code defect fixed & unit-tested; live sequence state and
the two historical rows are **NOT VERIFIED** (blocked on DB access, see §8).

---

## 4. Item 3 — Date filters require an explicit GO

### Findings

The Exec 15 fix covered the 7 report pages. A fresh scan of **every** page that
uses a date value to filter data found **5 more** genuine auto-search filters that
re-filtered on every keystroke (the date input was bound directly to the applied
filter):

| Page | Was | Now |
|------|-----|-----|
| `accounting/journal-entries` | direct `dateFrom`/`dateTo` binding | `*Draft` + GO |
| `hr/attendance` | direct binding | `*Draft` + GO |
| `sales/returns` | direct binding | `*Draft` + GO |
| `accounting/expenses` | direct `filterDateFrom`/`filterDateTo` | `*Draft` + GO |
| `expenses` | direct binding | `*Draft` + GO |

Pages already correct (draft + apply button) and re-verified: `reports/vat`,
`reports/profit-loss`, `reports/cash-flow`, `reports/balance-sheet`,
`reports/trial-balance`, `reports/analysis`, `reports/car-history`, `payments`,
`invoices`, `purchases`, `rentals/invoices`.

Deliberately **not** changed (not search filters):

- `customer-dashboard` — the date range is a **booking form** (creates a
  contract), not a search filter.
- `hr/payroll` — the date is the **payroll period** being processed; the inputs
  are computed values, not a filter.

### Status: **DONE (locally verified)** — enforced by
`tests/exec18-vat-numbering-dates-revenue.test.ts` (16 page assertions).

---

## 5. Item 4 — Dashboard revenue

### Findings

- Exec 15 already made the dashboard read revenue from invoices net of VAT and
  stop summing receipts. Two gaps remained:
  1. **Sales returns were ignored** — a returned sale still counted as revenue,
     so the dashboard did not reconcile with the sales documents.
  2. The figure was **not reconcilable in the UI** — the user could not see the
     gross/VAT/net/returns relationship.

### Change

- New pure module `src/lib/reporting/revenue.ts` (`summarizeRevenue`,
  `invoiceNetRevenue`) is the single revenue definition: recognised at issue, net
  of VAT (`gross - vat`), receipts excluded, sales returns as contra-revenue, with
  a safe fallback to `amount` when `total_amount` is missing (never negative).
- `src/app/dashboard/page.tsx` uses it, now also reads `sales_returns`, and shows
  a **reconciliation strip**: invoices gross (incl. VAT), VAT, net revenue,
  returns, net after returns. The monthly earnings chart now also excludes
  cancelled invoices.

### Status: **DONE (locally verified)**. The stated invariant "revenue reconciles
with the actual sales" holds at the document level. Reconciliation to the GL
(41001/41002/41003) is **NOT VERIFIED** (no DB).

---

## 6. Tests, typecheck, lint, build

| Gate | Command | Result |
|------|---------|--------|
| Tests | `npm test` | **427 tests, 421 pass, 0 fail, 6 skipped** (+30 new, 0 regressions) |
| New suite | `tests/exec18-vat-numbering-dates-revenue.test.ts` | 30 pass |
| Typecheck | `npm run typecheck` | **129 errors** — identical to the documented baseline |
| Lint | `npm run lint` | **clean** (no warnings or errors) |
| Build | `npm run build` | **exit 0**, all pages compiled (placeholder env; none in sandbox) |

Baseline note: the 129 typecheck errors are pre-existing legacy-ERP errors (e.g.
`customer-dashboard`, `journal-entries` at other lines). No new error was
introduced in any touched file.

One pre-existing Exec 15 assertion (`revenue:\s*invoices\.reduce`) pinned the old
inline implementation; it was updated to accept the shared reconciler
(`revenueSummary.net`) while still requiring invoice-derived, VAT-excluded
revenue. The invariant is unchanged; only the implementation detail moved.

---

## 7. Security / repository hygiene

- No tracked `.env*`, secret, or credential file (`git ls-files`).
- `git grep` for `service_role`, PEM private keys, `sk-…` and JWT shapes returned
  nothing in tracked source (outside the known fake test fixture).
- The temporary placeholder `.env.local` used for the build was **deleted**; the
  workspace is back to only the intended source changes.
- No credentials, tokens, or passwords were written to any file or printed.

---

## 8. Blockers and exact permissions needed

1. **Live database access is absent from this environment.** `DATABASE_URL` and
   the Supabase keys are not present, and `db.<ref>.supabase.co` is IPv6-only with
   no egress here (documented in Exec 05.4). Consequences:
   - The live **`document_sequences`** rows (`sale_invoice` in particular) and the
     **last two `invoices` rows** could not be inspected → Item 2's "last two
     operations" and the sequence-existence question are **NOT VERIFIED**.
   - The VAT report's **GL reconciliation** is **NOT VERIFIED**.
   - The dashboard revenue could not be compared against **live** invoice data.
2. **To close Item 2 and the VAT/GL reconciliation**, an operator needs to run,
   read-only, against the live project (`chlkmdobhvfnldqkgdji`):

   ```sql
   -- sales serial state
   select doc_type, prefix, last_number, use_year from public.document_sequences
    where doc_type in ('sale_invoice','receipt','sales_return','journal_entry');
   select invoice_number, invoice_type, invoice_date, status, total_amount, vat_amount
     from public.invoices order by created_at desc limit 5;
   -- VAT control totals (GL)
   select a.code, sum(jl.credit - jl.debit) as balance
     from public.journal_lines jl join public.accounts a on a.id = jl.account_id
    where a.code in ('24000') group by a.code;
   ```

   If `sale_invoice` is missing from `document_sequences`, seeding it (same shape
   as the `receipt`/`sales_return` seeds in migration `003`) is the remaining fix;
   that requires DDL/insert rights, which this environment does not have.

No production security change was made, and none is claimed. The tenant-isolation
work (Exec 17) is unchanged by this execution.

---

## 9. Summary

| # | Item | Status |
|---|------|--------|
| 1 | VAT report format & data source | DONE (local); GL reconciliation NOT VERIFIED |
| 2 | Sales serial numbers | PARTIAL — code defect fixed & tested; live sequence/rows NOT VERIFIED |
| 3 | Date filters GO button | DONE (local, all pages) |
| 4 | Dashboard revenue | DONE (local); GL reconciliation NOT VERIFIED |

All local gates pass (427 tests / 0 fail, typecheck at baseline 129, lint clean,
build exit 0). Nothing was deployed; production state is unchanged.
