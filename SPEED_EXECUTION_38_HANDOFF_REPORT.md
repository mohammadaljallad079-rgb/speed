# SPEED ERP — Execution 38: Production Deployment Handoff

**Status:** Release frozen and the operator handoff is complete. **Nothing was
deployed, no migration was applied, no branch was changed, and no credential was
touched.** Every value below is verified from the repository or a prior report;
anything unverified is labelled.

Companion document (Arabic operator runbook):
`SPEED_EXECUTION_38_DEPLOYMENT_HANDOFF_AR.md`.

---

## 1. Release freeze (verified)

> **Release commit vs. handoff commit.** The deployable release is frozen at
> `dd28b5e`. These Exec 38 handoff documents are committed **after** it as a
> docs-only commit that changes no runtime file, so the release checksum below
> stays non-circular and independently reproducible: check out `dd28b5e`, rebuild
> the deterministic archive, and the SHA-256 matches. An operator deploying the
> tip of the merged branch simply also carries these two Markdown files.

| Item | Value |
| --- | --- |
| Repository | `https://github.com/mohammadaljallad079-rgb/speed` |
| Branch | `feat/final-hardening-round5` |
| **Release commit (frozen, deployable)** | `dd28b5e821ed29aa9e9541c3b19956ec0548906f` (`dd28b5e`) |
| Parent | `595e7d4` (Exec 36) |
| Working tree | clean |
| `origin/main` | `29a005c4a9ddc964f6d92662c25ca991ca7fb477` |
| Relation | **22 ahead, 0 behind** — clean fast-forward |
| `origin/main` is ancestor of HEAD | **yes** (merge-base == `29a005c`) |

```
$ git rev-parse HEAD                                  -> dd28b5e821ed29aa9e9541c3b19956ec0548906f
$ git rev-list --count origin/main..HEAD              -> 22
$ git rev-list --count HEAD..origin/main              -> 0
$ git merge-base --is-ancestor origin/main HEAD       -> (exit 0) FF-safe
$ git status --porcelain                              -> (empty)
```

### Release archive verified against the exact commit

```
$ sha256sum release/speed-dd28b5e.tar.gz
5a4c38b40ddd5eca089daa41929dfdad12707e7f8d09e3367a5c6b3c8bce4a7a
```

- Extracted and diffed against a fresh extraction of `git ls-files` →
  **byte-identical, 462 files**, matching `git ls-files | wc -l` (462).
- Archive is git-ignored (`/release/`), never committed; contains no `.env`,
  `*.pem`, `*.key` or backup file.

---

## 2. Migrations 001–007 ↔ activation packages (verified)

| # | Migration | Activation package | Verified |
| --- | --- | --- | --- |
| 001 | `001_core_security.sql` | `PRODUCTION_ACTIVATION_001_002_003.sql` | ✔ embedded verbatim + SHA banner |
| 002 | `002_tenant_isolation_hardening.sql` | (same bundle) | ✔ |
| 003 | `003_sales_lifecycle.sql` | (same bundle) | ✔ |
| 004 | `004_global_super_admin.sql` | `PRODUCTION_ACTIVATION_004.sql` | ✔ |
| 005 | `005_accounting_integrity.sql` | `PRODUCTION_ACTIVATION_005_006.sql` | ✔ |
| 006 | `006_ai_repair.sql` | (same bundle) | ✔ |
| 007 | `007_purchase_sale_links.sql` | `PRODUCTION_ACTIVATION_007.sql` | ✔ |

`tests/activation-package-integrity.test.ts` recomputes every embedded SHA-256
against the source migration and rejects destructive/privilege-widening SQL:

```
$ npx tsx --test tests/activation-package-integrity.test.ts
ℹ tests 20   ℹ pass 20   ℹ fail 0
```

So **all seven migrations have an operator-runnable package whose checksum
matches its source migration at this release**. No forward migration contains a
destructive statement.

---

## 3. Branch decision (resolved safely — NOT executed)

**Finding:** the server deploys from `main`, but `origin/main` does **not**
contain the Exec 33–37 commits; they live only on `feat/final-hardening-round5`.
Local `main` (`3cd6e59`) is 3 commits behind `origin/main` (`29a005c`). The other
branch `feat/exec07-admin-superadmin-hardening` (`f02125d`) is already fully
merged (ancestor of both `HEAD` and `origin/main`).

**Fast-forward-safe publishing sequence** (owner-authorized; run from a clean
local clone, not the server):

```bash
git fetch origin
git merge-base --is-ancestor origin/main feat/final-hardening-round5   # FF-safe
git rev-list --count origin/main..feat/final-hardening-round5          # 22
# Guard: the release cannot silently omit Exec 33–37
for s in bbc5e3a 795292f f008ec7 595e7d4 dd28b5e; do
  git merge-base --is-ancestor "$s" dd28b5e && echo "ok $s" || echo "MISSING $s"
done
git checkout main
git merge --ff-only origin/main
git merge --ff-only feat/final-hardening-round5
git push origin main          # ordinary push — never --force
```

**Why this cannot silently omit Exec 33–37:** the server pulls with
`git pull --ff-only origin main`; a plain `git pull` after a proper merge lands on
`dd28b5e`, whose ancestry provably contains `bbc5e3a … dd28b5e`. The explicit
ancestor guard above turns any omission into a hard failure. `--force` and
`reset --hard` are never used.

