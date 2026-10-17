# SPEED ERP — Execution 20 Report
## Accounting Reconciliation + In-System AI Audit & Repair Capabilities

**Status:** audit + local preparation only. No production connection, no production
SQL, no migrations, no push, no deploy, no secret printed.
**Repository:** `https://github.com/mohammadaljallad079-rgb/speed.git`
**Branch:** `feat/final-hardening-round5`
**HEAD at start and end:** `509870f` (Exec 19) + this execution's local changes.

---

## 1. Git / branch / HEAD state

| Item | Value |
|---|---|
| Branch | `feat/final-hardening-round5` |
| HEAD at start | `509870f` — verified, not assumed |
| Prior commits present | `722967f` (Exec 16), `b4eb309` (Exec 17), `35f4a06` (Exec 18), `509870f` (Exec 19) |
| `origin/main` | `29a005c` (Exec 13) |
| Working tree at start | clean |
| Destructive commands | none (`reset --hard` / `clean` not used) |

Read first, as required: `AGENTS.md` and the Execution 17, 18 and 19 reports, plus
the AI reports (`SPEED_AI_REPORTING_FORMATS_EXECUTION_REPORT.md`,
`SPEED_AI_REPORTING_VALIDATION_REPAIR_EXECUTION_REPORT.md`,
`SPEED_AI_SELF_DEVELOPMENT_COMPLETION_REPORT.md`).

---

## 2. Accounting verification pack — safety status

`supabase/EXEC19_READONLY_RECONCILIATION.sql` was re-audited:

