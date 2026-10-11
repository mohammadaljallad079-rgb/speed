# SPEED ERP — Deployment Readiness Review
## Review of the AI reporting updates on `origin/main`

Reviewed: `8addbb7` (dynamic NL report builder + validation), plus the fix `5016e0a`
produced by this review. Reviewed at HEAD `5016e0a`, tree clean, `HEAD == origin/main`.
No production deploy performed. No DB/RLS/password changes.

---

## 1. What was actually reviewed

- Report, code and tests: `catalog.ts`, `report-def.ts`, `validation.ts`,
  `dynamic.ts`, `templates.ts`, `data.ts`, `api/financial/report-format/route.ts`,
  `DynamicReportBuilder.tsx`, `tests/reporting-dynamic.test.ts`.
- The **real code paths were exercised** by an independent script (not the test
  file), against an in-memory PostgREST-like database, plus the full test suite,
  typecheck and build.

## 2. Defects found by this review (and fixed in `5016e0a`)

`8addbb7` was **not** deploy-ready. Three real functional bugs existed; the test
suite did not catch them because the assertions were too weak.

1. **Grouped reports summed to zero.** Only *displayed* fields were loaded, so a
   grouped total over a non-displayed money field produced `0`. Found by running
   "أنشئ تقرير مبيعات حسب العميل خلال هذا الشهر مع المجموع" → all groups `0`.
   Fix: filter and aggregate fields are now loaded even when not displayed.
2. **"المجموع"/"total" with no named field aggregated the group key** (a text
   field) → `0`. Fix: fall back to the dataset's money column (`total`).
3. **"sorted by"/"order by" was misread as a group-by**, and an Arabic
   "رتّب المصروفات حسب التصنيف" (sort by category) became a grouping. Fix: sort
   clauses are stripped before group detection; a bare English "by" is no longer
   a group-by.

Regression tests were added; the suite is now 32 tests for this module.

## 3. Functional verification (actually run at `5016e0a`)

Independent script output (real functions, stub DB):

| Concern | Result |
|---|---|
| Create from Arabic request | dataset `sales`, group-by `customer_name`, rows returned |
| Create/sort | `sorted by total desc` → `{field:"total",dir:"desc"}`, **no** grouping |
| Arabic sort | `رتّب ... حسب التصنيف` → sort only, group-by `null` |
| Add a real field | `invoice_number`, `payment_status`, `remaining` resolved |
| Unknown field | `"اللون"` reported in `unknownFields`, never invented |
| Grouped totals | Alpha=220, Beta=220 (non-zero, correct sums) |
| Tenant isolation | Tenant B's `INV-B` absent; `tenant_id` filter applied first |
| Grouped sums (post-fix) | non-zero and equal to the sum of the group |
| Validation | wrong totals / duplicates / excluded rows / VAT / formula mismatch detected |
| Sensitive/data-change request | `dataChangeRequested=true`; invoice total unchanged |
| Export | verified buffer (`verification.ok=true`, ~7 KB file) |
| Save/restore versions | v1→v2 saved, restore returns v1 |

**Test suite:** `npm run test:core` → **209 tests · 203 pass · 0 fail · 6 skipped**.
**Typecheck:** `129` (pre-existing baseline, no new errors). `npm run build` → exit 0.
`npm run lint` remains unusable (pre-existing broken config, unrelated).

## 4. Authorization, tenant, branch and data-source review

- **Auth before work.** `requireContext(request, { module: "reports", action: "view" })`
  is called before any mode runs; unauthenticated/invalid callers get the guard's
  401/403. Tenant comes only from the session context, never the body.
- **Per-field permission gating.** `allowField: (f) => can(context, f.module, "view")`.
  Denied fields are dropped from output and listed in `deniedFields`.
- **Tenant scoping.** Every load goes through `loadDynamicRows` which applies the
  `tenant_id` filter first; relation fields (customer/supplier) are resolved from
  tenant-scoped rows without multiplying rows.
- **Branch.** The reporting catalog exposes no `branch_id` field and the queries
  do not scope by branch; online/query branch isolation is **not applicable here**
  and is not claimed. (Live schema note: `expenses.branch` is free text.)
- **Data sources.** Only the existing tables are read (`invoices`, `purchase_invoices`,
  `expenses`, `payments`, `accounts`, `customers`, `suppliers`). No new table, no
  `select('*')`, catalog fields map to named columns.

