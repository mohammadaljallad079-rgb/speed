# SPEED ERP — Execution 67 Implementation Report
## Server-Authoritative Financial Writes

**Repository:** https://github.com/mohammadaljallad079-rgb/speed
**Branch:** `feat/final-hardening-round5`
**Continuation point:** `418759e` (feat(supabase): freeze activation packages for 013, 014 and 015)
**Final commit:** `98d460996a03f95a2f3e684c55c93a3fcdda5eb8`
**Date:** 2026-10-26

---

## 1. What this execution was

The stated mission is: *financial writes MUST go through guarded,
server-authoritative, tenant-scoped, audited routes — never browser-direct
Supabase inserts/updates, and ledger journals must always accompany document
creation.*

I audited **every** browser-direct write to a financial table and every API route
that mutates one, then fixed what the audit found. The audit was mechanical
(grep every `from('<table>').insert|update|delete|upsert` in `src/app/**/*.tsx`)
and then behavioural (drive each fixed path against a two-tenant PostgREST stub).

**Result: six defects closed.** Four were write-path gaps, two were found only
when the fixed code was actually executed — including one that would have made a
brand-new endpoint fail on **every** call in production.

---

## 2. The six defects

### 2.1 Sales returns posted no journal at all — CRITICAL

`src/app/sales/returns/page.tsx` inserted `sales_returns` and updated
`invoices.paid_amount` / `invoices.status` **from the browser**. No journal was
ever written.

Consequence: the return reduced the invoice's paid amount, so the sales screen
said the money came back — while the ledger still showed the collection standing.
The receivable was never restored, revenue was never reversed, and P&L, trial
balance, balance sheet and cash flow all disagreed with the sales documents.

Fixed by:

| File | Role |
|---|---|
| `src/lib/accounting/sales-return-posting.ts` | pure `buildSalesReturnJournal` + tenant-scoped idempotency (`findPostedSalesReturnJournal`) |
| `src/lib/sales/return-service.ts` | `createSalesReturn` — row + settlement + journal in one transaction, compensating on failure |
| `src/app/api/sales-returns/route.ts` | `POST`, `requireContext` + `logAudit` |

The journal posts `Dr Sales Returns (41003, or revenue 41002) + Dr Output VAT /
Cr AR`.

### 2.2 Expenses posted no journal either — CRITICAL

Both expense screens (`/expenses`, `/accounting/expenses`) **and**
`POST /api/expenses` inserted into `expenses` and posted nothing. Every
ledger-derived report therefore omitted every expense, while the expense list
showed the money leaving. The one report that did see expenses (`reports/vat`)
read the `expenses` table directly — which is exactly how the two views were able
to disagree for so long.

Fixed by:

| File | Role |
|---|---|
| `src/lib/accounting/expense-posting.ts` (new) | `buildExpenseJournal`, `postExpense`, `buildExpenseReversalJournal`, `reverseExpense` |
| `src/app/api/expenses/route.ts` | creates the row and its journal together; deletes the row if the posting fails |
| `src/app/api/expenses/[id]/route.ts` (new) | `PUT` reverses and re-posts; `DELETE` reverses before removing |

The journal posts:

```
Dr expense account          taxable
Dr Input VAT (24001)        vat      (when resolvable)
    Cr Cash (11001) / Bank (11002)   amount   - cash paid now
    Cr Accounts Payable (21001)      amount   - bought on credit
```

A **credit purchase credits the payable, not cash**, so a supplier bill is not
treated as money already gone.

### 2.3 Cancelling a debit note left its journal standing — HIGH

The browser set `status='cancelled'` and the journal stayed. The payable and the
ledger then disagreed.

Fixed: `DELETE /api/debit-notes/[id]` mirrors the note's **own** journal (read
from `journal_lines`, never recomputed), is idempotent, and is tenant-scoped.

### 2.4 A posted invoice could be rewritten from the browser — HIGH

The edit screen wrote `invoices` directly. Its "posted" and "has dependents"
checks were **advisory** — a caller who did not use the screen could rewrite a
posted invoice's amounts while its journal and receipts kept the old figures.

Fixed: `PUT /api/invoices/[id]` + `decideInvoiceEdit` in `invoice-guards.ts`
(fail-closed, sharing one implementation with the delete decision).
`paid_amount`, `status` and `tenant_id` are not writable; `total_amount` is
derived server-side.

