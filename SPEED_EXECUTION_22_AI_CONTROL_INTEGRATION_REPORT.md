# SPEED ERP — Execution 22 Report
## AI Control UI Integration & Safe Repair Expansion

**Status:** local development only. No production connection, no production DB
change, no migrations applied, no push, no deploy, no secret printed.
**Repository:** `https://github.com/mohammadaljallad079-rgb/speed.git`
**Branch:** `feat/final-hardening-round5`

---

## 1. Git state before and after

| Item | Before | After |
|---|---|---|
| Branch | `feat/final-hardening-round5` | unchanged |
| HEAD | `ae14787` (Exec 21) — verified | `ae14787` + this execution's local commit |
| `ae14787` in history | present, ancestor of HEAD | preserved |
| Working tree | clean | committed |
| Prior commits | `7bca814`, `509870f`, `35f4a06`, `b4eb309`, `722967f` | all preserved |
| Destructive commands | none | none |

Read first, as required: `AGENTS.md`, `SPEED_EXECUTION_20_ACCOUNTING_AI_AUDIT_REPORT.md`,
`SPEED_EXECUTION_21_SAFE_AI_REPAIR_REPORT.md`. `git reset --hard` / `git clean`
were not used.

---

## 2. Files changed and why

| File | Change | Why |
|---|---|---|
| `src/lib/ai/repair-client.ts` | **new** — pure repair controller (no React) driving `/api/ai/repairs`; error mapping; `isVerifiedSuccess`; idempotency key; busy guard | the UI's brain, unit-testable without React or a live server |
| `src/lib/ai/repair-catalog.ts` | added `dashboard_revenue_reconciliation` and `date_filter_diagnostic` (read, `reports.view`); routed revenue/date complaints to them | expand read-first diagnostics from existing services |
| `src/lib/ai/repair-workflow.ts` | implemented the two new previews; mapped shaped report rows onto the revenue model | reuse `revenue.ts` / `data.ts`; never invent a figure |
| `src/app/settings/ai-control/page.tsx` | added a "Safe repair (catalogue)" section driven by the controller | wire the existing AI Control page to the real cycle |
| `tests/exec22-ai-control-integration.test.ts` | **new** — 23 tests | prove the UI↔API flow and the new diagnostics |
| `package.json` | register the Exec 22 suite in `test:core` | keep the gate honest |
| `AGENTS.md` | Exec 22 invariants | persistent memory |

**Bugs found and fixed during this work (regressions, caught by the tests):**
1. The revenue reconciliation read `total_amount` from a row already shaped by
   `loadReportData` (`{subtotal, vat_amount, total}`), so every figure was 0. Fixed
   by mapping shaped rows onto the revenue model. This is a real correctness bug,
   not a test artifact.
2. No typecheck/lint regressions were introduced (typecheck stayed at the 129
   baseline; lint stayed clean).

---

## 3. The path: UI → API → service

```
AI Control page (settings/ai-control)
  │  createRepairController(fetch)  (src/lib/ai/repair-client.ts)
  │    • loadActions → POST /api/ai/repairs?op=catalog
  │    • propose     → POST /api/ai/repairs?op=propose
  │    • approve     (local state only)
  │    • execute     → POST /api/ai/repairs?op=execute  (approval bound to fingerprint)
  ▼
POST /api/ai/repairs  (requireContext → session tenant + permissions)
  ▼
src/lib/ai/repair-workflow.ts
  • proposeRepair  → validate input, permission, deterministic preview
  • executeRepair  → re-check permission/approval/fingerprint/expiry,
                     re-run preview (conflict on change), write, verify
  ▼
existing services only:
  • src/lib/reporting/data.ts        (loadReportData)
  • src/lib/reporting/validation.ts  (validateReport)
  • src/lib/reporting/assistant.ts   (buildPreview / resolvePlan)
  • src/lib/reporting/revenue.ts     (summarizeRevenue)
  • src/lib/reporting/templates.ts   (tenant-scoped settings store)
```

The UI never receives a raw DB row and never decides a result. It only renders the
proposal/preview/result returned by the server, and it can only ever call the one
endpoint.

---

## 4. Executable actions vs. diagnostics-only

### Executable (catalogue) — all reuse existing services

| Action id | Effect | Permission | Approval | What it does |
|---|---|---|---|---|
| `report_validation` | read | `reports.view` | no | deterministic validator over the report rows; issues + data source |
| `report_format_preview` | read | `reports.view` | no | before/after columns + diff, no save |
| `dashboard_revenue_reconciliation` | read | `reports.view` | no | reconciles dashboard revenue vs sales documents via `summarizeRevenue` |
| `date_filter_diagnostic` | read | `reports.view` | no | replays the period window; shows inside/outside/undated |
| `save_report_format_template` | settings | `settings.edit` | **yes** | saves a tenant-scoped format template (the only persisted effect) |

