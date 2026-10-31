/**
 * Exec 75 - signup provisioning is all-or-nothing.
 *
 * THE DEFECT THESE TESTS PIN
 * --------------------------
 * The signup route provisioned five things (auth user, tenant, owner profile,
 * financial year, seven-day trial) and then answered `success: true`. It never
 * looked at the financial-year insert's error, and it never checked whether the
 * trial was granted. So a signup could report success for an account that could
 * not post a single entry (no financial year) or that had no trial at all. The
 * earlier steps were also compensated only on their OWN failure, so a failure at
 * step 4 or 5 left an auth user and a tenant behind.
 *
 * These tests drive the REAL service against a recording stub that models the
 * real PostgREST behaviour (it applies the filters it is given, and returns only
 * the rows it holds), and assert:
 *
 *   - success requires all five rows to exist;
 *   - a failure at ANY step compensates everything that call created;
 *   - a retry is idempotent: it reuses what exists, duplicates nothing, and does
 *     not extend the trial;
 *   - a reused auth identity is never deleted by compensation (it is the
 *     customer's account).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  findAuthUserByEmail,
  provisionSignup,
  verifyProvisionedAccount,
  type SignupDb,
} from "../src/lib/saas/signup-service.ts";
import { TRIAL_DAYS } from "../src/lib/saas/trial.ts";
import { grantTenantTrial } from "../src/lib/saas/trial-store.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

type Row = Record<string, unknown>;

const NOW = new Date("2026-03-01T10:00:00.000Z");

const INPUT = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  password: "supersecret",
  companyName: "Analytical Engines",
  phone: "+97333001122",
  now: NOW,
};

interface StubOptions {
  /** Force an insert to fail for a table, as the live DB would. */
  failInsert?: Partial<Record<"tenants" | "users" | "financial_years", boolean>>;
  /** Force the settings upsert (the trial) to fail. */
  failUpsert?: boolean;
  /** An auth identity that already exists for the email. */
  existingAuthUser?: { id: string; email: string } | null;
  /** An application profile that already exists for the email. */
  existingProfile?: Row | null;
  /** `financial_years.tenant_id` missing, as on a project without migration 001. */
  yearMissingTenantColumn?: boolean;
  /** Make `deleteUser` fail, to exercise the cleanup-incomplete path. */
  failDeleteUser?: boolean;
}

/**
 * A recording stub of the service-role client.
 *
 * It keeps real tables in memory and applies the filters it is handed, so a
 * missing filter (or a row that was never created) changes the result instead of
 * being silently ignored. Every mutation is recorded, so compensation can be
 * asserted on what was actually deleted.
 */
