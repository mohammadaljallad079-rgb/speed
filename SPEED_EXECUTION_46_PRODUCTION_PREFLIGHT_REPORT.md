# SPEED ERP — Execution 46: Production Migration Preflight & Release Gate Closure

> **No deploy. No migration applied. No production database contact. No admin
> account created or modified.** This execution was local-only. Every claim is
> backed by a command run here, or is explicitly marked unverified. No credentials
> were printed, committed, or exposed.

Report created by an AI agent (OpenHands) on behalf of the repository owner.

---

## 1. Repository state (verified)

| Item | Value |
| --- | --- |
| Branch | `feat/final-hardening-round5` |
| HEAD | `d06b6491202c4697f0f7fa4a1b26e45c8355fedb` |
| Source commit `d663a88` | ancestor of HEAD — **yes** |
| Report commit `d06b649` | ancestor of HEAD — **yes** (== HEAD) |
| Working tree | clean |
| `origin/main` | `d6788be` — **untouched** |
| `origin/feat/final-hardening-round5` | `d06b649` |
| Exec 45 report | present: `SPEED_EXECUTION_45_FINAL_GAP_CLOSURE_REPORT.md` |

`git reset --hard`, `git clean`, force push, destructive SQL, and data deletion
were **not** used. No production server was contacted.

---

## 2. Review of the new operations reports — **one real defect found & fixed**

### 2A. Defect (fixed)

`loadOperationsReport("outstanding_by_client", …)` selected `id,full_name,name`
from `customers`. **The live `customers` table has `full_name` but no `name`
column** (verified: `src/lib/supabase.ts` `Customer` type and every other call site
use `select('id, full_name')`). Selecting a non-existent column makes PostgREST
return an error → the report would have **failed at runtime on the live project**.

**Fix:** projection narrowed to `id,full_name`
(`src/lib/reporting/operations-reports.ts`). The pure builder already resolved the
name defensively (`full_name` → `name` → `customer_name` → id), so no logic change
was needed there.

### 2B. Re-review of the four reports (all correct after the fix)

| Check | Result |
| --- | --- |
| Permission guard | `requireContext(request, { module: "reports", action: "view" })` — verified |
| Tenant derivation | `tenantId: context.tenantId` from the **session**; never from input |
| Query scoping | tenant filter applied **before** any narrowing (`fetchScoped`); date range applied only to date tables (`payments`,`invoices`) |
| Tenant injection | route reads only `kind`/`from`/`to` from the query string; **no** `tenant` param; client sends **no** tenant identifier (regression-tested) |
| Output escaping | client renders React text nodes (auto-escaped); no `dangerouslySetInnerHTML` |
| Totals | per-report `totals` computed from the rows; footer renders currency/number correctly |
| Date filters | `from`/`to` wired to `payment_date`/`invoice_date`; cars report intentionally undated (status is current state) |
| Cancelled handling | `cancelled`/`canceled`/`void` excluded from receipts, invoices, and outstanding |
| VAT treatment | invoices report shows gross and **net = gross − VAT** (matches `revenue.ts`) |
| Empty state | explicit "no records" row |
| Excel/export | **not** part of these four pages; the app's export lives in the financial-report pages. No export control is shown here → no broken export claim |

### 2C. Tests

- `tests/exec45-operations-reports.test.ts` — now **15 tests** (added: real-column
  projection guard, route has no tenant param, client sends no tenant), all pass.
- Cross-tenant / authorization suites also run in `test:core`
  (`tenant-isolation`, `security-tenant-isolation`, `super-admin-policy`,
  `admin-provisioning`, `login-flow`). See §7.

---

## 3. Migration readiness (no production contact)

### 3A. Inventory & dependency order

| Migration | Adds | Transaction | Rollback file |
| --- | --- | --- | --- |
| `001_core_security` | `tenant_id` cols, RLS enable, policies, `activity_logs` | **no explicit `begin/commit`** | ✅ `001_*_rollback.sql` |
| `002_tenant_isolation_hardening` | `can_read_tenant`/`can_write_tenant`, policies, `revoke anon` | **no explicit `begin/commit`** | ✅ `002_*_rollback.sql` |
| `003_sales_lifecycle` | `sales_returns` cols, `receipt`/`sales_return` sequences, account `41003` | **no explicit `begin/commit`** | ❌ none |
| `004_global_super_admin` | `super_admin` role, `is_super_admin()`, escalation trigger | ✅ `begin/commit` | ❌ none |
| `005_accounting_integrity` | lookup idx, partial unique idx, `v_journal_integrity_issues` | ✅ `begin/commit` | ✅ `005_*_rollback.sql` |
| `006_ai_repair` | durable AI repair ledger | ✅ `begin/commit` | ❌ none |
| `007_purchase_sale_links` | `purchase_sale_links` table + RLS (analysis-only) | ✅ `begin/commit` | ❌ none |

