# SPEED ERP — Execution 26 Report
## Production Readiness Audit Before Deployment (read-only)

**Scope:** analysis + read-only local checks only. No push, no deploy, no
production database contact, no SQL executed on production, no migration applied
anywhere, no code change. `git reset --hard` / `git clean` were not used and no
file was deleted.
**Branch:** `feat/final-hardening-round5`
**HEAD:** `17837a3` (Execution 25) — clean working tree.
**Authorized repo:** `https://github.com/mohammadaljallad079-rgb/speed`
**Date:** 2026-10-17

---

## 1. GitHub vs local state (Phase 1)

| Item | Value |
| --- | --- |
| Local branch | `feat/final-hardening-round5` @ `17837a3` |
| Working tree | **clean** (`git status --short` empty) |
| `origin/main` (GitHub) | `29a005c` — *"docs: Exec 13 first-hand harness reproduction…"* |
| Relationship | `origin/main` **is an ancestor of** HEAD (linear, no divergence) |
| Local commits NOT on GitHub | **10** |
| File delta `origin/main..HEAD` | 94 files, +12,336 / −304, **0 files deleted** |
| New API routes | `src/app/api/ai/repairs/route.ts`, `src/app/api/import/route.ts` |
| New migrations | `005_accounting_integrity.sql`, `006_ai_repair.sql` |

> GitHub does **not** contain the local work. Everything below Exec 16 is
> local-only, exactly as prior reports stated.

### 1.1 Commits that must be transferred (oldest → newest)

`origin/main` (`29a005c`) is an ancestor of HEAD, so a merge is a **fast-forward**
— no rebase, no conflict, no history rewrite.

| # | SHA | Subject |
| --- | --- | --- |
| 1 | `722967f` | fix(accounting): Exec 16 integrity remediation |
| 2 | `b4eb309` | fix(exec17): report tenant fail-closed + ledger balance |
| 3 | `35f4a06` | fix(exec18): VAT base, collision-safe numbering, GO filters, revenue |
| 4 | `509870f` | docs(exec19): read-only reconciliation pack + guard |
| 5 | `7bca814` | audit(exec20): AI audit + repair capability |
| 6 | `ae14787` | feat(exec21): safe AI repair workflow R1 |
| 7 | `d0b31dd` | feat(exec22): AI Control UI integration |
| 8 | `2f992eb` | Exec 23: durable AI repair idempotency |
| 9 | `a0c946a` | Exec 24: VAT section subtotals + export |
| 10 | `17837a3` | Exec 25: universal Excel data import + local RLS verification |
| 11 | *(this commit)* | docs(exec26): this readiness report (docs-only) |

> The audit above was performed at `17837a3`; this report is committed on top
> (docs-only), so the transfer set is **11 commits** (10 app/docs + this report).
> `17837a3` is preserved as its parent — no history rewrite.

### 1.2 Branch nuance (verified, not assumed)

Local branch `main` (`3cd6e59`) is **behind** `origin/main` by 3 documentation
commits (`33a87f2`, `3443282`, `29a005c`). Those 3 commits are **already in HEAD**,
so the correct transfer is the **feature branch**, not local `main`.

---

## 2. Database review (Phase 2)

### 2.1 Approved execution order and why

```
001_core_security
  → 002_tenant_isolation_hardening
  → 003_sales_lifecycle
  → 004_global_super_admin
  → 005_accounting_integrity
  → 006_ai_repair
```

| Order | Reason (from the SQL itself, not the file number) |
| --- | --- |
| 001 first | Creates `activity_logs`, adds `tenant_id` columns, defines `current_tenant_id()` / `is_admin()`. |
| 002 after 001 | **Redefines** `current_tenant_id()`/`is_admin()` and adds `can_read/write_tenant`, `can_read/write_company`; creates the per-table RLS policies. Must run after 001. |
| 003 after 002 | Adds `sales_returns`/journal `tenant_id` columns and the `receipt`/`sales_return` sequences; seeds account `41003`. Requires live tables. |
| 004 after 002 | **Replaces** the 002 helper functions to add `is_super_admin()` and the `prevent_role_escalation` trigger. Running it before 002 would be overwritten. |
| 005 after 003 | Needs `journal_entries` with `entry_type`/`reference_number`/`status`/`total_debit`/`total_credit` (added in 003). |
| 006 last | Uses `can_read_tenant`/`can_write_tenant` (defined in 002, extended in 004). |

The dependency chain is `001 → 002 → (003 → 005)`, `(002 → 004)`, `(002 → 006)`.

### 2.2 Idempotency / re-run / data-safety

- **All six are additive and idempotent**: `create table/index if not exists`,
  `add column if not exists`, `create or replace function`, `drop policy if exists`
  before `create policy`, existence-guarded `do $$` blocks.