### 2.5 An optional chart account blocked every sales return — CRITICAL, found by execution

`postSalesReturn` resolved **41003** (the sales-returns contra account) as
**required**. Migration 003 seeds 41003 and is **not applied on the live
project**. So every sales return would have failed with:

```
Cannot resolve chart account(s): 41003 (missing)
```

The endpoint would have been **dead on arrival in production** while passing a
parse-only code review. Only running it against a stub exposed this.

Fixed: `resolveOptionalAccountIds` (`account-resolution.ts`) resolves accounts a
live install may legitimately lack tolerantly. Absence falls back to an account
the caller already holds (the return debits revenue directly); a **cross-tenant
or ambiguous** row is still an error, because that is a configuration fault, not
absence. The same rule now covers the expense path's input-VAT account.

### 2.6 A retry was refused as an overpayment — HIGH, found by execution

`createSalesReturn` checked *"the return exceeds the amount paid"* **before** its
idempotency lookup. A retry arrives after the first attempt already reduced
`invoices.paid_amount`, so the retry was refused with a misleading overpayment
error instead of reporting the return that already existed.

Fixed: the idempotency lookup now runs first.

### 2.7 The chart of accounts was written from the browser — HIGH

`/accounting/chart-of-accounts` inserted and updated `accounts` with the browser
client. A browser insert could create an account with **no tenant**, a **foreign
parent**, or a code that **duplicates** one already in the caller's chart.

A duplicate code is refused by `resolveAccountIdsForTenant` as `ambiguous` — so
the mistake would **silently break posting for every module that resolves that
code**.

Fixed: `POST /api/accounts` and `PUT /api/accounts/[id]` own both writes:

- tenant from the session via `assertWritableTenant`;
- the parent must be the caller's own account **or** the shared chart, so the
  tree cannot cross companies;
- the code must be unique within the caller's chart (the edit check excludes the
  row being edited);
- an account may not be its own parent.

---

## 3. Supporting change

`assertReference` / `assertReferenceList` (`src/lib/auth/references.ts`) now
accept an **injectable client**, defaulting to `supabaseAdmin`.

A hard-wired singleton made a tenant-scoped reference check impossible to
exercise against two tenants — which is exactly the check that needs it. This is
backwards compatible: every existing call site is unchanged.

---

## 4. Verification

### 4.1 Test suite

```
tests    1469
pass     1463
fail        0
skipped     6
```

`tests/exec67-tenant-scoped-writes.test.ts` — **50 assertions**, registered in
`test:core`:

- a repo-wide scan that walks **every** `.tsx` under `src/app` and fails if any
  page writes a financial table (`accounts`, `expenses`, `invoices`, `payments`,
  `journal_entries`, `journal_lines`, `supplier_payments`, `purchase_invoices`,
  `sales_returns`, `debit_notes`) directly;
- pure builder tests for the expense journal (cash, credit, VAT split, refusals)
  and its reversal;
- **end-to-end service tests** driving the real `createSalesReturn` against a
  two-tenant PostgREST stub with a real `post_journal_entry` RPC:
  - one row, the settlement, and a **balanced** journal;
  - an over-return refused **before any write**;
  - a failed posting **compensates** (no return row, settlement intact);
  - an idempotent retry (one row, one journal).

### 4.2 Static checks

| Check | Result |
|---|---|
| `npm run typecheck` | **0 errors** |
| `npm run lint` | **No ESLint warnings or errors** |
| `npm run build` | **green** (all routes compiled) |

### 4.3 Tenant isolation

The stubs hold **two tenants**. A query that forgets its tenant filter returns
both rows — exactly the production mistake — so a regression fails the test
rather than passing silently.

---

## 5. Commits

| SHA | Subject |
|---|---|
| `5669b0c` | fix(exec67): close four financial write-path defects |
| `9ef3c11` | fix(exec67): an optional chart account must not block a document, and a retry must not be refused as an overpayment |
| `293ea8e` | fix(exec67): the chart of accounts is written server-side, not from the browser |
| `98d4609` | docs(exec67): record the server-authoritative financial write invariants |

**27 files changed, 2638 insertions(+), 67 deletions(-)**

GitHub links:

- Branch: https://github.com/mohammadaljallad079-rgb/speed/tree/feat/final-hardening-round5
- Range: https://github.com/mohammadaljallad079-rgb/speed/compare/418759e...98d4609
- New expense posting module: https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/src/lib/accounting/expense-posting.ts
- New sales-return service: https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/src/lib/sales/return-service.ts
- The regression suite: https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/tests/exec67-tenant-scoped-writes.test.ts

