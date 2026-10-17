# SPEED ERP — Execution 19 Report
## Read-Only Production Reconciliation Preparation

**Status:** complete, local only. No connection to production, no query run on
production, no migration applied, no push, no deploy.
**Repository:** `https://github.com/mohammadaljallad079-rgb/speed`
**Branch:** `feat/final-hardening-round5`
**HEAD at start of Execution 19:** `35f4a06` (Exec 18) — verified, not assumed.

---

## 1. Git state and files inspected / changed

### 1.1 Git state (verified)

| Item | Value |
|---|---|
| Branch | `feat/final-hardening-round5` |
| HEAD | `35f4a06` — "fix(exec18): VAT taxable base + source breakdown …" |
| Parent chain | `35f4a06` → `b4eb309` (Exec 17) → `722967f` (Exec 16) |
| `origin/main` | `29a005c` (Exec 13) |
| Working tree at start | **clean** (no uncommitted work) |
| Shallow clone | yes |

`35f4a06` **was** the current HEAD, confirming Execution 18's local commit was not
lost. No prior fix was re-implemented.

### 1.2 Files read

- `AGENTS.md` (835 lines) — repo invariants, including Exec 05.5 / Exec 17 / Exec 18.
- `SPEED_EXECUTION_17_TENANT_FAILCLOSED_LEDGER_REPORT.md`
- `SPEED_EXECUTION_18_VAT_NUMBERING_DATES_REVENUE_REPORT.md`
- `supabase/ACCOUNT_BALANCE_VERIFICATION.sql`
- `supabase/ANON_VERIFICATION.sql`
- `supabase/RLS_COVERAGE_REPORT.sql`
- `supabase/migrations/001…005`, `supabase/tests/isolation_harness/base_schema.sql`
- Application sources that write the columns the queries read: `sales/new`,
  `invoices/new`, `rentals/new`, `sales/returns`, `payments/new`,
  `reports/vat/page.tsx`, `src/lib/accounting/*`.

### 1.3 Files created (uncommitted)

- `supabase/EXEC19_READONLY_RECONCILIATION.sql` — the safe read-only query pack.
- `tests/exec19-readonly-reconciliation.test.ts` — read-only guard (7 tests).
- `package.json` — the guard added to `test:core`.
- This report.

No production data, file or record was modified. No credential was read, printed
or written.

---

## 2. Queries confirmed read-only (Phase 2 audit)

| File | Claim | Audit verdict |
|---|---|---|
| `supabase/ACCOUNT_BALANCE_VERIFICATION.sql` | "READ-ONLY" | **Confirmed read-only.** Only `select` / `with … select` over `pg_proc` and `journal_lines`/`accounts`. The suggested fix is commented out. |
| `supabase/RLS_COVERAGE_REPORT.sql` | "read-only" | **Confirmed read-only.** Only `select` over `pg_class` / `pg_policy`. |
| `supabase/ANON_VERIFICATION.sql` | "read-only / non-destructive" | **NOT read-only.** It runs `create temp table`, `set role anon`, and guarded `insert`/`update`/`delete` (the writes are neutered with `where false`, and it touches only a temp table — but it is still not a pure `select`, and it is a **behavioural privilege probe**, not a reconciliation query). |

### 2.1 Finding: `ANON_VERIFICATION.sql` must not be run under Execution 19

The file's own header calls it "read-only / non-destructive". It is
non-destructive in effect (guarded writes), but it:

1. creates and drops a temp table,
2. switches role (`set role anon` / `reset role`),
3. issues `INSERT`/`UPDATE`/`DELETE` statements (as strings executed under
   `set role anon`), and
4. is a security probe, not a reconciliation query.

Under Execution 19's explicit constraints ("no INSERT/UPDATE/DELETE/DDL") it is
**out of scope and was not executed**. It is documented here, not run. Its
historical incident (two blank rows created by anon INSERT probes, recorded in
AGENTS.md Exec 05.4) is a reminder that behavioural anon probes are not
read-only. If the anon posture must be re-verified later, prefer the catalogue
form (`has_table_privilege('anon', …)`, pure `select`) which needs no writes.