No push, merge, or GitHub branch change was performed.

---

## 4. Operator deployment package (Arabic runbook)

`SPEED_EXECUTION_38_DEPLOYMENT_HANDOFF_AR.md` contains, in Arabic:

1. Required access and prerequisites (with the dev-environment gaps labelled).
2. Exact source commit and archive checksum.
3. Pre-deployment checks (branch, clean tree, `.env.local`, disk, Node).
4. Application + database backup requirements.
5. Safe install commands (`git pull --ff-only` → `npm ci` → `npm run build` →
   `pm2 restart speed --update-env`).
6. PM2 restart and health-check commands (local port 3090 + public domain).
7. Rollback that preserves financial data (no DB restore over newer data; reverse
   via in-app documents, never manual journal edits).
8. Post-deployment smoke tests and the exact evidence to collect.

All server paths, the PM2 app name (`speed`), port (`3090`), domain, and the
Supabase project ref (`chlkmdobhvfnldqkgdji`) are taken from `AGENTS.md` and prior
reports. Anything not verified (current deployed commit, DB backup availability,
`DATABASE_URL`, Node version) is explicitly labelled **«غير مؤكد — يجب التحقق على
الخادم»**.

---

## 5. Database activation (documented, NOT applied)

**Order (mandatory):** 001→002→003, then 004, then 005→006, then 007, via the
Supabase SQL Editor on project `chlkmdobhvfnldqkgdji`.

**Prerequisites / assumptions:**
- 002 defines `can_read_tenant()` / `can_write_tenant()`; 005 and 007 depend on
  002, and 005 additionally needs the 003 columns.
- 007 references `public.purchase_invoices` and `public.invoices` (present live).
- The current install is single-tenant (every `tenant_id` NULL); `can_read_tenant`
  is NULL-tolerant so it keeps working, while `can_write_tenant` is strict.

**Migration 005 duplicate pre-check (mandatory):** before the 005/006 package,
run its embedded pre-flight query. It must return **zero rows**; otherwise 005
aborts by design (it is wrapped in one transaction, so a failure rolls the whole
file back). The operator must resolve duplicate posted journals first — never skip
or ignore the failed statement.

**007 package:** included, generated verbatim from the source migration, SHA-256
banner verified by the integrity test (007 body hash
`cdc7d0f8f2c452a703089594aef57179cc6629b87fc0b29f0d1230b5d1ad4b68`).

No migration was applied and no production credential was accessed.

---

## 6. Production verification plan

### Anonymous (can run now, no identity)

| Check | Command | Expected |
| --- | --- | --- |
| Root | `curl -s -o /dev/null -w '%{http_code}' .../` | 200 |
| Login page | `.../login` | 200 |
| Protected page | `.../dashboard` | 307 → `/login` |
| Protected API | `.../api/me` | 401 |
| Public API | `.../api/public/vehicles` | 200 |

These were observed live in Exec 37 and must hold after deploy.

### Authenticated (require authorized identities — operator)

1. **Company admin** (`admin`, tenant-scoped): log in → `/dashboard` →
   administer only the SPEED tenant.
2. **Super admin** (`super_admin`, tenant-less): log in → `/dashboard` → reach
   global administration; **not** scoped to the SPEED tenant.
3. **Tenant isolation with two identities:** tenant A cannot read, insert, update
   or delete tenant B's records.
4. **Financial workflows:** sales invoice, rental invoice, purchase, payroll,
   bank transfer, journal entry, financial report — journals balanced
   (debit = credit).
5. **Duplicate protection:** resending the same request creates no second journal.

Ready-made verification (reads credentials from environment; prints PASS/FAIL
only, never a password):
```bash
npm run verify:admins
```

**Distinction:** items in the anonymous table can be run by anyone; items 1–5
require authenticated identities and an authorized operator. No tenant-isolation
result is claimed here — it has not been run against production.

---

## 7. Deliverables

- `SPEED_EXECUTION_38_DEPLOYMENT_HANDOFF_AR.md` — Arabic operator runbook.
- `SPEED_EXECUTION_38_HANDOFF_REPORT.md` — this report.

Committed locally only. No push, no deploy.

---

## 8. Status and blockers

| Phase | Status |
| --- | --- |
| 1 — Freeze release | **COMPLETE** |
| 2 — Branch decision | **RESOLVED (documented)**; push/merge NOT performed |
| 3 — Operator package | **COMPLETE** (Arabic runbook) |
| 4 — Database activation | **DOCUMENTED, NOT APPLIED** |
| 5 — Verification plan | **PROVIDED**; live authenticated checks NOT run |

**Blockers (exact):**
1. **No production host access** — no `/var/www`, `pm2`, `ssh`, or CI in this
   environment. Needed: the owner runs the runbook on the VM, or grants a deploy
   path.
2. **Branch merge authorization** — `feat/final-hardening-round5` must be merged
   to `main` (sequence in §3) before the server can pull it.
3. **DDL access** — apply packages 001–007 via the Supabase SQL Editor for
   `chlkmdobhvfnldqkgdji`; no DDL path exists here.

**No production deployment, database activation, or live tenant isolation is
claimed.** Those remain owner/operator steps, each with the exact command and
prerequisite recorded above.
