# SPEED ERP — Execution 21 Report
## Safe AI Repair Workflow (Phase R1)

**Status:** local development only. No production connection, no production DB
change, no migrations applied, no push, no deploy, no secret printed.
**Repository:** `https://github.com/mohammadaljallad079-rgb/speed.git`
**Branch:** `feat/final-hardening-round5`

---

## 1. Git state before and after

| Item | Before | After |
|---|---|---|
| Branch | `feat/final-hardening-round5` | unchanged |
| HEAD | `7bca814` (Exec 20) — verified | `7bca814` + this execution's local commit |
| `7bca814` in history | present, ancestor of HEAD | preserved |
| Working tree | clean | committed |
| Prior commits | `722967f`, `b4eb309`, `35f4a06`, `509870f`, `7bca814` | all preserved |
| Destructive commands | none | none |

Read first, as required: `AGENTS.md` and the Execution 17, 18, 19, 20 reports.
`git reset --hard` / `git clean` were not used.

---

## 2. Files changed and why

| File | Change | Why |
|---|---|---|
| `src/lib/ai/repair-catalog.ts` | **new** — the closed repair action catalogue + selection + input validation + plan fingerprint | R1: only known actions may run; the model cannot invent one; inputs are whitelisted |
| `src/lib/ai/repair-workflow.ts` | **new** — the propose/preview/execute/verify cycle with injected deps, idempotency port, content-change guard | R1: the full cycle, server-side, testable without a DB or provider |
| `src/app/api/ai/repairs/route.ts` | **new** — `POST ?op=catalog\|propose\|execute`, `GET`; session-gated + audited | the only entry point; identity/tenant/permission from the session |
| `tests/exec21-safe-ai-repair.test.ts` | **new** — 26 tests | prove the cycle and every mandatory refusal |
| `package.json` | register the Exec 21 suite in `test:core` | keep the gate honest |
| `AGENTS.md` | Exec 21 invariants | persistent memory |

**Bug found and fixed during this work (a new regression, caught by the gates):**
the route's HTTP-status mapping compared `result.status === "unknown_action"`,
but `unknown_action` is a *proposal* status, not an *execution* status — a dead
comparison (TS2367, typecheck 130). Fixed to key off `result.error?.code`.
Typecheck is back to the 129 baseline. No accounting logic was changed.

---

## 3. The repair cycle that was actually implemented

```
POST ?op=propose           POST ?op=execute
   │                          │
request ─▶ diagnosis ─▶ allowed action ─▶ preview ─▶ approval ─▶ execute ─▶ verify ─▶ audit
```

1. **Request** — Arabic or English text (≤ 4000 chars), from the body; nothing
   else about identity comes from the body.
2. **Diagnosis** — `classifyRepairRequest` (Exec 20) names the module, symptom
   and likely error type. Deterministic, never the model.
3. **Allowed action** — `selectRepairActions` intersects the catalogue with the
   caller's permissions. An unknown/forbidden action is refused.
4. **Preview** — `proposeRepair` runs the real reporting engine
   (`loadReportData` + `validateReport`, or the format `buildPreview`) and
   returns before/after, a diff, the data source and the row count. **Writes
   nothing.**
5. **Approval** — a write action returns `needs_approval` and a `fingerprint`
   (hash of action+kind+params). A read action is `ready`.
6. **Execute** — `executeRepair` re-checks permission, approval, fingerprint,
   expiry, and re-computes the preview; a content change since preview aborts
   with `conflict`.
7. **Verify** — a write is re-read from the store; if it is not found the result
   is `failed`, never `verified`.
8. **Audit** — `logAudit` records action/status/verified/idempotency key/reference
   and only the *keys* of the change.

The diagnosis (AI-side) and the facts (system queries) are separated: the answer
shows the classification, and the numbers come only from the deterministic
reporting providers.

---

## 4. Supported / executable actions vs. still-proposals

### Executable now (catalogue)

| Action id | Effect | Permission | Approval | Preview | Verify |
|---|---|---|---|---|---|
| `report_validation` | read | `reports.view` | no | deterministic issues + data source | n/a (read) |
| `report_format_preview` | read | `reports.view` | no | before/after columns + diff | n/a (read) |
| `save_report_format_template` | settings | `settings.edit` | **yes** | format plan preview | template re-read from the store |

All three reuse existing services: the reporting engine (`assistant.ts`,
`data.ts`, `validation.ts`) and the tenant-scoped settings template store. No new
engine, no SQL, no shell, no source-file editing.

### Still proposal-only (documented, not built)

- **Auto-editing a page's source/design** — there is no real, tested mechanism to
  change source files; the dev-request workflow (Exec 20) produces a review-only
  patch that a human applies. Not claimed as automatic.
- **Financial corrections** (amounts, journals, invoice numbers) — must go
  through the existing posting/reversal services with approvals and audit; not
  part of R1.
- **Durable idempotency** — R1 uses a per-process in-memory store; a durable
  store needs a `settings` row (a small, additive follow-up).
- **Post-execution re-validation of a financial report** — a later phase (R4),
  after the guarded financial actions exist.

---

