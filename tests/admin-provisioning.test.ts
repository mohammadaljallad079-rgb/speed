// @ts-nocheck — the provisioning module is an untyped .mjs; keep the typecheck
// baseline stable rather than adding implicit-any errors.
import test from "node:test";
import assert from "node:assert/strict";

import { provisionAdmins, generatePassword, DEFAULTS } from "../scripts/provision-admin-accounts.mjs";

/**
 * Minimal in-memory Supabase stub: an Auth admin API plus a PostgREST-like query
 * builder that applies the filters it is given. Enough for the provisioning
 * script, and no live database.
 */
function makeStub(seed = {}) {
  const state = {
    tenants: seed.tenants ?? [],
    users: seed.users ?? [],
    authUsers: seed.authUsers ?? [],
    columns: seed.columns ?? {
      tenants: ["id", "name", "name_en"],
      users: ["id", "email", "full_name", "role", "tenant_id", "is_active", "username"],
    },
    seq: 0,
    failUpsertWhen: seed.failUpsertWhen ?? null,
  };

  const nextId = () => `id-${++state.seq}`;

  class Query {
    constructor(table) {
      this.table = table;
      this.op = "select";
      this.filters = [];
      this.ilikeFilter = null;
      this.limitN = null;
      this.cols = "*";
      this.row = null;
    }
    select(cols) {
      if (this.op === "select") this.cols = cols;
      return this;
    }
    eq(col, val) {
      this.filters.push([col, val]);
      return this;
    }
    ilike(col, pattern) {
      this.ilikeFilter = [col, pattern.replaceAll("%", "")];
      return this;
    }
    limit(n) {
      this.limitN = n;
      return this;
    }
    insert(row) {
      this.op = "insert";
      this.row = row;
      return this;
    }
    upsert(row) {
      this.op = "upsert";
      this.row = row;
      return this;
    }
    _selectRows() {
      if (this.cols !== "*") {
        const cols = this.cols.split(",").map((c) => c.trim());
        const missing = cols.find((c) => !state.columns[this.table]?.includes(c));
        if (missing) return { error: { code: "42703", message: `column "${missing}" does not exist` } };
      }
      let rows = state[this.table].slice();
      for (const [col, val] of this.filters) rows = rows.filter((r) => r[col] === val);
      if (this.ilikeFilter) {
        const [col, needle] = this.ilikeFilter;
        rows = rows.filter((r) => String(r[col] ?? "").includes(needle));
      }
      if (this.limitN != null) rows = rows.slice(0, this.limitN);
      return { data: rows, error: null };
    }
    async _run() {
      if (this.op === "select") return this._selectRows();
      if (this.op === "insert") {
        const row = { id: this.row.id ?? nextId(), ...this.row };
        state[this.table].push(row);
        return { data: [row], error: null };
      }
      if (this.op === "upsert") {
        if (state.failUpsertWhen && state.failUpsertWhen(this.table, this.row)) {
          return { data: null, error: { message: "simulated upsert failure" } };
        }
        const idx = state[this.table].findIndex((r) => r.id === this.row.id);
        if (idx >= 0) state[this.table][idx] = { ...state[this.table][idx], ...this.row };
        else state[this.table].push({ ...this.row });
        return { data: [this.row], error: null };
      }
      throw new Error("unsupported op");
    }
    async maybeSingle() {
      const r = await this._run();
      if (r.error) return { data: null, error: r.error };
      return { data: r.data[0] ?? null, error: null };
    }
    async single() {
      const r = await this._run();
      if (r.error) return { data: null, error: r.error };
      return { data: r.data[0] ?? null, error: null };
    }
    then(resolve, reject) {
      return this._run().then(resolve, reject);
    }
  }

  const admin = {
    from(table) {
      if (!state[table]) state[table] = [];
      return new Query(table);
    },
    auth: {
      admin: {
        async listUsers({ page = 1, perPage = 200 } = {}) {
          const start = (page - 1) * perPage;
          const users = state.authUsers.slice(start, start + perPage);
          return { data: { users }, error: null };
        },
        async createUser({ email, password, user_metadata }) {
          const u = { id: nextId(), email, password, user_metadata, app_metadata: {} };
          state.authUsers.push(u);
          return { data: { user: u }, error: null };
        },
        async updateUserById(id, patch) {
          const u = state.authUsers.find((x) => x.id === id);
          if (!u) return { data: null, error: { message: "not found" } };
          Object.assign(u, patch);
          return { data: { user: u }, error: null };
        },
        async deleteUser(id) {
          state.authUsers = state.authUsers.filter((x) => x.id !== id);
          return { data: null, error: null };
        },
      },
    },
  };

  return { admin, state };
}

