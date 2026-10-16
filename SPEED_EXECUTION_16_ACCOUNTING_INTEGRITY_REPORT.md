# SPEED ERP — Execution 16: Accounting Integrity Remediation

**Scope:** resolve the accounting-integrity defects still open after Execution 15.
**Mode:** local only. No production deploy, no production data change, no migration applied to the live database.
**Date:** 2026-10-10
**Branch:** `feat/final-hardening-round5` (local commit; not pushed)
**Base commit inspected:** `29a005c` (== `origin/main`)

> The Exec 15 changes were still uncommitted when this execution started and are
> included in the same local commit. They are listed in section 2 for completeness.

---

## 1. Repository and commit inspected

- Repo: `https://github.com/mohammadaljallad079-rgb/speed` (the only authorised repo).
- Base commit: `29a005c` — "docs: Exec 13 first-hand harness reproduction + AGENTS hygiene invariants".
- Migrations present before this execution: `001_core_security`, `002_tenant_isolation_hardening`, `003_sales_lifecycle`, `004_global_super_admin` (+ rollbacks).
- No live database was reachable from the sandbox (`.env.local` absent; pooler/Direct DDL path remains blocked as documented in Exec 05.4/05.5). All work below is code + migration + local verification.

---

## 2. Confirmed status at the start of this execution

### Carried in uncommitted (Execution 15)

- 7 report pages bind date inputs to draft state and apply only on GO.
- `invoices/new` uses the row-locked `generate_document_number` RPC instead of `Date.now()`.
- `dashboard` derives revenue from `invoices` (excluding VAT/cancelled), not completed `payments`.
- `tests/exec15-financial-remediation.test.ts` (13 tests).

### Open at the start of Execution 16 (from the Exec 15 report + fresh audit)

| # | Defect | Evidence |
|---|--------|----------|
| 1 | Posted sales invoices could still be edited/deleted from the UI | `src/app/invoices/[id]/page.tsx` had no posting guard |
| 2 | Supplier payments updated the bill but posted **no** journal (GL/AP never moved) | `src/app/supplier-payments/page.tsx` |
| 3 | `Date.now()` document numbering in 4 purchase/posting pages | purchases/new, purchases/returns, purchase-orders, purchase-orders/requisitions |
| 4 | Four posting modules wrote journal **lines** to `journal_entry_lines`, which **no report reads** | bank-transfer, petty-cash, hr/payroll, rentals/[id]/refund-deposit |
| 5 | Those same four journal **headers** omitted `total_debit`/`total_credit`/`is_balanced` | same four files |
| 6 | No DB-level guard against a retried request double-posting a journal | no unique index on `(entry_type, reference_number)` |

---

## 3. Fixes applied (with evidence)

### 3.1 Posted-invoice guard — `src/lib/accounting/invoice-guards.ts` (new)

`isSaleInvoicePosted()` / `findPostedSaleJournal()` answer one question: does a
`journal_entries` row with `entry_type = 'sale_invoice'` and
`reference_number = <invoice_number>` exist? `src/app/invoices/[id]/page.tsx` now:

- resolves posted state on load,
- blocks `handleSubmit` and `handleDelete` when posted,
- disables the Save and Delete buttons,
- shows an explanatory banner pointing to credit-note/return reversal.

This closes defect #1 without introducing a second posting path.

### 3.2 Supplier-payment GL posting — `src/lib/accounting/payment-posting.ts` (new)

- `buildSupplierPaymentJournal()` (pure) produces **Dr Accounts Payable (21001) / Cr Cash (11001) or Bank (11002)** for the amount; returns `null` for a non-positive amount.
- `postSupplierPayment()` resolves the two accounts by code, writes one header + two lines to `journal_lines`, and deletes the orphan header if the line write fails.
- `src/app/supplier-payments/page.tsx` now:
  - takes its number from `nextDocumentNumber(..., "supplier_payment")` (was `SP-${Date.now()}`),
  - posts the journal,
  - reads the bill's **current** `paid_amount` from the DB before incrementing (was reading a possibly-stale list value),
  - compensates (deletes the payment row) if posting fails,
  - on delete, removes the payment's journal (lines then header) and restores the bill balance.