### 2.2 New pack: `supabase/EXEC19_READONLY_RECONCILIATION.sql`

Strictly read-only by construction and by test:

- Contains **only** `select` / `with … select` statements.
- No `insert|update|delete|alter|drop|truncate|create|grant|revoke|merge|copy|
  comment|call|do`, no `set role`, no temp table.
- Does **not** call `update_account_balance(...)` or `generate_document_number(...)`
  (it only *reads* the former's definition from `pg_proc`).
- Selects identifiers and monetary amounts only — **no** `phone`, `email`,
  `full_name`, `address`, `national_id` (privacy-safe).

`tests/exec19-readonly-reconciliation.test.ts` strips comments/string literals
and asserts all of the above, so the pack can never silently gain a write.

---

## 3. The query pack (Phase 3) — what each block proves

| Block | Proves | Reads |
|---|---|---|
| 0 — capability probe | the real column shape of every queried table | `information_schema.columns` |
| 1 — sequence | whether a `sale_invoice` row exists and its `last_number` | `document_sequences` |
| 2 — last five | id, number, date, type, status, amounts of the last 5 sales | `invoices` |
| 3 — empty/duplicate | empty and duplicated `invoice_number`s | `invoices` |
| 4 — VAT by source | output/input VAT **and taxable base** per source and month | `invoices`, `purchase_invoices`, `expenses` |
| 5 — revenue | issued invoices net of VAT vs sales returns | `invoices`, `sales_returns` |
| 6 — account balance | `update_account_balance` definition + `accounts.balance` drift vs ledger | `pg_proc`, `journal_lines`, `journal_entries`, `accounts` |
| 7 — tenant isolation | tenant distribution per table | `invoices`, `sales_returns`, `document_sequences` |

### 3.1 Column provenance (no invented schema)

Every column used is proven from source:

- `document_sequences(doc_type, prefix, last_number, use_year, tenant_id)` —
  migration 003 + 001.
- `invoices(invoice_number, invoice_date, invoice_type, status, amount,
  discount_amount, vat_amount, total_amount, paid_amount, created_at, tenant_id)`
  — `sales/new`, `invoices/new`, `rentals/new`, `sales/page.tsx`.
- `purchase_invoices(total_amount, vat_amount, bill_date, status)` — `reports/vat`.
- `expenses(amount, vat_amount, expense_date)` — `reports/vat`, `expenses`.
- `sales_returns(invoice_id, return_date, amount, reason, status, customer_id,
  invoice_number, vat_amount, return_number, tenant_id)` — `sales/returns` + 003.
- `journal_lines(journal_entry_id, account_id, debit, credit, …)` and
  `journal_entries(id, status)` — `sales/new`, `src/lib/accounting/payment-posting.ts`.
- `accounts(id, code, name, type, balance)` — `ACCOUNT_BALANCE_VERIFICATION.sql`.

**Called out as unproven (resolved by Block 0, not guessed):**

- `journal_entries.id` — implied by `postJournalEntry` and the existing
  verification query; Block 0 confirms it.
- `accounts.balance` — proven only by the Exec 17 verification query, not by a
  migration. Block 0/6b confirm its live presence.
- `journal_entries.tenant_id` / `journal_lines.tenant_id` — migration-only
  (Exec 01/03 invariants); `journal_lines` has **no** `tenant_id` live, so Block 6b
  scopes lines through their parent entry and Block 7 does not select
  `journal_lines.tenant_id`.

### 3.2 Period placeholders

Blocks 4 and 5 use the literal window `2026-01-01 … 2026-04-01`. The operator
adjusts this to the period under review; the query logic is unchanged.

---

## 4. Results provable locally (Phase 4)

| Claim | Evidence |
|---|---|
| HEAD is `35f4a06`; tree clean | `git rev-parse HEAD`, `git status --porcelain` |
| Exec 17/18 reports present and consistent with the code | reports read; Exec 18 claims match `git show 35f4a06` |
| The new pack is strictly read-only | `tests/exec19-readonly-reconciliation.test.ts` (7 tests) |
| `ACCOUNT_BALANCE_VERIFICATION.sql` / `RLS_COVERAGE_REPORT.sql` are read-only | manual audit + existing Exec 17 assertion |
| `ANON_VERIFICATION.sql` is **not** read-only | raw scan + test |
| No regression from Exec 19 | full suite below |

### 4.1 Gates

| Gate | Command | Result |
|---|---|---|
| Tests | `npm test` | **434 tests / 428 pass / 0 fail / 6 skipped** (+7 new) |
| New guard | `tests/exec19-readonly-reconciliation.test.ts` | 7 pass |
| Typecheck | `npm run typecheck` | **129 errors** — unchanged baseline |
| Lint | `npm run lint` | **No ESLint warnings or errors** |
| Build | not re-run | Exec 19 adds no runtime code (a `.sql` file and a test only); the Exec 18 build (exit 0) still stands |

No accounting logic was changed on a guess. Nothing was tuned to make a test
pass.

---

## 5. Data that requires an authorized production run

All of the following are **NOT VERIFIED** — they need the operator to run the
pack (or the relevant block) against production with explicit authorization:

1. **`sale_invoice` sequence** — whether the row exists and its `last_number`.
   If absent, every sale falls back to a non-sequential `SI-########`.
2. **Last five sales invoices** — their real `invoice_number` shape (does the
   "last two operations" symptom show an empty or non-sequential number?).
3. **Empty / duplicate invoice numbers** — whether any exist.
4. **VAT taxable base by source** — to confirm the Exec 18 screen matches the DB.
5. **Revenue vs invoices/returns** — to confirm the dashboard reconciles live.
6. **`update_account_balance` body and sign convention**, and **`accounts.balance`
   drift** vs `journal_lines`.
7. **Tenant distribution** — to confirm isolation state (single-tenant ⇒ all NULL).

---

## 6. Unresolved accounting discrepancies (carried forward, not guessed)

1. **`update_account_balance` sign convention** (Exec 17 Blocker 2). The function
   is defined in no migration. The reconciliation deliberately reports the raw
   signed sum *and* both magnitudes so the convention is read from data, not
   assumed. No sign was changed.
2. **Sales serial integrity** (Exec 18 Item 2). The client defect is fixed and
   tested; whether the live `sale_invoice` sequence exists — and whether the last
   two sales carry a proper number — is unverified without a DB run.
3. **VAT / revenue reconciliation to the GL** (Exec 18). The document-level
   figures are correct; the GL control-account reconciliation is unverified.

None of these can be closed from source alone; each is one read-only block away.

---

## 7. Required next step (NOT executed)

1. Obtain **separate, explicit authorization** to run read-only SQL on production
   (project `chlkmdobhvfnldqkgdji`).
2. Run `supabase/EXEC19_READONLY_RECONCILIATION.sql`, block by block, in the
   Supabase SQL Editor. Do **not** run `ANON_VERIFICATION.sql` for this purpose.
3. Return the result sets so the three unresolved items in §6 can be closed:
   - if `sale_invoice` is missing from `document_sequences`, seeding it (same
     shape as the `receipt`/`sales_return` seeds in migration 003) is the
     remaining fix — an **insert**, to be done only under separate authorization;
   - if `update_account_balance` is absent or its sign is inverted, that is a
     production change, reviewed separately;
   - if `drift` rows are non-zero, the cached column is stale (the ledger remains
     authoritative).
4. No migration is applied, no row is written, and nothing is deployed as part of
   Execution 19.

---

## 8. Constraint compliance

| Constraint | Status |
|---|---|
| No `git push`, no deploy | respected |
| No production DB change | respected (no connection made) |
| No INSERT/UPDATE/DELETE/DDL/migration | respected |
| No edit to real invoice/journal numbers | respected |
| No printing of passwords/keys/connection strings | respected |
| No deletion/replacement of prior work | respected |
| No production SQL without separate authorization | respected |