### Diagnostics / proposals only (documented, not built)

- **Financial writes** (invoices, journals, payments, balances) — **not** in Exec 22.
  Requires R2/R3/R4 guarantees first (see §6).
- **VAT source verification against the GL** — the VAT report is reconciled from
  `invoices`/`purchase_invoices`/`expenses`, but a GL (24000) cross-check needs an
  authorized production read; it is documented as deferred/unverified, not faked.
- **Auto-editing page source/design** — no tested mechanism exists; the dev-request
  workflow is review-only.
- **Durable idempotency** — R1/R2 use a per-process store; a durable store needs a
  `settings` row (follow-up).

---

## 5. UI / permission / isolation test results

`tests/exec22-ai-control-integration.test.ts` — **23 tests, 23 pass**:

| Requirement | Test |
|---|---|
| 1. Catalogue rendered from the API | `loadActions` populates actions |
| 2. Propose + preview for a supported action | propose returns `proposed` with a preview |
| 3. Approval requested for a write | `requiresApproval` + approve gate |
| 4. No success before the execution response | approve alone → `result: null`, `isVerifiedSuccess` false |
| 5. `conflict` / `forbidden` / `invalid input` / server error handled | error mapping tests |
| 6. Duplicate request prevented on repeated clicks | busy guard (propose + execute) |
| 7. Verification shown after execution | `verified` result + `verification.ok` |
| 8. No other-tenant information | revenue preview excludes `INV-B` |
| 9. UI cannot bypass server authority | no identity from the body; execute sends the bound fingerprint |
| 10. R1 preserved | Exec 21 catalogue actions still present and gated |

New diagnostics proven: revenue reconciliation (`gross 3800 / vat 300 / net 3500`)
with **no write**; date diagnostic (`inside 1, outside 1, undated 1`) flagging
undated rows. `mapRepairError` never leaks raw server output.

---

## 6. Financial guarantees still required before any financial action

No invoice/journal/payment/balance change was implemented. Before such an action
may exist, all of the following must be in place and reviewed:

1. **Approved posting/reversal services** — a financial repair must call the
   existing `postJournalEntry` / sales service, never a new path.
2. **Atomic transactions** — the write and its audit/verification must commit or
   roll back together.
3. **Durable idempotency** — a persisted key (settings/DB), not per-process.
4. **Approval + execution ledger** — a durable record bound to the plan fingerprint.
5. **Post-operation verification** — re-read the entry and the affected balances.
6. **Company/user permissions** — tenant from the session; admin/super-admin scope.
7. **Rollback / partial-failure handling** — a defined compensation path.

Until every item exists, a financial action stays a diagnosis or a proposal.

---

## 7. Quality gates

| Gate | Command | Result |
|---|---|---|
| Full tests | `npm test` | **506 tests / 500 pass / 0 fail / 6 skipped** (was 483/477; +23) |
| Exec 22 suite | `tsx --test tests/exec22-ai-control-integration.test.ts` | 23 / 23 pass |
| Typecheck | `npm run typecheck` | **129 errors — baseline** (0 in touched files) |
| Lint | `npm run lint` | **clean** |
| Build | `npm run build` (placeholder env) | **exit 0**; `/settings/ai-control` and `/api/ai/repairs` compiled |

Baseline: Exec 21 ended at 483/477/0/6, typecheck 129. Exec 22 is 506/500/0/6,
typecheck 129 — no regression. The 6 skipped tests are the opt-in live-DB probes
(skipped, not passed) and are reported honestly.

---

## 8. Remaining constraints and dependencies

- **No migration was needed.** The only persisted effect uses the existing
  `settings` table; nothing was applied.
- **Live verification** of the page against a real DB/provider is not available
  here, so the controller is proven against a fake server and the diagnostics
  against a PostgREST-like stub. This distinction is stated; no live success is
  claimed.
- **Durable idempotency** and the **approval ledger** are follow-ups (need a
  `settings`-backed store; no schema change).
- **Exec 19 reconciliation pack** still awaits an authorized production read.

---

## 9. Next step

- **R2** — extend the catalogue with guarded financial actions that call the
  existing posting/reversal services only, once the §6 guarantees exist.
- **R3** — persist proposals, approvals and idempotency keys.
- **R4** — post-execution verification recorded in `activity_logs`.
- Add an approval-history panel to the AI Control page (reusing `activity_logs`).

No phase creates a second AI engine, a second report engine, or an Excel engine.

---

## 10. Termination-condition compliance

| Constraint | Status |
|---|---|
| Local-only | respected |
| No push / no deploy | respected |
| No production connection / DB change | respected |
| No migrations applied | respected |
| No financial changes | respected (only a tenant-scoped template) |
| No duplicate engines | respected |
| No deletion/replacement of prior work | respected |

Nothing was pushed, deployed, or applied to any database.
