# SPEED ERP — Execution 73 Report

Continuation of the customer-facing and platform work on branch
`feat/final-hardening-round5`. Every claim below is backed by a command whose
output is reproduced here, or is explicitly marked **BLOCKED** / **NOT DONE**.

Baseline at the start of this execution: `4c417bd` (Exec 72.4).
Commit delivered: `6e7a5a3`.

---

## 1. Summary

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Start Free lifecycle (`exec73-start-free-lifecycle`) | **DONE** | 10/10 tests; 2 mutations caught |
| 2 | Book Now flow, real browser | **DONE** | defect found + fixed; 18/18 browser checks; 7 route tests |
| 3 | RLS isolation on the **live** Supabase | **BLOCKED** | placeholder credentials; `verify-live-schema.mjs` reports NOT VERIFIED |
| 4 | Isolation model proven by execution | **DONE** | 11 harnesses, ~242 assertions, 17/17 isolation on PostgreSQL 17 |
| 5 | Migration inventory + activation order | **DONE** | 17 migrations, 14 activation packages, 74 integrity assertions |
| 6 | Full suite + PR update | **DONE** | 1635 tests / 1629 pass / 0 fail / 6 skipped |

The headline result is **Item 2: a real, customer-blocking defect was found and
fixed.** Bookings did not work at all — for any customer.

---

## 2. Item 2 — the Book Now defect

### 2.1 What was wrong

Driving the flow in a real browser showed every booking failing. The booking was
never even attempted:

```
PUT /api/customer/profile        -> 403 Missing permission: customers.edit
POST /api/customer/bookings      -> never reached
```

`src/app/api/customer/profile/route.ts` was gated on the ERP permission
`customers.edit`. But `DEFAULT_ROLE_PERMISSIONS.client` is **empty by design** —
a rental customer holds no ERP permissions. So the only role the route exists for
could never satisfy its own guard. The route was unconditionally 403.

The customer dashboard persists the customer's identity documents before
creating a booking and treats a failed profile write as fatal, so the 403
returned early and **no booking was ever created**.

### 2.2 The fix

Gate the route by role, exactly as its siblings already are:

```diff
- const context = await requireContext(request, { module: "customers", action: "edit" });
+ const context = await requireContext(request, { allowRoles: ["client"] });
```

`/api/customer/bookings` and `/api/customer/available-cars` already used
`allowRoles: ["client"]`; the profile route was the outlier.

This does **not** widen access. The row being written is resolved from the
session (`context.customerId`, read from `users.customer_id`), never from the
request body, so a client can only ever update its own customer row. The `client`
role is itself the entire authorisation.

### 2.3 Proof the test has teeth

Reverting the gate to the buggy version:

```
REVERTED to the buggy gate; the test must now fail:
ℹ tests 7
ℹ pass 5
ℹ fail 2
  403 !== 200
    actual: 403,
```

Two of the seven route tests fail. The regression cannot return silently.

### 2.4 Browser verification (18/18)

`scripts/dev/e2e-exec73-book-now.mjs` drives real Chromium:

```
PASS  the customer signed in through the real form
PASS  the fleet page for car3 renders that vehicle -- Mazda CX5
PASS  the fleet page offers a Book Now action
PASS  the deep-linked vehicle is the one selected in the booking form
PASS  the form names the vehicle, not just an id -- Mazda CX5 2025 — For Rent
PASS  the booking form exposes pickup and return date inputs -- 2 date input(s)
PASS  the vehicle stays selected when the window becomes 2026-12-01 -> 2026-12-05
PASS  the vehicle stays selected when the window becomes 2027-02-10 -> 2027-02-14
PASS  the estimate uses the selected vehicle's own rate for the window
PASS  a car with an overlapping booking is withheld for that window
PASS  the same car is offered again once the window is clear
PASS  the form provides an address search for pickup and dropoff
PASS  the booking was saved -- 0 -> 1 contract(s) for car3
PASS  the SAVED reservation is the vehicle that was selected -- saved car_id=car3
PASS  the SAVED reservation carries the window that was chosen
PASS  the form does not pretend to support a time-of-day window it cannot enforce
PASS  no unexpected console errors during the flow

18/18 checks passed
```

The critical assertion is that the **saved** reservation names the selected
vehicle and the chosen window — not merely that a row appeared.

### 2.5 Screenshots (committed)

| File | Shows |
|------|-------|
| `docs/screenshots/exec73/00-fleet-page-book-now.png` | the public fleet page with the Book Now action |
| `docs/screenshots/exec73/01-selected-vehicle-in-form.png` | the deep-linked vehicle already selected |
| `docs/screenshots/exec73/02-vehicle-kept-after-date-change.png` | selection survives a date change |
| `docs/screenshots/exec73/03-availability-follows-window.png` | availability reacts to the window |
| `docs/screenshots/exec73/04-booking-saved.png` | the saved booking |

### 2.6 A limitation, recorded rather than hidden

The form collects **dates only**; there are no time inputs, and the availability
API accepts `start`/`end` dates only. A same-day turnover therefore cannot be
expressed. Migration `017` supports a `tsrange` with times, but the app never
supplies them. This is asserted as its own check so it stays visible.

---

## 3. Item 1 — Start Free lifecycle

