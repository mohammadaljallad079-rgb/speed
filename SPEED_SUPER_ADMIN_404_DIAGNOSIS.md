# SPEED ERP — Super Admin Production 404 Diagnosis

**Repository:** `github.com/mohammadaljallad079-rgb/speed`
**Branch with the implementation:** `feat/final-hardening-round5`
**Production:** `https://speed.harbourconsultancies.com` (nginx 1.18.0 → Next.js, PM2 app `speed`, port 3090)
**Investigated from commit:** `0a9f17e`
**Date:** 2026-10-24

---

## 1. Verdict

The 404 is **not** a routing, middleware, Next.js or nginx fault. The Super Admin
code has **never been merged into `main`**, and the server deploys `main`. The
production build therefore contains no `/super-admin` or `/super-admin-login`
route, and Next.js correctly 404s both paths.

**Nothing is broken in the Super Admin implementation. The fix is a release, not
a code change.**

---

## 2. Exact cause, with evidence

### 2.1 Production genuinely 404s, and Next.js is the one answering

```
$ curl -s -o /dev/null -w "%{http_code}\n" https://speed.harbourconsultancies.com/super-admin-login
404
$ curl -s -o /dev/null -w "%{http_code}\n" https://speed.harbourconsultancies.com/super-admin
404
```

Response headers on `/super-admin`:

```
HTTP/2 404
server: nginx/1.18.0 (Ubuntu)
cache-control: private, no-cache, no-store, max-age=0, must-revalidate
vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch, Accept-Encoding
x-powered-by: Next.js
```

`x-powered-by: Next.js` plus the RTL `__variable_bf4a91 font-tajawal` app shell in
the body prove this is **Next.js's own `not-found` page**, not an nginx
`try_files`/proxy miss. The request reached the app; the app has no such route.

### 2.2 The code is absent from `main`

```
$ git ls-tree -r --name-only origin/main | grep "^src/app/super-admin"
(NONE - no super-admin pages or APIs on main)

$ git ls-tree -r --name-only origin/main | grep "src/lib/super-admin"
(NONE)

$ git ls-tree -r --name-only HEAD | grep "^src/app/super-admin"
src/app/super-admin-login/page.tsx
src/app/super-admin/page.tsx
```

### 2.3 The implementation commit was never merged

