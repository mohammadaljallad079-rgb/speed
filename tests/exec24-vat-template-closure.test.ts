import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

import { getReportDefinition, REPORT_DEFINITIONS } from "../src/lib/reporting/definitions.ts";
import { buildFormatPlan } from "../src/lib/reporting/plan.ts";
import { parseReportIntent } from "../src/lib/reporting/intent.ts";
import { buildVatResult, vatReportRows, summarizeVatSources } from "../src/lib/reporting/vat.ts";
import { renderReportWorkbook, verifyWorkbookBuffer } from "../src/lib/reporting/workbook.ts";
import { validateReport } from "../src/lib/reporting/validation.ts";
import { buildPreview, type AssistantContext } from "../src/lib/reporting/assistant.ts";
import type { ReportingDb } from "../src/lib/reporting/data.ts";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

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

function vatRows() {
  const r = buildVatResult([
    { section: "sales", amount: 1000, vatAmount: 100 },
    { section: "purchases", amount: 400, vatAmount: 40 },
    { section: "purchases", amount: 50, treatment: "exempt" },
  ]);
  return vatReportRows(r);
}

// ---------------------------------------------------------------------------
// 1. VAT definition declares the section grouping
// ---------------------------------------------------------------------------
describe("Exec24 — VAT definition structure", () => {
  test("the VAT report groups by the section column", () => {
    assert.equal(REPORT_DEFINITIONS.vat_report.groupColumn, "section");
  });

  test("only the VAT report declares a group column (no accidental grouping)", () => {
    const grouped = Object.values(REPORT_DEFINITIONS).filter((d) => d.groupColumn);
    assert.deepEqual(grouped.map((d) => d.kind), ["vat_report"]);
  });

  test("the taxable base and the VAT are separate columns (never conflated)", () => {
    const cols = getReportDefinition("vat_report")!.columns.map((c) => c.key);
    assert.ok(cols.includes("taxable_amount"));
    assert.ok(cols.includes("vat_amount"));
    assert.notEqual(cols.indexOf("taxable_amount"), cols.indexOf("vat_amount"));
  });
});

// ---------------------------------------------------------------------------
// 2. Workbook emits real section subtotals plus the grand total
// ---------------------------------------------------------------------------
describe("Exec24 — VAT workbook subtotals and grand total", () => {
  test("subtotal rows are emitted per section and verify against the group sums", async () => {
    const plan = buildFormatPlan("vat_report", parseReportIntent("add totals", "vat_report"));
    const rendered = await renderReportWorkbook(plan, { kind: "vat_report", rows: vatRows() });
    const verified = await verifyWorkbookBuffer(rendered.buffer, { sheetName: rendered.sheetName, formulas: rendered.formulaCells });
    assert.equal(verified.ok, true, verified.errors.join("; "));

    // Sales subtotal = 1000 base / 100 VAT; purchases subtotal = 450 base / 40 VAT.
    assert.ok(rendered.formulaCells.some((f) => f.expected === 1000), "sales base subtotal");
    assert.ok(rendered.formulaCells.some((f) => f.expected === 100), "sales VAT subtotal");
    assert.ok(rendered.formulaCells.some((f) => f.expected === 450), "purchases base subtotal");
    assert.ok(rendered.formulaCells.some((f) => f.expected === 40), "purchases VAT subtotal");
    // Grand totals = sum of all details.
    assert.ok(rendered.formulaCells.some((f) => f.expected === 1450), "grand total base");
    assert.ok(rendered.formulaCells.some((f) => f.expected === 140), "grand total VAT");
  });

  test("the subtotal rows are SUM formulas over their own contiguous group", async () => {
    const plan = buildFormatPlan("vat_report", parseReportIntent("add totals", "vat_report"));
    const rendered = await renderReportWorkbook(plan, { kind: "vat_report", rows: vatRows() });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rendered.buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    const formulas: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => {
      const v = cell.value as ExcelJS.CellFormulaValue | null;
      if (v && typeof v === "object" && "formula" in v) formulas.push(v.formula);
    }));
    assert.ok(formulas.some((f) => f === "SUM(C5:C6)"), `purchases subtotal formula over C5:C6 (got ${formulas.join(", ")})`);
    assert.ok(formulas.some((f) => f === "SUM(C4:C6)"), "grand total over all rows");
  });

  test("a report without a group column emits no subtotal rows (no regression)", async () => {
    const plan = buildFormatPlan("sales_report", parseReportIntent("add totals", "sales_report"));
    const rendered = await renderReportWorkbook(plan, {
      kind: "sales_report",
      rows: [
        { invoice_date: "2026-01-05", invoice_number: "INV-1", customer_name: "A", subtotal: 100, vat_amount: 10, total: 110 },
        { invoice_date: "2026-01-06", invoice_number: "INV-2", customer_name: "B", subtotal: 200, vat_amount: 20, total: 220 },
      ],
    });
    // Exactly one total per totalable column (subtotal, vat, total) = 3 formulas.
    assert.equal(rendered.formulaCells.length, 3);
  });
});