A supplier payment reduces AP and cash — it never touches revenue.

### 3.3 One document-number mechanism

Replaced `Date.now()`-based numbers with `nextDocumentNumber` in:

| File | Was | Now |
|------|-----|-----|
| `purchases/new` (advance receipt) | `PAY-${Date.now()}` | `receipt` |
| `purchases/returns` (debit note) | `DN-${Date.now()}` | `debit_note` |
| `purchase-orders` (PO→invoice) | `INV-${Date.now()}` | `purchase_invoice` |
| `purchase-orders/requisitions` (req→PO) | `PO-${Date.now()}` | `purchase_order` |
| `accounting/bank-transfer` | `BT-${Date.now()}` | `bank_transfer` |
| `hr/payroll` | `PAY-${Date.now()}` | `payroll` |
| `accounting/petty-cash` | `PC-${Date.now()}` | `petty_cash` |
| `rentals/[id]/refund-deposit` | `DEP-REF-${Date.now()}` | `deposit_refund` |

`nextDocumentNumber` falls back to the **same** timestamp value the old code used
when the RPC/sequence is unavailable, so behaviour before migration 003 is
unchanged and behaviour after it becomes sequential and retry-safe.

### 3.4 One canonical journal-line table

`journal_lines` is the canonical table: it is what all four financial reports
(profit-loss, balance-sheet, trial-balance, cash-flow), the sales engine, the
manual journal editor and the supplier-payment posting all read/write.
`journal_entry_lines` had **zero readers**. The four modules that wrote lines to
it now write to `journal_lines`:

- `accounting/bank-transfer`
- `accounting/petty-cash` (both branches)
- `hr/payroll`
- `rentals/[id]/refund-deposit`

