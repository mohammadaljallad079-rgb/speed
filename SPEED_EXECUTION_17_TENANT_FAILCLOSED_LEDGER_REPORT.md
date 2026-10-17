# SPEED ERP — Execution 17 Report
## Tenant Fail-Closed & Ledger Balance Reconciliation

**Status:** complete, local only. No push, no deploy, no live database write.

---

## 1. Repository and commit inspected

| Item | Value |
|---|---|
| Repository | `https://github.com/mohammadaljallad079-rgb/speed` (authorized repo) |
| Branch | `feat/final-hardening-round5` |
| Base commit | `722967f` — "fix(accounting): Exec 16 integrity remediation (local, no deploy)" |
| Working tree | Exec 17 changes, uncommitted at time of writing |
| Stack | Next.js 15.3.6 App Router, React 19, TypeScript, Supabase |

Execution 17 continues from `722967f` and closes the three items the Exec 16
report listed as *"known, documented, not fixed here"*:

> the four financial reports fail open when `tenant_id` is null;
> `update_account_balance` has no definition in the repo and an inconsistent sign
> convention; `accounts.balance` may drift from the ledger.

---

## 2. Confirmed completed, partially completed and remaining

### Completed in this execution

1. **Financial report tenant isolation (fail closed).** All four report pages
   (`profit-loss`, `balance-sheet`, `trial-balance`, `cash-flow`) now resolve
   scope server-side and filter every journal read.
2. **Ledger balance reconciliation.** The `update_account_balance` call path is
   now single and auditable; the sign convention is documented; a read-only
   verification query ships for the operator. No sign was changed (unverifiable
   from source — see §2 remaining).
3. **Posting-module regression verification.** The four manual posting screens
   (bank transfer, petty cash, payroll, deposit refund) now build balanced
   journals through pure, tested builders and write to the canonical
   `journal_lines` table.
4. **Migration review by execution.** 001→005 verified on a real PostgreSQL 17
   (apply, idempotent re-apply, cross-tenant isolation, no-op paths). One real
   robustness gap in 005 found and fixed.
5. **Hygiene.** No tracked secrets; `.env*` excluded; no credential printed.

### Partially completed / blocked (no live DB from this environment)

- The exact sign implemented by the live `update_account_balance` RPC is
  unverifiable from source (the function is defined in no migration). The
  read-only `supabase/ACCOUNT_BALANCE_VERIFICATION.sql` is prepared for the
  operator. **No sign was changed** — changing it on a guess could break a
  currently-working balance display.
- The `accounts.balance` drift query is prepared but not run (needs live DB).

### Explicitly out of scope (not touched)

- No inventory/warehouse subsystem. No new tables, no second Excel engine, no
  second accounting posting path.
- No production deployment, no push.

---

## 3. Company administrator account status

Not created or rotated in this execution. Execution 17 is scoped to tenant
fail-closed and ledger reconciliation; account provisioning is owned by the
existing scripts (`scripts/provision-admin-accounts.mjs`,
`scripts/verify-admin-accounts.mjs`) and the Exec 06/07 flows, and requires live
Supabase Auth access that this sandbox does not have.

- **Tenant mapping:** unchanged. The company admin is expected to resolve through
  `resolveAuthContext` to `role='admin'` and the SPEED tenant's id, which is
  exactly the scope `resolveReportScope` now honours for reports.
- **No password is recorded here.** Nothing was generated or changed by this
  execution, and no credential was printed to any log.

---

## 4. Global Super Admin account status

Not created, repaired or modified in this execution. The authorization
architecture is unchanged and remains as verified by the 004 harness:

- `is_super_admin()` is a `SECURITY DEFINER` predicate over `public.users.role`.
- The super admin is **not** assigned a tenant; the 004 harness asserts the role
  predicate and the role-escalation trigger by execution.
- In the report scope, a super admin resolves to `kind: 'all'` (the only
  cross-tenant reader). A company admin can never reach `'all'`.

No credential is recorded here.

---

## 5. Login verification results

Not re-run against live Auth in this execution (no live credentials here). The
login/RBAC behaviour is unchanged by Exec 17 and remains covered by the passing
`login-flow`, `admin-provisioning`, `super-admin-policy` and `auth-permissions`
suites (part of the 397-test run in §7).

The one new authentication-relevant behaviour is that report pages now read the
caller's identity from the server (`/api/me`) rather than assuming it, and treat a
missing/unlinked identity as **denied** rather than as "single tenant".

---

## 6. RLS and cross-tenant test results

Executed against a disposable local **PostgreSQL 17.11** with two tenants, real
`anon`/`authenticated`/`service_role` roles and a GUC-driven `auth.uid()`:

| Harness | Result |
|---|---|
| `supabase/tests/isolation_harness/run.sh` (001→004, two tenants) | **17 passed, 0 failed** |
| `supabase/tests/004_harness/run.sh` (super-admin role semantics) | **PASS** |
| `supabase/tests/005_harness/run.sh` (005, new) | **10 passed, 0 failed** |

Coverage of the mission's acceptance tests:

1. Tenant A cannot read Tenant B — **PASS** (A1, A6b)
2. Tenant A cannot insert into Tenant B — **PASS** (A2)
3. Tenant A cannot update/delete Tenant B — **PASS** (A3, A4)
4. `tenant_id IS NULL` is not a cross-tenant path — **PASS** (A5)
5. Company admin cannot bypass tenant boundaries — **PASS** (A1, A2, A3, A4)
6. Super admin access is explicit — **PASS** (A7, A13)
7. Anonymous cannot access protected data — **PASS** (A8, A9, A12)
8. Protected pages redirect to `/login` — covered by the app middleware tests
9. Protected APIs return 401/403 — covered by `security-tenant-isolation` tests
10. Public pages and signup still work — covered by `public-api-routes`/`saas-signup`