- **No destructive statements** anywhere: no `DROP TABLE`, `DROP COLUMN`,
  `TRUNCATE`, or `DELETE` (verified by grep across `supabase/migrations/*.sql`).
  The only `disable row level security` statements are inside the **rollback**
  files, which are opt-in and are not part of any forward path.
- **Broad privilege change (intended):** 002 and 004 run
  `revoke all on public.<table> from anon` for every tenant table and
  `revoke all on function … from anon`. They do **not** revoke from
  `authenticated`. This is the deliberate "anon must hold zero table privileges"
  invariant.
- **Rollback files exist** for 001, 002 and 005. There is **no rollback file for
  003, 004, 006** (they are additive; 004's trigger/policies would need a manual
  drop to fully undo).

### 2.3 Blocking risk found in 005 (must be resolved before applying)

`005_accounting_integrity.sql` creates a **UNIQUE** partial index:

```sql
create unique index if not exists journal_entries_one_posted_per_doc_uidx
  on public.journal_entries (entry_type, reference_number)
  where status = 'posted' and reference_number is not null
    and reference_number <> '' and entry_type in ('sale_invoice','supplier_payment')
```

The migration comment is explicit: *"If a pre-existing duplicate already violates
it, `create unique index` fails loudly."* Because 005 runs inside a single
`begin; … commit;`, a failure **aborts the whole migration**. On a live database
that may already hold duplicate posted journals (the app posted from the browser
without a guard until Exec 16), this is a **real, unverified blocker** that must
be checked first with a read-only query:

```sql
select entry_type, reference_number, count(*)
from public.journal_entries
where status = 'posted' and reference_number is not null and reference_number <> ''
group by entry_type, reference_number
having count(*) > 1;
```

### 2.4 Activation-bundle gap (must be resolved)

- `PRODUCTION_ACTIVATION_001_002_003.sql` embeds 001→002→003 (byte-identical,
  SHA-256 recorded).
- `PRODUCTION_ACTIVATION_004.sql` embeds 004.
- **005 and 006 are embedded in NO activation bundle** (verified by grep).
  Applying them live therefore has **no frozen, reviewed artifact** — they would
  have to be pasted from `supabase/migrations/` directly. A
  `PRODUCTION_ACTIVATION_005_006.sql` should be generated from the migration
  files (never hand-edited) before they are applied.

### 2.5 Tested locally vs not tested on production

| Migration | Locally (PostgreSQL 17, throwaway) | On production |
| --- | --- | --- |
| 001–003 | Yes (isolation harness) | **NOT applied / NOT verified** |
| 004 | Yes (`004_harness`) | **NOT applied / NOT verified** |
| 005 | Yes (`005_harness`, 10/10) | **NOT applied / NOT verified** |
| 006 | Yes (`exec23-migration.test.ts`) | **NOT applied / NOT verified** |

The application is written to **work before 005/006 exist**: the AI repair store
uses `createResilientRepairStore` (falls back to an in-memory store if
`ai_repair_executions` is absent), and accounting guards live in code. So the app
deploy does not depend on 005/006.

---

## 3. Deployment review (Phase 3)

### 3.1 Build & environment

