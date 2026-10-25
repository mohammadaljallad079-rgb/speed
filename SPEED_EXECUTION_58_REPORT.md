# SPEED ERP — Execution 58 implementation report

Smart Forms closure (Stage 1) plus a verification pass over Stages 1–3.

- Repository: <https://github.com/mohammadaljallad079-rgb/speed>
- Branch: `feat/final-hardening-round5`
- Continuation point named in the task: `c536858` (Exec 41) — confirmed present and
  an ancestor of the branch tip. The remote had already moved past it
  (`1f184d5` was the tip on arrival), so Exec 52–57 work was preserved, not redone.
- Commits produced by this execution: `2224491`, `d45dfe0`, `6ec43ac`
- Pushed tip at hand-off: **`6ec43ac72047873133b4b735c207e6bda1d68487`**

## 1. Continuation point confirmed

```
git ls-remote origin refs/heads/feat/final-hardening-round5
6ec43ac72047873133b4b735c207e6bda1d68487   refs/heads/feat/final-hardening-round5
```

`c536858` is reachable (`git cat-file -t` → `commit`). The clone was **not**
shallow. No administrator account was created, reset or rotated — the task
forbade it and none was needed.

## 2. What this execution changed

The Stage 1 requirement is that a form which references another module selects
from **that module** and can create a record **inline**. The shared control for
this (`<RecordSelect>`) already existed. The gap was fields that still built
their own `<select>` + `.map()` list, which meant a missing record could only be
created by abandoning the form.

| Form | Field | Before | After |
|---|---|---|---|
| `rentals/[id]/edit` | customer, vehicle | bespoke `<select>` | `<RecordSelect createMode="inline">` |
| `purchase-orders` | vehicle | bespoke `<select>` | `<RecordSelect createMode="inline">` |
| `purchase-orders/requisitions` | vehicle | bespoke `<SelectField>` | `<RecordSelect createMode="inline">` |
| `purchase-orders/requisitions` | convert-to-PO supplier | bespoke `<select>` | `<RecordSelect createMode="inline">` |
| `payments/new` | customer (post-create read) | mount-time list lookup | uses the row the picker returns |
| `supplier-payments` | — | dead suppliers read | removed |

Each converted page also **lost its own read** of that table. A second read is
exactly what lets the control and the form's stored id drift apart.

### 2.1 A regression the conversion would otherwise have introduced

`recordLabel` labelled a car by `plate_number` alone, so the picker rendered
`12345` where the old form said `Toyota Corolla (12345)`. `RecordSource` gained
an optional `describe(row)`; `recordLabel` consults it first. Without this the
conversion fixed the interaction and broke readability.

### 2.2 A real defect found while auditing

`payments/new` stored the customer id from the picker but resolved the customer
for its balance panel from a list fetched at mount. A customer created inline a
moment earlier was not in that list, so the **balance panel and open-invoice list
stayed empty with no error shown**. The picker already hands back the selected
row, so the lookup now prefers it.

## 3. Deliberately NOT converted

The manual journal editor's per-line dimensions (vehicle / customer / supplier /
driver / contract) look like the same kind of field but are a 10px in-row grid,
and three of the five dimensions (driver, contract, and the cost-centre/branch
selects beside them) have **no `RecordKind` at all**. Converting part of that row
would give one row two interaction patterns. Recorded in `AGENTS.md` so a future
session does not re-litigate it.

`expenses/new` keeps its hierarchical `expense_accounts` tree for the same
reason: the parent/child structure is information the flat picker does not carry.

## 4. Verification performed

All browser work ran against the local dev harness (Next dev on port 3099 +
`scripts/dev/local-supabase-stub.mjs` on 54321). **No production system was
contacted and no live financial data was modified.**

### 4.1 Browser (Chromium via Playwright)

| Check | Result |
|---|---|
| `/rentals/rc1/edit` resolves existing customer + vehicle | `Ali Hassan`, `Toyota Corolla (12345)` — not placeholders |
| `/purchase-orders` → New PO vehicle picker | lists `Toyota Corolla (12345)`, `Nissan Patrol (67890)`, `New Vehicle` |
| `/purchase-orders/requisitions` vehicle picker | renders |
| `/payments/new` existing customer | balance panel populates |
| `/payments/new` **inline-created** customer | name selected **and** balance panel populates (broken before) |
| Super Admin login → `/super-admin` | 6 tabs: Overview, Companies, Users, AI Management, Subscriptions, Settings |
| Super Admin at 390 px | `scrollWidth 390 == clientWidth 390` — no horizontal scroll |
| Responsive sweep, 10 ERP pages at 390 px | all OK |

