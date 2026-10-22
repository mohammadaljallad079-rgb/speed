# SPEED ERP — Execution 47: Final Operator Handoff

> **Local-only execution. No deployment, no SQL, no migration, no RLS change, no
> admin-account change.** No authorized live access exists in this environment
> (verified in §2), so every live step below is a **prepared operator action**, not
> something performed here. No secret was printed, committed, or exposed.

Handoff prepared by an AI agent (OpenHands) on behalf of the repository owner.

---

## 0. Verified state at handoff

| Item | Value |
| --- | --- |
| Authorized repo | `https://github.com/mohammadaljallad079-rgb/speed.git` |
| Branch | `feat/final-hardening-round5` |
| HEAD | `c0802e0c5bfe27977c4c0e493cdd9f4519a37fee` (`c0802e0`) |
| `c0802e0` on authorized remote branch | **yes** |
| Working tree | **clean** |
| `origin/main` | `d6788be` — **unchanged** |
| Feature vs `main` | **8 ahead / 0 behind** → fast-forward promotion is possible |
| Supabase project ref | `chlkmdobhvfnldqkgdji` |
| Last validated gates (Exec 46) | tests 796/790/0/6 · tsc 125 (baseline) · lint clean · build exit 0 |

Release freeze candidate = **`c0802e0`**. No commit is created by this execution
until the handoff document itself is committed (§7).

---

## 1. Authorized access check (facts, no secrets)

| Capability | State |
| --- | --- |
| `.env*` file | **absent** |
| `DATABASE_URL` | **unset** |
| `SUPABASE_SERVICE_ROLE_KEY` | **unset** |
| `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` | **unset** |
| `SUPABASE_DB_PASSWORD` / `SUPABASE_ACCESS_TOKEN` | **unset** |
| `supabase` CLI / `psql` / `pg_dump` | **absent** |
| `/var/www/speed.harbourconsultancies.com` | **absent** |
| `pm2` | **absent** |

**Conclusion:** there is **no** DDL-capable database connection and **no**
production service-role/SSH access. Therefore **no live operation is authorized or
possible from here** — every item in §3–§6 is an operator action. Live production
conditions remain **UNVERIFIED** (not "fixed", not "applied").

---

## 2. Consolidated operator requirements (access + decisions)

### Required access
1. **A1 — DDL-capable database access** to `chlkmdobhvfnldqkgdji` (a valid
   `DATABASE_URL` / pooler string), **or** a Supabase SQL-Editor session as the
   `postgres` role. Needed to run the preflight and apply 001–007.
2. **A2 — Production service-role credentials** (`NEXT_PUBLIC_SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY`) for `npm run provision:admins` / `verify:admins`.
3. **A3 — Production server access** (SSH/`pm2` at
   `/var/www/speed.harbourconsultancies.com`, port 3090) for the single deploy.
4. **A4 — Explicit authorization** to (a) apply migrations, (b) provision the two
   admin accounts, (c) promote the feature branch to `main`, (d) deploy.

### Required business decisions
5. **D1 — Depreciation:** depreciation-expense account code, accumulated-
   depreciation (contra-asset) code, posting frequency, start convention.
6. **D2 — Loans:** interest-expense account code, repayment account (cash `11001`
   vs bank `11002`), late-fee policy.
7. **D3 — Orphan credit routes:** keep, remove, or redirect `credits/new` +
   `credits/print` (unreferenced; function is covered by `sales/new` +
   `invoices/new`).
8. **D4 — `.bak` history:** optional separate history-scrub (not required; the 39
   backups are already untracked, local copies preserved).

Nothing else is outstanding. No depreciation/loan accounting rule will be invented;
no credit route will be deleted without D3.

---

## 3. Step-by-step operator runbook (exact order)

> Run every step on the production VM or with an authorized DB session. **Stop at
> the first stop condition.**