## 5. Permission / approval / idempotency / isolation test results

`tests/exec21-safe-ai-repair.test.ts` — **26 tests, 26 pass**:

| Mandatory requirement | Test |
|---|---|
| 1. Only an existing catalogue action can be selected | `getRepairAction`, `allowedRepairActions`, `selectRepairActions` |
| 2. Unknown actions rejected | `drop_database` → `unknown_action` |
| 3. No execution without explicit approval | write proposal + `null` approval → `rejected`, no write |
| 4. Approval refused if the plan changed | mismatched fingerprint → `conflict` / `plan_changed` |
| 5. Permission re-checked at execution | staff executing an admin's proposal → `forbidden` |
| 6. No cross-company access | tenant-A preview contains no `tenant-b` / `INV-B` |
| 7. No duplicate execution on retry | same idempotency key → `duplicate` |
| 8. Stop if data changed after preview | mutated store → `conflict` / `data_changed` |
| 9. No AI-generated SQL/arbitrary code | static scan of all three files |
| 10. No secrets in output/logs | audit logs keys only; route test |
| 11. Success and failure logged correctly | `failed`/`verification_failed`/`save_failed` vs `verified` |
| 12. No success claim on failure | broken store → `failed`, not `verified` |
| 13. Existing AI/reporting not duplicated | imports the reporting engine; no second engine; no inventory |
| 14. Provider failure/timeout/invalid result | covered by Exec 20 (`withTimeout`); R1 reuses it |

Real success path proven: an authorized admin proposes
`save_report_format_template`, previews, approves with the matching fingerprint,
executes, and the template is verified as stored — the only persisted effect.

---

## 6. Full tests, TypeScript, lint, build

| Gate | Command | Result |
|---|---|---|
| Full tests | `npm test` | **483 tests / 477 pass / 0 fail / 6 skipped** (was 457/451; +26) |
| Exec 21 suite | `tsx --test tests/exec21-safe-ai-repair.test.ts` | 26 / 26 pass |
| Typecheck | `npm run typecheck` | **129 errors — baseline** (0 in the new/changed files; the one new error found was fixed) |
| Lint | `npm run lint` | **clean** |
| Build | `npm run build` (placeholder env) | **exit 0**, `/api/ai/repairs` compiled |

Baseline comparison: Exec 20 ended at 457/451/0/6 and typecheck 129. Exec 21 is
483/477/0/6 and typecheck 129 — no regression. The 6 skipped tests are the
opt-in live-DB probes (skipped, not passed).

---

## 7. Migration / external dependencies not resolved

- **No migration was needed for R1.** The only persisted effect uses the existing
  `settings` table (key `report_format_templates`), already tenant-scoped by the
  app and covered by migration 002's RLS model. Nothing was applied.
- **Durable idempotency** would need a small `settings`-backed store (no schema
  change; a `settings` row). Documented as a follow-up, not built.
- **Live verification** of the route needs a reachable DB and an authenticated
  admin; not available in this environment, so the cycle is proven with an
  injected stub, and that distinction is stated (no live provider/DB was used).
- **The Exec 19 reconciliation pack** still awaits an authorized production read
  (unchanged from Exec 19/20).

---

## 8. Next step to complete AI repair without duplicating anything

- **R2 — guarded action catalogue, broader:** add *financial* actions that reuse
  the existing posting/reversal services only (e.g. recompute account balance via
  the existing RPC; reseed a document sequence — approval-gated). Each action
  keeps the same spec shape (permission, effect, approval, preview, verify).
- **R3 — durable execution:** persist proposals and idempotency in the `settings`
  store; add an approval record bound to the plan fingerprint (reusing the
  dev-request/approval pattern).
- **R4 — post-execution verification:** re-run the deterministic check that
  raised the issue and record pass/fail in `activity_logs`.
- **UI:** surface the catalogue + preview + approval in the AI Control page and
  the assistant panel, calling `/api/ai/repairs`.

No phase creates a second AI engine, a second report engine, or an Excel engine.

---

## 9. Acceptance criteria check

| Criterion | Status |
|---|---|
| A real repair cycle tied to system functions (not just text) | ✔ (catalogue + preview + approval + execute + verify) |
| An authorized user can run a supported low-risk action after preview + approval | ✔ (test: save-template verified) |
| The result is verified and logged | ✔ (re-read + audit) |
| Unauthorized / repeated / post-approval-modified executions fail | ✔ (forbidden / duplicate / plan_changed / data_changed) |
| No accounting data or production settings changed | ✔ (only a tenant-scoped template; no DB access) |
| No AI/report engine duplicated | ✔ |
| Tests and quality gates pass without regression | ✔ (483/477/0, typecheck 129, lint clean, build 0) |

---

## 10. Termination-condition compliance

| Constraint | Status |
|---|---|
| Local-only execution | respected |
| No production connection / DB change | respected |
| No migrations applied | respected |
| No push, no deploy | respected |
| No general AI privileges (closed catalogue) | respected |
| No "auto-repair complete" claim beyond what a test proves | respected |
| Previous work preserved | respected |

Nothing was pushed, deployed, or applied to any database.