**Order (mandatory):** `001 → 002 → 003 → 004 → 005 → 006 → 007`.
Dependencies: 004 needs `002` helpers; 005 needs `003` columns; 006 needs `002`
predicates; 007 needs `002` predicates.

**Finding (transaction safety):** migrations `001`–`003` contain **no explicit
`begin; … commit;`**. The activation bundle expects them to be pasted into the SQL
Editor as one file, but to guarantee all-or-nothing the operator should wrap the
run in an explicit transaction (`begin;` … `commit;`) — **except** any statement that
cannot run inside a transaction. This is an operator-execution note, not a code defect.

**Finding (rollback coverage):** rollback scripts exist for `001`, `002`, `005`
only. `003`, `004`, `006`, `007` have **no** rollback file. All four are **additive**
(new columns / new table / new trigger+function / new indexes+view), so a
forward-only rollback is to disable/ignore them; a full down-migration is not
provided. **Documented gap.**

### 3B. Activation bundle integrity — **verified**

The frozen bundle `PRODUCTION_ACTIVATION_001_002_003.sql` records a SHA-256 per
embedded body. Those recorded hashes **exactly match** the migration files:

```
001_core_security.sql            e4adc370…5bba34  == bundle header
002_tenant_isolation_hardening   b411c30c…5d1a01  == bundle header
003_sales_lifecycle              f274e212…291c9e  == bundle header
```

→ the embedded bodies are byte-identical to the reviewed migrations. Companion
bundles: `PRODUCTION_ACTIVATION_004.sql`, `_005_006.sql`, `_007.sql`.

### 3C. EXEC27 duplicate-journal preflight — **read-only, correct**

`supabase/EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql`:
- is **read-only** (no INSERT/UPDATE/DELETE/DDL);
- **BLOCK 1** uses the **exact** predicate of the 005 partial unique index
  (`entry_type in ('sale_invoice','supplier_payment')`, `status='posted'`,
  `reference_number` non-null/non-empty), grouped with `having count(*) > 1`;
- **must return ZERO rows** before applying `005`. Any rows are genuine duplicate
  postings to resolve first;
- **BLOCK 3** detects whether 005 is already applied (`v_journal_integrity_issues`).

**005 must not proceed unless BLOCK 1 returns zero rows in the target database.**

### 3D. Staging & authorized credentials — **NOT AVAILABLE**

- No `.env*` file present; `DATABASE_URL` **unset**.
- No Supabase CLI; no `psql`.
- Only the REST host resolves (Cloudflare IPs); **no DDL-capable connection**.
- No staging database configured anywhere in the repo.

→ **The preflight cannot be run and no migration can be applied from this
environment.** This is the central blocker (see §8, Operator requirement).

---

## 4. Backups & release prerequisites (prepared, not executed)

Per the existing handoff (`SPEED_EXECUTION_38_DEPLOYMENT_HANDOFF_AR.md`):

**Application backup**
```bash
TS=$(date +%Y%m%d_%H%M%S); mkdir -p /root/backups
tar czf /root/backups/speed-app-$TS.tgz -C /var/www/speed.harbourconsultancies.com .
tar tzf /root/backups/speed-app-$TS.tgz >/dev/null && echo "backup OK: $TS"
sha256sum /root/backups/speed-app-$TS.tgz > /root/backups/speed-app-$TS.sha256
git -C /var/www/speed.harbourconsultancies.com rev-parse HEAD > /root/backups/speed-app-$TS.commit
```

**Database backup / PITR**
- Prefer a Supabase **PITR checkpoint** immediately before the migration window;
  record the restore target time.
