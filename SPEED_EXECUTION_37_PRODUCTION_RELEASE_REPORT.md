# SPEED ERP — Execution 37: Prepare and Execute a Safe Production Release

**Status:** Preflight complete and committed locally. **Production deployment is
BLOCKED** — this environment has no path to the production host and no
DDL-capable database connection. Nothing was deployed and no migration was
applied. Every claim below is backed by a command whose output is quoted.

---

## 1. Repository and commit inspected

| Item | Value |
| --- | --- |
| Repository | `https://github.com/mohammadaljallad079-rgb/speed` (only authorized repo) |
| Branch | `feat/final-hardening-round5` |
| HEAD at start | `595e7d4` (Exec 36) — verified clean |
| HEAD after this execution | the Exec 37 commit on `feat/final-hardening-round5` (one new commit; see §8.1) |
| Parent | `f008ec7` (Exec 35) |
| `origin/main` | `29a005c4a9ddc964f6d92662c25ca991ca7fb477` |
| Relation | **22 ahead, 0 behind** — clean fast-forward |
| Working tree | clean |
| Push performed | **none** (local-only constraint) |

```
$ git rev-list --count origin/main..HEAD   -> 22
$ git rev-list --count HEAD..origin/main   -> 0
```

### Executions 33–36 are all present

```
$ git log --oneline origin/main..HEAD | head -5
<exec37> exec37: release preflight - freeze 007 activation package + untrack editor backups
595e7d4 exec36: release audit fixes (cross-tenant journal delete, safe compensation, payroll run idempotency)
f008ec7 exec35: route remaining financial posting paths through the server
795292f exec34: close rental posting gap - rentals/new posts through /api/invoices
bbc5e3a exec33: close original 13 items - single posting path for bookings/rentals/payments
```

The Exec 34→35 diff was inspected in Exec 36 (23 files, +2588/−399). The Exec 36
report `SPEED_EXECUTION_36_RELEASE_READINESS_REPORT.md` is present in the tree.

---

## 2. Release archive and checksum verified against the exact commit

The artifact is a deterministic, content-only snapshot of the tracked files at
HEAD:

```
$ git ls-files -z | tar --null -T - \
    --mtime='2026-01-01 00:00:00 UTC' --sort=name \
    --owner=0 --group=0 --numeric-owner -czf release/speed-<short-sha>.tar.gz
$ sha256sum release/speed-<short-sha>.tar.gz
<see release/speed-<short-sha>.sha256>
```

| Item | Value |
| --- | --- |
| Artifact | `release/speed-<short-sha>.tar.gz` (git-ignored, never committed) |
| SHA-256 | `<see release/speed-<short-sha>.sha256>` |
| Files | exactly the tracked set — `tar tzf <artifact> \| wc -l` equals `git ls-files \| wc -l` |
| Secret scan of contents | clean — no `.env`, `*.pem`, `*.key`, backup or credential file |

Verification method: the archive was extracted and diffed against a fresh
extraction of the same tracked set — byte-identical, and the file count matches
`git ls-files` exactly. (Note: two independently-built `.tar.gz` files differ in
their own SHA-256 because gzip records the output filename in its header; the
*content* is what is verified, and it matches HEAD exactly.)

The prior Exec 36 artifact (`release/speed-exec36.*`) was superseded because it
predated the Exec 37 hygiene changes (below).

---

## 3. Migration inventory and dependencies (reviewed, NOT applied)

Seven forward migrations plus paired rollbacks. **No destructive statement**
(`drop table`, `drop column`, `truncate`, `delete from`) exists in any forward
migration:

```
$ grep -inE "^\s*(drop table|drop column|truncate|delete from|alter table .* drop)" \
    supabase/migrations/00*.sql | grep -v rollback
(no output)
```