function makeDb(options: StubOptions = {}) {
  const tables: Record<string, Row[]> = {
    tenants: [],
    users: [],
    financial_years: [],
    settings: [],
  };
  const created: string[] = [];
  const deleted: string[] = [];
  const authUsers: Array<{ id: string; email: string }> = options.existingAuthUser
    ? [options.existingAuthUser]
    : [];
  let nextId = 1;
  const uuid = () => `00000000-0000-0000-0000-${String(nextId++).padStart(12, "0")}`;

  if (options.existingProfile) tables.users.push(options.existingProfile);

  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op = "select";
    let limit: number | null = null;

    const matches = (r: Row) =>
      filters.every(([k, v]) => (v === null ? r[k] == null : r[k] === v));

    const builder: Record<string, unknown> = {};
    const self = () => builder;

    const rows = () => {
      const found = (tables[table] ?? []).filter(matches);
      return limit === null ? found : found.slice(0, limit);
    };

    Object.assign(builder, {
      select: () => {
        op = "select";
        return self();
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return self();
      },
      is(column: string, value: null) {
        filters.push([column, value]);
        return self();
      },
      limit(n: number) {
        limit = n;
        return self();
      },
      maybeSingle() {
        const found = rows();
        return Promise.resolve({ data: found[0] ?? null, error: null });
      },
      single() {
        const found = rows();
        return Promise.resolve({ data: found[0] ?? null, error: null });
      },
      insert(row: Row) {
        op = "insert";
        const fail = options.failInsert?.[table as keyof StubOptions["failInsert"]];
        const id = (row.id as string) ?? uuid();
        const stored: Row = { ...row, id };
        if (table === "financial_years" && options.yearMissingTenantColumn && "tenant_id" in stored) {
          return {
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: null,
                  error: { code: "PGRST204", message: "Could not find the 'tenant_id' column" },
                }),
              then: (res: (v: unknown) => unknown) =>
                Promise.resolve({ data: null, error: { code: "PGRST204", message: "no column" } }).then(res),
            }),
            then: (res: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: { code: "PGRST204", message: "no column" } }).then(res),
          };
        }
        if (fail) {
          return {
            select: () => ({
              single: () => Promise.resolve({ data: null, error: { message: `insert failed: ${table}` } }),
              then: (res: (v: unknown) => unknown) =>
                Promise.resolve({ data: null, error: { message: "insert failed" } }).then(res),
            }),
            then: (res: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: { message: "insert failed" } }).then(res),
          };
        }
        tables[table].push(stored);
        created.push(`${table}:${id}`);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id }, error: null }),
            then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [stored], error: null }).then(res),
          }),
          then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [stored], error: null }).then(res),
        };
      },
      delete() {
        op = "delete";
        return {
          eq(column: string, value: unknown) {
            const kept = (tables[table] ?? []).filter((r) => r[column] !== value);
            const removed = (tables[table] ?? []).filter((r) => r[column] === value);
            tables[table] = kept;
            for (const r of removed) deleted.push(`${table}:${r.id}`);
            return Promise.resolve({ data: removed, error: null });
          },
        };
      },
      upsert(row: Row, _opts?: { onConflict?: string }) {
        if (options.failUpsert) return Promise.resolve({ error: { message: "upsert failed" } });
        const key = `${row.tenant_id ?? "null"}|${row.key}`;
        tables.settings = tables.settings.filter((r) => `${r.tenant_id ?? "null"}|${r.key}` !== key);
        tables.settings.push({ ...row, id: uuid() });
        created.push(`settings:${row.key}`);
        return Promise.resolve({ error: null });
      },
      then(res: (v: unknown) => unknown) {
        // A bare `await builder` behaves like a select (PostgREST's default).
        if (op === "select") return Promise.resolve({ data: rows(), error: null }).then(res);
        return Promise.resolve({ data: null, error: null }).then(res);
      },
    });

    return builder;
  }

  const db = {
    from: (table: string) => query(table),
    auth: {
      admin: {
        async createUser(input: { email: string; user_metadata?: Record<string, unknown> }) {
          const dup = authUsers.find((u) => u.email === input.email);
          if (dup) return { data: { user: null }, error: { message: "User already registered" } };
          const user = { id: uuid(), email: input.email };
          authUsers.push(user);
          created.push(`auth:${user.id}`);
          return { data: { user: { id: user.id } }, error: null };
        },
        async deleteUser(id: string) {
          if (options.failDeleteUser) return { error: { message: "delete failed" } };
          const idx = authUsers.findIndex((u) => u.id === id);
          if (idx >= 0) authUsers.splice(idx, 1);
          deleted.push(`auth:${id}`);
          return { error: null };
        },
        async listUsers() {
          return { data: { users: authUsers.map((u) => ({ id: u.id, email: u.email })) }, error: null };
        },
      },
    },
  };

  return { db: db as unknown as SignupDb, tables, created, deleted, authUsers };
}

// ---------------------------------------------------------------------------
// The happy path: all five rows exist, and success reports the real trial end
// ---------------------------------------------------------------------------