`src/app/super-admin/page.tsx` and `src/app/super-admin-login/page.tsx` were
added by commit `c536858` ("feat(exec41): routes, global Super Admin console, AI
activation, unified formats").

```
$ git merge-base --is-ancestor c536858 origin/main && echo YES || echo NO
NO                      # exec41 is NOT on main
$ git merge-base --is-ancestor c536858 HEAD && echo YES || echo NO
YES                     # it IS on the feature branch
```

### 2.4 `main` is a direct ancestor of the branch — the release is a clean fast-forward

```
$ git merge-base origin/main HEAD
d6788be   (origin/main, origin/HEAD, main)

$ git merge-base --is-ancestor origin/main HEAD && echo YES
YES
```

`origin/main` is at `d6788be` ("exec39: record promotion outcome in AGENTS.md,
docs-only"). The branch tip is `8e06dcc` (plus this diagnosis). **The branch is
29+ commits ahead and 0 behind.** No merge conflicts are possible.

Exec 39 promoted the branch to `main` at `c1f4d1d`… but note that promotion
stopped at **Exec 39**. Everything from **Exec 41 onward — including the entire
Super Admin console — has never been on `main`.**

### 2.5 The deployed bundle confirms a pre-Exec-41 build

The production login chunk
(`/_next/static/chunks/app/login/page-2a845cb5f41223ec.js`) contains:

```js
if (u?.role !== "admin" && u?.role !== "super_admin" && u?.role !== "staff") { ... }
```

So production **does** know the `super_admin` *role* (that landed earlier, in
migration 004 / Exec 07), but **no chunk anywhere in the deployed build contains
a `/super-admin` route** — 18 chunks downloaded and grepped; only the role string
above matched. This is exactly the signature of a build that predates Exec 41.

### 2.6 The 404 is consistent with the deployed middleware, which also predates Exec 41

`src/middleware.ts` on the branch lists `/super-admin` in
`PROTECTED_PAGE_PREFIXES`, so an anonymous request is redirected (307), not
404'd:

```
$ curl -o /dev/null -w "%{http_code} %{redirect_url}\n" .../dashboard
307 https://speed.harbourconsultancies.com/login
$ curl -o /dev/null -w "%{http_code} %{redirect_url}\n" .../super-admin
404
```

If the deployed middleware knew `/super-admin`, the response would be `307`, not
`404`. Production returned `404` with no redirect, which is only possible when
the middleware does not recognise the prefix **and** no page route exists. Both
facts point to the same conclusion: the running build is older than Exec 41.

`/super-admin-login` is deliberately **not** in `PROTECTED_PAGE_PREFIXES` (it is
the public door), so its 404 is purely "the page route does not exist".

---

## 3. What is missing from production (full gap)

`main` is missing 25 page/route files added since Exec 39, including:

| Area | Missing from production |
|---|---|
| Super Admin | `/super-admin`, `/super-admin-login`, `/api/super-admin/{overview,ai,tenants/[id],users/[id]}` |
| General Ledger | `/reports/general-ledger` |
| Purchasing reports | `/reports/purchase-register`, `supplier-ledger`, `supplier-aging`, `vat-purchases`, `monthly-expenses`, `expenses-by-category`, `expenses-by-branch`, `expenses-by-vehicle`, `vehicle-profitability` |
| Purchasing API | `/api/purchases`, `/api/supplier-payments`, `/api/debit-notes`, `/api/reports/purchasing` |
| Migrations | `008_user_role_hardening`, `009_depreciation_accounts`, `010_purchasing_accounts` (+ rollbacks) |
| Activation packages | `PRODUCTION_ACTIVATION_008/009/010.sql` |

**Note:** `/reports/general-ledger`, `/purchases` and `/settings/ai-control`
return `307` on production — but a `307` only proves the *middleware* knows the
prefix (those prefixes existed before Exec 41). It does **not** prove the page
exists. After sign-in those paths may still 404. **Route presence cannot be
established from an unauthenticated request**; confirm on the VM after deploy.

---

## 4. Required fix

**Promote the feature branch to `main` and redeploy.** No source change is
needed for the 404 itself.

```bash
# On a workstation with push rights (NOT production):
cd <clone>
git fetch origin
git checkout main
git merge --ff-only feat/final-hardening-round5   # fast-forward; main is an ancestor
git push origin main
```

Then follow the production runbook in §5.

**Alternative (no `main` change):** deploy the feature branch directly by
checking it out on the server instead of `main`. Not recommended — it diverges
from the documented deploy procedure and makes the next `git pull --ff-only
origin main` a surprise.

---

## 5. Production deployment + migration checklist (for your approval — NOT executed)

### 5.0 Preconditions

- [ ] Owner approval obtained (this document is a proposal only).
- [ ] Migration `005` duplicate pre-check run first — **must return ZERO rows**
      (`supabase/EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql`). Migration 005 runs in a
      single transaction, so a pre-existing duplicate aborts the whole apply.
- [ ] A maintenance window agreed; the app will be briefly unavailable during
      `npm run build`.

### 5.1 Backups (do these first, verify them, and keep the rollback artefacts)

```bash
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p /root/backups

# 1. Application tree (excludes node_modules/.next — rebuildable, and large).
cd /var/www/speed.harbourconsultancies.com
tar --exclude=node_modules --exclude=.next -czf /root/backups/speed-app-$TS.tgz .
tar tzf /root/backups/speed-app-$TS.tgz | head        # verify the archive

# 2. The environment file — untracked and NOT in git. Losing it breaks the app.
cp -a .env.local /root/backups/env-local-$TS.bak
wc -c /root/backups/env-local-$TS.bak                 # verify it is non-empty

# 3. Record the currently deployed commit, so rollback is unambiguous.
git rev-parse HEAD | tee /root/backups/deployed-commit-$TS.txt

# 4. Database backup — via the Supabase dashboard (Database → Backups) or:
#    pg_dump "$DATABASE_URL" -Fc -f /root/backups/speed-db-$TS.dump
#    Verify with: pg_restore --list /root/backups/speed-db-$TS.dump | head
```

- [ ] App archive created and listable
- [ ] `.env.local` copied and non-empty
- [ ] Deployed commit recorded
- [ ] Database backup taken and verifiable

### 5.2 Database migrations (apply BEFORE or WITH the code, in this order)

Apply in the Supabase SQL Editor on project `chlkmdobhvfnldqkgdji`, in order.
**Never continue past a failed statement.**

| Order | Package | Notes |
|---|---|---|
| 1 | `PRODUCTION_ACTIVATION_001_002_003.sql` | Only if not already applied — check first |
| 2 | `PRODUCTION_ACTIVATION_004.sql` | Super Admin role + isolation predicates |
| 3 | `PRODUCTION_ACTIVATION_005_006.sql` | Run the duplicate pre-check first |
| 4 | `PRODUCTION_ACTIVATION_007.sql` | Purchase↔sale links |
| 5 | `PRODUCTION_ACTIVATION_008.sql` | User-role hardening |
| 6 | `PRODUCTION_ACTIVATION_009.sql` | Depreciation accounts |
| 7 | `PRODUCTION_ACTIVATION_010.sql` | Purchasing accounts + sequences |

- [ ] Confirm which of 001–007 are already applied before re-running them
      (all are idempotent, but confirm rather than assume).
- [ ] Each package's POST-FLIGHT block returns green.
- [ ] **`/super-admin` requires migration 004** — `is_super_admin()` and the
      extended tenant predicates. Deploying the code without 004 gives a console
      that loads but cannot read across tenants.

### 5.3 Deploy the application

```bash
cd /var/www/speed.harbourconsultancies.com
git status                     # expect clean; .env.local must remain untracked
git pull --ff-only origin main
npm ci                         # or: npm install   (match the project's lockfile)
npm run build
pm2 restart speed --update-env
pm2 save
pm2 status
pm2 logs speed --lines 100     # expect no errors
```

- [ ] `git pull --ff-only` succeeded (no merge commit, no `--force`)
- [ ] `.env.local` still present after the pull
- [ ] `npm run build` completed with no errors
- [ ] PM2 restarted and `online`
- [ ] PM2 logs show no startup errors

### 5.4 Verification (evidence, not assumption)

```bash
# From the server (bypasses nginx):
curl -s -o /dev/null -w 'local /super-admin-login -> %{http_code}\n' http://127.0.0.1:3090/super-admin-login
curl -s -o /dev/null -w 'local /super-admin        -> %{http_code}\n' http://127.0.0.1:3090/super-admin

# Through nginx:
curl -s -o /dev/null -w 'public /super-admin-login -> %{http_code}\n' https://speed.harbourconsultancies.com/super-admin-login
curl -s -o /dev/null -w 'public /super-admin       -> %{http_code} redirect=%{redirect_url}\n' https://speed.harbourconsultancies.com/super-admin
```

**Expected after a correct deploy:**

| Path | Expected |
|---|---|
| `/super-admin-login` | `200` (public page) |
| `/super-admin` (anonymous) | `307` → `/login` (middleware protects it) |
| `/login`, `/dashboard` | unchanged (`200`, `307`) |
| `/api/me` anonymous | `401` (unchanged) |
| `/api/public/*` | `200` (unchanged) |

- [ ] `/super-admin-login` returns `200`
- [ ] `/super-admin` returns `307` (not `404`)
- [ ] Confirm the deployed commit: `git rev-parse HEAD` on the server matches the
      promoted `main`
- [ ] Sign in at `/super-admin-login` with the existing super-admin account and
      confirm the six tabs render. **Do not recreate or reset any administrator
      account.**
- [ ] Spot-check one previously-missing page (e.g. `/reports/general-ledger`) is
      no longer a 404 after sign-in.

### 5.5 Rollback

Application (fast, always available):

```bash
cd /var/www/speed.harbourconsultancies.com
git reset --hard <deployed-commit-from-5.1>     # the recorded pre-deploy SHA
rm -rf .next && npm ci && npm run build
pm2 restart speed --update-env
```

Or restore the archive: `tar xzf /root/backups/speed-app-$TS.tgz -C /var/www/speed.harbourconsultancies.com`.

Database: each migration ships a non-destructive `*_rollback.sql`. **Rollback
never restores an old database over newer transactions, and journals are never
edited by hand** — reverse via in-app documents. Migration 004's rollback in
particular must not be applied while super-admin accounts exist.

- [ ] Rollback procedure rehearsed (or at least read and understood) before deploying

---

## 6. Honest limitations of this diagnosis

- **No access to the production host from this environment.** There is no
  `/var/www`, no `pm2`, and no `ssh` from the sandbox (documented in AGENTS.md,
  Exec 38). Everything above about the server's state is inferred from the
  **public HTTP responses** plus the git history — both of which are conclusive
  here. The specific commit hash actually checked out on the server
  (`git rev-parse HEAD` on the VM) has **not** been read and should be confirmed
  during the deploy.
- **The nginx configuration was not inspected.** It does not need to change: the
  404 was served by Next.js, which proves nginx proxied the request correctly.
  If the post-deploy verification in §5.4 still 404s while the local port-3090
  check returns 200, *then* nginx becomes the suspect.
- **Migration state on the live database was not read.** The order in §5.2 is the
  authoritative sequence from the migration files and Exec 38's runbook; confirm
  what is already applied before running anything.
- **No production deployment, no database change, and no administrator account
  was touched by this investigation.** The probes were read-only HTTP GETs.

---

## 7. Summary

| Question | Answer |
|---|---|
| Why does `/super-admin` 404? | The route does not exist in the deployed build, because `main` has never contained the Super Admin code. |
| Is the Super Admin code broken? | No. It builds correctly on the branch — both routes appear in the app-path-routes manifest. |
| Is it nginx? | No. Next.js served the 404 (`x-powered-by: Next.js`, app 404 shell). |
| Is it middleware? | No. The branch's middleware protects `/super-admin` with a 307; production 404s, which means the deployed middleware predates that entry. |
| What is the fix? | Fast-forward `main` to the branch tip and redeploy, then apply migrations 008–010 (and confirm 001–007). |
| What is the risk? | Low for the app (clean fast-forward, no conflicts). The database step is the one that needs care: 005 must pass its duplicate pre-check, and 004 is required for the console to work. |