## 5. Repair cannot change source data

Verified by inspection and by execution:

- The only write statements in `src/lib/reporting/` are two `settings` upserts
  (`saveTemplate`, `saveDefinition`). There are **no** `insert`/`update`/`delete`
  against `invoices`, `journal_entries`, `journal_lines`, `payments` or any balance.
- Repair is a classification workflow only: class-1 (safe display) fixes are
  applicable; class-2/class-3 are shown but not applied. A prompt asking to change
  an amount is flagged `dataChangeRequested=true` and nothing is written.
- The test snapshot of the DB is byte-identical before/after build and export.

## 6. Git and environment status

- `git status`: clean. `HEAD == origin/main == 5016e0a`. **No untracked files** —
  no stray `.env.local` or temporary artifacts (the readiness check removed its
  own temp files).
- `.env.local` is **not tracked** and is git-ignored (`.env`, `.env.*`,
  `!.env.example`). No `.env` file is present in this sandbox.
- Tracked-file secret scan: no JWTs, no `sk-ant-*`, no service-role key.
- **Production access: NOT available from this sandbox.** No `/var/www`, no `pm2`,
  no `~/.ssh`. Deployment steps below must run on the production VM.
- Disk: `/` 52 G free (29% used); `/workspace` 23 G free (9% used). Memory 13 G
  available. Node v24 / npm 11.

## 7. Files that will change on the production host

Deploy range `86034cc → 5016e0a` (13 files):

```
M AGENTS.md
A SPEED_AI_REPORTING_VALIDATION_REPAIR_EXECUTION_REPORT.md
M package.json
M src/app/api/financial/report-format/route.ts
M src/app/financial-dashboard/page.tsx
A src/components/reporting/DynamicReportBuilder.tsx
A src/lib/reporting/catalog.ts
M src/lib/reporting/data.ts
A src/lib/reporting/dynamic.ts
A src/lib/reporting/report-def.ts
M src/lib/reporting/templates.ts
A src/lib/reporting/validation.ts
A tests/reporting-dynamic.test.ts
```

No migrations, no `supabase/` changes, no dependency changes (`package.json`
diff is one line: the test name list). `git pull` cannot touch untracked
`.env.local` (it is ignored).

## 8. Deployment steps (run on the production VM)

```bash
cd /var/www/speed.harbourconsultancies.com
git fetch origin
git log --oneline -1 origin/main            # expect 5016e0a
git status --short                          # must be clean
# back up the current state for rollback
git rev-parse HEAD > /tmp/speed_prev_sha
git pull --ff-only origin main
test -f .env.local && echo "env ok"
npm ci                                      # only if node_modules changed; else skip
npm run build
pm2 restart speed --update-env
pm2 logs speed --lines 50
```
Then verify: open the app, log in, go to Financial Dashboard → AI Excel, build a
report, preview, and export.

## 9. Rollback (safe)

```bash
cd /var/www/speed.harbourconsultancies.com
git reset --hard $(cat /tmp/speed_prev_sha)   # back to 86034cc
npm run build
pm2 restart speed --update-env
```
`git reset --hard` here is for the server-side rollback of *your own* deploy and
only touches tracked files; `.env.local` is untracked and unaffected. No
database state is involved, so no data rollback is needed.

## 10. Risks and unresolved items

- **Not independently verified on live data.** All verification used an in-memory
  stub DB; no live Supabase connection was available in the sandbox. Real column
  presence was inferred from the existing code, not re-probed. Confirm the
  catalog columns against the live schema before relying on them in production.
- **VAT rate.** The validator uses a 10% Bahrain rate constant; confirm it matches
  your approved rate, otherwise "VAT not matching 10%" info findings will be noisy.
- **Bahrain VAT template fidelity** is not claimed (source file absent).
- **No production deploy was performed** and none should be attempted without the
  VM shell. The sandbox has no access to the host.
- `npm run lint` is still broken (pre-existing) and cannot gate the deploy.

## 11. Verdict

**Conditionally ready, pending one VM-side verification.** The code in `8addbb7`
was **not** ready (silent zero-sum grouped totals and a sort/group parsing bug);
those are fixed in `5016e0a`, which passed the full suite, typecheck and build and
was exercised end-to-end against real functions. Before pushing to production,
confirm the catalog's columns exist on the live database and that no other
untracked/dirty state conflicts on the VM. Nothing here requires a database
migration, RLS change, or password change.