| Check | Result |
|---|---|
| Only `select` / `with … select` | ✔ (verified by hand and by test) |
| No `insert/update/delete/alter/drop/create/grant/revoke/merge/copy/comment/call/do` | ✔ |
| No `set role`, no temp table | ✔ |
| Never *calls* `update_account_balance`/`generate_document_number` | ✔ (only reads the former's definition from `pg_proc`) |
| No PII columns (phone/email/name/address/national_id) | ✔ |
| Guard test | `tests/exec19-readonly-reconciliation.test.ts` — 7 tests pass |

No gap was found, so the pack was **not modified** (per "fix only confirmed gaps").
It remains operator-run-only and requires separate authorization. It covers: the
`sale_invoice` sequence row, the last five sales, empty/duplicate numbers, VAT
base by source, revenue vs returns, `update_account_balance` + account drift, and
tenant distribution.

**A note on `ANON_VERIFICATION.sql`:** its header says "read-only" but it creates a
temp table, `set role anon`, and issues guarded `insert/update/delete`. It is a
behavioural probe, not a reconciliation query, and must not be run under a
no-write constraint. This finding (from Exec 19) is pinned by the same test.

---

## 3. Accounting items — provable locally vs. needing an authorized production read

| Item | Local evidence | Needs authorized production read |
|---|---|---|
| `sale_invoice` sequence exists | migration 003 seeds it; code path uses the RPC | whether the live row exists + its `last_number` |
| Last 5 sales invoices | shape proven from `sales/new`, `invoices/new` | the real numbers (empty? non-sequential?) |
| Empty / duplicate invoice numbers | logic tested | whether any exist live |
| VAT taxable base by source | `summarizeVatSources` (Exec 18) + tests | live figures vs the screen |
| Revenue vs returns | `summarizeRevenue` (Exec 18) + tests | live reconciliation |
| `update_account_balance` + balance drift | reconciliation written to read the definition and show signed + magnitudes | the function body, sign convention, and any drift |
| Tenant distribution / isolation | migration model + isolation tests | live `tenant_id` distribution |

**No sign convention is assumed or changed.** **No production data is treated as
correct before an authorized read.** No fix that needs a DB write was performed.

---

## 4. Inventory of the AI capabilities that actually exist

Verified from code (paths + tests), not from prior reports.

| # | Feature | Path | What it does today | Local test | Provider | Wired? | Permission / data read | Gap |
|---|---|---|---|---|---|---|---|---|
| 1 | Provider abstraction + fallback + **timeout** | `src/lib/ai/providers.ts`, `pricing.ts` | anthropic / openai / openai-compatible; ordered fallback; per-call deadline; cost estimate | `ai-assistant.test.ts`, `exec20` (timeout) | external (optional) | n/a | none (transport) | live key not verifiable here |
| 2 | AI settings (tenant-scoped) | `src/lib/ai/settings.ts` | per-provider keys, per-task models, fallback, `enabled`; key never read back | `ai-assistant.test.ts` | none | yes | `settings` table, tenant from session | live read of stored key |
| 3 | Safety policy (pure) | `src/lib/ai/policy.ts` | read-only tool catalogue; write-intent refusal (AR+EN); injection scan; untrusted blocks; secret redaction; dev-request risk; **repair classifier** | `ai-assistant.test.ts`, `exec20` | none (deterministic) | yes | none | — |
| 4 | Read-only tools | `src/lib/ai/tools.ts` | tenant-scoped summaries (sales, expense, profit, receivables, payments, VAT, purchase, customer/invoice lookup, totals) | `ai-assistant.test.ts` | none | yes | permission-gated, tenant-scoped | — |
| 5 | In-ERP assistant | `src/lib/ai/assistant.ts`, `components/ai/AssistantPanel.tsx`, `POST /api/ai/assistant` | grounded Q&A; deterministic fallback; **now appends a deterministic diagnosis** | `ai-assistant.test.ts`, `exec20` | external (optional) | yes (financial dashboard) | `reports.view`, tenant from session | live provider phrasing |
| 6 | Agent registry | `src/lib/ai/agents.ts` | 6 config agents; tools ∩ permissions; per-run limits | `ai-assistant.test.ts` | none | via settings UI | permission-intersected | — |
| 7 | Development-request workflow | `src/lib/ai/dev-requests.ts`, `POST/GET /api/ai/dev-requests`, `app/settings/ai-control` | create → plan → impact → approve/reject → **review-only** patch artifact; high risk needs super admin | `ai-assistant.test.ts` | none | yes | admin + `settings.*`; high risk = super admin | a human applies the patch |
| 8 | AI Control dashboard | `src/app/settings/ai-control/page.tsx`, `GET/PATCH /api/ai/settings` | enable/provider/model/fallback, agents, dev-request board | route assertions | none | yes | GET `settings.view`; write admin | — |
| 9 | AI Excel analysis | `POST /api/financial/ai-excel-analysis` | reads an uploaded sheet, sends as untrusted data, returns a text analysis | route assertions | external (optional) | yes (dashboard tab) | `settings.view`; service-role read | live provider |
| 10 | Report **format** assistant | `src/lib/reporting/assistant.ts`, `intent.ts`, `plan.ts`, `workbook.ts`, `ReportFormatAssistant.tsx`, `POST /api/financial/report-format` | NL → formatting/structure; preview+diff; verified Excel; templates | `reporting-format.test.ts` | none (deterministic) | yes | `reports.view`; tenant from session | — |
| 11 | Dynamic report builder | `src/lib/reporting/dynamic.ts`, `report-def.ts`, `catalog.ts`, `DynamicReportBuilder.tsx` | NL → new report definition (fields/filters/group/aggregates) | `reporting-dynamic.test.ts` (17 mandatory) | none (deterministic) | yes | per-field `can()` gating | — |
| 12 | Deterministic validator + repair classes | `src/lib/reporting/validation.ts` | detects wrong totals, duplicates, excluded rows, missing data, VAT≠10%, formula errors; class 1/2/3 | `reporting-dynamic.test.ts` | none (deterministic) | yes | reads report rows only | — |
| 13 | Bahrain VAT model + report | `src/lib/reporting/vat.ts`, `reports/vat/page.tsx` | output/input VAT by source; taxable base vs VAT (Exec 18) | `reporting-format.test.ts`, `exec18` | none | yes | tenant-scoped | live reconciliation to GL |
| 14 | AI financial recommendations | `POST /api/financial/calculate` (writes `ai_recommendations`), `GET /api/financial/recommendations`, `/api/financial/reports` | rule-based recommendations; read side company-scoped | isolation via migration + route | none (rule-based) | yes | company-scoped | model-generated recommendations (today: rules) |

**No AI feature was rebuilt and no second engine was created.** The only AI
surface that calls a model are #1/#5/#9; everything else is deterministic.

---

## 5. AI capabilities that can propose or actually execute changes

| Capability | Can it *execute* a change? | Mechanism | Evidence |
|---|---|---|---|
| Assistant (`/api/ai/assistant`) | **No** | read-only tools; destructive intent refused before any model call | `policy.detectWriteIntent`, `exec20` |
| Report format assistant | **No** (formatting only) | `dataChangeRequested` flagged, never applied | `reporting-format.test.ts` |
| Dynamic builder | **No** (definition only) | sensitive change flagged; only class-1 display fixes are "applicable" | `reporting-dynamic.test.ts` |
| Dev-request workflow | **No self-apply** | produces a review-only patch artifact; a human applies it | `dev-requests.ts` |
| AI Excel analysis | **No** | text answer only | route |
| Recommendations | Writes its own `ai_recommendations` rows (rule-based), not accounting data | `/api/financial/calculate` | route |

So today the AI can **read, analyse, diagnose and propose** — it cannot change
accounting data, settings or code by itself.

---

## 6. What is still missing for AI to help fix reports/functions in-system

Mapped to the mission's 9-step goal and the mission's list (C):

| Requirement | Status | Note |
|---|---|---|
| 1. Understand request → identify module/report/operation | **DONE (Exec 20)** | `classifyRepairRequest` (module + symptom) |
| 2. Inspect data, permissions and report source | **PARTIAL** | read tools + permission gating exist; a guided "run this deterministic source" step is proposed, not automated |
| 3. Distinguish display / query / data / posting error | **DONE (Exec 20)** | `errorType` in the classifier |
| 4. Propose a clear, specific fix with reason + expected result | **PARTIAL** | deterministic validator emits `fixAr/fixEn` + evidence; the classifier emits a suggested step |
| 5. Preview the change and show the diff | **PARTIAL** | report format/dynamic previews exist; no unified preview for a data fix |
| 6. Execute only supported changes via predefined, authorized tools | **PARTIAL** | dev-requests is review-only; there is no whitelisted "approved action" executor |
| 7. Explicit approval before any real change | **DONE** | approval flags + admin/super-admin gating |
| 8. Audit who/what/when/result/reference | **PARTIAL** | `logAudit` on every AI route; the *applied* change is a human commit (traceable by `baseCommit`) |
| 9. Post-execution verification that it now works | **MISSING** | no automated re-check after a fix |
| C. Format/columns, custom reports, filters, VAT/revenue/trial-balance diffs, find the causing entry, propose corrections, execute approved actions, detect duplicates/missing entries, explain with data source | **MIXED** | formatting ✔, custom reports ✔, filters ✔, VAT/revenue diffs (deterministic) partial, find-causing-entry partial, execute-approved-actions missing, duplicates/missing ✔ (validator), data-source explanation ✔ |

**Explicit statement (mission rule):** producing a new report or a text answer is
**not** proof the AI can repair the system. The repair path is partially there
(diagnosis + validator + preview + approval + audit) and is missing the final,
guarded *execution* + *post-verification* stages.

---

## 7. Phased plan to complete the AI repair capability on the existing architecture

No new system; each phase extends `src/lib/ai/` and `src/lib/reporting/`.

- **Phase R1 — Diagnosis & evidence (mostly done, Exec 20).** Classifier +
  deterministic sources. *Remaining:* expose the diagnosis as a structured API
  field (not only in the answer text) and add the reporting validator's issues to
  the assistant response.
- **Phase R2 — Guarded action catalogue (new, small).** A closed, typed list of
  *pre-approved* actions that reuse existing services only, e.g.
  `recompute_account_balance` (calls the existing RPC), `reseed_document_sequence`
  (writes `document_sequences` — approval-gated), `reopen_draft_only`. Every action
  declares: module permission, whether it writes, and its audit entity. The model
  may only *select* an action by id — never supply SQL or parameters outside a
  validated schema.
- **Phase R3 — Preview + approval + idempotency.** Each action has a dry-run that
  returns the before/after diff; execution requires an explicit approval record
  (reuse the dev-request/approval pattern) and an idempotency key so a retry cannot
  double-apply. Financial corrections go through the **existing** posting/reversal
  path (`postJournalEntry` / the sales service) — never a new path.
- **Phase R4 — Post-execution verification.** After an action, re-run the
  deterministic check that raised the issue and record pass/fail in
  `activity_logs`.
- **Phase R5 — Tenant isolation & limits (already strong).** Keep the tenant from
  the session, keys server-side, bounded tokens/time/cost; add a per-tenant
  request/time budget counter.

The two phases that need **new, security-reviewed code** are R2 (the guarded action
catalogue) and R3 (execution + idempotency). Both are additive and reuse existing
services.

---

## 8. AI, security and tenant-isolation test results

New suite `tests/exec20-ai-audit-repair.test.ts` — **23 tests, 23 pass**:

- Repair classifier: VAT mismatch, dashboard/revenue mismatch, formatting (display),
  missing-rental (data), ledger balance (posting), and "never decides a figure".
- Provider deadline: hung provider rejects near the deadline; outer abort cancels;
  fast call resolves; default deadline sane; `completeWithFallback` aborts a hung
  real `fetch`.
- Assistant: diagnosis attached for a complaint, absent for a plain question,
  destructive request still refused; every tool is read-only.
- Isolation: tenant A never sees tenant B's invoices/customers; an unauthorized
  user gets no tools and an empty answer; a non-admin lacks report tools.
- Route hygiene: every AI route calls `requireContext`; none trusts the body for
  identity; none introduces code execution; the reporting source of truth is
  deterministic; `ai_recommendations` is company-scoped in migration 002.

Existing suites re-run and green: `ai-assistant.test.ts` (46), `reporting-format.test.ts`,
`reporting-dynamic.test.ts`.

---

## 9. Local changes made in this execution (and why)

| File | Change | Why |
|---|---|---|
| `src/lib/ai/providers.ts` | added `withTimeout` + `DEFAULT_TIMEOUT_MS`; `completeWithProvider`/`completeWithFallback` now bound every call | **Confirmed gap:** `AbortSignal` was accepted but never created/passed, so a hung provider hung the request. Mission requires timeout handling. |
| `src/lib/ai/policy.ts` | added `classifyRepairRequest` (pure) | Mission B/C: identify module/report, distinguish error type, name the deterministic source; keeps the model out of the truth path. |
| `src/lib/ai/assistant.ts` | attach the deterministic diagnosis to the answer; `requiresApproval` reflects a possible write | Mission B steps 1–4; diagnosis is evidence, never a figure, never a write. |
| `tests/exec20-ai-audit-repair.test.ts` | new (23 tests) | prove the above locally. |
| `package.json` | register the Exec 20 suite in `test:core` | keep the gate honest. |
| `AGENTS.md` | Exec 20 invariants | persistent memory. |

**Bug found and fixed during this work:** naming a local variable `module`
tripped Next.js `no-assign-module-variable` (lint). Renamed to `area`; lint is
clean again. This is exactly the "distinguish new regressions from baseline"
requirement — it was introduced and fixed in this execution.

No accounting logic was changed on a guess. No new engine, no inventory, no
duplicate module.

---

## 10. Gates (real results) and remaining 13-item list

### Gates

| Gate | Command | Result |
|---|---|---|
| Full tests | `npm test` | **457 tests / 451 pass / 0 fail / 6 skipped** (was 434/428; +23 new) |
| Exec 20 suite | `tsx --test tests/exec20-ai-audit-repair.test.ts` | 23 / 23 pass |
| Typecheck | `npm run typecheck` | **129 errors — unchanged baseline**, 0 in the new/changed files |
| Lint | `npm run lint` | **clean** (after the `module` rename) |
| Build | `npm run build` (placeholder env) | **exit 0** |

The 6 skipped tests are the opt-in live-DB probes (skipped, not passed). The build
needs a Supabase env at module scope (pre-existing, 13 routes); placeholder values
were used and none was written to disk.

### Remaining items from the original 13 (Execution 15 list)

| # | Item | Status | Blocker / next action |
|---|---|---|---|
| 1 | VAT Report | improved (Exec 18) | live reconciliation to GL 24000 blocked (no DB) |
| 2 | Sales serial numbers | fixed locally (Exec 15/18) | live `sale_invoice` sequence state needs authorized read (EXEC19 blocks 1–3) |
| 3 | Date filters | done | — |
| 4 | Sale edit | **blocked** | needs a server posting/reversal service + posted-lock |
| 5 | Supplier payments → GL | **blocked** | needs `Dr AP / Cr Cash-Bank` posting on the page |
| 6 | Purchases ↔ credit sales link | **blocked** | needs an owner decision + a schema column |
| 7 | Discounts & advance payments | pass by code review | not DB-run |
| 8 | Dashboard revenue | done (Exec 15/18) | — |
| 9 | Auto report updates / atomicity | **blocked** | needs an atomic server-side posting service |
| 10 | GL transaction flow (idempotency, single service) | **blocked** | architecture-level; needs the unified service |
| 11 | Transaction files/records (orphans on delete) | **blocked** | needs cascade-or-reverse on delete |
| 12 | Report data sources | map documented (Exec 15 §6) | GL verification blocked (no DB) |
| 13 | End-to-end flow | **blocked** | needs a disposable test DB / live credentials |

Items 4, 5, 6, 9, 10, 11, 13 need either a DB write/service or an owner decision —
all out of scope for a read-only audit execution.

---

## 11. Blockers, exact permissions needed, next action

- **Production DB read (accounting §3):** an operator with a working connection
  string (or the DB password) must run `supabase/EXEC19_READONLY_RECONCILIATION.sql`
  read-only. Do **not** run `ANON_VERIFICATION.sql` for this purpose. Return the
  result sets to close the three unresolved items (sequence, balance sign, VAT/GL).
- **Live AI verification:** a real provider key (or a self-hosted host) plus DB
  access is needed to exercise `/api/ai/*` end-to-end. Not claimed as verified.
  No key was read, printed or written.
- **DDL path:** unchanged from Exec 05.4/19 — not available from this environment.
- **Deployment:** not performed (no production access; and Exec 20 is local-only).

---

## 12. Compliance with the mandatory constraints

| Constraint | Status |
|---|---|
| Read AGENTS.md + Exec 17/18/19 reports | respected |
| Verify branch/HEAD/tree | respected |
| Preserve prior commits; no `reset --hard`/`clean` | respected |
| No `git push`, no deploy | respected |
| No production connection/SQL/migrations | respected |
| No AI/secret keys exposed | respected |
| No duplicate module/engine (AI, report, Excel) | respected |
| No inventory/warehouse | respected |
| Fix only proven gaps; no write-requiring fix | respected |
| No feature claimed complete without code + test evidence | respected |
| No production change claimed without live evidence | respected |

Nothing was pushed, deployed, or applied to any database.
