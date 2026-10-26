# SPEED ERP — Execution 64, Stage 1 Report

**Branch:** `feat/final-hardening-round5`
**Stage 1 commits:** `9696170` (code + tests + screenshots), `5e0d4d9` (invariants)
**Remote tip:** `5e0d4d9ed21e23f400e0dc9bc23940c3e2ed6c9a`
**Baseline before Stage 1:** `103cf66` (remote `e3a8eb8`)

---

## 1. Continuation point — confirmed

The repository was inspected before any change. The last confirmed pushed commit
named in the brief, `c536858a6e629c495b4d3b6b294cfa54c1424bd0` (Exec 41), is a
genuine ancestor of the branch tip — it is **not** the tip. The real chain is:

| Commit | Execution |
|---|---|
| `c536858` | Exec 41 — routes, global Super Admin console |
| `eef8499` | Exec 63 — AI Control Center, booking-to-invoice |
| `a787e5f` | Exec 64 — tenant-safe chart, atomic posting, acceptance suite |
| `103cf66` | Exec 64 — screenshot regeneration |
| `9696170` | **Exec 64 Stage 1 — this work** |
| `5e0d4d9` | **Exec 64 Stage 1 — invariants** |

So the continuation point was Exec 64 Stage 1, not Exec 41. Nothing was
recreated: Stages 2 and 3 were already delivered in `a787e5f` and are verified
in §5 rather than rebuilt.

No administrator account was created, reset or modified at any point.

---

## 2. What Stage 1 had to close

Stage 1's scope: Super Admin functionality, premium responsive UI, committed
browser screenshots, and all applicable Smart Forms with Quick Create modals and
database-backed Chart of Accounts selectors.

The Super Admin console, the shared `RecordSelect` picker with inline Quick
Create, and the responsive capture pipeline were already in place. Two real
defects remained in the account picker itself.

### Defect 1 — the manual journal editor could not post

`buildAccountTree` in `src/app/accounting/journal-entries/page.tsx` classified
**every** account with `parent_code: null` as a group heading.

The live chart is **flat**: all accounts are parentless. So every account was
rendered as a heading and the dropdown's only entries were
`(No sub-accounts)` placeholders. No account could be selected and no manual
journal could be posted. Confirmed in a real browser before the fix.

### Defect 2 — the shared picker offered group headings

The shared `RecordSelect` filtered on `is_active` only, so a `00`-suffixed group
heading could be chosen wherever an account was referenced.

---

## 3. The fix

### `src/lib/accounting/account-tree.ts` (new, pure, tested)

The classification rule moved out of the page so it can be tested directly:

```ts
export function isSelectableJournalAccount(a, hasChildren): boolean {
  if (a.is_active === false) return false;
  if (a.is_postable === false) return false;
  if (a.is_postable === true) return true;   // migration 014 is authoritative
  if (!isPostableAccountCode(a.code)) return false;
  return !hasChildren;                        // a parent WITH children is a heading
}
```

The key insight: **a parentless account is a heading only if it actually has
children.** On the flat chart it has none, so it *is* the ledger account. On a
hierarchical chart a real parent is a heading and its leaves are postable.

`isPostableAccountCode` keeps the two `00` codes that carry real postings as
exceptions — `24000` output VAT and `25000` customer deposits. The naive
"headings end in `00`" rule would have refused every sale and every deposit
refund once migration 014 was applied.

The page now imports the module; the invariant is asserted so it cannot drift
back.

### `src/lib/records/sources.ts` + `RecordSelect.tsx`

`isSelectablePostableAccount` filters group headings out of every account picker.
`RecordSelect` loads the wider column set tolerantly — it attempts the full list
and falls back to the base list, so the app runs **before and after** migration
014 is applied.

Wired into the four sites that still used a weak or inline filter:
`purchases/returns`, `rentals/new`, `cars/new`, `accounting/petty-cash`.

---

## 4. Evidence

### Automated tests

`tests/exec64-stage1-account-picker-hardening.test.ts` — **27 tests, all pass.**
It covers both chart shapes, the VAT/deposit exceptions, the stored-flag
override, the "a placeholder appears only for a real heading" rule, and that
`isPostableAccountCode` agrees with `chart.isPostable` on **every** catalogue
entry — so the two definitions cannot drift apart.

