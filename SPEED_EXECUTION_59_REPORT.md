# SPEED ERP — Execution 59 Report
## SaaS entitlements + AI agent financial writes

**Branch:** `feat/final-hardening-round5`
**Commit:** `f555fedad7c6d15aabd29035bc4355910fb44cb2`
**Commit URL:** https://github.com/mohammadaljallad079-rgb/speed/commit/f555fedad7c6d15aabd29035bc4355910fb44cb2
**Date:** 2026-10-25

---

## 1. What this execution closes

The mandate was to prove the **existing AI Agent** (not the AI Analysis) can perform
**real financial writes**, gated by the tenant's subscription package, with approval
and verification — and to back it with browser evidence.

Before this execution the agent could only read and format. This execution adds the
write capability, the entitlement gate that controls it, and a browser acceptance run
that proves all of it end to end.

## 2. One posting path, two callers

`POST /api/invoices` used to own the whole invoice-issue transaction inline (258 lines).
It is now a 42-line HTTP shell over `issueInvoice` (`src/lib/sales/service.ts`):

```
before:  route.ts  ──owns──>  numbering + reference checks + tenant check
                             + financial-year guard + invoice insert
                             + journal build + journal post + compensation

after:   route.ts  ──calls──>  issueInvoice()            (the HTTP caller)
         AI agent  ──calls──>  FinancePort ──> issueInvoice()   (the agent)
```

The invariants now live in exactly one place, so the HTTP route and the AI agent
cannot drift. The agent never builds a journal itself; it reuses
`postSaleInvoice` / `reverseSaleInvoice` and `nextDocumentNumber`.

| File | Role |
|---|---|
| `src/lib/sales/service.ts` | the one sales mutation service |
| `src/lib/ai/finance-port.ts` | the port the agent depends on (pure interface) |
| `src/lib/ai/supabase-finance-port.ts` | the production binding |

## 3. The three financial actions

`src/lib/ai/repair-catalog.ts` declares three high-risk actions:

| Action | Effect | Risk | Approval |
|---|---|---|---|
| `invoice_issue` | financial | high | required |
| `invoice_reverse` | financial | high | required |
| `contract_extend` | financial | high | required |

`selectFinancialActions` offers one only when **the wording names the operation** AND
**the caller holds the permission**. The model can never select a write it was not
asked for.

## 4. Entitlements

`src/lib/saas/entitlements.ts` is pure (`PLANS`, `capabilitiesFor`, `planAllowsEffect`,
`planGrants`). `src/lib/saas/tenant-plan.ts` stores the assignment in the existing
`settings` table under `tenant_plan`, tenant-scoped, and **fails closed to `free`**.
`PUT /api/super-admin/tenants/[id]/plan` is super-admin only and audit-logged.

| Package | AI actions | Financial writes |
|---|---|---|
| `free` | 0 | no |
| `premium` | 8 | no (`403 plan_upgrade_required`) |
| `enterprise` | 11 | yes |

The plan is read from the **session tenant**, never the request body. A super admin is
the platform operator and is not gated by a company package.

## 5. Defects found and fixed

Four divergences in the local stub (`scripts/dev/local-supabase-stub.mjs`) each either
**faked a defect or hid a real one**. All four are fixed:

1. **`POST` with `Prefer: resolution=merge-duplicates` appended instead of merging.**
   A saved package read back as `PGRST116` ("multiple rows"), so `maybeSingle()` failed
   and the app silently kept the default — the package looked unsaved.
2. **The `ai_repair_executions` unique index was not enforced.** A replayed
   idempotency key **minted a second invoice and a second journal**. The stub now
   returns the same `23505` the durable store expects.
3. **The atomic RPCs were missing** (`post_journal_entry`, `generate_document_number`,
   `update_account_balance`, `get_next_contract_number`), so every posting silently
   fell back to the two-request path instead of the atomic one.
4. **`.in(...)` was unparsed and accounts 41001/24001/41003 were absent**, which
   surfaced as a bogus "revenue/AR/cash accounts missing" posting failure.

Point 2 is the important one: the idempotency guarantee rests on a **database unique
index**, so a fixture without it will happily double-post.

## 6. Browser acceptance — 28/28

`scripts/dev/e2e-ai-financial-actions.mjs` (`npm run e2e:ai-financial`) drives the real
browser against the dev stack and asserts 28 behaviours:

