# SPEED ERP — Execution 67, Stage 2 & Stage 3 Implementation Report

Branch: `feat/final-hardening-round5`
Repository: https://github.com/mohammadaljallad079-rgb/speed
Continuation point at session start: `e0693a5` (confirmed against the remote)
Head at session end: `aeeddae`

---

## 1. Continuation point (verified, not assumed)

The remote branch was inspected before any change. `e0693a5` was the tip, the
working tree was clean, and `origin` carried no embedded token. The Stage 1 work
(Super Admin console, premium responsive UI, committed screenshots, Smart Forms
with Quick Create, database-backed Chart of Accounts selectors) was present and
was **not** recreated.

Administrator accounts were left untouched: no provisioning script was run and no
credential was rotated.

---

## 2. Commits delivered

| Commit | Subject |
|---|---|
| `1f61e22` | `feat(exec67/stage2): the BD 99 acceptance cycle now covers expenses and returns` |
| `c83cc89` | `fix(exec67/stage3): a supplier bill capitalised its VAT into the expense` |
| `4c8efb4` | `fix(exec67/stage3): a customer was written as a NULL-tenant orphan` |
| `aeeddae` | `fix(exec67/stage3): suppliers, expense accounts and the portal wrote orphans` |

GitHub compare: https://github.com/mohammadaljallad079-rgb/speed/compare/e0693a5...aeeddae

---

## 3. Stage 2 — financial posting integrity, ledger and the BD 99 scenario

### 3.1 What the acceptance scenario was missing

The BD 99 scenario proved a sale is issued, collected, and reconciles to the
ledger. It did **not** include an expense or a sales return — the two paths that,
before this execution, wrote a document with **no journal at all**. The scenario
could therefore pass while the ledger was missing every expense the company had
ever paid. That is a false green, so the scenario was extended.

The cycle now runs four real documents through the real services against one
ledger and then reconciles them through the same `buildTrialBalance` the reports
use:

```
issue    INV  100.000 + 10.000 VAT   Dr AR 110 / Cr Revenue 100 / Cr Output VAT 10
collect       110.000                Dr Cash 110 / Cr AR 110
expense  net  30.000 + 3.000 VAT     Dr Expense 30 + Dr Input VAT 3 / Cr Cash 33
return        20.000 + 2.000 VAT     Dr Revenue 20 + Dr Output VAT 2 / Cr AR 22
```

Asserted afterwards: AR `-22.000`, revenue `80` (net of the return), output VAT
`8`, input VAT `3`, cash `77`, expense `30`, trial balance balanced, and both a
retried expense and a retried return idempotent.

The scenario runs with account `41003` **deliberately absent** — it is seeded only
by migration 003, which is not applied live — so the return must fall back to
debiting revenue.

AR ending at `-22.000` is **correct accounting, not a defect**: the invoice was
collected in full, so the return has nothing left to offset and creates a refund
owed to the customer.

### 3.2 Two defects the scenario exposed and this execution fixed

1. **`resolveOptionalAccountIds` discarded the accounts that did resolve.** When
   one optional code was missing it caught the error and returned `{}`. With
   `41003` absent it threw away the output-VAT account too, so the return posted
   `Dr Revenue 22 / Cr AR 22` — **no VAT line** — instead of
   `Dr Revenue 20 + Dr Output VAT 2`. It now removes only the genuinely missing
   codes and retries; a cross-tenant or ambiguous row is still raised as an error.

2. **`POST /api/expenses` under-credited cash.** `expenses.amount` is stored
   **pre-VAT**, so the old `payload.total ?? payload.amount` fallback credited
   cash for the net amount whenever a caller omitted `total`. It now reconstructs
   the gross as `amount + vat_amount`.

### 3.3 Reports

General Ledger, Trial Balance, Profit & Loss, Balance Sheet and Cash Flow were
audited: all five read `journal_lines` through `applyReportScope`, which fails
closed (a `denied` scope filters to the nil UUID, never unfiltered), and all
exclude cancelled documents via `isCountableEntry`. No defect found; coverage is
in `tests/exec53-stage2-ledger-and-acceptance.test.ts` and
`tests/exec54-purchasing-integrity.test.ts` (cash-flow engine).

---

## 4. Stage 3 — purchasing, and tenant-owned master data

### 4.1 A supplier bill capitalised its VAT into the expense

`buildPurchaseJournal` debited the **whole VAT-inclusive total** to the expense
account and never split out input VAT, even though `POST /api/purchases` computes
`vat` from the line items and stores it on the bill. The recoverable VAT was
capitalised as cost: the VAT return could not claim it, and the expense was
overstated by the tax.

The builder now posts:

```
Dr expense    grandTotal - vat
Dr input VAT  vat
    Cr cash/bank  advancePayment
    Cr AP         remaining
```

and falls back to capitalising the whole amount when no `24001` account is
resolvable, so a chart without one still posts. `24001` is seeded by migration
010, which is **not** applied live, so the fallback is today's behaviour.

**Stage 3 acceptance** — a credit bill of `300 + 30 VAT`, paid in full, then a
`55.000` debit note, reconciled through `buildTrialBalance`:

| Account | Balance | Meaning |
|---|---|---|
| AP `21001` | `-55` | the supplier now owes the company |
| Cash `11001` | `-330` | the payment |
| Expense `51001` | `250` | net of VAT and the credit |
| Input VAT `24001` | `25` | the bill less the credit |

Ledger balanced. Both the VAT-splitting and the no-VAT-account fallback are
asserted.

### 4.2 Tenant-owned tables were still written from the browser