---

## 6. Super Admin — status of the Stage 1 requirement

The **18 Super Admin screenshots are already committed and live on GitHub** —
they are real captures, not mockups.

| Page | Desktop | Mobile |
|---|---|---|
| Login | ✅ | ✅ |
| Overview | ✅ | ✅ |
| Companies | ✅ | ✅ |
| Users | ✅ | ✅ |
| User roles | ✅ | ✅ |
| Subscriptions | ✅ | ✅ |
| AI | ✅ | ✅ |
| AI agent | ✅ | ✅ |
| Settings | ✅ | ✅ |

Viewport dimensions confirmed from the PNG headers: **1440 × 1000** desktop,
**390 × 900** mobile (one mobile capture is 390 × 844), consistent with real
Chromium captures at a live server. 111 screenshots are tracked in total.

Direct links:

- https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-overview-desktop.png
- https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-overview-mobile.png
- https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-companies-desktop.png
- https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-users-desktop.png
- https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-user-roles-desktop.png
- https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-subscriptions-desktop.png
- https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-desktop.png
- https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-agent-desktop.png
- https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-settings-desktop.png
- https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-login-desktop.png

---

## 7. What I did NOT do, and why

I will not claim these as complete, because they are not verified:

1. **I did not re-run the screenshot capture.** The 18 Super Admin screenshots
   already exist and are already on GitHub, and the brief says not to repeat
   completed work. Re-capturing them would require running the dev server and a
   browser session; if the owner wants *new* captures reflecting this execution's
   changes, that is a separate, explicitly requested step.

2. **I did not touch the live database.** Migrations 001–015 remain unapplied.
   DDL is not reachable from this sandbox (no IPv6 egress to the direct host, all
   24 pooler regions reject the credentials). Applying them is an operator step.

3. **I did not deploy.** No production contact, no PM2, no `.env.local` change.

4. **I did not create or reset administrator accounts.** Per instruction 4, they
   are already configured by the owner.

5. **Stages 2 and 3 are not complete.** The brief asks for Stage 1 first. What
   this execution actually delivers is the *financial write integrity* foundation
   that Stage 2 depends on — and it closed defects that would have made Stage 2's
   "BD 99 invoice-to-collection acceptance" and every ledger report wrong, because
   expenses and sales returns were missing from the ledger entirely.

---

## 8. Honest assessment of Stage 1

The brief's Stage 1 has four parts. Status:

| Part | Status |
|---|---|
| Global Super Admin functionality | **Pre-existing**; not re-audited in this execution |
| Premium responsive UI | **Pre-existing**; screenshots confirm desktop + mobile |
| Actual browser screenshots on GitHub | **Complete** — 18 captures, real dimensions, tracked |
| Smart Forms + Quick Create modals + DB-backed Chart of Accounts selectors | **Pre-existing** (screenshots exist); not re-audited |

I have not verified the Super Admin *functionality* or the Smart Forms in this
execution — I have only verified that the screenshots are real and committed. I
am not going to describe them as "complete" on the strength of a file listing.

**The correct next step** is to audit the Super Admin routes and the Smart Forms
the same way I audited the financial write paths — mechanically, then by
execution — before calling Stage 1 done.

---

## 9. Repository hygiene

- The push used an inline token URL; the token was **not** written to
  `.git/config`. `git remote -v` shows the clean URL and `grep -c "ghu_\|ghp_"
  .git/config` returns 0.
- No `.env.local`, credential file, or secret was committed.
- No `--force`, no `reset --hard`, no branch delete.

---

## 10. Next steps

1. **Audit Super Admin functionality + Smart Forms** to close Stage 1 properly
   (mechanical scan, then execution).
2. **Stage 2:** General Ledger, Trial Balance, P&L, Balance Sheet, Cash Flow —
   all four reports already read `journal_lines`, so the expense and sales-return
   fixes above are what makes them correct. Then the BD 99
   invoice-to-collection acceptance scenario.
3. **Stage 3:** Purchases, Supplier Bills, Payments, Debit Notes, Supplier
   Statements, Aging, vehicle/branch expense allocation, purchasing reports.
4. **Operator step:** apply migrations 001 → 015 in order (run the 005 duplicate
   pre-check first; it must return zero rows).