```
PASS  super admin resolves as the global operator — super_admin
PASS  package can be assigned from the global console — free
PASS  free package denies financial writes
PASS  free tenant is offered zero AI actions — plan=free
PASS  free tenant is refused a financial write — plan_upgrade_required
PASS  premium tenant gets the agent but not financial writes — 8 actions
PASS  premium tenant is refused a financial write — plan_upgrade_required
PASS  enterprise tenant is offered invoice_issue
PASS  enterprise tenant is offered invoice_reverse
PASS  enterprise tenant is offered contract_extend
PASS  invoice_issue executes and verifies
PASS  invoice_issue created a journal — SAL-00001
PASS  exactly one invoice was created — 2 -> 3
PASS  exactly one journal was created — 4 -> 5
PASS  the journal is balanced — 110/110
PASS  the journal is a sale_invoice entry
PASS  the journal lines balance to the invoice total — 110/110
PASS  the journal has AR + revenue + VAT lines — 3 lines
PASS  a replayed key is reported as already executed — verified
PASS  a replayed key mints no second invoice — 3 -> 3
PASS  invoice_reverse executes and verifies
PASS  the reversed invoice is cancelled — cancelled
PASS  contract_extend executes and verifies
PASS  the extension bills 10 extra days — 200
PASS  the contract end date moved — 2026-11-10
PASS  the contract total was increased — 800
PASS  a free tenant B is offered zero AI actions — plan=free
PASS  tenant B cannot write into tenant A — plan_upgrade_required

28/28 acceptance checks passed
```

### The posted journal, read back from the database

A fresh run (`SAL-00003`) read back over PostgREST:

```
journal_entries:
  journal_number   JOU-00004
  entry_type       sale_invoice
  reference_number SAL-00003
  total_debit      110
  total_credit     110
  is_balanced      true
  status           posted

journal_lines (joined to accounts):
  12001  Accounts Receivable   Dr 110   Cr   0
  41002  Sales Revenue          Dr   0   Cr 100
  24000  Output VAT             Dr   0   Cr  10
```

Balanced, one entry, no duplicates — `Dr AR / Cr Revenue / Cr Output VAT`.

## 7. Screenshots (real browser, committed)

The Super Admin console renders the **same AI engine** as a company dashboard, in the
dark operator theme. All 18 Super Admin shots are committed and listed in
`docs/screenshots/MANIFEST.json`.

| Screen | Desktop | Mobile |
|---|---|---|
| AI agent (financial write commands) | [super-admin-ai-agent-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-agent-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-agent-mobile.png) |
| AI management | [super-admin-ai-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-mobile.png) |
| Subscriptions (package assignment) | [super-admin-subscriptions-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-subscriptions-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-subscriptions-mobile.png) |
| Overview | [super-admin-overview-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-overview-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-overview-mobile.png) |
| Companies | [super-admin-companies-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-companies-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-companies-mobile.png) |
| Users | [super-admin-users-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-users-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-users-mobile.png) |
| Settings | [super-admin-settings-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-settings-desktop.png) | [mobile](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-settings-mobile.png) |

Verified content on the AI agent panel (read from the live DOM):

> AI Assistant — Ask about your figures, or request a safe repair with preview and
> approval before it runs. **Commands that change documents** — Issue/reverse invoices
> and extend contracts through the same posting services — with preview, approval and
> verification. ISSUE AN INVOICE …

## 8. Verification summary

| Gate | Result |
|---|---|
| `npm test` | **1180 tests / 274 suites / 1174 pass / 0 fail / 6 skipped** |
| `npm run typecheck` | **0 errors** (recorded baseline was 125 — this branch is now clean) |
| `npm run lint` | clean — "No ESLint warnings or errors" |
| `npm run e2e:ai-financial` | **28/28** |
| `npm run shots` | 70 screenshots written, 0 skipped |

## 9. Invariants recorded

Seven new invariants appended to `AGENTS.md` under "Execution 59": the one-posting-path
rule, the fail-closed plan store, the three behavioural tiers, the approval + durable
idempotency requirement (and its dependence on the migration-006 unique index), the
"fix the fixture before the app" rule, and the browser-acceptance requirement.

## 10. Honest limits

- **Not deployed.** No production contact, no live DDL, no live financial data touched.
- **The live database does not yet have migrations 001–012 applied.** The idempotency
  guarantee this execution relies on is the `ai_repair_executions` unique index from
  migration 006; on the live project the resilient store degrades to a per-process
  memory fallback until that migration is applied. The code is correct; the durability
  is an operator step.
- **Verification is against the local dev stack** (Next.js on 3099 + the PostgREST
  stub), not against production.
- **Stages 2 and 3** (financial statements, the BD 99 acceptance scenario, purchasing
  completeness) are tracked separately and are not claimed here.