Their headers now also carry `total_debit`, `total_credit` and `is_balanced`
(defect #5), so they are complete and visible in every report and in the
integrity view added by migration 005.

### 3.5 Ledger integrity detection — `src/lib/accounting/integrity.ts` (new)

Pure, read-only functions (no DB, no writes): duplicate posted journals, orphaned
lines, unbalanced headers, unbalanced line groups, stale invoice balances, plus a
combined `scanIntegrity()`. Usable in a report banner or a test; nothing
destructive.

### 3.6 Migration 005 — `supabase/migrations/005_accounting_integrity.sql` (new)

Additive, forward-only, idempotent, guarded:

1. `journal_entries_type_ref_idx` — non-unique lookup index.
2. `journal_entries_one_posted_per_doc_uidx` — **partial unique index** on
   `(entry_type, reference_number)` where `status = 'posted'` and
   `entry_type in ('sale_invoice','supplier_payment')`. This is the DB half of the
   retry/double-post guard. It is deliberately scoped to the two single-event
   document types; a manual journal may legitimately reuse a reference.
3. `v_journal_integrity_issues` — read-only view surfacing duplicate posted
   journals and unbalanced headers.

Rollback: `005_accounting_integrity_rollback.sql` (drops exactly those three
objects; drops no column, deletes no row).

---

## 4. Verification performed

### 4.1 Migration 005 executed on a real PostgreSQL 17 (local, disposable)

- Installed PostgreSQL 17.11 locally and created a throwaway database mirroring
  the journal shape (`journal_entries`, `journal_lines`).
- Apply → `COMMIT`, 0 errors.
- Re-apply → 0 errors (idempotent).
- Behavioural proof:
  - 1st posted `sale_invoice` journal for `SI-1` → inserted.
  - 2nd posted `sale_invoice` journal for `SI-1` → **blocked** by
    `journal_entries_one_posted_per_doc_uidx`.
  - Same reference as `draft` → allowed (index is scoped to `posted`).
  - Manual `journal_entry` with a repeated reference → allowed (out of scope).
  - Unbalanced header → surfaced by `v_journal_integrity_issues`.
- Rollback → objects removed; re-apply → duplicate blocked again.
- Guarded no-op: applied to a database with **no** `journal_entries` table → 0
  errors, creates nothing.
- All throwaway databases were dropped afterwards.

### 4.2 Test suite, typecheck, lint, build

| Gate | Result |
|------|--------|
| `npm test` | **351 tests, 345 pass, 0 fail, 6 skipped** (79 suites) |
| `npm run test:core` / `test:excel` | included in the above |
| `npm run typecheck` | **129 errors** — identical to the documented baseline; no new error |
| `npm run lint` | **clean** (no warnings or errors) |
| `npm run build` | **131/131 pages**, compiled successfully (placeholder env) |

New tests: `tests/exec16-accounting-integrity.test.ts` (28 tests) — guards,
payment posting (pure + injectable stub), integrity detection, canonical-table
regression, numbering regression, and migration-structure assertions.

A pre-existing Exec 15 test used a regex with the `s` (dotAll) flag, which
`tsconfig` (target ES2017) rejects as `TS1501`. The flag was unused; removing it
restored the typecheck baseline to exactly 129.

---

## 5. Security & repository hygiene

- `git ls-files` shows **no** tracked `.env` files; `.gitignore` excludes `.env`,
  `.env.*`, `.admin-credentials.local`.
- No JWT-like literals, no hardcoded service-role/anon keys in tracked files.
- No generated password was written to any file, log, or commit.
- Service-role usage stays server-side (`src/lib/supabase-admin.ts`); RLS is not
  disabled or weakened anywhere.
- 47 tracked `.bak`/`.backup` files remain (audit noise, no secrets). Deferred to
  a dedicated hygiene task; not deleted here to keep this diff reviewable.

---

## 6. Migrations applied vs prepared

| Migration | State |
|-----------|-------|
| 001, 002, 003, 004 | **Not applied to live** (unchanged; DDL path still blocked) |
| 005_accounting_integrity | **Prepared, verified locally, NOT applied to live** |

**Blocker (unchanged from Exec 05.4/05.5):** no reachable DDL path from this
environment — the direct host is IPv6-only, the pooler credentials are rejected,
and there is no `exec_sql` RPC. Applying 005 requires the operator to supply the
current pooler connection string (or DB password) as `DATABASE_URL`, then run
`005_accounting_integrity.sql`. Until then the unique index does not exist on
live, so the DB-level retry guard is inactive — the application-side guards
(3.1–3.2) and single-number mechanism (3.3) are active regardless.

---

## 7. Explicitly out of scope / deferred (documented, not silently changed)

These were identified during the audit and deliberately left, because changing
them without a live database and dedicated review would risk real accounting
behaviour:

1. **Financial reports fail open when `tenant_id` is null.** `profit-loss`,
   `balance-sheet`, `trial-balance`, `cash-flow` filter by `company_id` and skip
   the filter when null. Live is single-tenant, so it is latent, not exploited.
   Fixing it needs a tenant-aware report context; deferred to a security task.
2. **`update_account_balance` RPC has no definition in the repo and an
   inconsistent sign convention** (receivables decremented, payables/petty-cash
   incremented). No `create function` exists in any migration, so its real
   semantics cannot be verified here. Reported, not changed.
3. **Statement-recompute vs incremental balance.** Because of (2), `accounts.balance`
   may diverge from the ledger over time. A future task should recompute balances
   from `journal_lines` rather than trusting incremental RPCs.
4. **Duplicate core RPCs across migrations** (`current_tenant_id` etc. redefined in
   several files). Idempotent, no behavioural conflict, but should be consolidated
   in one authoritative migration.

---

## 8. Business constraint respected

SPEED ERP has **no inventory/warehouse** module. No stock table, warehouse
screen, or purchase-to-stock workflow was added. Purchases and expenses continue
to flow into accounting/cost/profit reporting exactly as before.

---

## 9. Next action

1. Operator applies `supabase/migrations/005_accounting_integrity.sql` after
   001→002→003 (004 optional) and re-runs the VERIFICATION block at the file
   footer.
2. Re-run the three acceptance checks in section 4.1 against live.
3. Optionally fold the section-7 items into the next security/accounting task.

No production change was made in this execution.
