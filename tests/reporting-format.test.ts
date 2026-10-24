import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

import { parseReportIntent } from "../src/lib/reporting/intent.ts";
import { buildFormatPlan, describePlanDiff, type FormatTemplate } from "../src/lib/reporting/plan.ts";
import { getReportDefinition } from "../src/lib/reporting/definitions.ts";
import {
  buildVatResult,
  vatReportRows,
  classifyVatTransaction,
  STANDARD_VAT_RATE,
} from "../src/lib/reporting/vat.ts";
import { renderReportWorkbook, verifyWorkbookBuffer, readTemplateWorkbook } from "../src/lib/reporting/workbook.ts";
import { loadTemplates, saveTemplate, findTemplate } from "../src/lib/reporting/templates.ts";
import { loadReportData, type ReportingDb } from "../src/lib/reporting/data.ts";
import { buildPreview, buildFile, resolvePlan, type AssistantContext } from "../src/lib/reporting/assistant.ts";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// --- A recording PostgREST-like stub: applies the filters it is given. --------
type Row = Record<string, unknown>;
class FakeQuery {
  rows: Row[];
  filters: { col: string; op: string; val: unknown }[] = [];
  constructor(rows: Row[]) { this.rows = rows; }
  select() { return this; }
  eq(col: string, val: string) { this.filters.push({ col, op: "eq", val }); return this; }
  gte(col: string, val: string) { this.filters.push({ col, op: "gte", val }); return this; }
  lte(col: string, val: string) { this.filters.push({ col, op: "lte", val }); return this; }
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
  then(resolve: (v: { data: Row[] | null; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
    return Promise.resolve({ data: this.apply(), error: null }).then(resolve, reject);
  }
}
class FakeDb {
  tables: Record<string, Row[]>;
  queries: FakeQuery[] = [];
  constructor(tables: Record<string, Row[]>) { this.tables = tables; }
  from(table: string) { const q = new FakeQuery(this.tables[table] ?? []); this.queries.push(q); return q; }
}

// --- In-memory settings store for the template tests --------------------------
class FakeSettingsDb {
  store: Row[] = [];
  from() {
    const self = this;
    const chain = {
      _filters: [] as { col: string; val: unknown }[],
      select() { return chain; },
      eq(col: string, val: string) { chain._filters.push({ col, val }); return chain; },
      async maybeSingle() {
        const found = self.store.find((r) => chain._filters.every((f) => r[f.col] === f.val));
        return { data: found ? { value: found.value } : null, error: null };
      },
    };
    return {
      select: chain.select,
      upsert: async (row: Row) => {
        self.store = self.store.filter((r) => !(r.key === row.key && r.tenant_id === row.tenant_id));
        self.store.push(row);
        return { error: null };
      },
    };
  }
}

const sampleDb = () =>
  new FakeDb({
    invoices: [
      { id: "1", tenant_id: "A", status: "issued", invoice_date: "2026-01-05", invoice_number: "INV-1", customer_name: "Alpha", subtotal: 100, vat_amount: 10, total: 110 },
      { id: "2", tenant_id: "B", status: "issued", invoice_date: "2026-01-06", invoice_number: "INV-2", customer_name: "Beta", subtotal: 200, vat_amount: 20, total: 220 },
      { id: "3", tenant_id: "A", status: "cancelled", invoice_date: "2026-01-07", invoice_number: "INV-3", subtotal: 999, vat_amount: 99, total: 1098 },
    ],
    expenses: [{ id: "e1", tenant_id: "A", expense_date: "2026-01-08", amount: 50, vat_amount: 5 }],
    purchase_invoices: [],
    accounts: [],
  });

describe("intent parser understands Arabic and English formatting requests", () => {
  test("detects RTL from Arabic and explicit phrasing", () => {
    assert.equal(parseReportIntent("خلّي التقرير عربي من اليمين لليسار", "sales_report").direction, "rtl");
    assert.equal(parseReportIntent("make it right to left", "sales_report").direction, "rtl");
    assert.equal(parseReportIntent("make it english ltr", "sales_report").direction, "ltr");
  });

  test("orders columns by the named fields (Arabic + English)", () => {
    const ar = parseReportIntent("رتّب الأعمدة حسب التاريخ ورقم الفاتورة والعميل", "sales_report");
    assert.deepEqual(ar.columnOrder, ["invoice_date", "invoice_number", "customer_name"]);
    assert.equal(ar.intent, "structure");
    const en = parseReportIntent("order by date, invoice number, customer", "sales_report");
    assert.deepEqual(en.columnOrder, ["invoice_date", "invoice_number", "customer_name"]);
  });

  test("recognises totals, hide and template requests", () => {
    assert.equal(parseReportIntent("أضف الإجماليات", "sales_report").addTotals, true);
    assert.deepEqual(parseReportIntent("أخفِ العميل", "sales_report").hideColumns, ["customer_name"]);
    const t = parseReportIntent("طبّق قالب الشركة", "sales_report");
    assert.equal(t.applyTemplate, "الشركة");
  });

  test("classifies an accounting-data change separately and never as formatting", () => {
    const i = parseReportIntent("عدّل المبلغ إلى 500", "sales_report");
    assert.equal(i.intent, "data");
    assert.equal(i.dataChangeRequested, true);
    const en = parseReportIntent("update the vat amount on the invoice", "sales_report");
    assert.equal(en.dataChangeRequested, true);
  });

  test("an unknown column term never invents a column", () => {
    const i = parseReportIntent("رتّب حسب اللون والحجم", "sales_report");
    assert.equal(i.columnOrder, undefined);
  });
});

describe("format plan is validated and whitelisted", () => {
  const def = getReportDefinition("sales_report")!;

  test("reorder keeps all columns and only known keys", () => {
    const plan = buildFormatPlan("sales_report", parseReportIntent("order by total, date", "sales_report"));
    assert.equal(plan.columns[0].key, "total");
    assert.equal(plan.columns.length, def.columns.length);
  });

  test("hiding every column is refused with a warning", () => {
    const allKeys = def.columns.map((c) => c.key);
    const plan = buildFormatPlan("sales_report", {
      intent: "structure",
      dataChangeRequested: false,
      hideColumns: allKeys,
      notes: [],
    });
    assert.equal(plan.hiddenColumns.length, 0);
    assert.ok(plan.warnings.some((w) => w.includes("كل الأعمدة")));
  });

  test("clamps widths and rejects an invalid header colour", () => {
    const plan = buildFormatPlan("sales_report", {
      intent: "format",
      dataChangeRequested: false,
      columnWidths: { total: 9999, nope: 10 },
      headerFill: "not-a-colour",
      notes: [],
    });
    assert.equal(plan.columnWidths.total, 80);
    assert.equal(plan.columnWidths.nope, undefined);
    assert.equal(plan.headerFill, "FF0F172A");
    assert.ok(plan.warnings.some((w) => w.includes("لون")));
  });

  test("diff reports rename and reorder", () => {
    const plan = buildFormatPlan("sales_report", {
      intent: "structure",
      dataChangeRequested: false,
      renameColumns: { customer_name: "Customer / العميل" },
      columnOrder: ["total", "invoice_date"],
      notes: [],
    });
    const diff = describePlanDiff(plan, def.columns);
    assert.ok(diff.changes.some((c) => c.includes("customer_name")));
    assert.ok(diff.reordered.length > 0);
    assert.equal(diff.structural, true);
  });
});

describe("VAT model follows Bahrain structure and validates arithmetic", () => {
  test("classifies by evidence, never guessing zero vs exempt", () => {
    assert.equal(classifyVatTransaction({ section: "sales", amount: 100, vatAmount: 10 }), "standard");
    assert.equal(classifyVatTransaction({ section: "sales", amount: 100, vatAmount: 0, partyRegistered: false }), "out_of_scope");
    assert.equal(classifyVatTransaction({ section: "sales", amount: 100, vatAmount: 0, partyRegistered: true }), "unclassified");
    assert.equal(classifyVatTransaction({ section: "sales", amount: 100, treatment: "exempt" }), "exempt");
  });

  test("totals output/input VAT and net correctly", () => {
    const r = buildVatResult([
      { section: "sales", amount: 1000, vatAmount: 100 },
      { section: "purchases", amount: 400, vatAmount: 40 },
      { section: "purchases", amount: 50, treatment: "exempt" },
    ]);
    assert.equal(r.totalOutputVat, 100);
    assert.equal(r.totalInputVat, 40);
    assert.equal(r.netVat, 60);
    assert.equal(STANDARD_VAT_RATE, 0.1);
  });

  test("flags a VAT amount that does not match the standard rate", () => {
    const r = buildVatResult([{ section: "sales", amount: 1000, vatAmount: 50 }]);
    assert.ok(r.issues.some((i) => i.messageEn.includes("VAT mismatch")));
  });

  test("unclassified rows are surfaced for review, not invented", () => {
    const r = buildVatResult([{ section: "sales", amount: 100, vatAmount: 0, partyRegistered: true }]);
    assert.ok(r.issues.some((i) => i.treatment === "unclassified"));
    const rows = vatReportRows(r);
    assert.ok(rows.some((row) => String(row.treatment).includes("غير محدد")));
  });
});

describe("workbook engine renders real formulas and verifies on reopen", () => {
  const plan = buildFormatPlan("sales_report", parseReportIntent("add totals", "sales_report"));
  const data = {
    kind: "sales_report" as const,
    rows: [
      { invoice_date: "2026-01-05", invoice_number: "INV-1", customer_name: "A", subtotal: 100, vat_amount: 10, total: 110 },
      { invoice_date: "2026-01-06", invoice_number: "INV-2", customer_name: "B", subtotal: 200, vat_amount: 20, total: 220 },
    ],
  };

  test("produces a re-openable workbook with SUM formulas for totalable columns", async () => {
    const rendered = await renderReportWorkbook(plan, data);
    const verified = await verifyWorkbookBuffer(rendered.buffer, {
      sheetName: rendered.sheetName,
      formulas: rendered.formulaCells,
    });
    assert.equal(verified.ok, true, verified.errors.join("; "));
    assert.ok(rendered.formulaCells.length >= 1);
    assert.ok(rendered.formulaCells.some((f) => f.expected === 300)); // subtotal 100 + 200

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rendered.buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    const totalFormula = sheet.getCell(rendered.formulaCells[0].ref).value as ExcelJS.CellFormulaValue;
    assert.ok(totalFormula && typeof totalFormula === "object" && totalFormula.formula.startsWith("SUM("));
  });

  test("RTL view is preserved in the saved file", async () => {
    const rtlPlan = buildFormatPlan("vat_report", parseReportIntent("عربي من اليمين", "vat_report"));
    const rendered = await renderReportWorkbook(rtlPlan, { kind: "vat_report", rows: [] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rendered.buffer as unknown as ArrayBuffer);
    assert.equal(wb.worksheets[0].views[0].rightToLeft, true);
  });

  test("a corrupted buffer fails verification instead of pretending success", async () => {
    const result = await verifyWorkbookBuffer(Buffer.from("not an xlsx"));
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  test("derives a template from an uploaded reference workbook", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Ref", { views: [{ rightToLeft: true }] });
    sheet.getRow(1).values = ["Date", "Invoice No.", "Customer", "Total"];
    sheet.getColumn(1).width = 22;
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const { template, matched } = await readTemplateWorkbook(buffer, "sales_report", "Company");
    assert.ok(template);
    assert.equal(template!.name, "Company");
    assert.equal(template!.plan.direction, "rtl");
    assert.ok(matched.includes("invoice_date"));
    assert.equal(template!.plan.columnWidths.invoice_date, 22);
  });
});

describe("templates persist in the settings store, tenant-scoped", () => {
  const template: FormatTemplate = {
    name: "Company",
    kind: "sales_report",
    plan: {
      direction: "rtl", columns: getReportDefinition("sales_report")!.columns, hiddenColumns: [],
      rightAlignColumns: [], headerFill: "FF0F172A", bandedRows: true, boldTotals: true,
      addTotals: true, freezeHeader: true, autoFilter: false, columnWidths: {},
      titleEn: "Sales Report", titleAr: "تقرير المبيعات",
    },
  };

  test("save then load, and find by partial name", async () => {
    const db = new FakeSettingsDb();
    const saved = await saveTemplate(db as never, "A", template);
    assert.equal(saved.length, 1);
    const loaded = await loadTemplates(db as never, "A");
    assert.equal(loaded.length, 1);
    assert.equal(findTemplate(loaded, "comp")!.name, "Company");
  });

  test("a different tenant does not see tenant A's templates", async () => {
    const db = new FakeSettingsDb();
    await saveTemplate(db as never, "A", template);
    assert.equal((await loadTemplates(db as never, "B")).length, 0);
  });
});

describe("data providers scope to the tenant before anything else", () => {
  test("only the caller's tenant rows are returned for sales", async () => {
    const db = sampleDb();
    const data = await loadReportData(db as unknown as ReportingDb, "sales_report", { tenantId: "A" });
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].customer_name, "Alpha");
    assert.ok(db.queries[0].filters.some((f) => f.col === "tenant_id" && f.val === "A"));
  });

  test("source rows are never mutated", async () => {
    const db = sampleDb();
    const before = JSON.stringify(db.tables.invoices[0]);
    await loadReportData(db as unknown as ReportingDb, "sales_report", { tenantId: "A" });
    assert.equal(JSON.stringify(db.tables.invoices[0]), before);
  });

  test("cancelled invoices are excluded", async () => {
    const db = sampleDb();
    const data = await loadReportData(db as unknown as ReportingDb, "sales_report", { tenantId: "A" });
    assert.ok(!data.rows.some((r) => r.invoice_number === "INV-3"));
  });
});

describe("assistant builds a verified file and never applies a data change", () => {
  const ctx = (): AssistantContext => ({ db: sampleDb() as unknown as ReportingDb, tenantId: "A" });

  test("preview returns plan, diff and bounded rows", async () => {
    const preview = await buildPreview(ctx(), { kind: "sales_report", prompt: "order by total, date" });
    assert.equal(preview.rowCount, 1);
    assert.equal(preview.plan.columns[0].key, "total");
    assert.equal(preview.dataChangeRequested, false);
  });

  test("a data-change request is flagged, not executed", async () => {
    const preview = await buildPreview(ctx(), { kind: "sales_report", prompt: "عدّل المبلغ إلى 500" });
    assert.equal(preview.dataChangeRequested, true);
    assert.ok(preview.warnings.length > 0);
    // The underlying data is untouched.
    const db = ctx();
    await buildPreview(db, { kind: "sales_report", prompt: "عدّل المبلغ إلى 500" });
    assert.equal((db.db as unknown as FakeDb).tables.invoices[0].subtotal, 100);
  });

  test("buildFile yields a verified buffer", async () => {
    const { buffer, verification, filename } = await buildFile(ctx(), { kind: "sales_report", prompt: "add totals" });
    assert.equal(verification.ok, true);
    assert.ok(buffer.length > 0);
    assert.match(filename, /SPEED_sales_report_\d{4}-\d{2}-\d{2}\.xlsx/);
  });

  test("resolvePlan applies a saved template then overlays the request", () => {
    const template: FormatTemplate = {
      name: "T", kind: "sales_report",
      plan: {
        direction: "ltr", columns: getReportDefinition("sales_report")!.columns, hiddenColumns: ["total"],
        rightAlignColumns: [], headerFill: "FF000000", bandedRows: false, boldTotals: false,
        addTotals: false, freezeHeader: false, autoFilter: false, columnWidths: { total: 30 },
        titleEn: "S", titleAr: "ت",
      },
    };
    const { plan } = resolvePlan({ kind: "sales_report", prompt: "rtl", template });
    assert.equal(plan.direction, "rtl");
    assert.ok(plan.hiddenColumns.includes("total"));
    assert.equal(plan.headerFill, "FF000000");
  });
});

describe("route and UI respect the security model", () => {
  test("route authenticates via requireContext and never takes tenant from input", () => {
    const route = read("src/app/api/financial/report-format/route.ts");
    assert.match(route, /requireContext\(/);
    assert.doesNotMatch(route, /body\.tenant_id|body\.tenantId|form\.get\(['"]tenant/);
    // Service-role client is server-only; the route must not echo a key.
    assert.doesNotMatch(route, /SERVICE_ROLE_KEY/);
  });

  test("the existing AI analysis route is unchanged in its key handling", () => {
    const route = read("src/app/api/financial/ai-excel-analysis/route.ts");
    // The service-role key is read only by the server-only admin module; the
    // route must reach it through that import, never via a browser client.
    assert.match(route, /supabase-admin/);
    assert.doesNotMatch(route, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    assert.doesNotMatch(route, /return.*apiKey/);
  });

  test("the assistant UI never reads tenant/branch from the browser", () => {
    const ui = read("src/components/reporting/ReportFormatAssistant.tsx");
    assert.doesNotMatch(ui, /tenant_id|branch_id/);
    assert.match(ui, /\/api\/financial\/report-format/);
  });
});