- Next.js **15.3.6**, React 19.2.0, TypeScript. No `engines` constraint declared.
- Required env vars (read from source): `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only),
  optional `ENABLE_SCHEMA_MIGRATION_ENDPOINT`.
- **No `.env.example` is tracked**; `.env`/`.env.*` are git-ignored. The sandbox
  has **no `.env.local`**, so local `npm run build` needs placeholder values.
- Frozen commit verified locally (read-only run): `npm test` **568 / 562 pass /
  0 fail / 6 skipped**, `npm run typecheck` **129** (unchanged baseline).

### 3.2 Files to deploy vs files that must be preserved

- **Deploy:** everything tracked in `17837a3` (94-file delta over `origin/main`),
  built via `npm run build` on the VM.
- **Preserve — never overwrite or commit:** `.env.local` (untracked, holds the
  real Supabase URL/anon/service-role keys), the PM2 process definition, the
  Nginx/vhost config, and any server-only uploads/logs.
- The server's current checked-out commit could **not** be observed (sandbox has
  no access to `/var/www` or `pm2`) — recorded as NOT VERIFIED, not assumed.

### 3.3 Backup / deploy / rollback plan (rollback-safe)

**Backup (before any change):**
1. Record current commit: `git -C /var/www/speed.harbourconsultancies.com rev-parse HEAD`.
2. Snapshot the running release:
   `tar czf /root/speed-backup-$(date +%F-%H%M).tgz -C /var/www speed.harbourconsultancies.com`
   (excludes nothing; the app dir has no DB data).
3. Copy `.env.local` to a safe location and confirm it is unchanged afterwards.
4. **Database backup (for the later migration phase):** take a Supabase
   point-in-time / logical backup of `chlkmdobhvfnldqkgdji` before applying SQL.

**Deploy (fast-forward, non-destructive):**
```
git fetch origin
git checkout feat/final-hardening-round5   # or merge to main, then:
git merge --ff-only origin/main
npm ci                                     # only if package-lock changed (it did not)
npm run build
pm2 restart speed --update-env
```
Never `git reset --hard`, never force-push, never delete `.env.local`.

**Rollback (if post-deploy checks fail):**
```
git checkout <previous-sha>     # e.g. the recorded pre-deploy commit
npm ci && npm run build
pm2 restart speed --update-env
```
Database rollback (only if a migration was applied): run the provided
`*_rollback.sql` for 001/002/005; 003/004/006 need manual `drop index/policy/
trigger` (documented in the migration headers). Data is not rewritten by any
forward migration, so an app-only rollback is sufficient unless SQL was applied.

### 3.4 Post-deploy acceptance tests

| # | Test | Expected |
| --- | --- | --- |
| 1 | Login as company admin | Resolves to a `public.users` row with role `admin`, correct tenant |
| 2 | Login as super admin | Resolves to `super_admin`, tenant-less; `/dashboard` reachable |
| 3 | Anonymous → protected page | Redirect to `/login` (middleware now gates pages) |
| 4 | Anonymous → `/api/*` | `401` |
| 5 | Company admin → global-only area | `403` / not shown |
| 6 | Accounting: issue invoice → payment | One posted journal per document; ledger balances |
| 7 | Excel import `/settings/import` | Template download, preview, valid commit, error report |
| 8 | AI Control `/settings/ai-control` | Repair catalogue preview/approve (read-only actions) |
| 9 | Public pages `/`, `/pricing`, signup | Still reachable; `/api/saas/signup` works |
| 10 | Reports `/reports/vat` | Renders; tenant-scoped |

A local `npm run build` or green test suite does **not** prove production success;
these tests must run on the live site after deploy.

---

## 4. Risks and blockers requiring resolution

| # | Risk | Severity | Resolution |
| --- | --- | --- | --- |
| R1 | 005 unique index may fail on existing duplicate posted journals | **High** | Run the read-only duplicate query (§2.3); resolve duplicates before applying 005 |
| R2 | 005/006 have no frozen activation bundle | **High** | Generate `PRODUCTION_ACTIVATION_005_006.sql` from the migration files |
| R3 | Migrations never verified on production | High | Apply via the runbook, then run `ANON_VERIFICATION.sql` / `RLS_COVERAGE_REPORT.sql` |
| R4 | Sandbox cannot reach the production VM | Medium | On-server steps must be executed on the VM by the operator |
| R5 | No server backup / no confirmed current server commit | Medium | Execute the backup plan (§3.3) before deploy |
| R6 | 006 needs its own activation artifact; app works without it | Low | Deploy app first; apply 006 with the bundle in R2 |
| R7 | `AGENTS.md` deployment note is stale ("middleware gates only `/api/*`") | Low | Middleware now also gates `PROTECTED_PAGE_PREFIXES`; update the note |
| R8 | `PRODUCTION_MIGRATION_RUNBOOK.md` / `PRODUCTION_SECURITY_CHECKLIST.md` referenced by `AGENTS.md` are absent | Low | Restore or regenerate them (referenced but not tracked) |

---

## 5. Decision

### **NOT READY** — for the full objective (deploy **and** DB security activation).

**Why (evidence-based):**

- The **application code is deploy-ready** in isolation: HEAD is a clean,
  linear fast-forward over `origin/main`; no files deleted; build succeeds;
  568 tests / 562 pass / 0 fail; the app degrades safely without 005/006.
- But the task's objective includes **activating database protection**, and that
  is **not safe to execute yet**, for two proven reasons:
  1. **R1** — the 005 unique index can abort mid-migration on live duplicate
     journals; this has not been checked against production.
  2. **R2** — 005 and 006 have no frozen activation bundle, so there is no
     reviewed artifact to apply.
- **R3/R4/R5** — no migration has been verified on production, the sandbox cannot
  reach the VM, and no production backup/current-commit has been confirmed.

**What is READY now:** the code deploy procedure (§3.3) and the local evidence
(§2.5, §3.1). **What is NOT READY:** the database security activation until R1
and R2 are closed.

### Single most important next action

Run the read-only duplicate-journal query (§2.3) against `chlkmdobhvfnldqkgdji`.
If it returns rows, resolve them first; then generate
`PRODUCTION_ACTIVATION_005_006.sql` from the migration files. Only then is the
database phase safe to schedule.

---

## 6. What was NOT done (compliance)

- No push, no deploy, no `git reset --hard` / `git clean`, no file deletion.
- No connection to the production database; no SQL executed against production.
- No migration applied to any database.
- No code change; no AI engine, Excel engine or completed feature rebuilt.
- No inventory/warehouse added.
- No secret, key or password printed.
