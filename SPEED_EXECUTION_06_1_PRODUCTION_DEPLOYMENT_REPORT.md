# SPEED ERP — EXECUTION 06.1
## DEPLOY EXECUTION 06 TO PRODUCTION + LIVE VERIFICATION

Date: 2026-09-30
Repo: `aljallad2025/orchids-remix-of-car-rental---sales-system2026`
Target host: `/var/www/speed.harbourconsultancies.com` (PM2 `speed`, port 3090)
Domain: `https://speed.harbourconsultancies.com`

---

## 0. Headline

The Execution 06 code was **committed and pushed** to `origin/main`
(`eec43c2`), and was **fully verified locally in production mode** (build,
HTTP, API authz, live Supabase signup/onboarding with full cleanup, RLS).

The **server-side deployment** (`git pull --ff-only`, `npm run build`,
`pm2 restart speed`) could **NOT be performed from this environment**: the
production host is not reachable here. The live domain therefore still serves
the **old** car-rental build (confirmed). See §7 for the exact reason and §13
for the exact remaining action.

---

## 1. Deployment commit

- **Commit:** `eec43c2be87d0095c45ce73810066603a4e331ad`
- **Message:** `feat: complete execution 06 saas website and free onboarding`
- **Files:** 21 changed (`+3215 / −269`)
- **Pushed:** fast-forward `7037aa7..eec43c2` on `origin/main` (verified via
  GitHub API: 21 files, same sha). `origin/main == HEAD`, ahead 0 / behind 0.
- `7037aa7` was **not** amended, reset or force-pushed. No force push was used.

> **Scope note:** the working tree contains substantial **uncommitted Exec 01–05
> work** (`src/lib/accounting`, `src/lib/sales`, `src/lib/excel`, many routes and
> tests). Only the **Execution 06 change set** was committed and pushed, exactly
> as scoped. Exec 01–05 were left uncommitted (they are outside this task's
> commit instruction and involve far more than the Exec 06 change set).

---

## 2. Server path / environment access

- **Server path:** `/var/www/speed.harbourconsultancies.com` — **NOT present in
  this environment.**
- **PM2:** **NOT installed** here (`pm2` command absent).
- **SSH:** **no SSH client, no `~/.ssh`** — the production host cannot be reached.
- This is a sandboxed build container (`runtime-…` pod), not the production VM.
- **Conclusion:** the on-server steps (pull/build/restart) **cannot be executed
  from here** and are reported **NOT RUN** (no failure implied — simply not
  reachable from this sandbox).

---

## 3. Pre-deploy safety

| Check | Result |
| --- | --- |
| Branch | `main` |
| Commit before work | `7037aa7` |
| `.env.local` | present (`-rw-rw-r--`, 722 bytes), **untracked** — verified |
| `.env.local` overwritten | **No** |
| Secrets printed | **No** (all key output masked) |
| `NEXT_PUBLIC_SUPABASE_URL` configured | Yes (masked) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` configured | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` configured server-side | Yes |
| Secret scan of staged diff | Clean — only doc/env-var-*name* references, no values |
| `.env.local` in commit | **No** |

---

## 4. Dependencies

- `@supabase/ssr` is present in `package.json` (`^0.12.7`) and in
  `package-lock.json`. **No install was required.**
- **No dependency upgrade, no `npm audit fix --force`, no Node version change.**
- Local Node here: `v24.21.0`. Production Node (`~20.20.1`) was **not changed**;
  note the mismatch between this sandbox and the stated production version —
  build was validated here, not on Node 20.

---

## 5. Build

- `npm run build` → **PASS** (exit 0).
- All new routes emitted: `/`, `/features`, `/solutions`, `/pricing`, `/faq`,
  `/privacy`, `/terms`, `/signup`, `/onboarding`, `/api/saas/signup`,
  `/api/saas/onboarding`.
- Only pre-existing warning: `experimental.missingSuspenseWithCSRBailout`
  unrecognized key in `next.config.js` (not introduced here, left untouched).

---

## 6. PM2 / restart