- Or `pg_dump "$DATABASE_URL" -Fc -f /root/backups/speed-db-$TS.dump` (connection
  string from the operator's secret store — never committed/printed).
- Verify: `pg_restore --list` the dump, or confirm the PITR restore point.

**Preserve** `/var/www/speed.harbourconsultancies.com/.env.local` (untracked) and
its permissions; **never** commit it.

**PM2 health checks**
```bash
pm2 status && pm2 describe speed && pm2 logs speed --lines 100
curl -sf http://127.0.0.1:3090/login   >/dev/null && echo login-OK
curl -sf http://127.0.0.1:3090/dashboard >/dev/null && echo dashboard-OK
```
Plus: load each of the four new report pages and confirm data renders.

**Rollback**
- App: restore the app tarball; `pm2 restart speed --update-env`.
- DB: `001/002/005_*_rollback.sql` for the reversible layers; for additive-only
  layers (003/004/006/007) revert the application and disable the new objects
  (documented gap, §3A).

---

## 5. Administrator accounts — separate, authorized task

**Supported path exists and was reviewed (read-only):**
- `scripts/provision-admin-accounts.mjs` (`npm run provision:admins`) and
  `scripts/verify-admin-accounts.mjs` (`npm run verify:admins`).
- Uses the **existing** Supabase Auth admin API + `public.users`; **no new auth
  system, table, or role model**.
- **Idempotent**: identities looked up by email and never re-created; re-running
  repairs the mapping. Password is **not** changed unless `--rotate-passwords`
  (or an explicit password) is given.
- Defaults: `speedadmin@speed.local` (company `admin`), `admin@system.local`
  (`super_admin`, always **tenant-less**).
- Company admin is bound to a **verified-existing** tenant; a half-provisioned
  Auth identity is rolled back if the mapping write fails.
- **No secrets are hardcoded**; temporary passwords are written to a `0600`
  credentials file by default (path only logged).
- Required env **names** (values never printed): `NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, optionally `COMPANY_ADMIN_PASSWORD` /
  `SUPER_ADMIN_PASSWORD`.

**Conclusion:** a safe, supported, idempotent provisioning path **exists**, but it
requires **live service-role access**, which is **not available here**. No account
was created, reset, or modified. No password was invented or exposed.

Evidence that the path is exercised safely: `tests/admin-provisioning.test.ts`
runs the real `provisionAdmins` against an injectable stub — **24/24 pass**
(with `tests/exec32-auth-outcomes.test.ts`).

---

## 6. Consolidated owner-decision list

Only decisions genuinely required before production functionality can be declared
complete:

1. **Depreciation (D1).** Missing: depreciation-expense account code,
   accumulated-depreciation (contra-asset) code, posting frequency, start
   convention. *Effect:* P&L/BS understate expense + accumulated depreciation.
   *Options:* (a) provide the two codes + policy; (b) keep schedule-only.
2. **Loans (D2).** Missing: interest-expense account code, repayment account
   (cash `11001` vs bank `11002`), late-fee policy. *Effect:* loan liability
   `22001` never amortises in the ledger. *Options:* (a) provide the codes + rule;
   (b) keep schedule-only.
3. **Orphan credit routes (D3).** `credits/new` + `credits/print` are unreferenced;
   the function is fully covered by `sales/new` + `invoices/new`. *Options:*
   (a) remove; (b) redirect `/credits` to the invoice list. Confirm before removal
   (external bookmarks).
4. **Database-operator access (D4).** A working DDL-capable `DATABASE_URL` (or a
   Supabase SQL-Editor session as `postgres` on ref `chlkmdobhvfnldqkgdji`) is
   required to run the EXEC27 preflight and apply `001–007`. *Effect:* without it,
   live tenant isolation does not exist.
5. **Admin provisioning authorization (D5).** Explicit go-ahead to run
   `npm run provision:admins` against the live project with the service-role key
   (credentials returned via the `0600` file, never printed/committed).

---

## 7. Validation results (actual)

| Gate | Result |
| --- | --- |
| `npm test` | **796 tests / 790 pass / 0 fail / 6 skipped** |
| New report tests | `exec45-operations-reports` **15/15** |
| Admin provisioning + auth | `admin-provisioning` + `exec32-auth-outcomes` **24/24** |
| `npx tsc --noEmit` | **125 errors** — identical to the known baseline, **no new errors** |
| `npm run lint` | clean (`✔ No ESLint warnings or errors`) |
| `npm run build` | **exit 0**, "Compiled successfully" |

**Skipped tests (recorded as UNVERIFIED, not passed):** 6 = the live-Supabase
probes — `public-api-routes` (no Supabase env) and the `security-tenant-isolation`
anon table reads. They require a live project and were not executed.

No test was weakened, hidden, or made to pass artificially.

---

## 8. Release decision: **NOT READY**

The **source tree is complete, green, and commit-ready**, but production is **not**
ready because three gates cannot be closed from this environment and one real
runtime defect (now fixed) shows why live verification matters:

| Gate | State |
| --- | --- |
| Source build/tests/typecheck/lint | ✅ green (this execution) |
| Runtime defect in a new report (bad column) | ✅ found & fixed, regression-tested |
| Migrations `001–007` applied live | ❌ **not applied** (no DDL path) |
| EXEC27 preflight returns zero rows | ❌ **not run** (no DB access) |
| Two-tenant live isolation verified | ❌ **unverified** |
| Admin accounts linked & verified live | ❌ **not done** (separate authorized task) |

### Operator requirement (exact)
Provide **either** a DDL-capable `DATABASE_URL` for ref `chlkmdobhvfnldqkgdji`,
**or** apply the frozen bundles via the Supabase SQL Editor as the `postgres` role
in this order — after taking the §4 backups and running EXEC27 BLOCK 1 (must be
zero rows):

```
PRODUCTION_ACTIVATION_001_002_003.sql  ->  PRODUCTION_ACTIVATION_004.sql
  ->  PRODUCTION_ACTIVATION_005_006.sql  ->  PRODUCTION_ACTIVATION_007.sql
```

### Single consolidated release operation (prepared, NOT executed)
1. Freeze release commit `d06b649` (+ the Exec 46 commit).
2. Take the app backup + DB backup/PITR (§4); record checksums; verify restorable.
3. Run `EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql` → **zero rows required**.
4. Apply `001–007` in order; re-apply to prove idempotency; verify rollback path.
5. Two-tenant isolation: cross-tenant read/insert/update/delete denied;
   `tenant_id IS NULL` not a cross-tenant path; anon denied; company-admin scoped;
   super-admin per explicit policy.
6. Provision + verify the two admin accounts (`provision:admins`, `verify:admins`).
7. Deploy: `git pull --ff-only origin main` → `npm run build` → `pm2 restart speed
   --update-env` (port 3090). Health checks + the four new report pages.
8. Rollback per §4 on any failure.

---

## 9. Changed files (this execution)

- `src/lib/reporting/operations-reports.ts` — customers projection `id,full_name`
  (removed the non-existent `name` column).
- `tests/exec45-operations-reports.test.ts` — +3 tests (real-column guard, no
  tenant query param, client sends no tenant).
- `SPEED_EXECUTION_46_PRODUCTION_PREFLIGHT_REPORT.md` — this report.

Secret scan of changed files: **0** secrets. No `.env` committed.

**Exec 46 commit:** `42d79aff4a5517bf62f5dbc7a20aa5868c2829b6` (`42d79af`),
parent `d06b649`, on `feat/final-hardening-round5`. Pushed **fast-forward only**
(`d06b649..42d79af`); `origin/main` remains `d6788be`. Release freeze candidate =
`42d79af`.

---

## 10. Arabic summary (ملخص عربي)

**1) ما اكتمل فعليًا**
- مراجعة التقارير الأربعة الجديدة واكتشاف **خلل حقيقي**: مسار
  `outstanding-by-client` كان يطلب عمود `name` **غير موجود** في جدول `customers`
  (العمود الصحيح `full_name`) → كان سيفشل على قاعدة البيانات الحيّة. **أُصلح** وأُضيف
  اختبار انحدار. الآن **15 اختبارًا** كلها تمر.
- التحقق من **سلامة حزمة التفعيل**: بصمات SHA-256 المسجّلة في الحزمة **مطابقة تمامًا**
  لملفات الهجرات (001/002/003) → الأجسام المدمجة مطابقة بايت-ببايت.
- التحقق من **EXEC27**: استعلام **للقراءة فقط** ويستخدم **نفس** شرط فهرس 005؛ يجب أن
  يُعيد **صفر صفوف** قبل تطبيق 005.
- التحقق من وجود **مسار آمن ومعتمد** لإنشاء حسابي المدير
  (`scripts/provision-admin-accounts.mjs` + `verify-admin-accounts.mjs`): **متكرر
  الاستدعاء بلا تكرار**، لا أسرار مضمّنة، كلمات المرور تُكتب في ملف `0600`.

**2) ما بقي محجوبًا ولماذا**
- **تطبيق الهجرات 001–007** و**تشغيل EXEC27**: لا يوجد اتصال قاعدة بيانات مخوّل من هذه
  البيئة (لا `.env`، لا `DATABASE_URL`، لا CLI، لا psql) → خطوة مشغّل.
- **عزل المستأجرين الحيّ بمستأجرين حقيقيين**: غير متحقَّق.
- **الحسابان الإداريان**: يحتاجان صلاحية service-role حيّة → مهمة منفصلة مصرّح بها.

**3) القرارات المطلوبة من المالك**
- **D1 الإهلاك:** رمز حساب المصروف + مجمع الإهلاك + التواتر + بداية الاحتساب.
- **D2 القروض:** رمز مصروف الفائدة + حساب السداد (نقدًا/بنكًا) + سياسة الغرامات.
- **D3:** مصير `credits/new`/`credits/print` (إزالة أو تحويل).
- **D4:** وصول مشغّل قاعدة بيانات (DDL) لتطبيق الهجرات.
- **D5:** تصريح صريح لتشغيل تهيئة الحسابين على الإنتاج.

**4) هل الإصدار جاهز للإنتاج؟** **لا (NOT READY).** الشيفرة خضراء بالكامل ومختبرة، لكن
بوابات الإنتاج (تطبيق الهجرات، preflight، عزل مستأجرين حيّ، الحسابان) لم تُغلق.

**5) هل حدث أي تغيير في الإنتاج؟** **لا.** لا نشر، لا SQL، لا هجرات، لا RLS، لا حساب
إداري، لا بيانات إنتاج.
