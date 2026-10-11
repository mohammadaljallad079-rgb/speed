# SPEED ERP — Production Readiness Check (read-only)

Requested host: `/var/www/speed.harbourconsultancies.com` · Repo: `mohammadaljallad079-rgb/speed`
Run date: 2026-10-11 · **No publish, no build, no restart, no DB change, no file change.**

---

## 0. Critical finding first: production host is not reachable

This execution ran in the OpenHands sandbox container
(`runtime-qbugzfvjammpvgwb-…`), **not** the production VM:

- `/var/www` and `/var/www/speed.harbourconsultancies.com` → **do not exist**.
- `pm2` → **not installed**; no PM2 app to inspect.
- `~/.ssh` → **does not exist**; no route to the production host.
- No `DATABASE_URL`, no `SUPABASE_*` env, no `.env.local` in the sandbox.

Therefore **every on-server and database item below is reported as NOT VERIFIED**,
not as "pass". No read-only SQL probe could be run. I did not attempt to create
credentials or change any Supabase setting.

---

## 1. GitHub version (verified)

- `git fetch origin` → executed (read-only). `origin/main` head = **`f02125d`**
  (`docs: deployment readiness review of the AI reporting updates`).
- Sandbox clone `HEAD` = **`f02125d`**, working tree **clean** (`git status --short`
  empty), `0  0` ahead/behind `origin/main`.
- Diff between what a hypothetical server at `8addbb7` would have and GitHub
  `f02125d`: commits `5016e0a` (aggregate/sort fixes) and `f02125d` (review doc).
- **The real server's `HEAD` and `git status` could NOT be observed** (no host
  access). Any statement about the server's checked-out version would be a guess,
  so it is not made.

## 2. Server change protection (NOT VERIFIABLE)

- The production working tree could not be inspected, so local/untracked server
  files could not be listed or compared.
- No previous server backups could be located or checked (not on this host).
- Nothing on the server was deleted, overwritten, reset, cleaned, pulled, or built.
- In the sandbox clone (not the server): `scripts/provision-admin-accounts.mjs`,
  `scripts/verify-admin-accounts.mjs`, `package-lock.json` are present and untouched;
  `.provision-preload.cjs` is not present in this snapshot. No secret values printed.

## 3. Database columns the reporting engine needs (NOT VERIFIED)

Could not run any safe read-only query — there are no Supabase/Postgres
credentials in this environment and no permitted schema endpoint. Recorded as
**NOT VERIFIED**; nothing was written to the database.

Required columns (from the reporting code, for the operator to confirm live):
- `invoices`: `invoice_number, invoice_date, status, vat_amount, total_amount, paid_amount, due_date, customer_id` (+ `tenant_id`)
- `purchase_invoices`: `invoice_number, bill_date, status, vat_amount, total_amount, supplier_id` (+ `tenant_id`)
- `expenses`: `expense_date, category, description, amount, vat_amount, branch` (+ `tenant_id`)
- `payments`: `payment_date, amount, payment_method, invoice_id` (+ `tenant_id`)
- `accounts`: `code, name, type` (+ `tenant_id`)
- `customers`: `full_name` (+ `tenant_id`, `id`) · `suppliers`: `name` (+ `tenant_id`, `id`)
- `settings`: `key, value` (+ `tenant_id`) · `activity_logs`: `action, entity, entity_id, metadata, created_at` (+ `tenant_id`, `user_id`)

## 4. Application state (partial)

- **PM2 / app name (`speed`)**: NOT VERIFIED — no PM2 in this environment.
- Node `v24.21.0`, npm `11.19.1` — the **sandbox's** versions, not the server's.
- Disk `/` 52 GB free (29% used); `/workspace` 23 GB free (9% used). Memory 13 GB
  free. (Sandbox figures; server figures unverified.)
- Live site over read-only HTTPS GET:
  - `https://speed.harbourconsultancies.com/login` → **200**
  - `https://speed.harbourconsultancies.com/` → **200**
  - `https://speed.harbourconsultancies.com/pricing` → **200**
  - The production site is **up and serving**. No application log could be read
    (no PM2/host access).

## 5. Final decision

**BLOCKED — for on-server/database readiness verification.**

- GitHub side: **ready** — `origin/main` = `f02125d`, the fix commit `5016e0a` is
  present, no newer version.
- On-server side: **blocked** — the production host (`/var/www/…`, PM2, logs,
  backups, working-tree state) and the database schema are **not reachable from
  this environment**. I cannot certify the server is safe to update, nor that the
  live columns exist.

### What is needed to unblock (exact)

Run these on the production VM (read-only) and return the output:
```bash
cd /var/www/speed.harbourconsultancies.com
git rev-parse HEAD && git log --oneline -1
git status --short
git fetch origin && git log --oneline -1 origin/main
pm2 list
ls -la scripts package-lock.json .provision-preload.cjs 2>&1
ls -1 *.bak backups 2>/dev/null      # locate existing backups
```
And, from a host that has the Supabase project, a read-only schema confirmation of
the columns listed in section 3 (e.g. `GET /rest/v1/<table>?select=<cols>&limit=1`,
or an information_schema query). **No publish, restart, build, migration or
credential change** should happen until that output is reviewed and explicitly
approved.

---

Status: **READY (GitHub) / BLOCKED (server + DB)**. Stopping as instructed; no
production change was made. Awaiting explicit approval before any next step.
