import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  createMemoryRepairStore,
  createResilientRepairStore,
  createSupabaseRepairStore,
  type RepairRecord,
  type RepairStore,
  type SupabaseClientLike,
} from "../src/lib/ai/repair-store.ts";
import { executeRepair, proposeRepair, type RepairDeps } from "../src/lib/ai/repair-workflow.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";
import type { ReportingDb, ReportingQuery } from "../src/lib/reporting/data.ts";
import type { FormatTemplate } from "../src/lib/reporting/plan.ts";

/**
 * Execution 23 — persistent idempotency, approvals, verified outcomes.
 *
 * Drives the real `executeRepair` against an isolated durable store. Two backing
 * stores are exercised: the in-memory one and a fake Supabase client whose rows
 * persist across store instances (modelling a process restart). No live DB.
 */

const ROOT = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    authUserId: "00000000-0000-0000-0000-000000000001",
    email: "admin@example.com",
    fullName: "Admin",
    role: "admin",
    tenantId: "tenant-a",
    customerId: null,
    branchIds: null,
    financialYearId: null,
    permissions: {},
    isAdmin: true,
    isSuperAdmin: false,
    ...overrides,
  };
}

type Row = Record<string, unknown>;
class FakeQuery implements PromiseLike<{ data: Row[] | null; error: unknown }> {
  constructor(private rows: Row[], private filters: { col: string; op: string; val: unknown }[] = []) {}
  select() { return this; }
  eq(col: string, val: string) { this.filters.push({ col, op: "eq", val }); return this; }
  gte(col: string, val: string) { this.filters.push({ col, op: "gte", val }); return this; }
  lte(col: string, val: string) { this.filters.push({ col, op: "lte", val }); return this; }
  then<R1 = { data: Row[] | null; error: unknown }, R2 = never>(
    onfulfilled?: ((v: { data: Row[] | null; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    const out = this.rows.filter((r) =>
      this.filters.every((f) => {
        const v = r[f.col];
        if (f.op === "eq") return String(v) === String(f.val);
        if (f.op === "gte") return String(v) >= String(f.val);
        if (f.op === "lte") return String(v) <= String(f.val);
        return true;
      }),
    );
    return Promise.resolve({ data: out, error: null }).then(onfulfilled, onrejected);
  }
}

interface StoreHarness { store: RepairStore; saveCalls: () => number; loadThrows: () => void; saveThrows: () => void; templates: () => FormatTemplate[]; }

function makeDeps(store: RepairStore): { deps: RepairDeps; h: StoreHarness } {
  let saveCount = 0;
  let loadThrow = false;
  let saveThrow = false;
  let templates: FormatTemplate[] = [];
  const db = { from: () => new FakeQuery([{ invoice_number: "INV-1", invoice_date: "2026-01-10", vat_amount: 100, total_amount: 1100, tenant_id: "tenant-a" }]) } as unknown as ReportingDb;
  const deps: RepairDeps = {
    db,
    tenantId: "tenant-a",
    loadTemplates: async () => {
      if (loadThrow) throw new Error("db read failed");
      return templates;
    },
    saveTemplate: async (_t, template) => {
      if (saveThrow) throw new Error("db write failed");
      saveCount++;
      templates = [template, ...templates];
      return templates;
    },
  };
  const h: StoreHarness = {
    store,
    saveCalls: () => saveCount,
    loadThrows: () => { loadThrow = true; },
    saveThrows: () => { saveThrow = true; },
    templates: () => templates,
  };
  return { deps, h };
}

async function approvedProposal(deps: RepairDeps, prompt = "رتّب أعمدة تقرير VAT واحفظه كقالب") {
  const p = await proposeRepair(context(), "save_report_format_template", { prompt, name: "MyVAT" }, deps);
  return { proposal: p, approval: { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint, idempotencyKey: "key-1" } };
}

/* -------------------------------------------------------------------------- */
/* Fake Supabase client backed by a persistent array (models a real table).    */
/* -------------------------------------------------------------------------- */
function fakeSupabase(): { client: SupabaseClientLike; rows: Row[] } {
  const rows: Row[] = [];
  let seq = 0;
  const matches = (r: Row, filters: { col: string; op: string; val: unknown }[]) =>
    filters.every((f) => (f.op === "is" ? r[f.col] === null : String(r[f.col]) === String(f.val)));

  function builder(table: string) {
    void table;
    const filters: { col: string; op: string; val: unknown }[] = [];
    let mode: "select" | "update" = "select";
    let patch: Row = {};
    let limitN = Infinity;
    let orderDesc = false;
    const run = () => {
      let out = rows.filter((r) => matches(r, filters));
      if (orderDesc) out = [...out].sort((a, b) => (String(a.created_at) < String(b.created_at) ? 1 : -1));
      if (mode === "update") for (const r of out) Object.assign(r, patch, { updated_at: new Date().toISOString() });
      return out.slice(0, limitN);
    };
    const self = {
      select() { return self; },
      eq(c: string, v: string) { filters.push({ col: c, op: "eq", val: v }); return self; },
      is(c: string, v: null) { filters.push({ col: c, op: "is", val: v }); return self; },
      order(_c: string, o?: { ascending?: boolean }) { orderDesc = o?.ascending === false; return self; },
      limit(n: number) { limitN = n; return self; },
      async maybeSingle() { const out = run(); return { data: out[0] ?? null, error: null }; },
      then(onf?: (v: { data: Row[] | null; error: unknown }) => unknown) {
        return Promise.resolve({ data: run(), error: null }).then(onf as never);
      },
    };
    return {
      self,
      setUpdate(p: Row) { mode = "update"; patch = p; return self; },
    };
  }

  const client = {
    from(table: string) {
      const b = builder(table);
      return {
        insert(row: Row) {
          const dup = rows.some((r) => r.tenant_id === row.tenant_id && r.idempotency_key === row.idempotency_key);
          if (dup) return Promise.resolve({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });
          rows.push({ id: `r${++seq}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row });
          return Promise.resolve({ error: null });
        },
        update(patch: Row) { return b.setUpdate(patch); },
        select() { return b.self; },
      };
    },
  };
  return { client: client as unknown as SupabaseClientLike, rows };
}

// ---------------------------------------------------------------------------
// 1. Durable idempotency survives a restart
// ---------------------------------------------------------------------------
describe("Exec23 — durable idempotency across a restart", () => {
  test("a replayed key after 'restart' does not re-run the write", async () => {
    const { client } = fakeSupabase();
    const { deps, h } = makeDeps(createSupabaseRepairStore(client));
    const { proposal, approval } = await approvedProposal(deps);
    const first = await executeRepair(context(), proposal, approval, deps, { store: h.store });
    assert.equal(first.ok, true);
    assert.equal(h.saveCalls(), 1);

    // New process: a fresh store instance over the same persistent rows.
    const store2 = createSupabaseRepairStore(client);
    const second = await executeRepair(context(), proposal, approval, deps, { store: store2 });
    assert.equal(second.status, "verified");
    assert.equal(second.ok, true);
    assert.equal(h.saveCalls(), 1, "the write must not run twice");
    assert.match(second.verification.detailEn, /already executed/i);
  });

  test("the memory store also blocks a replay with the same instance", async () => {
    const { deps, h } = makeDeps(createMemoryRepairStore());
    const { proposal, approval } = await approvedProposal(deps);
    await executeRepair(context(), proposal, approval, deps, { store: h.store });
    const again = await executeRepair(context(), proposal, approval, deps, { store: h.store });
    assert.equal(again.status, "verified");
    assert.equal(h.saveCalls(), 1);
  });
});

// ---------------------------------------------------------------------------
// 2. Concurrent requests with the same key
// ---------------------------------------------------------------------------
describe("Exec23 — concurrency", () => {
  test("two concurrent executions run the write at most once", async () => {
    const { deps, h } = makeDeps(createMemoryRepairStore());
    const { proposal, approval } = await approvedProposal(deps);
    const [a, b] = await Promise.all([
      executeRepair(context(), proposal, approval, deps, { store: h.store }),
      executeRepair(context(), proposal, approval, deps, { store: h.store }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.ok(statuses.includes("in_progress") || statuses.includes("verified"));
    assert.equal(h.saveCalls(), 1, "exactly one write");
  });
});

// ---------------------------------------------------------------------------
// 3. Key reuse with a different plan is rejected
// ---------------------------------------------------------------------------
describe("Exec23 — key reuse", () => {
  test("the same key for a different plan is a conflict, not a duplicate", async () => {
    const store = createMemoryRepairStore();
    const { deps } = makeDeps(store);
    const a = await approvedProposal(deps, "رتّب أعمدة تقرير VAT واحفظه كقالب");
    const b = await approvedProposal(deps, "أخفِ عمود التاريخ في تقرير المبيعات واحفظه");
    // Same idempotency key, different plan content.
    const approvalB = { proposalId: b.proposal.proposalId, approved: true, fingerprint: b.proposal.fingerprint, idempotencyKey: "key-1" };
    await executeRepair(context(), a.proposal, a.approval, deps, { store });
    const reuse = await executeRepair(context(), b.proposal, approvalB, deps, { store });
    assert.equal(reuse.status, "conflict");
    assert.equal(reuse.error?.code, "key_reused");
  });
});

// ---------------------------------------------------------------------------
// 4. Expired / stale approval
// ---------------------------------------------------------------------------
describe("Exec23 — approval validity", () => {
  test("an expired proposal is refused", async () => {
    const { deps } = makeDeps(createMemoryRepairStore());
    const { proposal, approval } = await approvedProposal(deps);
    const expired = { ...proposal, expiresAt: new Date(Date.now() - 1000).toISOString() };
    const r = await executeRepair(context(), expired, approval, deps, { store: createMemoryRepairStore() });
    assert.equal(r.status, "expired");
  });

  test("an approval for a different plan is refused", async () => {
    const { deps } = makeDeps(createMemoryRepairStore());
    const { proposal } = await approvedProposal(deps);
    const r = await executeRepair(context(), proposal, { proposalId: proposal.proposalId, approved: true, fingerprint: "other", idempotencyKey: "k" }, deps, { store: createMemoryRepairStore() });
    assert.equal(r.status, "conflict");
    assert.equal(r.error?.code, "plan_changed");
  });
});

// ---------------------------------------------------------------------------
// 5. Data changed after preview
// ---------------------------------------------------------------------------
describe("Exec23 — data changed after preview", () => {
  test("a changed source aborts with conflict and records it", async () => {
    const store = createMemoryRepairStore();
    const { deps } = makeDeps(store);
    const { proposal, approval } = await approvedProposal(deps);
    const tampered = { ...proposal, contentFingerprint: "different" };
    const r = await executeRepair(context(), tampered, approval, deps, { store });
    assert.equal(r.status, "conflict");
    assert.equal(r.error?.code, "data_changed");
    const rec = await store.get("tenant-a", "key-1");
    assert.equal(rec?.status, "conflict");
  });
});

// ---------------------------------------------------------------------------
// 6. Connection lost after execution, before the response
// ---------------------------------------------------------------------------
describe("Exec23 — interrupted execution", () => {
  test("a completed-but-unanswered run is not repeated (finalize ran)", async () => {
    const { client } = fakeSupabase();
    const store = createSupabaseRepairStore(client);
    const { deps, h } = makeDeps(store);
    const { proposal, approval } = await approvedProposal(deps);
    await executeRepair(context(), proposal, approval, deps, { store }); // side effect + finalize
    // The client never received the response; it retries with the same key.
    const retry = await executeRepair(context(), proposal, approval, deps, { store: createSupabaseRepairStore(client) });
    assert.equal(retry.ok, true);
    assert.equal(h.saveCalls(), 1);
  });

  test("if recording the outcome fails, the key stays unresolved and is never re-run blindly", async () => {
    const store = createMemoryRepairStore();
    const failing: RepairStore = { ...store, finalize: async () => { throw new Error("ledger down"); } };
    const { deps, h } = makeDeps(failing);
    const { proposal, approval } = await approvedProposal(deps);
    const first = await executeRepair(context(), proposal, approval, deps, { store: failing });
    // The write happened and verified, but the ledger could not record it.
    assert.equal(first.ok, true);
    assert.equal(h.saveCalls(), 1);
    // The durable record is still 'claimed' → a retry must not blindly re-run.
    const rec = await store.get("tenant-a", "key-1");
    assert.equal(rec?.status, "claimed");
    const retry = await executeRepair(context(), proposal, approval, deps, { store: failing });
    assert.equal(retry.status, "in_progress");
    assert.equal(h.saveCalls(), 1, "no blind re-run");
  });
});

// ---------------------------------------------------------------------------
// 7. Verification failure after execution
// ---------------------------------------------------------------------------
describe("Exec23 — post-execution verification", () => {
  test("a write that cannot be found afterwards is a verification failure", async () => {
    const store = createMemoryRepairStore();
    const { deps, h } = makeDeps(store);
    const { proposal, approval } = await approvedProposal(deps);
    // Force the re-read to report the template absent.
    const deps2: RepairDeps = { ...deps, loadTemplates: async () => [] };
    const r = await executeRepair(context(), proposal, approval, deps2, { store });
    assert.equal(r.ok, false);
    assert.equal(r.status, "failed");
    assert.equal(r.error?.code, "verification_failed");
    assert.equal(h.saveCalls(), 1);
    const rec = await store.get("tenant-a", "key-1");
    assert.equal(rec?.status, "failed");
  });

  test("a verification read that throws leaves the key unresolved", async () => {
    const store = createMemoryRepairStore();
    const { deps, h } = makeDeps(store);
    const { proposal, approval } = await approvedProposal(deps);
    h.loadThrows();
    const r = await executeRepair(context(), proposal, approval, deps, { store });
    assert.equal(r.status, "unresolved");
    assert.equal(r.verification.ok, false);
    const rec = await store.get("tenant-a", "key-1");
    assert.equal(rec?.status, "unresolved");
  });
});

// ---------------------------------------------------------------------------
// 8. Tenant isolation and server-side permissions
// ---------------------------------------------------------------------------
describe("Exec23 — tenant isolation and permissions", () => {
  test("two tenants may reuse the same key without colliding", async () => {
    const store = createMemoryRepairStore();
    const { deps } = makeDeps(store);
    const { proposal, approval } = await approvedProposal(deps);
    await executeRepair(context({ tenantId: "tenant-a" }), proposal, approval, { ...deps, tenantId: "tenant-a" }, { store });
    const other = await executeRepair(context({ tenantId: "tenant-b" }), proposal, approval, { ...deps, tenantId: "tenant-b" }, { store });
    // Tenant B has its own key space, so it is not a duplicate of A.
    assert.notEqual(other.status, "duplicate");
    const recA = await store.get("tenant-a", "key-1");
    const recB = await store.get("tenant-b", "key-1");
    assert.ok(recA && recB);
    assert.equal(recA!.tenantId, "tenant-a");
    assert.equal(recB!.tenantId, "tenant-b");
  });

  test("a caller without permission is forbidden before any claim", async () => {
    const store = createMemoryRepairStore();
    const { deps } = makeDeps(store);
    const { proposal, approval } = await approvedProposal(deps);
    const client = context({ role: "client", isAdmin: false, permissions: {} });
    const r = await executeRepair(client, proposal, approval, deps, { store });
    assert.equal(r.status, "forbidden");
    assert.equal(await store.get("tenant-a", "key-1"), null, "nothing is claimed for a forbidden caller");
  });

  test("history is scoped to the tenant", async () => {
    const store = createMemoryRepairStore();
    const { deps } = makeDeps(store);
    const { proposal, approval } = await approvedProposal(deps);
    await executeRepair(context({ tenantId: "tenant-a" }), proposal, approval, { ...deps, tenantId: "tenant-a" }, { store });
    assert.equal((await store.history("tenant-a")).length, 1);
    assert.equal((await store.history("tenant-b")).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 9. Secrets and arbitrary code
// ---------------------------------------------------------------------------
describe("Exec23 — no secrets, no arbitrary code", () => {
  test("a persisted record carries no secrets or financial values", async () => {
    const store = createMemoryRepairStore();
    const { deps } = makeDeps(store);
    const { proposal, approval } = await approvedProposal(deps);
    await executeRepair(context(), proposal, approval, deps, { store });
    const rec = (await store.get("tenant-a", "key-1")) as RepairRecord;
    const json = JSON.stringify(rec);
    assert.ok(!/apiKey|password|secret|service_role|1100/.test(json));
    assert.ok(rec.changedKeys.every((k) => typeof k === "string"));
  });

  test("the store and workflow never execute SQL or shell", () => {
    for (const rel of ["src/lib/ai/repair-store.ts", "src/lib/ai/repair-workflow.ts"]) {
      const src = read(rel);
      assert.ok(!/exec_sql|\beval\(|new Function\(|child_process|execSync/.test(src), rel);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Evidence sufficiency
// ---------------------------------------------------------------------------
describe("Exec23 — evidence sufficiency", () => {
  test("a request with no module or symptom returns 'requires verification', not a guess", async () => {
    const { deps } = makeDeps(createMemoryRepairStore());
    const p = await proposeRepair(context(), "report_validation", { prompt: "شيء ما غير صحيح" }, deps);
    assert.equal(p.status, "requires_verification");
    assert.equal(p.preview, null);
    assert.equal(p.error?.code, "requires_verification");
  });

  test("a request that names the area still produces a deterministic preview", async () => {
    const { deps } = makeDeps(createMemoryRepairStore());
    const p = await proposeRepair(context(), "dashboard_revenue_reconciliation", { prompt: "إيراد Dashboard مختلف عن تقرير المبيعات" }, deps);
    assert.equal(p.status, "ready");
    assert.ok(p.preview);
  });
});

// ---------------------------------------------------------------------------
// 10. Resilient store + prior executions intact
// ---------------------------------------------------------------------------
describe("Exec23 — resilience and regression safety", () => {
  test("a broken durable store degrades to the in-memory fallback", async () => {
    const broken: RepairStore = {
      claim: async () => { throw new Error("table missing"); },
      finalize: async () => { throw new Error("table missing"); },
      get: async () => { throw new Error("table missing"); },
      history: async () => { throw new Error("table missing"); },
    };
    const resilient = createResilientRepairStore(broken);
    const { deps, h } = makeDeps(resilient);
    const { proposal, approval } = await approvedProposal(deps);
    const r = await executeRepair(context(), proposal, approval, deps, { store: resilient });
    assert.equal(r.ok, true);
    assert.equal(h.saveCalls(), 1);
  });

  test("the Exec 21/22 execute path still works without a store", async () => {
    const { deps, h } = makeDeps(createMemoryRepairStore());
    const { proposal, approval } = await approvedProposal(deps);
    const r = await executeRepair(context(), proposal, approval, deps);
    assert.equal(r.ok, true);
    assert.equal(h.saveCalls(), 1);
  });
});

// ---------------------------------------------------------------------------
// 12. Route wiring
// ---------------------------------------------------------------------------
describe("Exec23 — route wiring", () => {
  const route = read("src/app/api/ai/repairs/route.ts");

  test("the route builds the resilient durable store and passes it to executeRepair", () => {
    assert.match(route, /createResilientRepairStore\(/);
    assert.match(route, /createSupabaseRepairStore\(/);
    assert.match(route, /store: repairStore/);
  });

  test("a history operation is exposed", () => {
    assert.match(route, /op === "history"/);
    assert.match(route, /repairStore\.history\(context\.tenantId/);
  });

  test("the route is still session-gated and reads no identity from the body", () => {
    assert.match(route, /requireContext/);
    assert.ok(!/body\.tenant_id|body\.tenantId|body\.role/.test(route));
  });
});