| # | Migration | Nature | Depends on | Activation package |
| --- | --- | --- | --- | --- |
| 001 | `001_core_security.sql` | RLS + audit + tenant columns | — | `PRODUCTION_ACTIVATION_001_002_003.sql` |
| 002 | `002_tenant_isolation_hardening.sql` | Supersedes 001; `can_read_tenant`/`can_write_tenant`, restrictive `activity_logs` policies | 001 | (same bundle) |
| 003 | `003_sales_lifecycle.sql` | Additive columns + receipt/return sequences | 001,002 | (same bundle) |
| 004 | `004_global_super_admin.sql` | `super_admin` role | 001,002 | `PRODUCTION_ACTIVATION_004.sql` |
| 005 | `005_accounting_integrity.sql` | Duplicate-journal index + integrity view | 003 | `PRODUCTION_ACTIVATION_005_006.sql` |
| 006 | `006_ai_repair.sql` | Append-only `ai_repair_executions` | 002 | (same bundle) |
| 007 | `007_purchase_sale_links.sql` | Analytical purchase↔sale link table | 002 | **`PRODUCTION_ACTIVATION_007.sql` (added this execution)** |

**Required execution order:** 001 → 002 → 003 → 004 → 005 → 006 → 007.
005 can abort by design if the live ledger already contains duplicate posted
journals for a `(entry_type, reference_number)`; the pre-flight query in the
005/006 package must return **zero rows** first.

### The named `EXEC07_1_TENANT_POLICY_FIX.sql` does not exist

The mission names `EXEC07_1_TENANT_POLICY_FIX.sql` as an existing security
artifact. It is **not present** in this repository under any name:

```
$ git ls-files | grep -iE "exec07|tenant_policy"   -> (none)
```

The change that file is presumed to carry — making the `activity_logs`
append-only policies `as restrictive` so the generic tenant loop's permissive
policies cannot OR past a `using(false)` deny — **is already present in migration
002** and is regression-guarded:

```
$ grep -n "as restrictive" supabase/migrations/002_tenant_isolation_hardening.sql
540:  as restrictive for update to authenticated using (false);
544:  as restrictive for delete to authenticated using (false);
$ grep -rln "activity_logs_no_update|as restrictive" tests/
tests/security-tenant-isolation.test.ts
tests/exec23-migration.test.ts
```

So the tenant-policy fix is in the authoritative model; there is no separate
file to apply.

### Packaging gap closed this execution

Migration 007 backs the live route `/api/purchase-sale-links` (Exec 30, Item 6)
but was the **only migration with no operator-runnable activation package**. It
has been frozen into `supabase/PRODUCTION_ACTIVATION_007.sql` — the body embedded
verbatim with a SHA-256 banner, plus a read-only PRE-FLIGHT (helper/table
presence) and POST-FLIGHT (table, RLS, both unique indexes, anon has no
privilege, the four policies). `scripts/generate-activation-bundle.mjs` now emits
it, and `tests/activation-package-integrity.test.ts` verifies byte-identity, the
recorded hash, single embedding and non-destructiveness (20/20 pass). Regenerating
the 005/006 package produced a byte-identical file (no drift).

---

## 4. Repository hygiene (Phase 1.5)

- **No secrets tracked.** No `.env`, `*.pem`, `*.key`, `*.p12`, `credential` or
  `secret` file is in `git ls-files`. No Supabase JWT, `postgres://user:pass@`
  URL or assigned anon/service key literal exists in tracked source.
- **No secret was ever committed.** `git log --all -S` finds exactly one JWT
  header, and it is the **fabricated redaction fixture** in
  `tests/ai-assistant.test.ts` (a deliberate fake used to prove `redactSecrets`
  works). `.env*` was never added to history. No private-key header ever entered
  history.
- **16 editor-backup files untracked.** `*.backup`, `*.backup2`,
  `*.backup.<timestamp>` files had been committed by mistake. They were removed
  from the index (`git rm --cached`, files left on disk) and `.gitignore` now
  covers them. Every one of the 16 has its original file present and unmodified.

```
$ git ls-files | grep -c "\.backup"   -> 0
$ git check-ignore src/components/DashboardLayout.tsx.backup  -> matched
```

- `.env.local` is absent and git-ignored; `release/` is git-ignored so the binary
  is never committed.

---

## 5. Phase 2 — Deployment access (result: PARTIAL, host access MISSING)

