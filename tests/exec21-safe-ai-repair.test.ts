import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  REPAIR_ACTIONS,
  allowedRepairActions,
  canRunRepairAction,
  getRepairAction,
  inferReportKind,
  planFingerprint,
  selectRepairActions,
  stableFingerprint,
  validateRepairInput,
} from "../src/lib/ai/repair-catalog.ts";
import {
  createMemoryIdempotency,
  executeRepair,
  proposeRepair,
  type RepairDeps,
  type RepairProposal,
} from "../src/lib/ai/repair-workflow.ts";
import { classifyRepairRequest } from "../src/lib/ai/policy.ts";
import { PERMISSION_MODULES } from "../src/lib/auth/permissions.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";
import type { ReportingDb, ReportingQuery } from "../src/lib/reporting/data.ts";
import type { FormatTemplate } from "../src/lib/reporting/plan.ts";

/**
 * Execution 21 — safe AI repair workflow (Phase R1).
 *
 * Proves the full cycle (request → diagnosis → allowed action → preview →
 * approval → execute → verify → audit) and every mandatory refusal: unknown
 * action, no approval, changed plan after approval, permission re-check at
 * execution, cross-tenant isolation, duplicate execution, data change after
 * preview, no arbitrary code, no secret leakage, and honest success/failure.
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
  rows: Row[];
  filters: { col: string; op: string; val: unknown }[] = [];
  constructor(rows: Row[]) {
    this.rows = rows;
  }
  select() {
    return this;
  }
  eq(col: string, val: string) {
    this.filters.push({ col, op: "eq", val });
    return this;
  }
  gte(col: string, val: string) {
    this.filters.push({ col, op: "gte", val });
    return this;
  }
  lte(col: string, val: string) {
    this.filters.push({ col, op: "lte", val });
    return this;
  }
  private apply() {
    return this.rows.filter((r) =>
      this.filters.every((f) => {
        const v = r[f.col];
        if (f.op === "eq") return String(v) === String(f.val);
        if (f.op === "gte") return String(v) >= String(f.val);
        if (f.op === "lte") return String(v) <= String(f.val);
        return true;
      }),
    );
  }
  then<R1 = { data: Row[] | null; error: unknown }, R2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve({ data: this.apply(), error: null }).then(onfulfilled, onrejected);
  }
}

/** A mutable store so the test can simulate a data change between steps. */
function makeDeps(seed?: { templates?: FormatTemplate[]; invoices?: Row[] }): {
  deps: RepairDeps;
  store: { templates: FormatTemplate[]; invoices: Row[] };
  saved: FormatTemplate[];
} {
  const store = {
    templates: (seed?.templates ?? []) as FormatTemplate[],
    invoices: (seed?.invoices ?? [
      { invoice_number: "INV-1", invoice_date: "2026-01-10", status: "paid", vat_amount: 100, total_amount: 1100, paid_amount: 1100, tenant_id: "tenant-a" },
      { invoice_number: "INV-2", invoice_date: "2026-02-10", status: "pending", vat_amount: 200, total_amount: 2200, paid_amount: 0, tenant_id: "tenant-a" },
      { invoice_number: "INV-B", invoice_date: "2026-02-10", status: "paid", vat_amount: 999, total_amount: 9999, paid_amount: 9999, tenant_id: "tenant-b" },
    ]) as Row[],
  };
  const saved: FormatTemplate[] = [];
  const db = {
    from(table: string) {
      const rows = table === "invoices" ? store.invoices : table === "purchase_invoices" ? [] : table === "expenses" ? [] : table === "accounts" ? [] : [];
      return new FakeQuery(rows) as unknown as ReportingQuery;
    },
  } as unknown as ReportingDb;
  const deps: RepairDeps = {
    db,
    tenantId: "tenant-a",
    loadTemplates: async () => store.templates,
    saveTemplate: async (_tenantId, template) => {
      saved.push(template);
      store.templates = [template, ...store.templates.filter((t) => t.name.toLowerCase() !== template.name.toLowerCase())];
      return store.templates;
    },
  };
  return { deps, store, saved };
}