// ---------------------------------------------------------------------------
// 3. Validator checks subtotals sum to the grand total
// ---------------------------------------------------------------------------
describe("Exec24 — subtotal consistency validation", () => {
  const columns = getReportDefinition("vat_report")!.columns.map((c) => ({
    key: c.key, labelAr: c.labelAr, labelEn: c.labelEn, type: c.type, total: c.total,
  }));

  test("correct subtotals produce no calculation error", () => {
    const rows = [
      { section: "Sales", taxable_amount: 1000, vat_amount: 100 },
      { section: "Purchases", taxable_amount: 450, vat_amount: 40 },
    ];
    const issues = validateReport({ columns, rows, totals: { taxable_amount: 1450, vat_amount: 140 }, groupColumn: "section" });
    assert.ok(!issues.some((i) => i.id.startsWith("calc-subtotal-sum")), "no subtotal-sum error when it balances");
  });

  test("subtotals that do not add up to the grand total are an error", () => {
    // Grand total claims 2000 base but the sections only add up to 1450.
    const rows = [
      { section: "Sales", taxable_amount: 1000, vat_amount: 100 },
      { section: "Purchases", taxable_amount: 450, vat_amount: 40 },
    ];
    const issues = validateReport({ columns, rows, totals: { taxable_amount: 2000, vat_amount: 140 }, groupColumn: "section" });
    const found = issues.find((i) => i.id === "calc-subtotal-sum-taxable_amount");
    assert.ok(found, "subtotal-sum mismatch flagged");
    assert.equal(found!.severity, "error");
    assert.equal(found!.fixClass, 2);
  });
});

// ---------------------------------------------------------------------------
// 4. Preview surfaces deterministic findings
// ---------------------------------------------------------------------------
describe("Exec24 — preview surfaces validation findings", () => {
  const db = new FakeDb({
    invoices: [
      { id: "1", tenant_id: "A", status: "issued", invoice_date: "2026-01-05", vat_amount: 10, total_amount: 110, subtotal: 100 },
      { id: "2", tenant_id: "B", status: "issued", invoice_date: "2026-01-06", vat_amount: 20, total_amount: 220, subtotal: 200 },
    ],
    purchase_invoices: [],
    expenses: [],
    accounts: [],
  });
  const ctx: AssistantContext = { db: db as unknown as ReportingDb, tenantId: "A" };

  test("preview returns issues and a summary (never AI-guessed)", async () => {
    const preview = await buildPreview(ctx, { kind: "vat_report", prompt: "أضف الإجماليات" });
    assert.ok(Array.isArray(preview.issues));
    assert.ok(preview.summary && typeof preview.summary.error === "number");
    // Tenant A only: tenant B's invoice must not leak into the rows.
    assert.ok(preview.rowCount >= 1);
    assert.ok(preview.previewRows.every((r) => Number(r.taxable_amount) !== 200), "tenant B row must not appear");
  });

  test("a cancelled invoice is excluded from the VAT preview", async () => {
    const db2 = new FakeDb({
      invoices: [{ id: "3", tenant_id: "A", status: "cancelled", invoice_date: "2026-01-07", vat_amount: 99, total_amount: 1098, subtotal: 999 }],
      purchase_invoices: [], expenses: [], accounts: [],
    });
    const preview = await buildPreview({ db: db2 as unknown as ReportingDb, tenantId: "A" }, { kind: "vat_report", prompt: "totals" });
    assert.equal(preview.rowCount, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. The VAT screen's Excel export carries the taxable base
// ---------------------------------------------------------------------------
describe("Exec24 — VAT screen export completeness", () => {
  const src = read("src/app/reports/vat/page.tsx");

  test("the export writes the taxable base alongside the VAT", () => {
    assert.match(src, /Taxable Base/, "export header must include the taxable base");
    assert.match(src, /الوعاء الضريبي/, "Arabic taxable-base header");
    assert.match(src, /breakdown\.sales\.taxable/, "sales taxable base written");
    assert.match(src, /breakdown\.purchases\.taxable/, "purchases taxable base written");
    assert.match(src, /breakdown\.expenses\.taxable/, "expenses taxable base written");
  });

  test("the screen still uses the shared pure aggregator (one VAT path)", () => {
    assert.match(src, /summarizeVatSources/);
  });

  test("the VAT model reports taxable base and VAT separately per source", () => {
    const s = summarizeVatSources({
      invoices: [{ total_amount: 110, vat_amount: 10, status: "paid", invoice_date: "2026-01-05" }],
      purchases: [{ total_amount: 220, vat_amount: 20, status: "paid", bill_date: "2026-01-06" }],
      expenses: [{ amount: 100, vat_amount: 10, expense_date: "2026-01-07" }],
    });
    assert.equal(s.breakdown.sales.taxable, 100);
    assert.equal(s.breakdown.sales.vat, 10);
    assert.equal(s.breakdown.purchases.taxable, 200);
    assert.equal(s.breakdown.expenses.taxable, 100);
    assert.equal(s.outputVat, 10);
    assert.equal(s.inputVat, 30);
    assert.equal(s.netVat, -20);
  });
});

// ---------------------------------------------------------------------------
// 6. Export safety: a text cell that looks like a formula is never a formula
// ---------------------------------------------------------------------------
describe("Exec24 — Excel export formula-injection safety", () => {
  test("a text value beginning with = is written as text, not an executable formula", async () => {
    const plan = buildFormatPlan("sales_report", parseReportIntent("add totals", "sales_report"));
    const rendered = await renderReportWorkbook(plan, {
      kind: "sales_report",
      rows: [{ invoice_date: "2026-01-05", invoice_number: "=cmd|'/C calc'!A0", customer_name: "+1+1", subtotal: 1, vat_amount: 0, total: 1 }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rendered.buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    const cell = sheet.getCell("B4"); // invoice_number column
    const v = cell.value;
    const isFormula = v !== null && typeof v === "object" && "formula" in (v as object);
    assert.equal(isFormula, false, "a text cell must never become a formula");
    assert.equal(String(v), "=cmd|'/C calc'!A0");
  });
});