| Access needed | Available here? | Evidence |
| --- | --- | --- |
| GitHub (repo/token) | **Yes** | `api.github.com` returns HTTP 200 with the token (value not printed) |
| Production host `/var/www` | **No** | `ls /var/www` → *No such file or directory* |
| PM2 process manager | **No** | `which pm2` → not found |
| SSH client / keys | **No** | `which ssh` → not found; `~/.ssh` absent |
| CI/CD pipeline | **No** | `.github/workflows/` absent |
| DDL-capable Postgres | **No** | no `psql`/`DATABASE_URL` path that reaches the project (per Exec 05.4/05.5) |

**Blocker (exact):** the sandbox is not the production VM. It has no shell on
`/var/www/speed.harbourconsultancies.com`, no `pm2`, no SSH binary or key, and no
DDL-capable database connection. Deployment and migration application are
therefore **operator steps**, not something this environment can perform. No
credential is requested in chat.

The production site itself **is** reachable read-only over HTTPS (see §6).

---

## 6. Phase 3/5 — Read-only production verification (no modification)

The live app answers, and the deployed middleware already enforces the
authentication gate:

```
$ curl -s -o /dev/null -w "%{http_code} %{redirect_url}" .../dashboard
307 https://speed.harbourconsultancies.com/login
$ curl .../accounting/journal-entries    -> 307 -> /login
$ curl .../financial-dashboard           -> 307 -> /login
$ curl .../                              -> 200
$ curl .../login                         -> 200
$ curl .../api/me                        -> 401
$ curl .../api/invoices                  -> 401
$ curl .../api/public/vehicles           -> 200   (public marketing read works)
$ curl .../api/saas/signup               -> 405   (GET not allowed; POST-only route exists)
```

Server: `nginx/1.18.0 (Ubuntu)`. So, in production today:

- Anonymous protected **pages redirect to `/login`** (307) — acceptance test #8 ✔
- Anonymous protected **APIs return 401** — acceptance test #9 (API half) ✔
- Legitimate **public reads** work — acceptance test #10 ✔

### Honest limitation on route fingerprinting

An anonymous GET cannot reveal which API routes are deployed, because middleware
gates **every** `/api/*` path before the route runs — a *nonexistent* API path
returns 401 too:

```
$ curl .../api/zzz-nonexistent-xyz   -> 401   (control — route does not exist)
```

Therefore no claim is made about whether the Exec 33–35 posting routes are in the
deployed build. Confirming the **deployed commit** requires the operator to run
`git -C /var/www/speed.harbourconsultancies.com rev-parse HEAD` on the VM.

### Tenant-isolation acceptance tests (#1–#7): NOT executed against production

Tests #1–#7 require **two authenticated identities against the live database**.
From this environment that would mean (a) creating live test users and (b)
issuing authenticated cross-tenant writes against production — both excluded by
this execution's constraints (no live admin credentials created, no production
writes). They remain **unverified in production**. Their *local* counterparts are
green in the Exec 36 suite (tenant isolation, RLS, anon-denial, super-admin
policy). Live confirmation is an operator step (see §9).

---

## 7. Test, typecheck, lint, build (local — clearly distinguished from live)

Run at HEAD the Exec 37 commit:

| Gate | Result |
| --- | --- |
| `npm test` | **780 tests / 774 pass / 6 skipped / 0 fail** |
| `npx tsc --noEmit` | **125 errors — the unchanged pre-existing baseline, 0 new** |
| `npm run lint` | **clean** (`✔ No ESLint warnings or errors`) |
| `npm run build` | **exit 0** (placeholder env, removed immediately after) |

These are **local** results. They are not evidence of production behaviour.

---

## 8. Phase 4 — Deployment readiness report

### 8.1 Source and target

| | Value |
| --- | --- |
| Source commit | the Exec 37 commit on `feat/final-hardening-round5` (top of branch) |
| Release checksum | `<see release/speed-<short-sha>.sha256>` |
| Target path | `/var/www/speed.harbourconsultancies.com` |
| Process | PM2 app `speed`, port `3090` |
| Domain | `https://speed.harbourconsultancies.com` |
| Production commit | **UNKNOWN from here** — read it on the VM (see §9) |

### 8.2 Configuration differences

- Deployment target uses `git pull --ff-only origin main` on the **`main`**
  branch, but all Exec 33–37 work is on **`feat/final-hardening-round5`**. The
  release cannot be pulled until the branch is merged to `main` (or the server
  fetches this branch explicitly). This is a **decision for the owner**, not a
  step this execution may take.
