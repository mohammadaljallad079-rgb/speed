# SPEED ERP — Execution 30 Report

## Purchase-to-Credit-Sales Analytical Linking (System Action Item 6)

- **Repository:** `https://github.com/mohammadaljallad079-rgb/speed`
- **Branch:** `feat/final-hardening-round5` (local-only; no push, no deploy)
- **Starting commit:** `8f617dd` — "exec29: close remaining action items (local, no deploy)"
- **Scope:** implement the owner-approved Item 6 decision — link purchases to
  credit (آجلة) sales for **reporting/analysis only**, with **no** inventory or
  warehouse subsystem.
- **Constraints honored:** local-only; no production DB contact; no migrations
  applied to any production database; no `reset --hard`/`clean`; no secrets
  committed or printed.

---

## 1. What was built

A small, self-contained analytical link between a supplier bill
(`purchase_invoices`) and a credit-sale invoice (`invoices`). It records a
relationship and nothing else — it is deliberately **not** a financial event.

| Artifact | Purpose |
| --- | --- |
| `supabase/migrations/007_purchase_sale_links.sql` | Additive, idempotent link table + RLS (operator-applied, not applied live). |
| `src/lib/accounting/purchase-sale-links.ts` | Pure validation/summary + injectable-client service (`linkPurchaseToSale`, `unlinkPurchaseFromSale`). |
| `src/app/api/purchase-sale-links/route.ts` | Server-authenticated GET/POST/DELETE, tenant-scoped. |
| `src/app/reports/purchase-sale-links/page.tsx` | Report page: summary, current relationships, create/unlink, unlinked lists. |
| `src/app/reports/page.tsx` | Added the report card to the reports hub. |
| `tests/exec30-purchase-sale-links.test.ts` | 27 tests (pure, DB-bound, permissions, migration structure, regression). |
| `supabase/tests/007_harness/run.sh` | Executes migration 007 on a real PostgreSQL 17 with two tenants. |

### Design decisions (and why)

- **Many-to-many, not one-to-one.** Real data supports it: a credit sale can be
  backed by purchases from several suppliers, and one supplier bill can cover
  several sales. A one-to-one constraint would reject valid data.
- **No cost allocation.** The link carries an optional `relation_type` label
  (provenance) and `source`; it never computes a cost figure and never posts.
  Owner decision was reporting/analysis only.
- **Purchase value is never folded into revenue.** The report shows linked
  purchase totals and linked sale totals **separately**, and `summarizeLinks`
  de-duplicates by id before summing, so many-to-many cannot inflate a figure.
- **Fail-closed tenant scoping.** The service and the API resolve both records
  within the caller's tenant (or the NULL tenant). A link between two tenants is
  impossible; the global operator is scoped to the NULL tenant rather than being
  allowed to join arbitrary tenants.

---

## 2. Migration 007 — prepared, verified by execution, NOT applied live

`007_purchase_sale_links.sql`:

- creates `public.purchase_sale_links` (`tenant_id`, `purchase_invoice_id`,
  `invoice_id`, `relation_type`, `source`, `note`, `created_by`, `created_at`);
- two **partial unique** indexes prevent duplicate pairs for a real tenant and
  for the NULL tenant (a plain `UNIQUE` treats NULLs as distinct);
- RLS enabled with `can_read_tenant` (SELECT/DELETE) and `can_write_tenant`
  (INSERT/UPDATE); `anon` revoked;
- additive/idempotent/forward-only — drops nothing.

**Verified by execution** (`supabase/tests/007_harness/run.sh`) against a
throwaway PostgreSQL 17 with two tenants: **15/15 assertions pass** —
clean apply, idempotent re-apply, tenant A cannot read/insert/update/delete
tenant B's links, a NULL-tenant link is not a cross-tenant path, duplicate pair
blocked, anon denied, referenced tables preserved.

> **Production status: NOT APPLIED.** Consistent with 001–006, DDL is an operator
> step (no reachable DDL path from this environment). The app runs before and
> after: the API returns a clear error if the table is absent, and no existing
> flow depends on it.

---

## 3. Verification results

| Gate | Result |
| --- | --- |
| Full test suite (`npm test`) | **651 tests / 645 pass / 0 fail / 6 skipped** |
| New Exec 30 tests | **27/27 pass** |
| Migration 007 execution harness | **15/15 pass** |
| TypeScript (`npm run typecheck`) | **129 errors — unchanged baseline** (0 new) |
| Lint (`npm run lint`) | **clean** (0 warnings/errors) |
| Production build (`npm run build`) | **compiled successfully**; routes `/api/purchase-sale-links` and `/reports/purchase-sale-links` emitted |

No regressions. The suite grew from 624 → 651 tests (the 27 new ones).

---

## 4. Item-6 invariants enforced by tests

- The service writes **no** `journal_entries`/`journal_lines`/`payments` and
  references no posting path (`postJournalEntry`/`postSaleInvoice`/…).
- **No** inventory/stock/warehouse table, query, or module is introduced.
- Creating a link changes no document amount; deleting a link deletes only the
  link row.
- Cross-tenant create/read/update/delete are all refused.
- Exec 29's single sales-posting path and the AI/Excel engines are intact.

---

## 5. 13-item framework status (carried)

| Item | Status |
| --- | --- |
| 4, 9, 10, 11 | CLOSED (Exec 29) |
| 1, 2, 3, 5, 7, 8, 12 | PRESERVED (regression-guarded) |
| **6** | **IMPLEMENTED this execution (reporting/analysis only)** |
| 13 | Externally blocked (no DDL path to production) |

---

## 6. Blockers / next action

- **Migration 007 activation** requires an operator with DDL privileges on the
  Supabase project to apply `supabase/migrations/007_purchase_sale_links.sql`
  after 001→002. No other blocker.
- No production changes were made. No credentials were created, changed,
  committed, or printed in this execution.

---

## 7. Files changed

```
 M AGENTS.md                                   (Exec 30 invariants)
 M package.json                                (register exec30 test)
 M src/app/reports/page.tsx                    (report card)
?? src/lib/accounting/purchase-sale-links.ts
?? src/app/api/purchase-sale-links/route.ts
?? src/app/reports/purchase-sale-links/page.tsx
?? supabase/migrations/007_purchase_sale_links.sql
?? supabase/tests/007_harness/run.sh
?? tests/exec30-purchase-sale-links.test.ts
?? SPEED_EXECUTION_30_PURCHASE_SALE_LINKING_REPORT.md
```

Committed locally only. No push, no deploy.