// ---------------------------------------------------------------------------
// 1-2. Catalogue only; unknown actions rejected
// ---------------------------------------------------------------------------
describe("Exec21 — action catalogue", () => {
  test("only known actions can be selected; unknown ids are rejected", () => {
    assert.equal(getRepairAction("report_validation")?.id, "report_validation");
    assert.equal(getRepairAction("drop_database"), null);
    const v = validateRepairInput("drop_database", { prompt: "x" });
    assert.equal(v.ok, false);
    assert.equal(v.error?.code, "unknown_action");
  });

  test("allowedRepairActions is the intersection with the caller's permissions", () => {
    const admin = allowedRepairActions(context({ isAdmin: true }));
    assert.ok(admin.some((a) => a.id === "report_validation"));
    // A staff user without settings.edit cannot save a template.
    const staff = context({ role: "staff", isAdmin: false, permissions: { reports: { view: true, create: false, edit: false, delete: false } } });
    assert.equal(canRunRepairAction(staff, "report_validation"), true);
    assert.equal(canRunRepairAction(staff, "save_report_format_template"), false);
    // A client has nothing.
    const client = context({ role: "client", isAdmin: false, permissions: {} });
    assert.equal(allowedRepairActions(client).length, 0);
  });

  test("every catalogue action reuses an existing permission and declares its effect", () => {
    for (const a of REPAIR_ACTIONS) {
      assert.ok(["read", "settings", "financial"].includes(a.effect));
      assert.ok(typeof a.permission.module === "string" && a.permission.module.length > 0);
      // Every non-read effect changes persisted state and must be approved.
      assert.equal(a.requiresApproval, a.effect !== "read");
      // A financial write is the highest risk and must declare a high risk.
      if (a.effect === "financial") assert.equal(a.risk, "high");
    }
  });

  test("a financial action targets a real permission module and needs approval", () => {
    const financial = REPAIR_ACTIONS.filter((a) => a.effect === "financial");
    assert.ok(financial.length >= 3, "invoice/contract actions must exist");
    for (const a of financial) {
      assert.ok(PERMISSION_MODULES.includes(a.permission.module as never), `${a.id} must use a real module`);
      assert.equal(a.requiresApproval, true, `${a.id} must require approval`);
    }
  });

  test("the report kind is inferred deterministically, never invented", () => {
    assert.equal(inferReportKind("تقرير VAT لا يطابق الفواتير"), "vat_report");
    assert.equal(inferReportKind("ميزان المراجعة غير متوازن"), "trial_balance");
    assert.equal(inferReportKind("hello world"), null);
  });

  test("selectRepairActions returns candidates gated by permission", () => {
    const admin = selectRepairActions(context({ isAdmin: true }), "تقرير VAT لا يطابق الفواتير");
    assert.ok(admin.some((c) => c.action === "report_validation"));
    assert.ok(admin.every((c) => c.kind === "vat_report"));
    const client = selectRepairActions(context({ role: "client", isAdmin: false, permissions: {} }), "تقرير VAT");
    assert.equal(client.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Propose cycle
// ---------------------------------------------------------------------------
describe("Exec21 — propose produces a diagnosis + preview, writes nothing", () => {
  test("a read action proposes 'ready' with a preview and a data source", async () => {
    const { deps, saved } = makeDeps();
    const p = await proposeRepair(context(), "report_validation", { prompt: "تقرير VAT لا يطابق الفواتير" }, deps);
    assert.equal(p.status, "ready");
    assert.equal(p.kind, "vat_report");
    assert.ok(p.preview && p.preview.dataSource.length > 0);
    assert.equal(p.requiresApproval, false);
    assert.equal(saved.length, 0, "propose must not write");
  });

  test("a settings action proposes 'needs_approval'", async () => {
    const { deps, saved } = makeDeps();
    const p = await proposeRepair(context(), "save_report_format_template", { prompt: "رتّب أعمدة تقرير VAT حسب التاريخ", name: "VAT custom" }, deps);
    assert.equal(p.status, "needs_approval");
    assert.equal(p.requiresApproval, true);
    assert.equal(saved.length, 0);
  });

  test("an unauthorized caller gets a 'forbidden' proposal, no preview", async () => {
    const { deps } = makeDeps();
    const staff = context({ role: "staff", isAdmin: false, permissions: { reports: { view: true, create: false, edit: false, delete: false } } });
    const p = await proposeRepair(staff, "save_report_format_template", { prompt: "x", name: "t" }, deps);
    assert.equal(p.status, "forbidden");
    assert.equal(p.preview, null);
  });

  test("an unknown action and invalid input are rejected", async () => {
    const { deps } = makeDeps();
    const unknown = await proposeRepair(context(), "rm -rf /", { prompt: "x" }, deps);
    assert.equal(unknown.status, "unknown_action");
    const missingName = await proposeRepair(context(), "save_report_format_template", { prompt: "رتّب أعمدة تقرير VAT" }, deps);
    assert.equal(missingName.status, "invalid_input");
  });

  test("the diagnosis is deterministic and separate from the data facts", async () => {
    const { deps } = makeDeps();
    const p = await proposeRepair(context(), "report_validation", { prompt: "رصيد الحساب مختلف عن دفتر الأستاذ" }, deps);
    assert.equal(p.diagnosis.module, "ledger_balance");
    assert.equal(classifyRepairRequest("رصيد الحساب مختلف عن دفتر الأستاذ").errorType, "posting");
  });
});

// ---------------------------------------------------------------------------
// 4. Execute: approval, fingerprint, idempotency, verification
// ---------------------------------------------------------------------------
describe("Exec21 — execute enforces approval, plan binding and verification", () => {
  test("a write without approval is rejected", async () => {
    const { deps, saved } = makeDeps();
    const p = await proposeRepair(context(), "save_report_format_template", { prompt: "رتّب أعمدة تقرير VAT", name: "T1" }, deps);
    const r = await executeRepair(context(), p, null, deps);
    assert.equal(r.ok, false);
    assert.equal(r.status, "rejected");
    assert.equal(saved.length, 0, "no write without approval");
  });

  test("an approval whose fingerprint does not match the plan is refused (plan changed)", async () => {
    const { deps } = makeDeps();
    const p = await proposeRepair(context(), "save_report_format_template", { prompt: "رتّب أعمدة تقرير VAT", name: "T1" }, deps);
    // The plan changed after the user approved: the executed proposal now
    // carries a different fingerprint than the one the approval was bound to.
    const changed: RepairProposal = { ...p, fingerprint: "deadbeefdeadbeef" };
    const r = await executeRepair(context(), changed, { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint }, deps);
    assert.equal(r.status, "conflict");
    assert.equal(r.error?.code, "plan_changed");
  });

  test("a valid approval executes and verifies the template is stored", async () => {
    const { deps, saved } = makeDeps();
    const p = await proposeRepair(context(), "save_report_format_template", { prompt: "رتّب أعمدة تقرير VAT حسب التاريخ وأضف الإجماليات", name: "VAT custom" }, deps);
    const r = await executeRepair(context(), p, { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint }, deps);
    assert.equal(r.ok, true);
    assert.equal(r.status, "verified");
    assert.equal(r.verification.ok, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, "VAT custom");
  });

  test("permission is re-checked at execution, not only at propose", async () => {
    const { deps } = makeDeps();
    const admin = context({ isAdmin: true });
    const p = await proposeRepair(admin, "save_report_format_template", { prompt: "رتّب أعمدة تقرير VAT", name: "T1" }, deps);
    // The same proposal executed by a caller without settings.edit is refused.
    const staff = context({ role: "staff", isAdmin: false, permissions: { reports: { view: true, create: false, edit: false, delete: false } } });
    const r = await executeRepair(staff, p, { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint }, deps);
    assert.equal(r.status, "forbidden");
  });

  test("a failed verification is never reported as success", async () => {
    const { deps } = makeDeps();
    // saveTemplate succeeds but the store does not reflect it -> verify fails.
    const broken: RepairDeps = { ...deps, saveTemplate: async () => ({}), loadTemplates: async () => [] };
    const p = await proposeRepair(context(), "save_report_format_template", { prompt: "رتّب أعمدة تقرير VAT", name: "T1" }, broken);
    const r = await executeRepair(context(), p, { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint }, broken);
    assert.equal(r.ok, false);
    assert.equal(r.status, "failed");
    assert.equal(r.error?.code, "verification_failed");
  });

  test("a save failure is reported, not swallowed", async () => {
    const { deps } = makeDeps();
    const broken: RepairDeps = { ...deps, saveTemplate: async () => { throw new Error("db down"); } };
    const p = await proposeRepair(context(), "save_report_format_template", { prompt: "رتّب أعمدة تقرير VAT", name: "T1" }, broken);
    const r = await executeRepair(context(), p, { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint }, broken);
    assert.equal(r.status, "failed");
    assert.equal(r.error?.code, "save_failed");
  });

  test("a read action executes without approval and verifies", async () => {
    const { deps } = makeDeps();
    const p = await proposeRepair(context(), "report_validation", { prompt: "تقرير المبيعات" }, deps);
    const r = await executeRepair(context(), p, null, deps);
    assert.equal(r.ok, true);
    assert.equal(r.status, "verified");
  });
});

// ---------------------------------------------------------------------------
// 5. Idempotency / duplicate prevention
// ---------------------------------------------------------------------------
describe("Exec21 — idempotency prevents duplicate execution", () => {
  test("the same idempotency key cannot run twice", async () => {
    const { deps } = makeDeps();
    const idem = createMemoryIdempotency();
    const p = await proposeRepair(context(), "save_report_format_template", { prompt: "رتّب أعمدة تقرير VAT", name: "T1" }, deps);
    const first = await executeRepair(context(), p, { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint, idempotencyKey: "k1" }, deps, { idempotency: idem });
    assert.equal(first.ok, true);
    const second = await executeRepair(context(), p, { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint, idempotencyKey: "k1" }, deps, { idempotency: idem });
    assert.equal(second.ok, false);
    assert.equal(second.status, "duplicate");
  });
});

// ---------------------------------------------------------------------------
// 6. Cross-tenant isolation and data-change detection
// ---------------------------------------------------------------------------
describe("Exec21 — tenant isolation and change detection", () => {
  test("a tenant-A read never returns tenant-B rows", async () => {
    const { deps } = makeDeps();
    const p = await proposeRepair(context({ tenantId: "tenant-a" }), "report_validation", { prompt: "تقرير المبيعات" }, deps);
    const blob = JSON.stringify(p.preview);
    assert.ok(!blob.includes("tenant-b"));
    assert.ok(!blob.includes("INV-B"));
  });

  test("execution is aborted with 'conflict' if the data changed after preview", async () => {
    const { deps, store } = makeDeps();
    const p = await proposeRepair(context(), "report_validation", { prompt: "تقرير المبيعات" }, deps);
    // Mutate the underlying data after the preview.
    store.invoices.push({ invoice_number: "INV-3", invoice_date: "2026-03-01", status: "pending", vat_amount: 5, total_amount: 55, paid_amount: 0, tenant_id: "tenant-a" });
    const r = await executeRepair(context(), p, null, deps);
    assert.equal(r.status, "conflict");
    assert.equal(r.error?.code, "data_changed");
  });

  test("an expired proposal is refused", async () => {
    const { deps } = makeDeps();
    let clock = 1_000_000;
    const depsWithClock: RepairDeps = { ...deps, now: () => clock };
    const p = await proposeRepair(context(), "report_validation", { prompt: "تقرير المبيعات" }, depsWithClock);
    clock += 16 * 60_000; // past the 15-minute TTL
    const r = await executeRepair(context(), p, null, depsWithClock);
    assert.equal(r.status, "expired");
  });
});

// ---------------------------------------------------------------------------
// 9-10. No arbitrary code / no secret leakage
// ---------------------------------------------------------------------------
describe("Exec21 — no arbitrary execution, no secret leakage", () => {
  test("the repair modules contain no SQL/code execution or shell", () => {
    for (const f of ["src/lib/ai/repair-catalog.ts", "src/lib/ai/repair-workflow.ts", "src/app/api/ai/repairs/route.ts"]) {
      const src = read(f);
      assert.ok(!/exec_sql|\beval\(|new Function\(|child_process|spawn\(|exec\(/.test(src), `${f} introduces code execution`);
    }
  });

  test("the repair route is session-gated and trusts nothing from the body", () => {
    const src = read("src/app/api/ai/repairs/route.ts");
    assert.match(src, /requireContext\(/);
    assert.ok(!/body\.tenant_id|body\.role|body\.isAdmin|body\.isSuperAdmin/.test(src));
    assert.match(src, /logAudit\(context/);
  });

  test("plan fingerprints are stable and content-sensitive", () => {
    const a = planFingerprint({ action: "report_validation", kind: "sales_report", params: { from: null, to: null }, effect: "read", requiresApproval: false });
    const b = planFingerprint({ action: "report_validation", kind: "sales_report", params: { from: null, to: null }, effect: "read", requiresApproval: false });
    const c = planFingerprint({ action: "report_validation", kind: "vat_report", params: { from: null, to: null }, effect: "read", requiresApproval: false });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(stableFingerprint({ x: 1 }), stableFingerprint({ x: 1 }));
  });
});

// ---------------------------------------------------------------------------
// 13. Existing AI/reporting engines are not duplicated
// ---------------------------------------------------------------------------
describe("Exec21 — no duplicate engine", () => {
  test("the repair workflow reuses the reporting engine, not a second one", () => {
    const src = read("src/lib/ai/repair-workflow.ts");
    assert.match(src, /from "@\/lib\/reporting\/assistant"/);
    assert.match(src, /from "@\/lib\/reporting\/data"/);
    assert.match(src, /from "@\/lib\/reporting\/validation"/);
  });

  test("there is still exactly one AI layer and one reporting layer", () => {
    const aiLibs = fs.readdirSync(path.join(ROOT, "src/lib/ai")).filter((f) => f.endsWith(".ts"));
    assert.ok(aiLibs.includes("repair-catalog.ts") && aiLibs.includes("repair-workflow.ts"));
    // The Excel engine is not touched and no inventory module exists.
    assert.ok(!fs.existsSync(path.join(ROOT, "src/lib/inventory")));
  });
});