### STEP 1 — Application backup (recoverable)
```bash
TS=$(date +%Y%m%d_%H%M%S); mkdir -p /root/backups
cd /var/www/speed.harbourconsultancies.com
tar czf /root/backups/speed-app-$TS.tgz --exclude=.next -C /var/www/speed.harbourconsultancies.com .
tar tzf /root/backups/speed-app-$TS.tgz >/dev/null && echo "APP BACKUP OK: $TS"
sha256sum /root/backups/speed-app-$TS.tgz | tee /root/backups/speed-app-$TS.sha256
git rev-parse HEAD | tee /root/backups/speed-app-$TS.commit
```
**Expected:** `APP BACKUP OK`, a `.sha256`, and the current production commit.
**Stop condition:** `tar tzf` fails, or the archive is empty.

### STEP 2 — Database backup / PITR checkpoint (recoverable)
Preferred: in the Supabase dashboard, **confirm a PITR restore point** immediately
before the migration window and record the timestamp.
Alternative (if a connection string is available):
```bash
pg_dump "$DATABASE_URL" -Fc -f /root/backups/speed-db-$TS.dump
pg_restore --list /root/backups/speed-db-$TS.dump | head && echo "DB BACKUP OK"
```
**Expected:** a restore point, or a dump that `pg_restore --list` reads.
**Stop condition:** no restorable backup/PITR → **do not proceed**.

### STEP 3 — Duplicate-journal preflight (READ-ONLY; the 005 gate)
Paste `supabase/EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql` into the SQL Editor and run
**BLOCK 1**.
**Expected:** **ZERO rows.**
**Stop condition:** any row → resolve those duplicate postings first, re-run BLOCK 1
until zero. **005 is blocked until BLOCK 1 returns zero rows.** (BLOCK 3 tells you
whether 005 is already applied.)

### STEP 4 — Apply the frozen activation bundles, in this exact order
Run each whole file in the SQL Editor as `postgres`, one at a time, verifying it
completes before the next:

```
1) supabase/PRODUCTION_ACTIVATION_001_002_003.sql
2) supabase/PRODUCTION_ACTIVATION_004.sql
3) supabase/PRODUCTION_ACTIVATION_005_006.sql
4) supabase/PRODUCTION_ACTIVATION_007.sql
```
Notes:
- The bundle bodies are **byte-identical** to `supabase/migrations/001…003`
  (SHA-256 verified: `e4adc370…`, `b411c30c…`, `f274e212…`).
- Migrations **004, 005, 006, 007 already carry their own `begin; … commit;`** —
  run them as-is.
- Migrations **001, 002, 003 have no explicit transaction**. Every statement in
  them is transaction-safe DDL (verified: no `CONCURRENTLY`, no `VACUUM`, no
  `ALTER TYPE … ADD VALUE`, no `CREATE DATABASE`). To make the whole 001→003 run
  all-or-nothing, the operator **may** wrap it: `begin;` … paste … `commit;`.
  (Do **not** add `begin/commit` around any statement that does not support
  transactional execution — there are none in these files.)
- **Idempotency:** all four bundles are additive/idempotent; safe to re-run.
**Expected:** each file returns success; no error.
**Stop condition:** any error → stop, restore from STEP 1/2, and report the exact
error text.

### STEP 5 — Verify migration state & isolation
1. **Applied state:** confirm the objects exist (e.g.
   `select to_regclass('public.v_journal_integrity_issues');`,
   `select to_regclass('public.purchase_sale_links');`, and that the new
   `tenant_id` columns exist).
2. **Idempotency:** re-run one bundle; expect no error and no duplicate objects.
3. **Anon denial:** run `supabase/ANON_VERIFICATION.sql`; expect **all write probes
   denied** and protected reads denied.
4. **Two-tenant isolation:** with **two real tenants**, confirm Tenant A cannot
   read / insert / update / delete Tenant B's rows, and that `tenant_id IS NULL`
   is not a cross-tenant path.
5. **Company-admin scope:** the company admin cannot read another tenant.
6. **Super-admin policy:** the super admin follows the explicit 004 policy.
**Stop condition:** any cross-tenant success, or anon write success → **stop and
roll back** (§6).