### 4.2 Screenshots committed (GitHub links)

| Screen | Link |
|---|---|
| Rental edit pickers | [rental-edit-pickers-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/rental-edit-pickers-desktop.png) |
| PO vehicle picker | [purchase-orders-vehicle-picker-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/purchase-orders-vehicle-picker-desktop.png) |
| Requisitions vehicle picker | [purchase-requisitions-vehicle-picker-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/purchase-requisitions-vehicle-picker-desktop.png) |
| Payments — customer balance | [payments-new-customer-balance-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/payments-new-customer-balance-desktop.png) |
| Payments — inline customer | [payments-new-inline-customer-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/payments-new-inline-customer-desktop.png) |
| Supplier statements picker | [supplier-statements-picker-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/supplier-statements-picker-desktop.png) |
| Supplier statements inline create | [supplier-statements-inline-create-desktop.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/supplier-statements-inline-create-desktop.png) |
| Supplier statements (mobile) | [supplier-statements-picker-mobile.png](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/supplier-statements-picker-mobile.png) |

### 4.3 Super Admin screenshots

16 files, **16 distinct SHA-256 hashes** (0 duplicates — a duplicate would mean a
capture silently photographed the same panel twice).

| Screen | Desktop | Mobile |
|---|---|---|
| Login | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-login-desktop.png) | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-login-mobile.png) |
| Overview | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-overview-desktop.png) | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-overview-mobile.png) |
| Companies | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-companies-desktop.png) | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-companies-mobile.png) |
| Users | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-users-desktop.png) | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-users-mobile.png) |
| User roles | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-user-roles-desktop.png) | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-user-roles-mobile.png) |
| AI Management | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-desktop.png) | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-ai-mobile.png) |
| Subscriptions | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-subscriptions-desktop.png) | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-subscriptions-mobile.png) |
| Settings | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-settings-desktop.png) | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/super-admin-settings-mobile.png) |

Manifest: [`docs/screenshots/MANIFEST.json`](https://github.com/mohammadaljallad079-rgb/speed/blob/feat/final-hardening-round5/docs/screenshots/MANIFEST.json) — 78 files, all verified `200` via the GitHub contents API.

### 4.4 Tests

```
npm test              1139 tests / 1133 pass / 0 fail / 6 skipped
tests/exec52          17 pass   (record sources, labels, describe)
tests/exec55          43 pass   (Smart Forms, picker + inline create)
Stage 1–3 combined   184 pass / 0 fail
npm run typecheck     0 errors
npm run lint          No ESLint warnings or errors
```

## 5. Stage 2 and Stage 3 — audited, no gaps found

Audited rather than assumed. My first sweep reported three Stage 3 pages as
"missing"; that was my own wrong path guesses, and I re-checked before reporting
it as a finding. They exist:

- **Stage 2 ledger:** `reports/general-ledger`, `trial-balance`, `profit-loss`,
  `balance-sheet`, `cash-flow` all present. The BD 99 acceptance scenario is
  `tests/exec53-stage2-ledger-and-acceptance.test.ts` — issue → collect → reconcile,
  asserting the collection settles the receivable and never credits revenue again.
- **Stage 3 purchasing:** bills are `purchases`, debit notes are
  `purchases/returns` (writes through `POST /api/debit-notes`, not the browser),
  statements `supplier-statements`, payments `supplier-payments`, aging
  `reports/supplier-aging`, plus `purchase-register`, `supplier-ledger`,
  `purchase-details`, `expenses-by-vehicle`, `expenses-by-branch`,
  `expenses-by-category`. Depreciation posting is
  `tests/exec53-stage3-depreciation.test.ts`.

## 6. Honest status

**Completed and verified here:** the Smart Forms conversions, the two defects
fixed, browser evidence, the full test suite, typecheck, lint, the responsive
sweep, and the Super Admin surface check.

**Not done / not verifiable from this sandbox — stated, not claimed:**

- Nothing was deployed. Production (`speed.harbourconsultancies.com`) was not
  touched, and no live financial data was modified.
- The screenshots are from the **local dev harness with a stubbed Supabase**, not
  from production.
- The remaining workstreams named in the mandate (AI Agent, SaaS Subscriptions,
  Booking, Contracts, Reports, Notifications) were **not** re-implemented: prior
  executions (52–57) delivered them, and this execution's audit found their
  pages and tests present. I did not independently re-verify each one's runtime
  behaviour end-to-end, so I am not claiming a fresh pass over them.
- Migrations remain unapplied on the live project; that is an operator step and
  was out of scope here.