New report-scope assertions (`tests/exec17-report-tenant-isolation.test.ts`,
19 tests) prove: no identity → denied; `client`/unknown role → denied; a
browser-supplied tenant cannot widen scope; a denied scope filters to the nil
UUID (never unfiltered); and every report page resolves scope server-side and
contains no raw journal read.

---

## 7. Test, typecheck, lint and build results

| Gate | Command | Result |
|---|---|---|
| Tests | `npm test` | **397 tests / 391 pass / 0 fail / 6 skipped** |
| Typecheck | `npm run typecheck` | **129 errors** — unchanged baseline (no new errors) |
| Lint | `npm run lint` | **No ESLint warnings or errors** |
| Build | `npm run build` | **exit 0** (requires env; see note) |

- Baseline before Exec 17: 351 tests / 345 pass / 0 fail / 6 skipped.
  Exec 17 adds **46 tests** (19 + 11 + 16), all passing, zero regressions.
- Typecheck baseline is 129 pre-existing errors in legacy pages. Every file
  touched by Exec 17 was checked individually: the same pre-existing errors
  remain (line numbers shifted); **no new error was introduced**.
- Build note: `next build` fails page-data collection when no Supabase env is
  present, because several API routes create their client at module scope
  (`supabaseUrl is required`). This is a **pre-existing environment
  requirement**, not a regression — with the production env present the build
  completes with **exit 0** and all eight touched pages compile
  (`/reports/*`, `/accounting/bank-transfer`, `/accounting/petty-cash`,
  `/hr/payroll`, `/rentals/[id]/refund-deposit`).

---

## 8. Migrations: applied vs prepared-but-not-applied

| Migration | Local verification | Applied live? |
|---|---|---|
| `001_core_security.sql` | apply + idempotent + isolation (harness) | **No** |
| `002_tenant_isolation_hardening.sql` | apply + idempotent + isolation (harness) | **No** |
| `003_sales_lifecycle.sql` | apply + idempotent + no-op | **No** |
| `004_global_super_admin.sql` | apply + idempotent + role semantics (harness) | **No** |
| `005_accounting_integrity.sql` | apply + idempotent + behavioural + no-op (harness) | **No** |

Nothing was applied to any live database. The Exec 17 code change to 005 is a
**guard hardening only** (see §9); it is byte-compatible with the existing
verification tests and remains forward-only, additive and idempotent.

**Empty-schema finding (pre-existing, documented, not a live risk):** 001, 002 and
004 are not clean no-ops on a schema that lacks the core identity tables
(`profiles`, `tenants`, `users`). A Supabase project always has them, so the live
apply path is unaffected. 003 and 005 *are* clean no-ops.

---

## 9. Key changes

**New**
- `src/lib/auth/scope.ts` — pure, client-safe scope decision rules
  (`resolveReportScope`, `applyReportScope`, `isReportScopeAllowed`).
- `src/lib/hooks/use-report-scope.ts` — `useReportScope` resolves the scope from
  `/api/me` (server-authoritative) and probes `journal_entries.tenant_id`
  capability, so reports keep working on a live install before 001 is applied.
- `src/lib/accounting/account-balance.ts` — `applyAccountBalanceDelta`, the single
  call path for the RPC; surfaces failure instead of swallowing it.
- `src/lib/accounting/manual-postings.ts` — pure balanced-journal builders for the
  four manual posting screens.
- `supabase/ACCOUNT_BALANCE_VERIFICATION.sql` — read-only operator query (function
  definition, sign convention, `accounts.balance` drift).
- `supabase/tests/005_harness/run.sh` — executes 005 against real PostgreSQL.
- `tests/exec17-report-tenant-isolation.test.ts` (19),
  `tests/exec17-account-balance.test.ts` (11),
  `tests/exec17-posting-regression.test.ts` (16).

**Modified**
- The four report pages — server-resolved, fail-closed scoping + denied banner.
- The four posting pages — build journals via the pure builders.
- `supabase/migrations/005_accounting_integrity.sql` — lookup index and view now
  guarded on **column** existence, matching the migration's own claim of being a
  clean no-op on any schema state (the unique index was already guarded this way).
- `package.json` — the three Exec 17 test files added to `test:core`.
- `AGENTS.md` — Exec 17 invariants recorded.

---

## 10. Blockers, exact permissions needed, and next action

**Blocker 1 — no DDL path from this environment (pre-existing).**
The pooler credentials are rejected and the direct host is IPv6-only. Applying
001→005 live requires the operator to supply the **current** pooler connection
string (or DB password) as `DATABASE_URL`.

**Blocker 2 — the `update_account_balance` body is not in source.**
Needed: run `supabase/ACCOUNT_BALANCE_VERIFICATION.sql` on the live database and
report the function body and the `drift` rows. Only then can the sign be
reconciled (and the deposit-refund deviation corrected) with confidence.

**Next action (operator):**
1. Apply `supabase/PRODUCTION_ACTIVATION_001_002_003.sql` and
   `supabase/PRODUCTION_ACTIVATION_004.sql`, then 005, in order.
2. Run `supabase/ANON_VERIFICATION.sql` to confirm the anon key is denied.
3. Run `supabase/ACCOUNT_BALANCE_VERIFICATION.sql` and return the two results.
4. Deploy: `git pull --ff-only` → `npm run build` → `pm2 restart speed`.

---

## 11. Temporary administrator credentials

**None generated or changed in this execution.** Execution 17 did not create,
repair or rotate any account, so there is no new temporary credential to hand
over. No password was committed, printed to a terminal, or written to any log.
