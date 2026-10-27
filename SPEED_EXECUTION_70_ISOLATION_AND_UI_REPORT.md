# SPEED ERP — Execution 70 Implementation Report

**Scope:** intra-tenant (customer-to-customer) row isolation, self-escalation
block, fail-closed tenant scoping across the API surface, and real browser
evidence of the Global Super Admin console.

**Continuation point.** The task brief named `c536858` (Exec 41) as "last pushed".
It is an **ancestor** of `origin/main`. The true latest on `origin/main` is
`164b0b8` (Exec 68, merged via PR #4). This execution continues on top of
`feat/final-hardening-round5` → Exec 69 (`2df4460`, `b8d27de`) → Exec 70
(`a2fbaa4`) → this commit. Nothing was reset, recreated, or re-provisioned.

---

## 1. The reported defect, restated

Migrations 001/002 isolate rows by **tenant**. Inside one tenant every
`authenticated` identity satisfies the same predicate, so a rental `customer`
— who is an `authenticated` user — could read and write every other customer's
rentals, invoices and payments of that tenant. There was no intra-company
isolation. The second half of the defect was self-escalation: a user could
update their own `users.role` to `admin`.

## 2. Migration 016 — customer row isolation

`supabase/migrations/016_customer_row_isolation.sql`

| Object | Purpose |
|---|---|
| `current_customer_id()` | SECURITY DEFINER, `search_path` pinned. The caller's `customers.id`, or `NULL`. |
| `current_user_is_office()` | SECURITY DEFINER. True for `admin`/`staff`/`super_admin`; false for `client`. |
| RESTRICTIVE policies on customer-owned tables | A `client` sees only rows whose `customer_id` matches. RESTRICTIVE (ANDed) so it cannot be widened by a permissive policy. |
| `prevent_role_escalation` BEFORE trigger on `users` | Refuses a `role` change by a non-super-admin. |
| `revoke execute ... from anon` | The predicates are not a callable oracle for the anonymous role. |

A `NULL` `customer_id` means "not a portal customer", never "every customer".
The office side is exempt (`current_user_is_office()`), and `cars` stays
tenant-scoped: it is a catalogue, not customer-owned data.

Verified by execution, not by parsing: `supabase/tests/016_harness/run.sh`
builds a throwaway PostgreSQL 17 with two tenants and real identities, applies
016, re-applies it idempotently, rolls it back, and asserts the isolation
semantics.

**Result: 39/39 assertions pass.** The anon assertions use `expect_denied`
(privilege denied) rather than "0 rows", which is the stronger claim. The frozen
package `supabase/PRODUCTION_ACTIVATION_016.sql` was regenerated from the
migration and its SHA-256 banner is recomputed by
`tests/activation-package-integrity.test.ts`.

## 3. Fail-closed tenant scoping (T4/T5)

The same defect class as Exec 70, one level up: a tenant predicate that stops
filtering when the caller's tenant cannot be resolved.

| Location | Before | After |
|---|---|---|
| `/api/invoices/[id]` GET, DELETE | `if (context.tenantId) query.eq(...)` → **unfiltered** | fail-closed ternary → `.is("tenant_id", null)` |
| `/api/invoices/[id]/reverse` | same | same |
| `/api/financial/report-format?what=history` | same over `activity_logs` | tenant-scoped |
| `scopeToTenant` (`src/lib/auth/policy.ts`) | returned the query unfiltered | delegates to `scopeToTenantColumn` |
| `/api/users` POST | never set `tenant_id` on the `users` row | stamped from the session; auth user rolled back on failure |
| `/api/users` GET | `null` tenant → whole platform directory | super admin only; otherwise no accounts |

The invoice case was an IDOR: with an unresolved tenant the row was selected by
`id` alone, so another company's invoice was readable and, on DELETE/reverse,
mutable.

`scopeToTenant` was exported but unused. That is precisely why it was dangerous —
the next caller would have inherited the hole — so it now shares the one
predicate with `scopeToTenantColumn` rather than duplicating it.

## 4. Real browser evidence

`docs/screenshots/exec70/` — **82 screenshots** (41 shots × desktop 1440×1000 and
mobile 390×900) plus `MANIFEST.json`, captured on this exact commit.

The capture runs against `scripts/dev/local-supabase-stub.mjs`, an in-memory
Supabase-compatible backend with an obviously-fake seeded dataset. **No live
system was contacted and no live financial data was read or written.** The
capture fails if two images are byte-identical, so a blank frame cannot be
committed as evidence.

The tooling itself needed a fix. It signed in as `super_admin` only and then
visited ERP pages. Since Exec 69 the area boundary is enforced server-side, so
those pages (correctly) redirect to `/access-denied` — 8 shots were being
silently skipped. It now builds three contexts — anonymous, `platform`
(`super_admin`), `erp` (company `admin`) — and selects the session per shot.
This was a masked failure before Exec 69 and a real one now.

### Global Super Admin console

| Screenshot | What it proves |
|---|---|
| `super-admin-login-desktop.png` | The operator door, distinct from the company sign-in. |
| `super-admin-overview-desktop.png` | Live platform totals and the audit feed. |
| `super-admin-companies-desktop.png` | Per-company status, user counts, plan, search. |
| `super-admin-users-desktop.png` | Company drawer with users and Activate/Suspend. |
| `super-admin-ai-desktop.png` | Provider/model/key management and the tool catalogue. |
| `super-admin-ai-agent-desktop.png` | The AI agent panel on the global console. |
| `super-admin-subscriptions-desktop.png` | Package capability matrix and plan assignment. |
| `super-admin-settings-desktop.png` | Where each global setting is managed. |

Each has a matching `-mobile.png`. The ERP and financial screens (General
Ledger, Trial Balance, Profit & Loss, Balance Sheet, Cash Flow, purchases,
supplier statements/aging, VAT, Smart Forms) are captured under the company
`admin` session.

## 5. Verification

| Gate | Result |
|---|---|
| `npm test` | **1552 tests / 1546 pass / 6 skipped / 0 fail** |
| `npx tsc --noEmit` | **0 errors** |
| `npm run lint` | **clean** |
| `npm run build` | **green** |
| `016_harness/run.sh` | **39/39 pass** (apply, idempotent re-apply, rollback, cross-customer denial, anon denial) |
| Frozen package 016 | applies, idempotent re-apply, rollback; POST-FLIGHT rows `t\|t\|t\|5\|t` |

New regression tests: `tests/exec70-customer-row-isolation.test.ts` (static),
`tests/security-tenant-isolation.test.ts` (+4: route-wide fail-open scan, invoice
`IS NULL` fallback, user-tenant stamp, no body tenant),
`tests/tenant-isolation.test.ts` (+4 for `scopeToTenant`).

## 6. Not done, and why

- **No migration was applied to the live database.** DDL is not reachable from
  this environment (no pooler credentials, no IPv6 egress). Applying
  001→002→003→004→005→006→007→016 is an operator step; the runbooks are in the
  repository. This report does not claim the live database is isolated.
- **No deployment.** The production host is not reachable from the sandbox.
- **Administrator accounts were not recreated.** The brief states they are
  already configured; the provisioner is idempotent and was not run.
- **`/api/accounting/petty-cash` line 118** (`if (context.tenantId)
  transactionRow.tenant_id = ...`) is *not* the fail-open defect: the row is
  being **inserted**, and a tenant-less caller legitimately writes a NULL-tenant
  row. Its read path is already fail-closed (`query.is("tenant_id", null)`).
  Recorded as reviewed, not changed.

## 7. Files changed in this commit

```
AGENTS.md
scripts/dev/capture-screenshots.mjs
docs/screenshots/exec70/                     (82 PNG + MANIFEST.json)
SPEED_EXECUTION_70_ISOLATION_AND_UI_REPORT.md
```

The functional changes (migration 016, the routes, `policy.ts`, the tests) are
in `a2fbaa4` and `eee7483`; this commit adds the evidence and the invariants.
