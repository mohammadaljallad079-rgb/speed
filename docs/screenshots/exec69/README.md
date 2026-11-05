# Exec 69 — Access boundary + Super Admin console (screenshots)

These are **real browser screenshots** of the running application, not mockups.

How they were produced:

1. A local, in-memory Supabase-compatible stub backend was started
   (`node scripts/dev/stub-supabase.mjs 54321`). It serves the small slice of the
   Supabase API the app uses (GoTrue password grant + `getUser`, PostgREST
   `select`/`eq`/`is`/`in`, and the `generate_document_number` RPC) over a small,
   obviously-fake seeded dataset (two tenants, four identities).
2. The application was built and served against that stub
   (`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`, `next start -p 3000`).
3. A real browser navigated the app and signed in through the real forms.

No production system was contacted. No live financial data was read or written.

---

## 1. The reported defect: a customer must not reach the ERP

| # | Screenshot | What it proves |
|---|---|---|
| 01 | [`01-customer-login.png`](./01-customer-login.png) | The customer portal has its own sign-in door. |
| 02 | [`02-customer-dashboard.png`](./02-customer-dashboard.png) | After signing in, a `client` lands on the **customer portal**, not the ERP. |
| 03 | [`03-customer-blocked-from-erp.png`](./03-customer-blocked-from-erp.png) | Navigating to `/dashboard` as that customer redirects to `/access-denied`. **This is the bug fix.** |

Before the fix the middleware only asked "is there a session?", so an
authenticated customer was served the ERP shell at `/dashboard`. It now resolves
the caller's area from the session role and refuses a cross-area request.

The same boundary is enforced on the API surface (verified by direct request):

| identity | `/api/me` | `/api/customers` | `/api/invoices` | `/api/customer/bookings` |
|---|---|---|---|---|
| `client` | 200 | **403** | **403** | 405 (method) |
| `admin` | 200 | 405 (method) | 200 | **403** |
| `super_admin` | 200 | **403** | 403 | 403 |

`/api/me` stays reachable by every authenticated identity because both login
flows depend on it to learn their role.

## 2. The global Super Admin console

Signed in as the tenant-less `super_admin` (`admin@system.local`).

| # | Screenshot | What it proves |
|---|---|---|
| 04 | [`04-super-admin-login.png`](./04-super-admin-login.png) | A separate operator door, distinct from the company sign-in. |
| 05 | [`05-super-admin-overview.png`](./05-super-admin-overview.png) | Live platform totals (tenants, users, branches) and the audit feed, derived from the tables rather than stored. |
| 06 | [`06-super-admin-companies.png`](./06-super-admin-companies.png) | Per-company status, user counts and plan, with a search filter. |
| 07 | [`07-super-admin-tenant-users.png`](./07-super-admin-tenant-users.png) | A company drawer with its users and Activate/Suspend controls. |
| 08 | [`08-super-admin-ai-management.png`](./08-super-admin-ai-management.png) | Provider/model/key management, the read-only tool catalogue with risk levels, and the assistant. |
| 09 | [`09-super-admin-subscriptions.png`](./09-super-admin-subscriptions.png) | The package capability matrix and per-company plan assignment. |
| 10 | [`10-super-admin-settings.png`](./10-super-admin-settings.png) | Where each global setting is managed. |

## Reproducing

```bash
node scripts/dev/stub-supabase.mjs 54321          # stub backend
# in another shell, with the env pointed at it:
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
NEXT_PUBLIC_SUPABASE_ANON_KEY=stub-anon-key \
SUPABASE_SERVICE_ROLE_KEY=stub-service-role \
  npm run build && npx next start -p 3000
```

Seeded identities (password `Verify!2026`):

| email | role |
|---|---|
| `admin@system.local` | `super_admin` (tenant-less) |
| `speedadmin@speed.local` | `admin` (SPEED tenant) |
| `staff@speed.local` | `staff` (SPEED tenant) |
| `customer@example.com` | `client` |

The stub is development tooling only. It is not imported by application code and
is not part of a production build.