### STEP 6 — Provision + verify the two admin accounts (only with A2 + A4)
```bash
cd /var/www/speed.harbourconsultancies.com
NEXT_PUBLIC_SUPABASE_URL=…  SUPABASE_SERVICE_ROLE_KEY=…  npm run provision:admins
# then, with the operator-supplied/again-generated passwords:
COMPANY_ADMIN_EMAIL=… COMPANY_ADMIN_PASSWORD=… SUPER_ADMIN_EMAIL=… SUPER_ADMIN_PASSWORD=… \
  npm run verify:admins
```
Safeguards (already built into the script):
- **Idempotent** — identities are looked up by email and never re-created; re-running
  repairs the mapping. Password is **not** changed unless `--rotate-passwords` is given.
- Company admin `speedadmin@speed.local` → `role=admin`, bound to a **verified-existing**
  tenant. Super admin `admin@system.local` → `role=super_admin`, **tenant-less**.
- A half-provisioned Auth identity is rolled back if its mapping write fails.
- Temporary passwords are written to a **`0600` credentials file**; **never** printed
  to stdout unless `--print-passwords`, and **never** committed. **Do not paste
  passwords into the shell history or logs.**
**Stop condition:** any account cannot be linked → do not force it; report the exact error.

### STEP 7 — Promote the reviewed source to `main` (fast-forward only)
```bash
git fetch origin
git checkout main && git pull --ff-only origin main
git merge --ff-only feat/final-hardening-round5
git push origin main            # fast-forward; no force
```
**Expected:** `origin/main` advances to `c0802e0` (or the final release commit).
**Stop condition:** not a fast-forward → **stop**; do not merge/force. (Currently
the branch is 8 ahead / 0 behind, so a fast-forward is expected to succeed.)
**Never** rewrite history or force-push.

### STEP 8 — Deploy once from the approved `main`
```bash
cd /var/www/speed.harbourconsultancies.com
git fetch origin && git checkout main && git pull --ff-only origin main
npm ci   # or npm install if no lockfile
npm run build
pm2 restart speed --update-env && pm2 save
```
**Stop condition:** `npm run build` fails → **do not restart**; keep the running
version; roll back (§6).
Post-deploy checks:
```bash
pm2 status && pm2 describe speed && pm2 logs speed --lines 100
curl -sf http://127.0.0.1:3090/login    >/dev/null && echo login-OK
curl -sf http://127.0.0.1:3090/dashboard >/dev/null && echo dashboard-OK
```
Then load, as an authenticated admin, the four reports:
`/reports/monthly-receipts`, `/reports/monthly-invoices`,
`/reports/rented-vehicles`, `/reports/outstanding-by-client` — confirm each renders
data (not an error/empty-state), plus `/api/reports/operations?kind=monthly_invoices`.

---

## 4. Migration rollback limitations (accurate)

| Migration | Nature | Rollback script | Reversible? |
| --- | --- | --- | --- |
| 001 core security | adds `tenant_id`, RLS, policies, `activity_logs` | **YES** | via script (drops added objects) |
| 002 tenant isolation | helper functions, policies, `revoke anon` | **YES** | via script |
| 003 sales lifecycle | `sales_returns` cols, sequences, account `41003` | **NO** | **additive-only — not fully reversible** |
| 004 global super admin | role value, `is_super_admin()`, trigger | **NO** | **additive-only — not fully reversible** |
| 005 accounting integrity | indexes + read-only view | **YES** | via script |
| 006 ai repair | durable repair ledger table | **NO** | **additive-only — not fully reversible** |
| 007 purchase↔sale links | table + RLS (analysis-only) | **NO** | **additive-only — not fully reversible** |

**Do not treat 003/004/006/007 as fully reversible.** For those, "rollback" means
reverting the **application** (STEP 6 of §6) and leaving the additive objects in
place (harmless; new columns/table/trigger/indexes), or manually disabling them
with a bespoke script reviewed by the owner. Only 001/002/005 have tested
down-scripts.

---

## 5. Backup & rollback plan

- **Pre-change:** STEP 1 (app tarball + checksum + commit) and STEP 2 (PITR point or
  `pg_dump`). Both must be **verified restorable** before STEP 4.
- **Rollback — application:** restore `/root/backups/speed-app-$TS.tgz` into
  `/var/www/speed.harbourconsultancies.com`, then `pm2 restart speed --update-env`.
- **Rollback — database (reversible layers):** run
  `supabase/migrations/001_core_security_rollback.sql`,
  `002_tenant_isolation_hardening_rollback.sql`, `005_accounting_integrity_rollback.sql`
  as needed (each is idempotent).