- **NOT RUN** — `pm2` is not available in this environment and the production
  host is unreachable. No `pm2 restart speed --update-env` was executed.

---

## 7. Live HTTP verification

### 7a. Deployed domain (actual production) — **NOT VERIFIED / OLD BUILD**

Probed `https://speed.harbourconsultancies.com`:

| Path | Result |
| --- | --- |
| `/` | 200 — but `<title>Speed Application</title>` and **"Drive with SPEED"** (old car-rental landing) |
| `/features` | **404** |
| `/pricing` | **404** |
| `/signup` | **404** |
| `/login` | 200 |
| `/api/public/vehicles` | 401 |

→ The deployed server still runs the pre-Exec-06 build. **Deployment has not
happened.** This is the expected consequence of §2.

### 7b. Local production-mode server (`next start`) — **PASS**

| Path | Status |
| --- | --- |
| `/` | 200 (SPEED ERP SaaS hero: "Run Your Business Smarter with SPEED ERP") |
| `/features` | 200 |
| `/solutions` | 200 |
| `/pricing` | 200 |
| `/faq` | 200 |
| `/privacy` | 200 |
| `/terms` | 200 |
| `/signup` | 200 |
| `/login` | 200 |
| `/onboarding` | 200 (shell only; no protected data to anonymous callers) |

---

## 8. API security (local production mode) — **PASS**

| Request | Expected | Actual |
| --- | --- | --- |
| `GET /api/invoices` | 401 | **401** |
| `GET /api/expenses` | 401 | **401** |
| `GET /api/users` | 401 | **401** |
| `GET /api/suppliers` | 401 | **401** |
| `GET /api/excel/export` | 401 | **401** |
| `POST /api/saas/onboarding` | 401 | **401** |
| `GET /api/public/vehicles` | 200 | **200** |
| `GET /api/public/company-profile` | 200 | **200** |
| `POST /api/saas/signup` (invalid payload) | 400 | **400** `validation_error` (no tenant created) |

> On the **deployed** host, `GET /api/public/vehicles` returned **401** — that is
> the old build's behavior and further confirms the new code is not deployed.

---

## 9. Free signup live test (disposable) — **PASS, then fully cleaned up**

Executed against the live Supabase project (`chlkmdobhvfnldqkgdji`) using one
disposable email `deploy.exec061.<ts>@speed-disposable.test`:

| # | Check | Result |
| --- | --- | --- |
| 1 | signup succeeds | **PASS** (`{"success":true}`) |
| 2 | a NEW tenant is created | **PASS** |
| 3 | user role is `admin` | **PASS** |
| 4 | user belongs only to the new tenant | **PASS** (`tenant_id` = the new tenant) |
| 5 | `tenant_id` NOT supplied by the browser | **PASS** (server-generated; route never reads it from body) |
| 6 | onboarding works | **PASS** (`{"success":true,"applied":["company","business_info","branch"]}`) |
| 7 | company name stored | **PASS** (`Deploy Test 061 Co Ltd`) |
| 8 | business information stored | **PASS** (`settings.company_profile`) |
| 9 | financial year exists | **PASS** (provisioned at signup: `2026`, `is_current`) |
| 10 | optional branch created | **PASS** (`Branch 061`, scoped to tenant) |
| 11 | user reaches dashboard | **PASS** (authenticated `GET /dashboard` → 200) |

**Cleanup (all performed, then verified empty):**

| Resource | Deleted | Post-check |
| --- | --- | --- |
| auth user | 200 | **404** (gone) |
| `users` row | 204 | `[]` |
| `tenants` row | 204 | `[]` |
| `branches` | 204 | `[]` |
| `settings` | 204 | `[]` |
| `financial_years` | 204 | `[]` |
| `customers`/`invoices`/`expenses`/`journal_entries`/`accounts` (tenant-scoped) | 204 each | none created |

**Production data untouched:** total tenant count returned to **0** (the state
before the test). No existing production tenant or data was modified.

---

## 10. RLS verification — **PASS (not weakened)**

Anonymous direct REST reads against sensitive ERP tables, after the work:

| Table | Result |
| --- | --- |
| customers | `42501 permission denied` |
| invoices | `42501` |
| users | `42501` |
| accounts | `42501` |
| journal_entries | `42501` |
| expenses | `42501` |
| tenants | `42501` |
| suppliers | `42501` |
| payments | `42501` |

- No RLS policy was modified; no public policy was created for any ERP table.
- Public website data continues through the existing safe public routes
  (`/api/public/vehicles`, `/api/public/company-profile`) only.

---

## 11. Public website verification — **PASS (local build)**

Confirmed via rendered content:

- Branding **SPEED ERP**; SaaS hero "Run Your Business Smarter with SPEED ERP".
- CTAs: **"ابدأ مجانًا" / "Start Free"** and **Login** present.
- Sections present: Why, Core modules (14 real modules), How it works, Free plan
  (`$0`), Security, dashboard preview, FAQ, CTA, footer (Product / Company /
  Account).
- Responsive navbar (Features, Solutions, Pricing, FAQ, Contact, عربي, Login,
  Start Free) and footer.
- Arabic/English direction support (`dir={isRTL …}` on every page; عربي toggle).
- **No fake** statistics, customer logos, testimonials, payment claims, or
  paid-plan prices (paid plans are "coming soon / contact us").
- **Inventory is NOT advertised** anywhere (asserted by test and by content
  review).

---

## 12. Signup security (deployed implementation inspection) — **PASS**

- `tenant_id` cannot be supplied by the signup body — **confirmed** (route never
  reads it; test asserts it).
- `role` cannot be supplied by the body — **confirmed** (literal `admin`).
- `company_id` cannot be supplied by the body — **confirmed**.
- `user_id` cannot be supplied by the body — **confirmed**.
- Public signup **always creates a NEW tenant** — **confirmed** (E2E).
- Public signup **always creates the creator as admin of that tenant** —
  **confirmed** (E2E: `role = admin`).
- Duplicate email returns **409** — **confirmed** (`email_taken`).
- Failed provisioning **rolls back** partial resources — **confirmed** by code
  (auth user + tenant deleted on partial failure) and by test.
- Service-role key is **never sent to the browser** — **confirmed**: grep of
  `.next/static` finds no `service_role`/`SUPABASE_SERVICE_ROLE` string; client
  bundles reference only `chlkmdobhvfnldqkgdji.supabase.co` (16 hits).
- `/api/saas/signup` is the **only newly public SaaS API route** — **confirmed**
  (middleware allow-list extended by exactly that prefix; `/api/saas/onboarding`
  stays behind the auth gate).

---

## 13. Production environment check — **PASS (with a pre-existing observation)**

- Data-access Supabase project used by the app: **`chlkmdobhvfnldqkgdji`**
  (all `NEXT_PUBLIC_*` client refs point here). ✔ matches expected.
- A second ref, `slelguoygbfzlpylpxfs`, appears in `.next` and in
  `src/app/layout.tsx`, but it is **not a database** — it is the **pre-existing
  Orchids platform script host** (`/storage/v1/object/public/scripts/…`
  `orchids-browser-logs.js`, `route-messenger.js`). It is unrelated to ERP data,
  existed before Exec 06, and is **out of scope** (left untouched).
- No accidental reference to any unrelated **database** project was found.

---

## 14. Mobile / RTL — **static PASS; visual NOT AVAILABLE**

Static code check (PASS):

- Mobile-first layout with responsive breakpoints: `sm:` ×23, `md:` ×6, `lg:` ×21
  across the new pages; **no fixed `w-[Npx]` / `min-w-[Npx]`** widths.
- Hamburger navigation present and accessible (`aria-label`, `aria-expanded`,
  `Menu`/`X` toggle, closes on link click).
- RTL/LTR: `dir={isRTL ? "rtl" : "ltr"}` on every new page; logical spacing and
  mirrored arrows.
- Mobile CTA layout uses `flex-wrap`.