test("signup: success only after the user, tenant, profile, year and trial all exist", async () => {
  const { db, tables } = makeDb();
  const result = await provisionSignup(db, INPUT);

  assert.equal(result.ok, true, "a complete provisioning must succeed");
  if (!result.ok) return;

  assert.equal(tables.tenants.length, 1, "exactly one tenant is created");
  assert.equal(tables.users.length, 1, "exactly one owner profile is created");
  assert.equal(tables.financial_years.length, 1, "exactly one financial year is created");
  assert.equal(tables.settings.length, 1, "exactly one trial row is created");

  // Ownership is server-generated and the role is a literal admin of the NEW tenant.
  assert.equal(tables.users[0].role, "admin");
  assert.equal(tables.users[0].tenant_id, tables.tenants[0].id);
  assert.equal(tables.financial_years[0].tenant_id, tables.tenants[0].id);
  assert.equal(tables.settings[0].tenant_id, tables.tenants[0].id);
  assert.equal(result.account.tenantId, tables.tenants[0].id);
});

test("signup: the trial is exactly seven days from provisioning", async () => {
  const { db } = makeDb();
  const result = await provisionSignup(db, INPUT);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const endsAt = new Date(result.account.trialEndsAt as string);
  const expected = new Date(NOW.getTime() + TRIAL_DAYS * 86_400_000);
  assert.equal(endsAt.getTime(), expected.getTime(), "the trial ends exactly TRIAL_DAYS after signup");
});

// ---------------------------------------------------------------------------
// The defect: a failure at step 4 or 5 must NOT be reported as success
// ---------------------------------------------------------------------------

test("signup: a financial-year failure is reported, and the account is rolled back", async () => {
  // This is the defect. The old route ignored this error and answered success,
  // leaving a tenant that could not post and had no trial.
  const { db, tables, deleted, authUsers } = makeDb({
    failInsert: { financial_years: true },
  });

  const result = await provisionSignup(db, INPUT);

  assert.equal(result.ok, false, "a signup without a financial year is NOT a success");
  if (result.ok) return;
  assert.equal(result.reason, "financial_year_failed");

  // Everything this call created is gone again.
  assert.equal(tables.tenants.length, 0, "the tenant was compensated");
  assert.equal(tables.users.length, 0, "the owner profile was compensated");
  assert.equal(tables.settings.length, 0, "no trial row is left behind");
  assert.equal(authUsers.length, 0, "the auth identity was compensated");
  assert.ok(deleted.some((d) => d.startsWith("tenants:")), "the tenant delete was issued");
  assert.ok(deleted.some((d) => d.startsWith("auth:")), "the auth user delete was issued");
});

test("signup: a trial failure is reported, and the account is rolled back", async () => {
  const { db, tables, authUsers } = makeDb({ failUpsert: true });

  const result = await provisionSignup(db, INPUT);

  assert.equal(result.ok, false, "a signup without a trial is NOT a success");
  if (result.ok) return;
  assert.equal(result.reason, "trial_failed");
  assert.equal(tables.tenants.length, 0);
  assert.equal(tables.users.length, 0);
  assert.equal(tables.financial_years.length, 0, "the year is compensated too");
  assert.equal(authUsers.length, 0);
});

test("signup: a tenant failure removes the auth user it just created", async () => {
  const { db, authUsers, deleted } = makeDb({ failInsert: { tenants: true } });
  const result = await provisionSignup(db, INPUT);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "tenant_failed");
  assert.equal(authUsers.length, 0, "no orphaned auth identity");
  assert.ok(deleted.some((d) => d.startsWith("auth:")));
});

test("signup: a profile failure removes the tenant and the auth user", async () => {
  const { db, tables, authUsers } = makeDb({ failInsert: { users: true } });
  const result = await provisionSignup(db, INPUT);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "profile_failed");
  assert.equal(tables.tenants.length, 0);
  assert.equal(authUsers.length, 0);
});

test("signup: compensation that cannot complete is surfaced, not swallowed", async () => {
  // A failed cleanup must be visible: the caller cannot fix it, but an operator
  // must be able to find it rather than believing the signup left nothing.
  const { db } = makeDb({ failInsert: { tenants: true }, failDeleteUser: true });
  const result = await provisionSignup(db, INPUT);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.cleanupIncomplete, true, "an incomplete cleanup is reported");
});