```
ℹ tests 27   ℹ pass 27   ℹ fail 0
```

### Full suite

```
ℹ tests 1358   ℹ pass 1352   ℹ fail 0   ℹ skipped 6
```

Lint: `✔ No ESLint warnings or errors`. Typecheck: **0 errors**.
Build: green. Migration 014 harness: **36 passed / 0 failed**.

### Real browser verification

The journal dropdown was driven in a real headless Chromium against the local
Supabase stub, signed in through the real login form:

```
JOURNAL PICKER: {"selectable":14,"sample":["11001 - Cash","11002 - Bank",
"12001 - Accounts Receivable","13001 - Vehicle Fleet"],"placeholders":0}
```

14 real ledger accounts, **zero** placeholders. Before the fix this list was
empty apart from placeholders.

### Committed screenshots

82 screenshots (desktop + mobile), all present on disk, none suspiciously small,
no duplicate images. New shots:

- [`journal-entries-account-picker-desktop.png`](https://github.com/mohammadaljallad079-rgb/speed/blob/5e0d4d9/docs/screenshots/journal-entries-account-picker-desktop.png)
- [`journal-entries-account-picker-mobile.png`](https://github.com/mohammadaljallad079-rgb/speed/blob/5e0d4d9/docs/screenshots/journal-entries-account-picker-mobile.png)

The capture scene `journal-entries-account-picker` opens the real dropdown and
**aborts the run if fewer than 5 ledger accounts are offered**, so a blank
dropdown can never be committed as evidence again.

### Super Admin screenshots (Stage 1 scope)

Committed and linked:

| Screen | Desktop |
|---|---|
| Overview | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/5e0d4d9/docs/screenshots/super-admin-overview-desktop.png) |
| Companies | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/5e0d4d9/docs/screenshots/super-admin-companies-desktop.png) |
| Users | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/5e0d4d9/docs/screenshots/super-admin-users-desktop.png) |
| Subscriptions | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/5e0d4d9/docs/screenshots/super-admin-subscriptions-desktop.png) |
| AI Management | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/5e0d4d9/docs/screenshots/super-admin-ai-desktop.png) |
| Settings | [link](https://github.com/mohammadaljallad079-rgb/speed/blob/5e0d4d9/docs/screenshots/super-admin-settings-desktop.png) |

Mobile variants exist for each and are listed in
`docs/screenshots/MANIFEST.json`.

---

## 5. Stages 2 and 3 — verified, not rebuilt

Both were already delivered. They were checked against the brief rather than
recreated:

**Stage 2** (`a787e5f`): General Ledger, Trial Balance, Profit & Loss, Balance
Sheet and Cash Flow pages all exist under `src/app/reports/`. The BD 99
invoice-to-collection acceptance scenario is covered by
`tests/exec64-tenant-chart-acceptance.test.ts` — **45 tests, all pass** — which
asserts two companies holding identical account codes never resolve to each
other's accounts, that BD 99 issue→collect reconciles per company, that a retry
does not double-post, and that a pre-014 schema still posts.

**Stage 3**: Purchases, Supplier Bills, Supplier Payments, Supplier Statements,
Aging, vehicle/branch expense allocation and the purchasing reports all exist.
Debit Notes have posting logic (`debit-note-posting.ts`) and an API route, and
are surfaced through `/purchases/returns` — which is where the sidebar points
(`DashboardLayout.tsx`), so there is no missing page.

---

## 6. Honest status

**Complete and verified:** the account-picker hardening (both defects), the
tests, the screenshots, the capture guard, the invariants.

**Verified as already complete:** Stages 2 and 3, including the BD 99 scenario.

**Not done, and not claimed:**

- Migration `014_tenant_chart_of_accounts.sql` is **not applied to production**.
  DDL is an operator step — the sandbox has no DDL path to the live project.
  Until it is applied the `00`-suffix heuristic is the fallback, which is why
  the picker was built to work both before and after.
- Nothing was deployed. Production was not touched.

The branch is ready for the operator to apply migration 014 and deploy.