- `.env.local` must be preserved on the server (untracked; never overwritten).

### 8.3 Required environment variables (names only — never values)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `NODE_ENV`. (Provisioning scripts additionally read
`COMPANY_ADMIN_EMAIL`, `COMPANY_ADMIN_PASSWORD`, `SUPER_ADMIN_EMAIL`,
`SUPER_ADMIN_PASSWORD`.) None of these is printed or committed anywhere.

### 8.4 Deployment commands (for the operator, on the VM)

```bash
cd /var/www/speed.harbourconsultancies.com
git rev-parse HEAD                       # record the CURRENT commit first
git status --porcelain                   # must be clean; if not, STOP
cp -a . ../speed-backup-$(date +%Y%m%d%H%M%S)   # filesystem rollback point
git pull --ff-only origin main           # or the release branch, per owner
npm ci                                   # or npm install
npm run build
pm2 restart speed --update-env
```

### 8.5 Rollback

```bash
cd /var/www/speed.harbourconsultancies.com
git reset --hard <previous-commit>       # owner-authorized only
npm ci && npm run build && pm2 restart speed --update-env
# or restore the ../speed-backup-<ts> directory
```

Database rollback: each migration has a paired `*_rollback.sql`; none drops data.
Do **not** restore an old database dump over newer transactions.

### 8.6 Migration application order (Supabase Dashboard SQL Editor)

001→002→003 (`PRODUCTION_ACTIVATION_001_002_003.sql`), then 004, then 005→006,
then 007. Run the 005 pre-flight duplicate query first (must return zero rows).
Confirm the SQL Editor shows project ref `chlkmdobhvfnldqkgdji` before executing.

### 8.7 Smoke-test / health-check commands

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://speed.harbourconsultancies.com/
curl -s -o /dev/null -w '%{http_code}\n' https://speed.harbourconsultancies.com/login
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://speed.harbourconsultancies.com/dashboard  # expect 307 -> /login
curl -s -o /dev/null -w '%{http_code}\n' https://speed.harbourconsultancies.com/api/me                      # expect 401
pm2 logs speed --lines 100
```

---

## 9. Blockers, exact permissions needed, next action

1. **Production host access (BLOCKER).** No SSH/shell on the VM, no `pm2`, no
   `/var/www`. Needed: either the owner runs the §8.4 sequence, or grants a
   deployment path this environment can use. Never paste passwords/keys into chat.
2. **Branch decision (BLOCKER for the pull).** The release is on
   `feat/final-hardening-round5`; the server deploys from `main`. Owner must merge
   (or authorize a branch-specific deploy).
3. **DDL access (BLOCKER for migrations).** No DDL-capable connection. The
   packages are prepared and integrity-verified; an operator must paste them into
   the Supabase SQL Editor for `chlkmdobhvfnldqkgdji`.
4. **Live isolation proof (#1–#7).** Needs two authenticated live identities and
   live writes; out of scope here. Operator step after migration application.
5. **Deployed-commit confirmation.** Read `git rev-parse HEAD` on the VM.

**Next action:** owner merges `feat/final-hardening-round5` → `main`, applies
packages 001–007 in order, then runs §8.4 on the VM. This environment is ready
with the artifact and the frozen packages but cannot perform those steps.

---

## 10. Final status table

| Phase | Status |
| --- | --- |
| 1 — Verify release (repo/commit/artifact/migrations/hygiene) | **COMPLETE** |
| 2 — Establish deployment access | **PARTIAL** — GitHub yes; production host no |
| 3 — Protect production (backup) | **BLOCKED** — no host access; read-only probes only |
| 4 — Release sequence | **PREPARED, NOT EXECUTED** — readiness report §8 |
| 5 — Post-deployment verification | **NOT PERFORMED** — nothing deployed |

**No production deployment occurred and no migration was applied.** The
read-only production facts in §6 are the only live observations, and they are
labelled as such. No temporary administrator credentials are produced or printed
by this execution.

## 11. Credentials

This execution created, rotated, and printed **no** administrator credentials. It
made no production database contact. The only password-shaped string anywhere in
the repository is the deliberate redaction-test fixture in
`tests/ai-assistant.test.ts`.