test("generatePassword is long, unique and URL-safe", () => {
  const a = generatePassword();
  const b = generatePassword();
  assert.ok(a.length >= 20);
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("fresh install: creates one tenant, both identities and their correct mappings", async () => {
  const { admin, state } = makeStub();
  const result = await provisionAdmins(admin);

  assert.equal(result.tenantCreated, true);
  assert.equal(state.tenants.length, 1);
  assert.equal(state.authUsers.length, 2);
  assert.equal(state.users.length, 2);

  const company = state.users.find((u) => u.email === DEFAULTS.companyEmail);
  const superu = state.users.find((u) => u.email === DEFAULTS.superEmail);
  assert.equal(company.role, "admin");
  assert.equal(company.tenant_id, result.tenant.id);
  assert.equal(superu.role, "super_admin");
  assert.equal(superu.tenant_id, null, "super admin must never be tenant-scoped");

  // Auth UUID === public.users id for each account.
  for (const email of [DEFAULTS.companyEmail, DEFAULTS.superEmail]) {
    const auth = state.authUsers.find((u) => u.email === email);
    const row = state.users.find((u) => u.email === email);
    assert.equal(row.id, auth.id);
  }

  assert.ok(result.companyAdmin.issuedPassword);
  assert.ok(result.superAdmin.issuedPassword);
});

test("idempotent: re-running repairs and never duplicates or resets passwords", async () => {
  const { admin, state } = makeStub();
  const first = await provisionAdmins(admin);
  const authSnapshot = state.authUsers.map((u) => u.id);

  const second = await provisionAdmins(admin);
  assert.equal(state.tenants.length, 1, "no duplicate tenant");
  assert.equal(state.authUsers.length, 2, "no duplicate auth user");
  assert.equal(state.users.length, 2, "no duplicate users row");
  assert.deepEqual(state.authUsers.map((u) => u.id), authSnapshot);
  assert.equal(second.tenantCreated, false);
  // No password reissued when nothing rotated and identities already existed.
  assert.equal(second.companyAdmin.issuedPassword, null);
  assert.equal(second.superAdmin.issuedPassword, null);
  assert.equal(second.companyAdmin.authUserId, first.companyAdmin.authUserId);
});

test("repairs an Orphaned Auth identity (no users row) without re-creating it", async () => {
  const { admin, state } = makeStub({
    authUsers: [{ id: "auth-orphan", email: DEFAULTS.companyEmail, app_metadata: {} }],
    tenants: [{ id: "t1", name: "SPEED" }],
  });
  const result = await provisionAdmins(admin);

  assert.equal(result.companyAdmin.authUserId, "auth-orphan");
  assert.equal(result.companyAdmin.authCreated, false);
  const row = state.users.find((u) => u.id === "auth-orphan");
  assert.ok(row, "users row created for the existing identity");
  assert.equal(row.role, "admin");
  assert.equal(row.tenant_id, "t1");
  assert.equal(state.authUsers.length, 2); // orphan + new super, no duplicate company
});

test("pinned tenantId is verified and refused when absent", async () => {
  const { admin } = makeStub();
  await assert.rejects(
    () => provisionAdmins(admin, { tenantId: "does-not-exist" }),
    /does not exist/,
  );
});

test("pinned tenantId is used verbatim and the company admin is scoped to it", async () => {
  const { admin, state } = makeStub({ tenants: [{ id: "speed-tenant", name: "SPEED" }] });
  const result = await provisionAdmins(admin, { tenantId: "speed-tenant" });
  assert.equal(result.tenant.id, "speed-tenant");
  assert.equal(result.tenantCreated, false);
  const company = state.users.find((u) => u.email === DEFAULTS.companyEmail);
  assert.equal(company.tenant_id, "speed-tenant");
});

test("username is written only when the column exists", async () => {
  const withCol = makeStub();
  await provisionAdmins(withCol.admin);
  assert.equal(withCol.state.users.find((u) => u.email === DEFAULTS.companyEmail).username, "speedadmin");

  const withoutCol = makeStub({
    columns: { tenants: ["id", "name"], users: ["id", "email", "role", "tenant_id", "is_active"] },
  });
  await provisionAdmins(withoutCol.admin);
  assert.equal(withoutCol.state.users.find((u) => u.email === DEFAULTS.companyEmail).username, undefined);
});

test("explicit password is honored; rotate reissues; default does not", async () => {
  const { admin, state } = makeStub();
  const r1 = await provisionAdmins(admin, { companyPassword: "FixedPass-123" });
  assert.equal(state.authUsers.find((u) => u.email === DEFAULTS.companyEmail).password, "FixedPass-123");
  assert.equal(r1.companyAdmin.issuedPassword, "FixedPass-123");
  // Super admin had none supplied nor rotation -> generated (new identity).
  assert.ok(r1.superAdmin.issuedPassword);

  const rotated = await provisionAdmins(admin, { rotate: true });
  assert.ok(rotated.companyAdmin.issuedPassword, "rotate reissues a password");
  assert.notEqual(rotated.companyAdmin.issuedPassword, "FixedPass-123");
});

test("partial failure rolls back the newly-created identity (no privileged orphan)", async () => {
  const { admin, state } = makeStub({
    tenants: [{ id: "t1", name: "SPEED" }],
    failUpsertWhen: (_table, row) => row.role === "super_admin",
  });
  await assert.rejects(() => provisionAdmins(admin), /mapping to public\.users failed/);

  // The super admin's Auth identity must have been deleted; only the company
  // admin (created and mapped) remains.
  assert.equal(state.authUsers.length, 1);
  assert.equal(state.authUsers[0].email, DEFAULTS.companyEmail);
  assert.ok(state.users.find((u) => u.email === DEFAULTS.companyEmail));
  assert.equal(state.users.find((u) => u.email === DEFAULTS.superEmail), undefined);
});

test("dry-run writes nothing", async () => {
  const { admin, state } = makeStub({ tenants: [{ id: "t1", name: "SPEED" }] });
  const result = await provisionAdmins(admin, { dryRun: true });
  assert.equal(state.authUsers.length, 0);
  assert.equal(state.users.length, 0);
  assert.equal(result.companyAdmin.authUserId, "(would-create)");
});
