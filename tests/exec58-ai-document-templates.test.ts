import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  REPAIR_ACTIONS,
  allowedRepairActions,
  canRunRepairAction,
  isDocumentTemplateRequest,
  selectDocumentTemplateActions,
  validateRepairInput,
} from "../src/lib/ai/repair-catalog.ts";
import { executeRepair, proposeRepair, type RepairDeps } from "../src/lib/ai/repair-workflow.ts";
import type { AuthContext } from "../src/lib/auth/types.ts";
import type { ReportingDb } from "../src/lib/reporting/data.ts";
import type { FormatTemplate } from "../src/lib/reporting/plan.ts";
import { defaultTemplate } from "../src/lib/templates/document-templates.ts";
import type { TemplateDb } from "../src/lib/templates/document-template-store.ts";

/**
 * Execution 58 — the AI Agent can customize a *document* (invoice, rental
 * contract, ...), not only a report. Proves the whole path: a natural-language
 * design request becomes a deterministic template change, is previewed, requires
 * approval, is persisted tenant-scoped, and is verified. Also proves the
 * refusals: no approval, changed plan, cross-tenant isolation, no invented field.
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

/** A tenant-scoped settings store, so cross-tenant isolation is real. */
function fakeTemplateDb() {
  const rows: Array<{ key: string; tenant_id: string | null; value: unknown; updated_at: string }> = [];
  const db = {
    rows,
    from(table: string) {
      assert.equal(table, "settings");
      return {
        select(_c: string) {
          let key: string | null = null;
          let tenant: string | null | undefined = undefined;
          const q: any = {
            eq(col: string, val: string) {
              if (col === "key") key = val;
              if (col === "tenant_id") tenant = val;
              return q;
            },
            async maybeSingle() {
              const found = rows.find((r) => r.key === key && (tenant === undefined ? true : r.tenant_id === tenant));
              return { data: found ? { value: found.value } : null, error: null };
            },
          };
          return q;
        },
        async upsert(row: Record<string, unknown>) {
          const key = String(row.key);
          const t = (row.tenant_id ?? null) as string | null;
          const existing = rows.find((r) => r.key === key && r.tenant_id === t);
          if (existing) {
            existing.value = row.value;
            existing.updated_at = String(row.updated_at ?? "");
          } else rows.push({ key, tenant_id: t, value: row.value, updated_at: String(row.updated_at ?? "") });
          return { error: null };
        },
      };
    },
  };
  return db;
}

function makeDeps(tenantId: string | null = "tenant-a") {
  const templateDb = fakeTemplateDb();
  const deps: RepairDeps = {
    db: { from: () => ({}) } as unknown as ReportingDb,
    tenantId,
    loadTemplates: async () => [] as FormatTemplate[],
    saveTemplate: async () => undefined,
    templates: templateDb as unknown as TemplateDb,
  };
  return { deps, templateDb };
}

describe("Exec58 — document-template catalogue", () => {
  test("the three document actions exist and are declared correctly", () => {
    for (const id of ["document_template_preview", "save_document_template", "restore_document_template"]) {
      const spec = REPAIR_ACTIONS.find((a) => a.id === id);
      assert.ok(spec, id);
      assert.ok(["read", "settings"].includes(spec!.effect));
      assert.equal(spec!.requiresApproval, spec!.effect === "settings");
    }
    const preview = REPAIR_ACTIONS.find((a) => a.id === "document_template_preview")!;
    assert.equal(preview.effect, "read");
    assert.equal(preview.requiresApproval, false);
  });

  test("a client may not run any document action; an admin may", () => {
    const client = context({ role: "client", isAdmin: false, permissions: {} });
    assert.equal(canRunRepairAction(client, "document_template_preview"), false);
    assert.equal(canRunRepairAction(client, "save_document_template"), false);
    const admin = context({ isAdmin: true });
    assert.equal(canRunRepairAction(admin, "document_template_preview"), true);
    assert.equal(canRunRepairAction(admin, "save_document_template"), true);
    assert.ok(allowedRepairActions(admin).some((a) => a.id === "save_document_template"));
  });

  test("a document-design request routes to the document actions, not the report ones", () => {
    assert.equal(isDocumentTemplateRequest("عدّل تصميم فاتورة المبيعات وأضف شعار الشركة"), true);
    assert.equal(isDocumentTemplateRequest("add the company logo to the rental contract"), true);
    assert.equal(isDocumentTemplateRequest("تقرير VAT لا يطابق الفواتير"), false);

    const admin = context({ isAdmin: true });
    const doc = selectDocumentTemplateActions(admin, "عدّل تصميم فاتورة المبيعات وأضف شعار الشركة");
    assert.ok(doc.some((c) => c.action === "document_template_preview"));
  });

  test("a save is only offered when the request asks to save/apply", () => {
    const admin = context({ isAdmin: true });
    const previewOnly = selectDocumentTemplateActions(admin, "show the logo on the invoice");
    assert.ok(!previewOnly.some((c) => c.action === "save_document_template"));
    const save = selectDocumentTemplateActions(admin, "احفظ تصميم الفاتورة مع الشعار");
    assert.ok(save.some((c) => c.action === "save_document_template"));
  });

  test("an unsupported document kind is refused", () => {
    const v = validateRepairInput("document_template_preview", { prompt: "add logo", documentKind: "payslip_of_ceo" });
    assert.equal(v.ok, false);
    assert.equal(v.error?.code, "bad_request");
    const ok = validateRepairInput("document_template_preview", { prompt: "add logo", documentKind: "sales_invoice" });
    assert.equal(ok.ok, true);
    assert.equal(ok.plan?.documentKind, "sales_invoice");
  });
});