Visual viewport testing at 360 / 390 / 414 / 768 / 1024 / 1440 px for `/`,
`/signup`, `/login`, `/pricing`: **NOT AVAILABLE** — the browser tool used here
does not expose viewport-resize emulation. Pages were rendered and inspected at
default viewport only.

---

## 15. Regression tests — **PASS**

| Command | tests | pass | fail | skipped |
| --- | --- | --- | --- | --- |
| `npm test` | 379 | **373** | **0** | 6 |
| `npm run test:core` | 137 | 131 | 0 | 6 |
| `npm run test:accounting` | 30 | 30 | 0 | 0 |
| `npm run test:excel` | 167 | 167 | 0 | 0 |
| `npm run test:sales` | 21 | 21 | 0 | 0 |
| `npm run build` | — | **PASS** | — | — |

Matches the expected baseline exactly (379 / 373 / 0 / 6).

---

## 16. TypeScript — **baseline unchanged (PASS, no expansion)**

- `npm run typecheck` → **119 errors**, identical to the known pre-existing
  baseline. **0 new errors.** Not expanded.

---

## 17. Lint — **pre-existing FAILED (not caused here)**

- `npm run lint` crashes in the ESLint/`next lint` tooling with a
  circular-structure serialization error (`property 'configs' … property 'react'
  closes the circle`). This is a pre-existing configuration/tooling issue,
  unrelated to Exec 06; **no unrelated lint/config refactoring was attempted**
  (per instructions).

---

## 18. Status summary

```
DEPLOYMENT:      PARTIAL   — committed eec43c2 + pushed origin/main (fast-forward);
                             on-server pull/build/restart NOT RUN (host unreachable)
BUILD:           PASS      — npm run build exit 0 (local, Node 24; prod Node 20 not used here)
PM2:             NOT RUN   — pm2 unavailable in this environment
PUBLIC WEBSITE:  PASS (local build) / NOT VERIFIED on the deployed domain (still old build)
FREE SIGNUP:     PASS      — E2E against live Supabase; new tenant, admin role, cleanup verified
ONBOARDING:      PASS      — E2E authenticated, tenant-scoped; cleanup verified
RLS:             PASS      — anon denied (42501) on all sensitive tables; not weakened
TESTS:           PASS      — 379 / 373 / 0 / 6; all named sub-suites green
MOBILE/RTL:      PASS (static) / NOT AVAILABLE (visual viewports)
TYPESCRIPT:      PASS      — 119 pre-existing errors, 0 new
LINT:            FAILED    — pre-existing tooling crash (out of scope)
```

---

## 19. Warnings

- Deployed domain still serves the **old** car-rental build.
- `next.config.js` `experimental.missingSuspenseWithCSRBailout` unrecognized key
  (pre-existing).
- Node version mismatch between this sandbox (24) and production (~20.20.1) —
  build validated on 24 only.
- `src/app/layout.tsx` includes the pre-existing Orchids platform scripts from
  `slelguoygbfzlpylpxfs` (not a database; out of scope).
- **Pre-existing (not introduced here, flagged for awareness):** the middleware
  only enforces authentication on `/api/*`; page routes such as `/dashboard`
  return 200 to anonymous callers and rely on client-side gating. This predates
  Exec 06 and was **not modified** (out of scope), but it is a real
  defense-in-depth gap worth a future hardening pass.

---

## 20. Exact remaining blockers

1. **The on-server deployment has not been performed.** From the production host:

   ```
   cd /var/www/speed.harbourconsultancies.com
   git pull --ff-only origin main          # 7037aa7 -> eec43c2
   npm run build
   pm2 restart speed --update-env
   pm2 status && pm2 logs speed --lines 100 --nostream
   ```

   `.env.local` must remain in place (do not overwrite). Then re-run §7a / §8
   against `https://speed.harbourconsultancies.com`.

2. Visual viewport verification (mobile/RTL) remains **NOT AVAILABLE** in this
   environment; run it after deploy (or in a viewport-capable browser).

3. Pre-existing middleware page-route gating gap (see §19) — **out of scope**,
   recommend a dedicated hardening task.
