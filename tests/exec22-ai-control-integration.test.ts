import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  createRepairController,
  isVerifiedSuccess,
  mapRepairError,
  newIdempotencyKey,
  type RepairFetch,
  type RepairState,
} from "../src/lib/ai/repair-client.ts";
import {
  REPAIR_ACTIONS,
  allowedRepairActions,
  getRepairAction,
  selectRepairActions,
} from "../src/lib/ai/repair-catalog.ts";
import { proposeRepair, type RepairDeps } from "../src/lib/ai/repair-workflow.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";
import type { ReportingDb, ReportingQuery } from "../src/lib/reporting/data.ts";
import type { FormatTemplate } from "../src/lib/reporting/plan.ts";

/**
 * Execution 22 — AI Control UI integration + safe repair expansion.
 *
 * Drives the pure repair controller (the UI's brain) against a fake server and
 * proves: catalogue rendering, propose/preview, approval, no-premature-success,
 * error mapping, double-click prevention, verification display, and the new
 * read-only diagnostics. No live database or provider is used.
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

function makeDeps(): { deps: RepairDeps; store: { templates: FormatTemplate[] } } {
  const store = { templates: [] as FormatTemplate[] };
  const invoices: Row[] = [
    { invoice_number: "INV-1", invoice_date: "2026-01-10", status: "paid", vat_amount: 100, total_amount: 1100, paid_amount: 1100, tenant_id: "tenant-a" },
    { invoice_number: "INV-2", invoice_date: "2026-02-10", status: "pending", vat_amount: 200, total_amount: 2200, paid_amount: 0, tenant_id: "tenant-a" },
    { invoice_number: "INV-NODATE", status: "pending", vat_amount: 0, total_amount: 500, paid_amount: 0, tenant_id: "tenant-a" },
    { invoice_number: "INV-B", invoice_date: "2026-02-10", status: "paid", vat_amount: 999, total_amount: 9999, paid_amount: 9999, tenant_id: "tenant-b" },
  ];
  const db = {
    from(table: string) {
      const rows = table === "invoices" ? invoices : [];
      return new FakeQuery(rows) as unknown as ReportingQuery;
    },
  } as unknown as ReportingDb;
  const deps: RepairDeps = {
    db,
    tenantId: "tenant-a",
    loadTemplates: async () => store.templates,
    saveTemplate: async (_t, template) => {
      store.templates = [template, ...store.templates];
      return store.templates;
    },
  };
  return { deps, store };
}

// --- A fake API server for the controller -----------------------------------
interface FakeResponse {
  status?: number;
  body: unknown;
}
function fakeFetch(responses: FakeResponse[]): { impl: RepairFetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const impl: RepairFetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: input, body });
    const r = responses.shift() ?? { status: 200, body: {} };
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body };
  };
  return { impl, calls };
}

const CATALOG = {
  status: 200,
  body: { success: true, actions: [{ id: "report_validation", titleAr: "تحقق", titleEn: "Validation", modules: ["reports"], effect: "read", risk: "low", requiresApproval: false }] },
};
function proposalBody(overrides: Record<string, unknown> = {}): FakeResponse {
  return {
    status: 200,
    body: {
      success: true,
      candidates: [],
      proposal: {
        proposalId: "rep_1",
        action: "save_report_format_template",
        kind: "vat_report",
        params: { prompt: "x", name: "T" },
        effect: "settings",
        requiresApproval: true,
        status: "needs_approval",
        titleAr: "حفظ",
        titleEn: "Save",
        preview: { action: "save_report_format_template", kind: "vat_report", before: { columns: ["a"] }, after: { columns: ["b"] }, diff: ["c"], dataSource: "plan.ts", rowCount: 0 },
        fingerprint: "fp123",
        contentFingerprint: "cf123",
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        ...overrides,
      },
    },
  };
}
const VERIFIED = {
  status: 200,
  body: { success: true, result: { ok: true, status: "verified", proposalId: "rep_1", action: "save_report_format_template", changed: { columns: ["b"] }, verification: { ok: true, detailAr: "تم", detailEn: "done", dataSource: "settings" }, idempotencyKey: "k1", reference: "ref1" } },
};

// ---------------------------------------------------------------------------
// 1. Catalogue rendering
// ---------------------------------------------------------------------------
describe("Exec22 — controller renders the real catalogue", () => {
  test("loadActions populates the actions from the API", async () => {
    const { impl } = fakeFetch([CATALOG]);
    const c = createRepairController(impl);
    await c.loadActions();
    const s = c.getState();
    assert.equal(s.actions.length, 1);
    assert.equal(s.actions[0].id, "report_validation");
    assert.equal(s.busy, false);
  });

  test("a 500 on the catalogue maps to a safe server error", async () => {
    const { impl } = fakeFetch([{ status: 500, body: {} }]);
    const c = createRepairController(impl);
    await c.loadActions();
    assert.equal(c.getState().phase, "error");
    assert.equal(c.getState().error?.code, "server_error");
  });
});

// ---------------------------------------------------------------------------
// 2-4. Propose / preview / approval / no-premature-success
// ---------------------------------------------------------------------------
describe("Exec22 — propose, preview and approval", () => {
  test("a supported action proposes with a preview and awaits approval", async () => {
    const { impl } = fakeFetch([proposalBody()]);
    const c = createRepairController(impl);
    await c.propose("رتّب أعمدة تقرير VAT", "save_report_format_template");
    const s = c.getState();
    assert.equal(s.phase, "proposed");
    assert.ok(s.proposal?.preview);
    assert.equal(s.approved, false);
  });

  test("pressing approve alone is not success (no result yet)", async () => {
    const { impl } = fakeFetch([proposalBody()]);
    const c = createRepairController(impl);
    await c.propose("x", "save_report_format_template");
    c.approve();
    const s = c.getState();
    assert.equal(s.approved, true);
    assert.equal(s.result, null);
    assert.equal(isVerifiedSuccess(s.result), false);
  });

  test("execute is refused until an approval exists", async () => {
    const { impl, calls } = fakeFetch([proposalBody()]);
    const c = createRepairController(impl);
    await c.propose("x", "save_report_format_template");
    await c.execute(); // not approved yet
    assert.equal(c.getState().error?.code, "approval_required");
    assert.ok(!calls.some((x) => x.url.includes("op=execute")), "no execute call without approval");
  });

  test("a verified execution shows the result and its verification", async () => {
    const { impl } = fakeFetch([proposalBody(), VERIFIED]);
    const c = createRepairController(impl);
    await c.propose("x", "save_report_format_template");
    c.approve();
    await c.execute();
    const s = c.getState();
    assert.equal(s.phase, "done");
    assert.equal(isVerifiedSuccess(s.result), true);
    assert.equal(s.result?.verification.ok, true);
  });

  test("the execute call sends the approval bound to the plan fingerprint", async () => {
    const { impl, calls } = fakeFetch([proposalBody(), VERIFIED]);
    const c = createRepairController(impl);
    await c.propose("x", "save_report_format_template");
    c.approve();
    await c.execute();
    const exec = calls.find((x) => x.url.includes("op=execute"));
    assert.ok(exec);
    const body = exec!.body as { approval: { fingerprint: string; idempotencyKey: string } };
    assert.equal(body.approval.fingerprint, "fp123");
    assert.ok(body.approval.idempotencyKey.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 5. Error handling: conflict / forbidden / invalid / server
// ---------------------------------------------------------------------------
describe("Exec22 — safe error handling", () => {
  test("a forbidden proposal shows a permission error, not success", async () => {
    const { impl } = fakeFetch([proposalBody({ status: "forbidden", preview: null, error: { code: "forbidden", ar: "ممنوع", en: "Forbidden" } })]);
    const c = createRepairController(impl);
    await c.propose("x", "save_report_format_template");
    assert.equal(c.getState().phase, "error");
    assert.equal(c.getState().error?.code, "forbidden");
  });

  test("an invalid-input proposal is surfaced", async () => {
    const { impl } = fakeFetch([proposalBody({ status: "invalid_input", preview: null, error: { code: "bad_request", ar: "bad", en: "bad" } })]);
    const c = createRepairController(impl);
    await c.propose("x", "save_report_format_template");
    assert.equal(c.getState().error?.code, "bad_request");
  });

  test("a conflict on execute (data changed) is surfaced and not shown as success", async () => {
    const { impl } = fakeFetch([proposalBody(), { status: 409, body: { success: false, result: { ok: false, status: "conflict", proposalId: "rep_1", action: "save_report_format_template", changed: null, verification: { ok: false, detailAr: "تعارض", detailEn: "conflict" }, idempotencyKey: "k", reference: "r", error: { code: "data_changed", ar: "تغيّرت", en: "changed" } } } }]);
    const c = createRepairController(impl);
    await c.propose("x", "save_report_format_template");
    c.approve();
    await c.execute();
    const s = c.getState();
    assert.equal(s.phase, "error");
    assert.equal(s.error?.code, "data_changed");
    assert.equal(isVerifiedSuccess(s.result), false);
  });

  test("mapRepairError never returns raw server output", () => {
    const e = mapRepairError(500, { error: "stack trace: /var/www/secret" });
    assert.ok(!JSON.stringify(e).includes("/var/www"));
    assert.equal(e.code, "server_error");
  });
});

// ---------------------------------------------------------------------------
// 6. Double-click prevention
// ---------------------------------------------------------------------------
describe("Exec22 — duplicate clicks are prevented", () => {
  test("a second propose while busy is ignored", async () => {
    const { impl, calls } = fakeFetch([proposalBody(), proposalBody()]);
    const c = createRepairController(impl);
    const p1 = c.propose("first", "save_report_format_template");
    const p2 = c.propose("second", "save_report_format_template"); // busy -> ignored
    await Promise.all([p1, p2]);
    assert.equal(calls.filter((x) => x.url.includes("op=propose")).length, 1);
  });

  test("a second execute while busy is ignored", async () => {
    const { impl, calls } = fakeFetch([proposalBody(), VERIFIED, VERIFIED]);
    const c = createRepairController(impl);
    await c.propose("x", "save_report_format_template");
    c.approve();
    const e1 = c.execute();
    const e2 = c.execute(); // busy -> ignored
    await Promise.all([e1, e2]);
    assert.equal(calls.filter((x) => x.url.includes("op=execute")).length, 1);
  });

  test("newIdempotencyKey returns distinct keys", () => {
    assert.notEqual(newIdempotencyKey(), newIdempotencyKey());
  });
});

// ---------------------------------------------------------------------------
// 7-8. New read-first diagnostics + tenant isolation
// ---------------------------------------------------------------------------
describe("Exec22 — new read-only diagnostics", () => {
  test("dashboard revenue reconciliation reuses summarizeRevenue and never writes", async () => {
    const { deps, store } = makeDeps();
    const p = await proposeRepair(context(), "dashboard_revenue_reconciliation", { prompt: "إيراد Dashboard مختلف عن تقرير المبيعات" }, deps);
    assert.equal(p.status, "ready");
    assert.equal(p.requiresApproval, false);
    assert.match(p.preview!.dataSource, /revenue\.ts:summarizeRevenue/);
    const after = p.preview!.after as Record<string, number>;
    // INV-1: gross 1100 vat 100 ; INV-2: gross 2200 vat 200 ; INV-NODATE: gross 500 vat 0
    assert.equal(after.gross, 3800);
    assert.equal(after.vat, 300);
    assert.equal(after.net, 3500);
    assert.equal(store.templates.length, 0, "no write");
  });

  test("the revenue preview never contains another tenant's document", async () => {
    const { deps } = makeDeps();
    const p = await proposeRepair(context({ tenantId: "tenant-a" }), "dashboard_revenue_reconciliation", { prompt: "revenue" }, deps);
    assert.ok(!JSON.stringify(p.preview).includes("INV-B"));
  });

  test("date filter diagnostic reports inside/outside/undated", async () => {
    const { deps } = makeDeps();
    const p = await proposeRepair(context(), "date_filter_diagnostic", { prompt: "تقرير المبيعات لا يطابق فلتر التاريخ", from: "2026-02-01", to: "2026-02-28" }, deps);
    const after = p.preview!.after as Record<string, number>;
    assert.equal(after.rowCount, 3); // tenant-a invoices only
    assert.equal(after.inside, 1); // INV-2 (Feb)
    assert.equal(after.outside, 1); // INV-1 (Jan)
    assert.equal(after.undated, 1); // INV-NODATE
    assert.match(p.preview!.dataSource, /loadReportData/);
  });

  test("the new actions are read-only and require reports.view", () => {
    for (const id of ["dashboard_revenue_reconciliation", "date_filter_diagnostic"]) {
      const spec = getRepairAction(id);
      assert.ok(spec);
      assert.equal(spec!.effect, "read");
      assert.equal(spec!.requiresApproval, false);
      assert.deepEqual(spec!.permission, { module: "reports", action: "view" });
    }
  });

  test("selectRepairActions routes revenue and date complaints to the diagnostics", () => {
    const revenue = selectRepairActions(context(), "إيراد Dashboard مختلف عن تقرير المبيعات");
    assert.equal(revenue[0]?.action, "dashboard_revenue_reconciliation");
    const date = selectRepairActions(context(), "تقرير المبيعات لا يطابق فلتر التاريخ");
    assert.equal(date[0]?.action, "date_filter_diagnostic");
    // A client may still run nothing.
    const client = selectRepairActions(context({ role: "client", isAdmin: false, permissions: {} }), "revenue dashboard");
    assert.equal(client.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 9-10. UI cannot bypass the server; R1 preserved
// ---------------------------------------------------------------------------
describe("Exec22 — UI wiring and server authority", () => {
  test("the AI Control page uses the controller and never decides success itself", () => {
    const page = read("src/app/settings/ai-control/page.tsx");
    assert.match(page, /createRepairController/);
    assert.match(page, /isVerifiedSuccess/);
    // Success text is gated on the verified result, never on the approve button.
    assert.match(page, /isVerifiedSuccess\(repair\.result\)/);
    // The endpoint is called by the client, not decided by the page.
    const client = read("src/lib/ai/repair-client.ts");
    assert.match(client, /\/api\/ai\/repairs\?op=/);
  });

  test("the page sends no trusted identity from the browser", () => {
    const src = read("src/app/settings/ai-control/page.tsx");
    assert.ok(!/tenant_id|body\.role|isSuperAdmin/.test(src));
  });

  test("the repair client never handles secrets or raw SQL", () => {
    const src = read("src/lib/ai/repair-client.ts");
    assert.ok(!/exec_sql|\beval\(|new Function\(|child_process|apiKey|service_role/i.test(src));
  });

  test("the Exec 21 catalogue actions are still present and gated", () => {
    const ids = REPAIR_ACTIONS.map((a) => a.id);
    for (const id of ["report_validation", "report_format_preview", "save_report_format_template"]) {
      assert.ok(ids.includes(id as never));
    }
    const client = allowedRepairActions(context({ role: "client", isAdmin: false, permissions: {} }));
    assert.equal(client.length, 0);
  });
});