- **Rollback — additive layers (003/004/006/007):** no down-script; revert the app
  and leave the additive objects, or apply an owner-reviewed disable script.
- **PITR fallback:** if a bad migration cannot be unwound by script, restore the
  database to the STEP 2 PITR point (this reverts **all** data changes since the
  checkpoint — use only as last resort).

---

## 6. Stop conditions (summary)

1. STEP 2: no restorable backup/PITR → **stop**.
2. STEP 3: BLOCK 1 returns any row → **005 blocked**.
3. STEP 4: any migration error → **stop + restore**.
4. STEP 5: any cross-tenant success or anon write success → **stop + roll back**.
5. STEP 6: an account cannot be linked → **stop**; do not force.
6. STEP 7: promotion is not a fast-forward → **stop**; do not force.
7. STEP 8: build fails → **do not restart**; roll back.

---

## 7. What this execution changed

- **No production change.** No deploy, SQL, migration, RLS, or admin-account change.
- Added this document: `SPEED_EXECUTION_47_OPERATOR_HANDOFF.md` (docs-only).
- No source code change; the release tree remains exactly `c0802e0`.

---

## 8. Arabic summary (ملخص عربي)

**1) الحالة المُتحقَّقة**
- الفرع `feat/final-hardening-round5`، وآخر التزام `c0802e0` موجود على الفرع الرسمي،
  وشجرة العمل نظيفة، و`main` لم يتغيّر (`d6788be`). الفرع **متقدّم 8 التزامات ولا
  يتأخر عن main** → الترقية **تقدّم سريع آمن**.

**2) الوصول المتاح**
- **لا يوجد** أي وصول حيّ: لا `.env`، لا `DATABASE_URL`، لا service-role، لا Supabase CLI،
  لا `psql`/`pg_dump`، لا `/var/www`، لا `pm2`. لذلك **كل خطوة حيّة هي مهمة مشغّل**،
  والحالة الإنتاجية تبقى **غير متحقَّقة**.

**3) ما هو مطلوب من المالك/المشغّل**
- **وصول:** (A1) اتصال DDL لقاعدة `chlkmdobhvfnldqkgdji`، (A2) بيانات service-role
  للتهيئة، (A3) وصول خادم الإنتاج، (A4) تفويض صريح للهجرات + الحسابين + الترقية + النشر.
- **قرارات:** (D1) حسابات الإهلاك وسياسته، (D2) حساب فائدة القروض وحساب السداد وسياسة
  الغرامات، (D3) مصير `credits/new`/`credits/print`، (D4) تنظيف تاريخ `.bak` (اختياري).

**4) دليل التشغيل (بالترتيب)**
نسخة احتياطية للتطبيق → نسخة/PITR لقاعدة البيانات → تشغيل EXEC27 (يجب أن يعيد **صفر
صفوف**) → تطبيق الحزم `001_002_003 → 004 → 005_006 → 007` → التحقق (التطبيق،
التكرارية، منع anon، عزل مستأجرين اثنين، نطاق مدير الشركة، سياسة المدير العام) →
تهيئة الحسابين ثم التحقق → ترقية `main` **بتقدّم سريع فقط** → نشر واحد + بناء +
`pm2 restart` + فحوص `/login` و`/dashboard` والتقارير الأربعة → خطة رجوع مُختبرة.

**5) حدود الرجوع (بدقة)**
- سكربتات الرجوع موجودة لـ **001 و002 و005 فقط**؛ الهجرات **003 و004 و006 و007 إضافية
  وليست قابلة للرجوع الكامل** — لا تصفها بأنها قابلة للعكس بالكامل.
- **001–003** بلا `begin/commit` صريح؛ كل عباراتها آمنة داخل معاملة (لا `CONCURRENTLY`
  ولا `VACUUM` ولا `ALTER TYPE … ADD VALUE`) → يجوز للمشغّل تغليفها بـ `begin;…commit;`.

**6) هل حدث أي تغيير إنتاجي؟** **لا.** لا نشر، لا SQL، لا هجرات، لا RLS، لا حساب إداري.