// ---------------------------------------------------------------------------
// Idempotency: a retry finishes the job instead of duplicating it
// ---------------------------------------------------------------------------

test("signup: an existing profile is refused before any auth user is created", async () => {
  const { db, authUsers, created } = makeDb({
    existingProfile: { id: "existing-user", email: INPUT.email, tenant_id: "other-tenant" },
  });

  const result = await provisionSignup(db, INPUT);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "email_taken");
  assert.equal(authUsers.length, 0, "no auth identity is created for a taken email");
  assert.equal(created.filter((c) => c.startsWith("auth:")).length, 0);
});

test("signup: a retry reuses an auth identity left by a partial failure", async () => {
  // The first attempt created the identity but failed before the tenant existed.
  // A retry must be able to finish, not be blocked by its own leftover.
  const reused = { id: "leftover-auth-id", email: INPUT.email };
  const { db, tables, authUsers } = makeDb({ existingAuthUser: reused });

  const result = await provisionSignup(db, INPUT);

  assert.equal(result.ok, true, "the retry completes the account");
  if (!result.ok) return;
  assert.equal(result.account.userId, reused.id, "the existing identity is reused");
  assert.equal(tables.tenants.length, 1, "one tenant, not two");
  assert.equal(tables.users.length, 1);
  assert.equal(authUsers.length, 1, "the identity was not duplicated");
});

test("signup: a failed retry never deletes the auth identity it reused", async () => {
  // The identity belongs to the customer and predates this call, so compensation
  // must leave it alone - deleting it would remove an account they can sign in with.
  const reused = { id: "leftover-auth-id", email: INPUT.email };
  const { db, authUsers, deleted } = makeDb({
    existingAuthUser: reused,
    failInsert: { tenants: true },
  });

  const result = await provisionSignup(db, INPUT);

  assert.equal(result.ok, false);
  assert.equal(authUsers.length, 1, "the reused identity survives a failed retry");
  assert.equal(
    deleted.filter((d) => d.startsWith("auth:")).length,
    0,
    "compensation must not delete an identity this call did not create",
  );
});