Every `from('<table>').insert|update|delete|upsert` in `src/app/**/*.tsx` was
mapped against migration 002's tenant/company ownership arrays. Three tenant-owned
tables were still written from the browser, all with the same two defects:

- the **create never set `tenant_id`** — a NULL-tenant orphan that no
  tenant-scoped query finds and the single-tenant install can read;
- the **update/delete was scoped by `id` alone** — any authenticated caller could
  reach another company's row.

| Table | Was | Now |
|---|---|---|
| `customers` | `/customers`, `/customers/new` inserted/updated/deleted in the browser | `POST /api/customers`, `PUT`/`DELETE /api/customers/[id]` |
| `suppliers` | `/suppliers` inserted/deleted in the browser even though a guarded route existed | `/api/suppliers` + new `/api/suppliers/[id]` |
| `expense_accounts` | both expense screens inserted inline | existing `/api/expense-accounts` |
| `customers` (portal) | `customer-dashboard` updated its own row with a browser write | `PUT /api/customer/profile` |

All new routes are `requireContext`-guarded, take the tenant from the session via
`assertWritableTenant`, filter the body through a column whitelist that cannot
carry `tenant_id`, and scope **both the lookup and the write** by tenant — a
foreign id is a `404`.

### 4.3 A referenced record is refused, not orphaned

`DELETE /api/customers/[id]` and `DELETE /api/suppliers/[id]` count the documents
that name the row — `invoices`/`rental_contracts`/`payments` and
`purchase_invoices`/`supplier_payments`/`debit_notes` respectively — and return
`409 has_dependents` instead of leaving those documents pointing at nothing. An
unreadable table counts as zero, so the guard never blocks a legitimate delete.

### 4.4 Purchasing reports

All nine purchasing report kinds (purchase register, supplier ledger, supplier
aging, expenses by vehicle/branch/category, VAT purchases, monthly expenses,
vehicle profitability) were audited: they are served by
`/api/reports/purchasing`, which is permission-gated and tenant-scoped on the
server before any date filter. No defect found; coverage is in
`tests/exec54-purchasing-integrity.test.ts`.

---

## 5. Verification

| Gate | Result |
|---|---|
| `npm test` | **1475 tests / 1469 pass / 0 fail / 6 skipped** |
| `npm run typecheck` | **0 errors** |
| `npm run lint` | **No ESLint warnings or errors** |
| `npm run build` | **green, 165/165 pages** |

Regression guards added so the defects cannot return:

- `FINANCIAL_TABLES` in `tests/exec67-tenant-scoped-writes.test.ts` now includes
  `customers`, `suppliers` and `expense_accounts`; a page that writes one
  directly fails the suite.
- The BD 99 cycle fails if the return loses its VAT line or if either retry posts
  a second journal.
- The purchasing cycle fails if a bill stops splitting out input VAT.

---

## 6. Super Admin — verified Stage 1 evidence

Stage 1 was re-verified, not rebuilt:

- every `/api/super-admin/*` route is guarded with
  `requireContext(request, { requireSuperAdmin: true })`; a company `admin` is
  rejected with `403`;
- **zero** browser-direct Supabase writes remain in the Super Admin console;
- 19 Super Admin captures are tracked in git at 1440×1000 (desktop) and
  390×900 (mobile), and a test rejects a blank or duplicated frame.

Committed screenshots (GitHub renders them inline):

| View | Desktop | Mobile |
|---|---|---|
| Login | [login-desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-login-desktop.png) | [login-mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-login-mobile.png) |
| Overview | [overview-desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-overview-desktop.png) | [overview-mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-overview-mobile.png) |
| Companies | [companies-desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-companies-desktop.png) | [companies-mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-companies-mobile.png) |
| Users | [users-desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-users-desktop.png) | [users-mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-users-mobile.png) |
| User roles | [user-roles-desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-user-roles-desktop.png) | [user-roles-mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-user-roles-mobile.png) |
| AI | [ai-desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-desktop.png) | [ai-mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-mobile.png) |
| AI agent | [ai-agent-desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-agent-desktop.png) | [ai-agent-mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-agent-mobile.png) |
| Subscriptions | [subscriptions-desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-subscriptions-desktop.png) | [subscriptions-mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-subscriptions-mobile.png) |
| Settings | [settings-desktop](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-settings-desktop.png) | [settings-mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-settings-mobile.png) |

Full gallery: https://github.com/mohammadaljallad079-rgb/speed/tree/feat/final-hardening-round5/docs/screenshots

---

## 7. Not claimed as complete

The following are **not** claimed, because they could not be verified from this
environment:

- **Migrations 001–010 are not applied to the live database.** Direct PostgreSQL
  access is blocked here, so DDL remains an operator step. Everything that depends
  on a migration-only account (`41003`, `24001`) is written to degrade gracefully,
  and the tests assert that degraded behaviour rather than the post-migration one.
- **No deployment was performed.** Production was not touched and no live
  financial data was modified.
- **`expenses.branch` remains free text** (no `branch_id` FK); no consumer exists,
  so it was left as-is by design.
- **Rentals pages** still write `rental_contracts`/`cars` from the browser. They
  are outside the Stage 2/3 scope (they issue their invoice through
  `/api/invoices`, which is the single posting path), but they are the next
  tenant-ownership candidates.

---

## 8. Next steps

1. Apply migrations 001→010 with the existing activation packages (operator step),
   running the 005 duplicate pre-check first.
2. Bring `rental_contracts` and `cars` onto guarded routes, the same way
   `customers`/`suppliers` were brought.
3. Continue the audit for tables that are tenant-owned but have **no** owning
   route yet (`attendance`, `quotations`, `purchase_orders`,
   `purchase_requisitions`, `financial_years`, `tax_settings`).
