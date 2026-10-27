import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  getRepairAction,
  REPAIR_ACTIONS,
  selectFinancialActions,
  validateRepairInput,
} from "../src/lib/ai/repair-catalog.ts";
import { proposeRepair, executeRepair, type RepairDeps, type FinancePort } from "../src/lib/ai/repair-workflow.ts";
import { createMemoryRepairStore, createResilientRepairStore, type RepairStore } from "../src/lib/ai/repair-store.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";
import type { ReportingDb } from "../src/lib/reporting/data.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const context = (over: Partial<AuthContext> = {}): AuthContext =>
  ({
    authUserId: "u1",
    email: "admin@speed.local",
    role: "admin",
    tenantId: "tenant-a",
    companyId: null,
    branchId: null,
    financialYearId: null,
    isAdmin: true,
    isSuperAdmin: false,
    permissions: {},
    ...over,
  }) as unknown as AuthContext;

/**
 * A recording PostgREST-like stub. It applies the filters it is given and
 * returns only affected rows, so the tests exercise the real query shapes the
 * financial actions emit.
 */
function recordingDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = JSON.parse(JSON.stringify(seed));
  const writes: Array<{ table: string; op: string; payload: unknown }> = [];
  const client = {
    from(table: string) {
      if (!tables[table]) tables[table] = [];
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const api: any = {
        select: () => api,
        insert: (rows: any) => {
          const list = Array.isArray(rows) ? rows : [rows];
          for (const r of list) tables[table].push({ ...r });
          writes.push({ table, op: "insert", payload: rows });
          return api;
        },
        update: (payload: any) => {
          writes.push({ table, op: "update", payload });
          api._update = payload;
          return api;
        },
        delete: () => {
          writes.push({ table, op: "delete", payload: null });
          return api;
        },
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return api;
        },
        is: (col: string, val: unknown) => {
          filters.push((r) => (r[col] ?? null) === val);
          return api;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return api;
        },
        limit: () => api,
        order: () => api,
        single: async () => {
          const rows = tables[table].filter((r) => filters.every((f) => f(r)));
          const row = api._update
            ? Object.assign(rows[0] ?? {}, api._update)
            : rows[0];
          return { data: row ?? null, error: row ? null : { message: "not found" } };
        },
        maybeSingle: async () => {
          const rows = tables[table].filter((r) => filters.every((f) => f(r)));
          const row = api._update ? Object.assign(rows[0] ?? {}, api._update) : rows[0];
          return { data: row ?? null, error: null };
        },
        then: (resolve: any) => {
          const rows = tables[table].filter((r) => filters.every((f) => f(r)));
          if (api._update) for (const r of rows) Object.assign(r, api._update);
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return { client, tables, writes };
}

/**
 * A memory store *marked durable*, standing in for the migration-006 ledger.
 * `executeRepair` refuses a financial write without durable idempotency, so a
 * test that expects the write to proceed must supply one.
 */
const durableStore = () => ({ ...createMemoryRepairStore(), durable: true });

function depsWith(finance: FinancePort, db: any, tenantId: string | null = "tenant-a"): RepairDeps {
  return {
    db: db as ReportingDb,
    tenantId,
    loadTemplates: async () => [],
    saveTemplate: async () => ({}),
    finance,
  };
}

describe("Exec 59 — the AI agent can change invoices and contracts", () => {
  test("the catalogue declares the three financial actions, all high risk", () => {
    for (const id of ["invoice_issue", "invoice_reverse", "contract_extend"]) {
      const spec = getRepairAction(id);
      assert.ok(spec, `${id} must be in the catalogue`);
      assert.equal(spec!.effect, "financial");
      assert.equal(spec!.risk, "high");
      assert.equal(spec!.requiresApproval, true);
    }
  });

  test("a financial action is only offered when the wording names the operation", () => {
    const admin = context();
    assert.ok(selectFinancialActions(admin, "أصدر فاتورة جديدة").some((c) => c.action === "invoice_issue"));
    assert.ok(selectFinancialActions(admin, "issue a new invoice").some((c) => c.action === "invoice_issue"));
    assert.ok(selectFinancialActions(admin, "reverse invoice SI-1").some((c) => c.action === "invoice_reverse"));
    assert.ok(selectFinancialActions(admin, "extend the rental contract").some((c) => c.action === "contract_extend"));
    // A plain question must not offer a financial action.
    assert.equal(selectFinancialActions(admin, "why is revenue wrong?").length, 0);
  });

  test("a caller without the permission is offered no financial action", () => {
    const client = context({ role: "client", isAdmin: false, permissions: {} });
    assert.equal(selectFinancialActions(client, "issue a new invoice").length, 0);
  });

  test("invoice_issue validates its inputs and rejects an empty customer or amount", () => {
    const bad = validateRepairInput("invoice_issue", { amount: 10 });
    assert.equal(bad.ok, false);
    const bad2 = validateRepairInput("invoice_issue", { customerId: "c1", amount: 0 });
    assert.equal(bad2.ok, false);
    const good = validateRepairInput("invoice_issue", {
      customerId: "c1",
      amount: 100,
      vat: 10,
      discount: 0,
      paymentMethod: "cash",
      invoiceType: "sale",
    });
    assert.equal(good.ok, true);
    assert.equal(good.plan!.params.amount, 100);
    assert.equal(good.plan!.effect, "financial");
    assert.equal(good.plan!.requiresApproval, true);
  });

  test("a rental invoice requires a contract id", () => {
    const r = validateRepairInput("invoice_issue", { customerId: "c1", amount: 50, invoiceType: "rental" });
    assert.equal(r.ok, false);
    const ok = validateRepairInput("invoice_issue", { customerId: "c1", amount: 50, invoiceType: "rental", contractId: "ct1" });
    assert.equal(ok.ok, true);
    assert.equal(ok.plan!.params.contractId, "ct1");
  });

  test("contract_extend requires a valid ISO new end date", () => {
    assert.equal(validateRepairInput("contract_extend", { contractId: "ct1", newEndDate: "2026/01/01" }).ok, false);
    const ok = validateRepairInput("contract_extend", { contractId: "ct1", newEndDate: "2026-06-30" });
    assert.equal(ok.ok, true);
    assert.equal(ok.plan!.params.newEndDate, "2026-06-30");
  });

  test("propose computes the deterministic amounts the caller is approving", async () => {
    const { client } = recordingDb({
      customers: [{ id: "c1", full_name: "Ahmed Ali", tenant_id: "tenant-a" }],
    });
    const finance: FinancePort = {
      issueInvoice: async () => ({ id: "inv1", invoiceNumber: "SI-1", totalAmount: 110, status: "pending" }),
      reverseInvoice: async () => ({ invoiceId: "inv1", journalId: "j1", created: true }),
      extendContract: async () => ({ contractId: "ct1", newEndDate: "2026-06-30", additionalAmount: 0 }),
    };
    const proposal = await proposeRepair(
      context(),
      "invoice_issue",
      { customerId: "c1", amount: 100, vat: 10, discount: 0, paymentMethod: "cash", invoiceType: "sale" },
      depsWith(finance, client),
    );
    assert.equal(proposal.status, "needs_approval");
    assert.equal(proposal.effect, "financial");
    assert.equal(proposal.preview!.after.total, 110);
    assert.equal(proposal.preview!.after.customerName, "Ahmed Ali");
    assert.ok(proposal.fingerprint);
  });

  test("execution without an approval is refused and changes nothing", async () => {
    const { client, writes } = recordingDb({ customers: [{ id: "c1", full_name: "A", tenant_id: "tenant-a" }] });
    let called = false;
    const finance: FinancePort = {
      issueInvoice: async () => {
        called = true;
        return { id: "inv1", invoiceNumber: "SI-1", totalAmount: 110, status: "pending" };
      },
      reverseInvoice: async () => ({ invoiceId: "x", journalId: "j", created: true }),
      extendContract: async () => ({ contractId: "ct1", newEndDate: "2026-06-30", additionalAmount: 0 }),
    };
    const deps = depsWith(finance, client);
    const proposal = await proposeRepair(
      context(),
      "invoice_issue",
      { customerId: "c1", amount: 100, vat: 10, discount: 0, invoiceType: "sale" },
      deps,
    );
    const result = await executeRepair(context(), proposal, null, deps);
    assert.equal(result.ok, false);
    assert.equal(result.status, "rejected");
    assert.equal(called, false, "the finance port must not be called without approval");
    assert.equal(writes.length, 0);
  });

  test("an approval bound to a different plan is refused", async () => {
    const { client } = recordingDb({ customers: [{ id: "c1", full_name: "A", tenant_id: "tenant-a" }] });
    const finance: FinancePort = {
      issueInvoice: async () => ({ id: "inv1", invoiceNumber: "SI-1", totalAmount: 110, status: "pending" }),
      reverseInvoice: async () => ({ invoiceId: "x", journalId: "j", created: true }),
      extendContract: async () => ({ contractId: "ct1", newEndDate: "2026-06-30", additionalAmount: 0 }),
    };
    const deps = depsWith(finance, client);
    const proposal = await proposeRepair(
      context(),
      "invoice_issue",
      { customerId: "c1", amount: 100, vat: 10, discount: 0, invoiceType: "sale" },
      deps,
    );
    const result = await executeRepair(
      context(),
      proposal,
      { proposalId: proposal.proposalId, approved: true, fingerprint: "deadbeef" },
      deps,
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, "conflict");
    assert.equal(result.error!.code, "plan_changed");
  });

  test("an approved issue runs through the finance port and is verified against a re-read", async () => {
    const { client, tables } = recordingDb({
      customers: [{ id: "c1", full_name: "A", tenant_id: "tenant-a" }],
    });
    // The verification re-reads invoices by number; the port persists it.
    const finance: FinancePort = {
      issueInvoice: async () => {
        tables.invoices = [
          { id: "inv1", invoice_number: "SI-9", status: "pending", total_amount: 110, invoice_type: "sale", tenant_id: "tenant-a" },
        ];
        return { id: "inv1", invoiceNumber: "SI-9", totalAmount: 110, status: "pending", journalId: "j1", journalCreated: true };
      },
      reverseInvoice: async () => ({ invoiceId: "x", journalId: "j", created: true }),
      extendContract: async () => ({ contractId: "ct1", newEndDate: "2026-06-30", additionalAmount: 0 }),
    };
    const deps = depsWith(finance, client);
    const proposal = await proposeRepair(
      context(),
      "invoice_issue",
      { customerId: "c1", amount: 100, vat: 10, discount: 0, invoiceType: "sale" },
      deps,
    );
    const result = await executeRepair(
      context(),
      proposal,
      { proposalId: proposal.proposalId, approved: true, fingerprint: proposal.fingerprint },
      deps,
      { store: durableStore() },
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, "verified");
    assert.equal(result.verification.ok, true);
    assert.equal(result.changed!.invoiceNumber, "SI-9");
    assert.equal(result.changed!.journalCreated, true);
  });

  test("a port that reports success without persisting is never reported verified", async () => {
    const { client } = recordingDb({ customers: [{ id: "c1", full_name: "A", tenant_id: "tenant-a" }] });
    const finance: FinancePort = {
      // Claims an invoice but persists nothing: the re-read must catch it.
      issueInvoice: async () => ({ id: "ghost", invoiceNumber: "SI-GHOST", totalAmount: 110, status: "pending" }),
      reverseInvoice: async () => ({ invoiceId: "x", journalId: "j", created: true }),
      extendContract: async () => ({ contractId: "ct1", newEndDate: "2026-06-30", additionalAmount: 0 }),
    };
    const deps = depsWith(finance, client);
    const proposal = await proposeRepair(
      context(),
      "invoice_issue",
      { customerId: "c1", amount: 100, vat: 10, discount: 0, invoiceType: "sale" },
      deps,
    );
    const result = await executeRepair(
      context(),
      proposal,
      { proposalId: proposal.proposalId, approved: true, fingerprint: proposal.fingerprint },
      deps,
      { store: durableStore() },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, "unresolved");
  });

  test("a failed posting is reported as failed, never as a success", async () => {
    const { client } = recordingDb({ customers: [{ id: "c1", full_name: "A", tenant_id: "tenant-a" }] });
    const finance: FinancePort = {
      issueInvoice: async () => {
        throw Object.assign(new Error("Cannot post a sale without the revenue account"), { code: "bad_request" });
      },
      reverseInvoice: async () => ({ invoiceId: "x", journalId: "j", created: true }),
      extendContract: async () => ({ contractId: "ct1", newEndDate: "2026-06-30", additionalAmount: 0 }),
    };
    const deps = depsWith(finance, client);
    const proposal = await proposeRepair(
      context(),
      "invoice_issue",
      { customerId: "c1", amount: 100, vat: 10, discount: 0, invoiceType: "sale" },
      deps,
    );
    const result = await executeRepair(
      context(),
      proposal,
      { proposalId: proposal.proposalId, approved: true, fingerprint: proposal.fingerprint },
      deps,
      { store: durableStore() },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.verification.ok, false);
  });

  test("a missing finance port fails closed instead of silently succeeding", async () => {
    const { client } = recordingDb({ customers: [{ id: "c1", full_name: "A", tenant_id: "tenant-a" }] });
    const deps: RepairDeps = {
      db: client as ReportingDb,
      tenantId: "tenant-a",
      loadTemplates: async () => [],
      saveTemplate: async () => ({}),
    };
    const proposal = await proposeRepair(
      context(),
      "invoice_issue",
      { customerId: "c1", amount: 100, vat: 10, discount: 0, invoiceType: "sale" },
      deps,
    );
    const result = await executeRepair(
      context(),
      proposal,
      { proposalId: proposal.proposalId, approved: true, fingerprint: proposal.fingerprint },
      deps,
      { store: durableStore() },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error!.code, "not_configured");

  });
});

/**
 * Execution 60, Section 9 — financial durability is mandatory.
 *
 * Execution 59 showed the posting works, but leaned on the migration-006 unique
 * index. The resilient store silently degrades to per-process memory when that
 * table is absent, and a per-process guard cannot stop a retry routed to another
 * worker (or served after a restart) from posting a second invoice. These tests
 * pin the fail-closed behaviour the assignment asks for: no durable store, no
 * financial write.
 */
describe("Exec 60 — a financial write without durable idempotency is refused", () => {
  const goodFinance = (): FinancePort => ({
    issueInvoice: async () => ({ id: "inv1", invoiceNumber: "SI-1", totalAmount: 110, status: "pending" }),
    reverseInvoice: async () => ({ invoiceId: "x", journalId: "j", created: true }),
    extendContract: async () => ({ contractId: "ct1", newEndDate: "2026-06-30", additionalAmount: 0 }),
  });

  async function proposeIssue(finance: FinancePort, client: unknown) {
    return proposeRepair(
      context(),
      "invoice_issue",
      { customerId: "c1", amount: 100, vat: 10, discount: 0, invoiceType: "sale" },
      depsWith(finance, client),
    );
  }

  test("no store at all: the write is refused as unavailable and nothing is posted", async () => {
    const { client } = recordingDb({ customers: [{ id: "c1", full_name: "A", tenant_id: "tenant-a" }] });
    let called = false;
    const finance: FinancePort = {
      issueInvoice: async () => {
        called = true;
        return { id: "inv1", invoiceNumber: "SI-1", totalAmount: 110, status: "pending" };
      },
      reverseInvoice: async () => ({ invoiceId: "x", journalId: "j", created: true }),
      extendContract: async () => ({ contractId: "ct1", newEndDate: "2026-06-30", additionalAmount: 0 }),
    };
    const proposal = await proposeIssue(finance, client);
    const result = await executeRepair(
      context(),
      proposal,
      { proposalId: proposal.proposalId, approved: true, fingerprint: proposal.fingerprint },
      depsWith(finance, client),
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, "unavailable");
    assert.equal(result.error!.code, "durability_unavailable");
    assert.equal(called, false, "the finance port must not be reached without durable idempotency");
  });

  test("a NON-durable store is refused exactly like no store", async () => {
    const { client } = recordingDb({ customers: [{ id: "c1", full_name: "A", tenant_id: "tenant-a" }] });
    const finance = goodFinance();
    const proposal = await proposeIssue(finance, client);
    const result = await executeRepair(
      context(),
      proposal,
      { proposalId: proposal.proposalId, approved: true, fingerprint: proposal.fingerprint },
      depsWith(finance, client),
      { store: createMemoryRepairStore() },
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.error!.code, "durability_unavailable");
  });

  test("a DURABLE store lets the same write proceed", async () => {
    const { client, tables } = recordingDb({ customers: [{ id: "c1", full_name: "A", tenant_id: "tenant-a" }] });
    const finance: FinancePort = {
      issueInvoice: async () => {
        tables.invoices = [
          { id: "inv1", invoice_number: "SI-9", status: "pending", total_amount: 110, invoice_type: "sale", tenant_id: "tenant-a" },
        ];
        return { id: "inv1", invoiceNumber: "SI-9", totalAmount: 110, status: "pending", journalId: "j1", journalCreated: true };
      },
      reverseInvoice: async () => ({ invoiceId: "x", journalId: "j", created: true }),
      extendContract: async () => ({ contractId: "ct1", newEndDate: "2026-06-30", additionalAmount: 0 }),
    };
    const proposal = await proposeIssue(finance, client);
    const result = await executeRepair(
      context(),
      proposal,
      { proposalId: proposal.proposalId, approved: true, fingerprint: proposal.fingerprint },
      depsWith(finance, client),
      { store: durableStore() },
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, "verified");
  });

  test("a READ action is unaffected by the durability requirement", async () => {
    const { client } = recordingDb({});
    const proposal = await proposeRepair(context(), "date_filter_diagnostic", { from: "2026-01-01", to: "2026-01-31" }, depsWith(goodFinance(), client));
    // No store, yet a read must still run: only financial writes need durability.
    const result = await executeRepair(
      context(),
      proposal,
      { proposalId: proposal.proposalId, approved: true, fingerprint: proposal.fingerprint },
      depsWith(goodFinance(), client),
    );
    assert.notEqual(result.error?.code, "durability_unavailable");
  });

  test("the resilient wrapper reports durable=false once it degrades", async () => {
    const broken: RepairStore = {
      durable: true,
      claim: async () => {
        throw new Error("relation ai_repair_executions does not exist");
      },
      finalize: async () => true,
      get: async () => null,
      history: async () => [],
    };
    const store = createResilientRepairStore(broken);
    assert.equal(store.durable, true, "healthy primary is durable");
    await store.claim({
      tenantId: "tenant-a",
      userId: null,
      userEmail: null,
      proposalId: "p",
      action: "invoice_issue",
      planFingerprint: "f",
      contentFingerprint: "c",
      idempotencyKey: "k",
    });
    assert.equal(store.durable, false, "a degraded store must not claim durability");
  });
});

describe("Exec 59 — one posting path, no private AI engine", () => {
  test("the AI finance port delegates to the shared sales service", () => {
    const port = read("src/lib/ai/finance-port.ts");
    assert.match(port, /from "@\/lib\/sales\/service"/, "must reuse the shared sales service");
    assert.match(port, /issueInvoice\(/, "must delegate the issue");
    assert.match(port, /reverseSaleInvoice/, "must reuse the existing reversal");
    // It must not open its own posting path.
    assert.doesNotMatch(port, /from\("journal_entries"\)\s*\.insert/, "must not write a journal header itself");
    assert.doesNotMatch(port, /from\("journal_lines"\)\s*\.insert/, "must not write journal lines itself");
  });

  test("the HTTP route and the AI agent share one issue service", () => {
    const route = read("src/app/api/invoices/route.ts");
    assert.match(route, /from "@\/lib\/sales\/service"/, "the route delegates to the service");
    assert.doesNotMatch(route, /postSaleInvoice/, "the route must not post directly any more");
  });

  test("the repair route wires the finance port and no shell/SQL primitive", () => {
    const route = read("src/app/api/ai/repairs/route.ts");
    assert.match(route, /createSupabaseFinancePort/);
    assert.doesNotMatch(route, /exec_sql|child_process|new Function|eval\(/);
  });

  test("the workflow never writes financial rows itself", () => {
    const wf = read("src/lib/ai/repair-workflow.ts");
    assert.match(wf, /finance\.issueInvoice/, "must go through the port");
    assert.doesNotMatch(wf, /from\("invoices"\)\s*\.insert/, "must not insert an invoice itself");
    assert.doesNotMatch(wf, /from\("journal_lines"\)\s*\.insert/, "must not write journal lines itself");
  });
});
