# SPEED ERP — Execution 23 Report
## Persistent AI Repair, Approvals & Verified Outcomes

**Scope:** local-only. No push, no deploy, no production database contact, no
migration applied to any live database.
**Branch:** `feat/final-hardening-round5`
**Base (start) HEAD:** `d0b31dd` (Execution 22) — verified, clean tree.
**Date:** 2026-10-17

---

## 1. Repository and commit inspected

| Item | Value |
| --- | --- |
| Repo | `https://github.com/mohammadaljallad079-rgb/speed` (authorized) |
| Branch | `feat/final-hardening-round5` |
| Exec 22 HEAD | `d0b31dd` (confirmed HEAD at start; `ae14787` Exec 21 is an ancestor) |
| Working tree at start | clean — no reset, no clean |
| Authorized repo note | the task names `mohammadaljallad079-rgb/speed`; the runner's context refers to `startgroup2022-tech/speed`. This execution used the authorized repo's workspace only. |

The previous state (Exec 21/22) was confirmed from the code before changing
anything: the AI Control page, the repair catalogue, the safe repair workflow
and the `/api/ai/repairs` route all existed and passed their suites.

---

## 2. Confirmed state: completed / partial / remaining

**Already completed (verified in code, unchanged):**
- One AI layer and one reporting layer (Exec 20/21). No duplicate engine.
- Safe repair cycle: catalogue → propose → approve → execute → verify (Exec 21).
- AI Control settings page and client controller (Exec 22).
- Accounting, sales, Excel and financial services — untouched this execution.

**Partially completed before this execution:**
- **Idempotency** existed only as an in-memory, per-process port
  (`createMemoryIdempotency`). A restart, a concurrent request or a lost response
  could re-run an approved action; an interrupted run left no durable trace.

**Remaining / delivered this execution (Exec 23):**
1. Durable repair store abstraction (`RepairStore`).
2. Durable store wired into `executeRepair` with an atomic claim.
3. Durable store + `history` operation wired into `/api/ai/repairs`.
4. Migration `006_ai_repair.sql` for `ai_repair_executions`.
5. Migration tested by execution on an isolated PostgreSQL 17.
6. Tests, `AGENTS.md` invariants and this report.

---

## 3. What changed

| File | Change |
| --- | --- |
| `src/lib/ai/repair-store.ts` | **NEW.** `RepairStore` port; memory store; `createSupabaseRepairStore(client)` over `ai_repair_executions`; `createResilientRepairStore(primary, fallback)`. |
| `src/lib/ai/repair-workflow.ts` | `executeRepair` claims the key atomically before any side effect; finalises the outcome on every exit path; `in_progress` / `unresolved` statuses; `key_reused` conflict; evidence gate in `proposeRepair`. |
| `src/lib/ai/policy.ts` | `RepairClassification.requiresVerification` (additive). |
| `src/lib/ai/repair-client.ts` | history loading, new error-code mapping, `requires_verification` handling. |
| `src/app/api/ai/repairs/route.ts` | builds the resilient durable store; `history` op; `409` for `in_progress`/`unresolved`. |
| `src/app/settings/ai-control/page.tsx` | repair-history panel. |
| `supabase/migrations/006_ai_repair.sql` | **NEW.** `ai_repair_executions` table, unique claim indexes, RLS. |
| `tests/exec23-persistent-ai-repair.test.ts` | **NEW.** 23 tests. |
| `tests/exec23-migration.test.ts` | **NEW.** 6 tests. |
| `package.json` | registers the two new suites in `test:core`. |
| `AGENTS.md` | Exec 23 invariants. |

### The durability model

- **Claim before side effect.** `executeRepair` inserts a `claimed` row keyed by
  `UNIQUE (tenant_id, idempotency_key)` *before* it writes anything. Concurrent
  requests, restarts and replayed approvals all resolve to that one row.
- **NULL tenant covered.** A plain unique index treats NULLs as distinct, so a
  second partial index covers `where tenant_id is null`. Both are required; the
  live install is single-tenant (every `tenant_id` NULL).
- **Never released blindly.** If finalising fails after the side effect, the row
  stays `claimed`; a retry returns `in_progress` rather than re-running.
  `unresolved` = "executed but not verified — human review".
- **Key reuse is a conflict.** Same key, different plan fingerprint →
  `conflict` / `key_reused`, never a false "already done".
- **Graceful before migration.** `createResilientRepairStore` degrades to memory
  when the table is absent (the `hasColumn` pattern). A degraded store is
  per-process; this is logged, never hidden.
- **No secrets.** Only ids, fingerprints, statuses, timestamps and change *keys*.

---

## 4. Migration 006 — verified by execution

Applied to an **isolated PostgreSQL 17** (`postgres:17-alpine`, Docker) with a
minimal schema providing `anon`/`authenticated`/`service_role` and the
`can_read_tenant` / `can_write_tenant` functions.