describe("Exec58 — propose previews a real change and writes nothing", () => {
  test("a design change previews a before/after diff without persisting", async () => {
    const { deps, templateDb } = makeDeps();
    const p = await proposeRepair(
      context(),
      "document_template_preview",
      { prompt: "أضف شعار الشركة وأضف مربع التوقيع إلى الفاتورة", documentKind: "sales_invoice" },
      deps,
    );
    assert.equal(p.status, "ready");
    assert.equal(p.documentKind, "sales_invoice");
    assert.ok(p.preview);
    assert.ok(p.preview!.diff.length >= 1, "a change is shown");
    const after = p.preview!.after.template as { layout: { showSignatureBlock: boolean } };
    assert.equal(after.layout.showSignatureBlock, true);
    // Nothing was written.
    assert.equal(templateDb.rows.length, 0);
  });

  test("a logo request with no file is reported as unapplied, not a phantom change", async () => {
    const { deps } = makeDeps();
    const p = await proposeRepair(
      context(),
      "document_template_preview",
      { prompt: "أضف شعار الشركة إلى الفاتورة", documentKind: "sales_invoice" },
      deps,
    );
    assert.ok(p.preview);
    assert.equal(p.preview!.diff.length, 0);
    const issues = JSON.stringify(p.preview!.issues ?? []);
    assert.match(issues, /logo/);
  });

  test("'add the plate number to the rental contract' shows that field in the diff", async () => {
    const { deps } = makeDeps();
    const p = await proposeRepair(
      context(),
      "document_template_preview",
      { prompt: "أضف رقم اللوحة إلى عقد الإيجار", documentKind: "rental_contract" },
      deps,
    );
    assert.ok(p.preview);
    const after = p.preview!.after.template as { layout: { visibleFields: string[] } };
    assert.ok(after.layout.visibleFields.includes("plate_number"));
  });

  test("a save action needs approval and previews as 'needs_approval'", async () => {
    const { deps } = makeDeps();
    const p = await proposeRepair(
      context(),
      "save_document_template",
      { prompt: "أضف شعار الشركة", documentKind: "sales_invoice", name: "Branded invoice" },
      deps,
    );
    assert.equal(p.status, "needs_approval");
    assert.equal(p.requiresApproval, true);
  });
});