test("signup: a retry does not extend an existing trial", async () => {
  // The trial's end is a promise to the customer, so a retry must keep the
  // ORIGINAL window rather than handing out fresh days. The service passes
  // `restart: false`, which makes `grantTenantTrial` return the stored record
  // unchanged when one already exists. Both halves are asserted: the source uses
  // the safe flag, and the store's behaviour actually preserves the window.
  const source = read("src/lib/saas/signup-service.ts");
  assert.match(
    source,
    /grantTenantTrial\(\s*db,\s*tenantId,\s*\{[^}]*restart:\s*false/,
    "provisioning must grant the trial with restart:false",
  );

  const { db, tables } = makeDb();
  const result = await provisionSignup(db, INPUT);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const first = tables.settings.find((s) => s.key === "tenant_trial");
  assert.ok(first, "the trial row exists");
  const firstEnds = (first.value as { endsAt: string }).endsAt;

  // A later attempt to grant against the SAME tenant must not move the end date.
  const again = await grantTenantTrial(db, result.account.tenantId, {
    now: new Date(NOW.getTime() + 3 * 86_400_000),
    restart: false,
  });
  assert.equal(again.ok, true);
  assert.equal(again.record?.endsAt, firstEnds, "the trial end is unchanged by a retry");
});

// ---------------------------------------------------------------------------
// Verification: success is backed by re-reading the rows
// ---------------------------------------------------------------------------

test("verify: a missing financial year is detected after a reported success", async () => {
  const { db, tables } = makeDb();
  const result = await provisionSignup(db, INPUT);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal((await verifyProvisionedAccount(db, result.account)).ok, true);

  // Remove the year, as a silent failure would have left it.
  tables.financial_years = [];
  const after = await verifyProvisionedAccount(db, result.account);
  assert.equal(after.ok, false);
  if (after.ok) return;
  assert.deepEqual(after.missing, ["financial_year"]);
});

test("verify: a missing trial is detected after a reported success", async () => {
  const { db, tables } = makeDb();
  const result = await provisionSignup(db, INPUT);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  tables.settings = [];
  const after = await verifyProvisionedAccount(db, result.account);
  assert.equal(after.ok, false);
  if (after.ok) return;
  assert.ok(after.missing.includes("trial"));
});

test("findAuthUserByEmail matches case-insensitively and returns null when absent", async () => {
  const { db } = makeDb({ existingAuthUser: { id: "u1", email: "ada@example.com" } });
  assert.equal((await findAuthUserByEmail(db, "ADA@Example.COM"))?.id, "u1");
  assert.equal(await findAuthUserByEmail(db, "nobody@example.com"), null);
});

// ---------------------------------------------------------------------------
// The route wiring: it must not answer success on an unchecked step
// ---------------------------------------------------------------------------

test("signup route delegates provisioning and verifies before reporting success", () => {
  const source = read("src/app/api/saas/signup/route.ts");

  // Provisioning lives in the service, which checks every step.
  assert.match(source, /provisionSignup\s*\(/, "the route must use the provisioning service");
  assert.match(source, /verifyProvisionedAccount\s*\(/, "the route must verify before success");
  assert.match(source, /if\s*\(\s*!result\.ok\s*\)/, "a provisioning failure must be handled");

  // It must not write the provisioning rows itself any more: a second write path
  // is how the year/trial errors went unchecked in the first place.
  for (const table of ["tenants", "financial_years", "users"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`from\\(\\s*["'\`]${table}["'\`]\\s*\\)\\s*\\n?\\s*\\.insert`),
      `the route must not insert into ${table} directly`,
    );
  }
  assert.doesNotMatch(source, /grantTenantTrial\s*\(/, "the route must not grant the trial itself");

  // Ownership still comes from the service, never the body.
  assert.doesNotMatch(source, /body\.tenant_id/);
  assert.doesNotMatch(source, /body\s*\[\s*["'`]tenant_id["'`]\s*\]/);
});

test("signup service checks every step and compensates in reverse", () => {
  const source = read("src/lib/saas/signup-service.ts");

  // Every step's result is inspected.
  assert.match(source, /yearInsert\.error/, "the financial-year error must be checked");
  assert.match(source, /if\s*\(\s*!trial\.ok/, "the trial result must be checked");
  assert.match(source, /profile\.error/, "the profile error must be checked");
  assert.match(source, /tenant\.error/, "the tenant error must be checked");

  // The missing-column fallback is narrow: only a missing column justifies it.
  assert.match(source, /isMissingColumn/, "the year insert must tolerate a missing column");
  assert.match(source, /PGRST204/);
});

// ---------------------------------------------------------------------------
// The production verification harness
// ---------------------------------------------------------------------------

test("verify-saas-production: covers all three requirements and is disposable", () => {
  const script = read("scripts/verify-saas-production.mjs");

  // All three requirements are actually checked.
  for (const r of [1, 2, 3]) {
    assert.match(script, new RegExp(`requirement${r}\\s*\\(`), `requirement ${r} must be checked`);
  }

  // It cleans up after itself and refuses to run without credentials.
  assert.match(script, /async function cleanup\s*\(/, "the script must clean up");
  assert.match(script, /created\.tenants/, "cleanup must be scoped to rows this run created");
  assert.match(script, /Missing SUPABASE_URL/, "the script must refuse to run without credentials");

  // Safety: it must never delete an unscoped set of rows. Every delete is
  // filtered by an id this run created.
  const deletes = script.match(/\.delete\(\)[\s\S]{0,80}?;/g) ?? [];
  for (const d of deletes) {
    assert.match(d, /\.eq\(/, `a delete without a filter was found: ${d.replace(/\s+/g, " ")}`);
  }

  // It never prints a secret.
  assert.doesNotMatch(script, /console\.log\([^)]*SERVICE_KEY/, "must not log the service key");
  assert.doesNotMatch(script, /console\.log\([^)]*password/, "must not log a password");
});