| Check | Result |
| --- | --- |
| First apply | 0 errors |
| Idempotent re-apply | 0 errors (all objects `if not exists` / `drop policy if exists`) |
| Same tenant + same key twice | **unique violation** `ai_repair_executions_tenant_key_uidx` |
| Different tenants, same key | both inserted (no cross-tenant collision) |
| NULL tenant + same key twice | **unique violation** `ai_repair_executions_null_tenant_key_uidx` |
| `anon` SELECT | **permission denied** (revoked) |
| Tenant A read (GUC-driven predicate) | 1 row (own) |
| Tenant B read | 1 row (own) |
| Tenant C read | 0 rows |
| DELETE (restrictive) | 0 rows deleted |

**Migration 006 is prepared but NOT applied to any live database.** Applying it
is the operator step (see §7).

---

## 5. Tests, typecheck, lint, build

| Gate | Result |
| --- | --- |
| `npm test` (full `test:core`) | **535 tests, 529 pass, 6 skipped, 0 fail** |
| Exec 23 suite (`exec23-persistent-ai-repair`) | 23 pass / 0 fail |
| Exec 23 migration suite | 6 pass / 0 fail |
| Exec 21 + 22 (regression) | all pass |
| `npm run typecheck` | **129 errors** — the documented baseline; no error in any file touched here |
| `npm run lint` | clean (no warnings or errors) |
| `npm run build` | succeeds with the Supabase env present; `/api/ai/repairs` and `/settings/ai-control` compile |

Baseline before Exec 23: 506 tests / 500 pass / 6 skipped. Now **535 / 529 / 6**
— +29 tests, 0 regressions.

**Build note (environmental, not a regression):** `npm run build` fails at
page-data collection with `supabaseUrl is required` when no `.env.local` exists.
`.env.*` is git-ignored and this sandbox has none. With the three Supabase env
vars present the build completes and both routes appear in the output. This
affects any commit at this tree, including `d0b31dd`.

---

## 6. Security and repository hygiene

- No secret, service-role key, private key or credential was written to a tracked
  file. The new store stores no secret and no financial value.
- `.env.local` / `.env.*` remain git-ignored; none was created or committed.
- No test prints a secret value.
- RLS is not disabled and no authorization was weakened.
- The repair route stays session-gated (`requireContext`) and reads no identity
  from the request body (asserted by test).
- The new ledger is append-only: RESTRICTIVE delete-deny, `revoke all from anon`.
- No historical/backup file was opened in a way that exposed a secret.

---

## 7. Migrations: applied vs prepared

| Migration | Live status |
| --- | --- |
| 001 / 002 / 003 / 004 / 005 | Not applied (pre-existing; no DDL path from this environment) |
| **006_ai_repair.sql** | **Prepared, not applied.** Verified by execution on isolated PostgreSQL 17. |

**To apply (operator):** run `supabase/migrations/006_ai_repair.sql` against the
project after 001/002. It is additive and idempotent. Required permission: an
account able to `create table` / `create index` / `create policy` in `public`
(i.e. the DB owner or service-role DDL path).

---

## 8. Deployment and live verification

- **No deployment performed.** Local-only constraint honored.
- **No live database contacted.** No row written, no probe issued.
- Live verification of the AI Control repair flow is **blocked** until 006 is
  applied; before that the app still runs correctly through the in-memory
  fallback (by design).

---

## 9. Blockers, permissions needed, next action

| Blocker | Exact need |
| --- | --- |
| Migration 006 not applied | An operator with DDL rights on project `chlkmdobhvfnldqkgdji` runs `006_ai_repair.sql` after 001/002. |
| Local `npm run build` | The three Supabase env vars in `.env.local` (present on the server, absent in this sandbox). |

**Next action:** apply 001 → 002 → 006, then run `npm test` on the server and
confirm `/settings/ai-control` shows the repair-history panel with real rows.

---

## 10. Acceptance criteria

| Criterion | Status |
| --- | --- |
| Idempotency is durable across restarts | Met (tested) |
| Concurrent requests run the write at most once | Met (tested) |
| Interrupted run is not re-run blindly | Met (tested) |
| Outcome is verified after execution | Met (tested) |
| Key reuse is a conflict | Met (tested) |
| Tenant isolation of the ledger | Met (tested + live PG) |
| No secrets / no arbitrary code | Met (tested) |
| No second engine, no inventory | Met (no engine added) |
| Migration verified by execution | Met (isolated PostgreSQL 17) |
| Tests / typecheck / lint / build reported honestly | Met |
| Production change verified or blocked stated | Met (§8) |

---

## 11. Temporary credentials

None. Execution 23 created, changed or rotated no account and generated no
password.