`tests/exec73-start-free-lifecycle.test.ts`, 10 tests, **10/10 pass**. It composes
the real server-side path (`resolveAuthContext` + effective-plan/trial) rather
than calling `/api/me`, which needs Next's `cookies()` request scope. It covers
signup, two companies remaining independent, trial state, capability loss at
expiry (not merely a flag), and super-admin activation.

Mutation testing:

| Mutation | Result |
|----------|--------|
| `trial.ts` boundary made inclusive | caught by the unit test |
| `effective-plan.ts` treats an expired trial as active | **2 tests fail** |

Registered in `package.json` `test:core`.

---

## 4. Item 3 — live RLS verification: BLOCKED

`.env.local` holds **placeholder** credentials:

```
NEXT_PUBLIC_SUPABASE_URL=https://chlk…        (the correct project ref)
NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-…
SUPABASE_SERVICE_ROLE_KEY=placeholder-…
```

The values are 20 and 23 characters and are not JWTs. The live host **is**
reachable — `HTTP 401 in 0.24s` — so this is a credentials block, not
connectivity.

`node scripts/verify-live-schema.mjs`:

```
NOT VERIFIED - Live schema could NOT be read: no usable Supabase URL/key in
.env.local (the values present are placeholders). Nothing is verified or
refuted.
```

It fails closed and does not claim success. **A real anon and service-role key
are operator inputs.** No live read or write was performed.

---

## 5. Item 4 — isolation proven by execution

A throwaway PostgreSQL 17 container, a schema mirroring the live project, real
`anon`/`authenticated`/`service_role` roles, and a GUC-driven `auth.uid()`.

**Migrations 001→004:** applied cleanly, and re-applied cleanly (idempotent).

**Post-conditions:**

| Check | Result |
|-------|--------|
| RLS enabled on every public table | **64 / 64** |
| `anon` table privileges | **0** |

**The repository's own `isolation_harness`:**

```
RESULT: 17 passed, 0 failed
ISOLATION: PASS
```

Including: a company admin reads only its own tenant; a cross-tenant INSERT is
blocked; cross-tenant UPDATE and DELETE affect 0 rows; a NULL-tenant row is not
a cross-tenant path; an ordinary staff member is confined; a super admin reads
across tenants; `anon` cannot select, insert or execute `is_super_admin()`; the
audit trail cannot be updated or deleted; a company admin cannot promote itself
to `super_admin`; account `41003` is created once; the receipt and sales_return
sequences exist.

**All eleven migration harnesses:**

| Harness | Result |
|---------|--------|
| `isolation_harness` | 17 / 17 PASS |
| `004_harness` | PASS |
| `005_harness` | 10 / 10 |
| `007_harness` | 15 / 15 |
| `008_harness` | PASS |
| `011_harness` | 28 / 28 |
| `013_harness` | 15 / 15 |
| `014_harness` | 36 / 36 |
| `015_harness` | 43 / 43 |
| `016_harness` | 39 / 39 |
| `017_harness` | 39 / 39 |

≈242 behavioural assertions. **This proves the SQL. It does not prove the live
database** — that remains blocked per §4.

---

## 6. Item 5 — migrations and activation order

17 migrations are present, `001` through `017`, each with a non-destructive
`*_rollback.sql`. 14 frozen activation packages exist.

`tests/activation-package-integrity.test.ts`: **74 assertions, 74 pass** —
every embedded body is recomputed against its recorded SHA-256 banner, so a
stale banner fails.

Activation order: `001 → 002 → 003 → 004 → 005 → 006 → 007 → … → 017`, via the
Supabase SQL Editor. Run the `005` duplicate-journal preflight first (it must
return zero rows) and never continue past a failed statement.

---

## 7. Item 6 — verification gates

| Gate | Result |
|------|--------|
| `npm test` | **1635 tests / 1629 pass / 0 fail / 6 skipped** |
| `npm run typecheck` | **0 errors** |
| `npm run lint` | **clean** ("No ESLint warnings or errors") |
| Migration harnesses (PostgreSQL 17) | **11 / 11 pass, ~242 assertions** |
| Activation-package integrity | **74 / 74** |
| Browser Book Now flow | **18 / 18** |

---

## 8. Files changed

| File | Change |
|------|--------|
| `src/app/api/customer/profile/route.ts` | gate by role, not by an unsatisfiable ERP permission |
| `tests/exec73-book-now-path.test.ts` | **new** — 7 route tests for the booking path |
| `tests/exec73-start-free-lifecycle.test.ts` | **new** — 10 tests for the Start Free lifecycle |
| `scripts/dev/e2e-exec73-book-now.mjs` | **new** — real-browser flow with evidence capture |
| `scripts/dev/local-supabase-stub.mjs` | auth admin API, a `client` identity, a free car |
| `package.json` | register both new suites in `test:core` |
| `docs/screenshots/exec73/*.png` | **new** — 5 screenshots of the flow |
| `AGENTS.md` | Execution 73 invariants |

---

## 9. Not done / blocked

- **Live RLS verification (Item 3)** — blocked on real Supabase credentials.
  Reported as NOT VERIFIED; nothing was faked.
- **Same-day turnover** — the booking form has no time-of-day inputs and
  availability is date-granular. Recorded as an asserted limitation.
- **No production deploy, no live data change** was performed.