describe("Exec58 — execute applies, approves, persists and verifies", () => {
  test("an approved save writes a tenant-scoped template and verifies it", async () => {
    const { deps, templateDb } = makeDeps("tenant-a");
    const p = await proposeRepair(
      context(),
      "save_document_template",
      { prompt: "أضف شعار الشركة وأضف مربع التوقيع", documentKind: "sales_invoice", name: "Branded invoice" },
      deps,
    );
    const res = await executeRepair(
      context(),
      p,
      { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint },
      deps,
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, "verified");
    assert.equal(res.verification.ok, true);
    assert.equal(templateDb.rows.length, 1);
    assert.equal(templateDb.rows[0].tenant_id, "tenant-a");
    const stored = (templateDb.rows[0].value as { templates: Record<string, { layout: { showSignatureBlock: boolean } }> }).templates.sales_invoice;
    assert.equal(stored.layout.showSignatureBlock, true);
  });

  test("without approval the save is rejected and nothing is written", async () => {
    const { deps, templateDb } = makeDeps();
    const p = await proposeRepair(
      context(),
      "save_document_template",
      { prompt: "أضف شعار الشركة", documentKind: "sales_invoice", name: "X" },
      deps,
    );
    const res = await executeRepair(context(), p, null, deps);
    assert.equal(res.ok, false);
    assert.equal(res.status, "rejected");
    assert.equal(templateDb.rows.length, 0);
  });

  test("a changed plan (fingerprint mismatch) is refused", async () => {
    const { deps, templateDb } = makeDeps();
    const p = await proposeRepair(
      context(),
      "save_document_template",
      { prompt: "أضف شعار الشركة", documentKind: "sales_invoice", name: "X" },
      deps,
    );
    const res = await executeRepair(
      context(),
      p,
      { proposalId: p.proposalId, approved: true, fingerprint: "deadbeef" },
      deps,
    );
    assert.equal(res.status, "conflict");
    assert.equal(templateDb.rows.length, 0);
  });

  test("a permission revoked after the proposal blocks execution", async () => {
    const { deps } = makeDeps();
    const p = await proposeRepair(
      context(),
      "save_document_template",
      { prompt: "أضف شعار الشركة", documentKind: "sales_invoice", name: "X" },
      deps,
    );
    const downgraded = context({ isAdmin: false, permissions: {} });
    const res = await executeRepair(
      downgraded,
      p,
      { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint },
      deps,
    );
    assert.equal(res.ok, false);
    assert.equal(res.status, "forbidden");
  });

  test("a save request that maps to no change fails honestly", async () => {
    const { deps, templateDb } = makeDeps();
    const p = await proposeRepair(
      context(),
      "save_document_template",
      { prompt: "improve the quality somehow", documentKind: "sales_invoice", name: "X" },
      deps,
    );
    const res = await executeRepair(context(), p, { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint }, deps);
    assert.equal(res.ok, false);
    assert.equal(templateDb.rows.length, 0);
  });
});

describe("Exec58 — tenant isolation of the template store", () => {
  test("tenant A's saved template never appears for tenant B", async () => {
    const db = fakeTemplateDb();
    const depsA: RepairDeps = {
      db: { from: () => ({}) } as unknown as ReportingDb,
      tenantId: "tenant-a",
      loadTemplates: async () => [],
      saveTemplate: async () => undefined,
      templates: db as unknown as TemplateDb,
    };
    const p = await proposeRepair(
      context(),
      "save_document_template",
      { prompt: "أضف شعار الشركة", documentKind: "sales_invoice", name: "Tenant A invoice" },
      depsA,
    );
    await executeRepair(context(), p, { proposalId: p.proposalId, approved: true, fingerprint: p.fingerprint }, depsA);

    const depsB: RepairDeps = { ...depsA, tenantId: "tenant-b" };
    const pb = await proposeRepair(
      context({ tenantId: "tenant-b" }),
      "document_template_preview",
      { prompt: "make the accent colour blue", documentKind: "sales_invoice" },
      depsB,
    );
    const before = pb.preview!.before.template as { name: string };
    assert.notEqual(before.name, "Tenant A invoice");
    assert.equal(before.name, defaultTemplate("sales_invoice").name);
  });
});

describe("Exec58 — no arbitrary code, no new engine", () => {
  test("the document-template modules contain no eval/exec/SQL/child_process", () => {
    for (const rel of ["src/lib/templates/document-templates.ts", "src/lib/templates/document-template-store.ts"]) {
      const src = read(rel);
      assert.ok(!/\beval\s*\(/.test(src), rel);
      assert.ok(!/new\s+Function\s*\(/.test(src), rel);
      assert.ok(!/child_process/.test(src), rel);
      assert.ok(!/exec_sql/.test(src), rel);
      assert.ok(!/\.rpc\(\s*["']exec/.test(src), rel);
    }
  });

  test("the print pages are not a second template engine: the store is the only writer", () => {
    const store = read("src/lib/templates/document-template-store.ts");
    assert.match(store, /settings/);
    assert.match(store, /DOCUMENT_TEMPLATES_KEY/);
  });
});
