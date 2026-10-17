import { test, describe } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";

import { getImportModule, importSafety, importableModuleKeys, IMPORT_MODULES } from "../src/lib/import/registry.ts";
import { parseSheet } from "../src/lib/import/parse.ts";
import { buildPreview, commitImport, mapHeaders, type ImportDb, type ImportWriter } from "../src/lib/import/engine.ts";
import { buildTemplateWorkbook } from "../src/lib/import/template.ts";
import { buildErrorReportWorkbook } from "../src/lib/import/export.ts";

// --- A recording PostgREST-like stub that applies the filters it is given. ----
type Row = Record<string, unknown>;
class FakeQuery {
  rows: Row[];
  filters: { col: string; op: string; val: unknown }[] = [];
  constructor(rows: Row[]) { this.rows = rows; }
  select() { return this; }
  eq(col: string, val: string) { this.filters.push({ col, op: "eq", val }); return this; }
  in(col: string, vals: string[]) { this.filters.push({ col, op: "in", val: vals }); return this; }
  private apply() {
    return this.rows.filter((r) =>
      this.filters.every((f) => {
        const v = r[f.col];
        if (f.op === "eq") return String(v) === String(f.val);
        if (f.op === "in") return (f.val as string[]).map(String).includes(String(v));
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
  constructor(tables: Record<string, Row[]>) { this.tables = tables; }
  from(table: string) { return new FakeQuery(this.tables[table] ?? []); }
}

function xlsxBuffer(headers: string[], rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

const grantedAll = ["customers", "suppliers", "expenses", "accounting", "invoices", "purchases", "reports"];

// ---------------------------------------------------------------------------
describe("Exec25 — import registry safety (fail-closed)", () => {
  test("every registered module declares a tenant column", () => {
    for (const spec of Object.values(IMPORT_MODULES)) {
      assert.equal(importSafety(spec).ok, true, `${spec.key} must be import-safe`);
      assert.ok(spec.tenantColumn, `${spec.key} must declare a tenant column`);
    }
  });

  test("importable keys exclude any module without a tenant column", () => {
    const keys = importableModuleKeys();
    assert.deepEqual(keys.sort(), ["customers", "expenses", "suppliers"]);
  });

  test("a module without a tenant column is refused", () => {
    const spec = { ...getImportModule("customers")!, tenantColumn: null };
    assert.equal(importSafety(spec).ok, false);
  });
});

// ---------------------------------------------------------------------------
describe("Exec25 — parse and header mapping", () => {
  test("parses an xlsx into headers + rows and drops blank rows", () => {
    const buf = xlsxBuffer(["Full Name", "Phone"], [["Ali", "39000001"], ["", ""], ["Sara", "39000002"]]);
    const sheet = parseSheet(buf);
    assert.deepEqual(sheet.headers, ["Full Name", "Phone"]);
    assert.equal(sheet.rows.length, 2);
  });

  test("maps Arabic and English headers (with aliases) to fields", () => {
    const spec = getImportModule("customers")!;
    const { mapping } = mapHeaders(spec, ["الاسم", "الجوال", "البريد الإلكتروني", "Unknown Column"]);
    assert.equal(mapping[0].field, "full_name");
    assert.equal(mapping[1].field, "phone");
    assert.equal(mapping[2].field, "email");
    assert.equal(mapping[3].field, null);
  });
});

// ---------------------------------------------------------------------------
describe("Exec25 — preview validation, references and duplicates", () => {
  const db = new FakeDb({
    suppliers: [{ id: "sup-1", tenant_id: "A", name: "Gulf Parts" }],
    accounts: [{ id: "acc-1", tenant_id: null, name: "Rent Expense", code: "5001" }],
    expenses: [{ id: "e1", tenant_id: "A", invoice_number: "INV-100" }],
    customers: [{ id: "c1", tenant_id: "A", phone: "39000001" }],
  });

  test("a clean customers file is valid and can commit", async () => {
    const spec = getImportModule("customers")!;
    const sheet = parseSheet(xlsxBuffer(["Full Name", "Phone", "Customer Type"], [["Ali", "39111111", "individual"], ["Sara", "39222222", "company"]]));
    const preview = await buildPreview(db as unknown as ImportDb, { spec, headers: sheet.headers, rows: sheet.rows, tenantId: "A", grantedModules: grantedAll });
    assert.equal(preview.summary.valid, 2);
    assert.equal(preview.canCommit, true);
  });

  test("a missing required field is an error (required)", async () => {
    const spec = getImportModule("customers")!;
    const sheet = parseSheet(xlsxBuffer(["Full Name", "Phone"], [["", "39111111"]]));
    const preview = await buildPreview(db as unknown as ImportDb, { spec, headers: sheet.headers, rows: sheet.rows, tenantId: "A", grantedModules: grantedAll });
    assert.equal(preview.rows[0].errors[0].code, "required");
    assert.equal(preview.canCommit, false);
  });

  test("an invalid enum value is rejected", async () => {
    const spec = getImportModule("customers")!;
    const sheet = parseSheet(xlsxBuffer(["Full Name", "Phone", "Customer Type"], [["Ali", "39111111", "alien"]]));
    const preview = await buildPreview(db as unknown as ImportDb, { spec, headers: sheet.headers, rows: sheet.rows, tenantId: "A", grantedModules: grantedAll });
    assert.ok(preview.rows[0].errors.some((e) => e.code === "enum"));
  });

  test("an unknown reference is an error; a known reference resolves to an FK", async () => {
    const spec = getImportModule("expenses")!;
    const ok = parseSheet(xlsxBuffer(["Date", "Supplier", "Expense Account", "Amount"], [["2026-01-05", "Gulf Parts", "Rent Expense", 100]]));
    const good = await buildPreview(db as unknown as ImportDb, { spec, headers: ok.headers, rows: ok.rows, tenantId: "A", grantedModules: grantedAll });
    assert.equal(good.rows[0].errors.length, 0, JSON.stringify(good.rows[0].errors));
    assert.equal(good.rows[0].normalized.supplier_id, "sup-1");
    assert.equal(good.rows[0].normalized.expense_account_id, "acc-1");

    const bad = parseSheet(xlsxBuffer(["Date", "Supplier", "Expense Account", "Amount"], [["2026-01-05", "Ghost Supplier", "Rent Expense", 100]]));
    const badPreview = await buildPreview(db as unknown as ImportDb, { spec, headers: bad.headers, rows: bad.rows, tenantId: "A", grantedModules: grantedAll });
    assert.ok(badPreview.rows[0].errors.some((e) => e.code === "reference"));
  });

  test("LEVEL 1: a duplicate inside the file is flagged", async () => {
    const spec = getImportModule("customers")!;
    const sheet = parseSheet(xlsxBuffer(["Full Name", "Phone"], [["Ali", "39111111"], ["Ali again", "39111111"]]));
    const preview = await buildPreview(db as unknown as ImportDb, { spec, headers: sheet.headers, rows: sheet.rows, tenantId: "A", grantedModules: grantedAll });
    assert.equal(preview.rows[1].duplicate?.level, 1);
  });

  test("LEVEL 2: a duplicate already in the DB is flagged", async () => {
    const spec = getImportModule("customers")!;
    const sheet = parseSheet(xlsxBuffer(["Full Name", "Phone"], [["Existing", "39000001"]]));
    const preview = await buildPreview(db as unknown as ImportDb, { spec, headers: sheet.headers, rows: sheet.rows, tenantId: "A", grantedModules: grantedAll });
    assert.equal(preview.rows[0].duplicate?.level, 2);
    assert.equal(preview.canCommit, false);
  });

  test("tenant isolation: another tenant's key is not treated as a duplicate", async () => {
    const spec = getImportModule("customers")!;
    const sheet = parseSheet(xlsxBuffer(["Full Name", "Phone"], [["Other tenant", "39000001"]]));
    // Tenant B has no customers, so phone 39000001 (tenant A) must not collide.
    const preview = await buildPreview(db as unknown as ImportDb, { spec, headers: sheet.headers, rows: sheet.rows, tenantId: "B", grantedModules: grantedAll });
    assert.equal(preview.rows[0].duplicate, null);
    assert.equal(preview.canCommit, true);
  });

  test("permission denial blocks reference resolution (no silent import)", async () => {
    const spec = getImportModule("expenses")!;
    const sheet = parseSheet(xlsxBuffer(["Date", "Supplier", "Expense Account", "Amount"], [["2026-01-05", "Gulf Parts", "Rent Expense", 100]]));
    const preview = await buildPreview(db as unknown as ImportDb, { spec, headers: sheet.headers, rows: sheet.rows, tenantId: "A", grantedModules: ["expenses"] });
    assert.ok(preview.notesEn.some((n) => n.includes("suppliers")));
    assert.equal(preview.canCommit, false);
  });
});

// ---------------------------------------------------------------------------
describe("Exec25 — commit is all-or-nothing and tenant-scoped", () => {
  const spec = getImportModule("customers")!;
  class Recorder implements ImportWriter {
    calls: { table: string; rows: Row[] }[] = [];
    async insert(table: string, rows: Row[]) { this.calls.push({ table, rows }); return rows.length; }
  }

  async function previewFor(rows: unknown[][], db: FakeDb, tenantId = "A") {
    const sheet = parseSheet(xlsxBuffer(["Full Name", "Phone"], rows));
    return buildPreview(db as unknown as ImportDb, { spec, headers: sheet.headers, rows: sheet.rows, tenantId, grantedModules: grantedAll });
  }

  test("a clean preview commits every row with the session tenant attached", async () => {
    const db = new FakeDb({ customers: [] });
    const preview = await previewFor([["Ali", "39111111"], ["Sara", "39222222"]], db);
    const rec = new Recorder();
    const res = await commitImport(rec, { spec, preview, tenantId: "A", mode: "all" });
    assert.equal(res.inserted, 2);
    assert.equal(rec.calls[0].table, "customers");
    assert.ok(rec.calls[0].rows.every((r) => r.tenant_id === "A"));
  });

  test("any invalid row refuses the whole commit", async () => {
    const db = new FakeDb({ customers: [] });
    const preview = await previewFor([["Ali", "39111111"], ["", "39222222"]], db);
    const rec = new Recorder();
    await assert.rejects(() => commitImport(rec, { spec, preview, tenantId: "A", mode: "all" }));
    assert.equal(rec.calls.length, 0);
  });

  test("only declared columns and the tenant are written (no arbitrary columns)", async () => {
    const db = new FakeDb({ customers: [] });
    const sheet = parseSheet(xlsxBuffer(["Full Name", "Phone", "Hacked Column"], [["Ali", "39111111", "DROP TABLE"]]));
    const preview = await buildPreview(db as unknown as ImportDb, { spec, headers: sheet.headers, rows: sheet.rows, tenantId: "A", grantedModules: grantedAll });
    const rec = new Recorder();
    await commitImport(rec, { spec, preview, tenantId: "A", mode: "all" });
    // Only declared fields (including defaults) + the tenant are written; the
    // unknown "Hacked Column" is never a key.
    assert.deepEqual(Object.keys(rec.calls[0].rows[0]).sort(), ["customer_type", "full_name", "phone", "status", "tenant_id"]);
  });
});

// ---------------------------------------------------------------------------
describe("Exec25 — template download and route security", () => {
  test("the template workbook is a valid xlsx with the module headers", async () => {
    const spec = getImportModule("suppliers")!;
    const buf = await buildTemplateWorkbook(spec);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    const headerTexts: string[] = [];
    sheet.getRow(1).eachCell((c) => headerTexts.push(String(c.value)));
    assert.ok(headerTexts.some((h) => h.includes("Supplier Name")));
    assert.ok(wb.worksheets.some((w) => w.name === "Notes"));
  });

  test("the route authenticates and never reads tenant from the request body", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/api/import/route.ts"), "utf8");
    assert.match(src, /requireContext/);
    assert.match(src, /tenantId: context\.tenantId/);
    assert.doesNotMatch(src, /body\.tenant_id|formData\.get\(["']tenant_id/);
    assert.match(src, /logAudit/);
  });

  test("the error report workbook lists each failing row with a resolution", async () => {
    const db = new FakeDb({ customers: [] });
    const spec = getImportModule("customers")!;
    const sheet = parseSheet(xlsxBuffer(["Full Name", "Phone"], [["", "39111111"]]));
    const preview = await buildPreview(db as unknown as ImportDb, { spec, headers: sheet.headers, rows: sheet.rows, tenantId: "A", grantedModules: grantedAll });
    const buf = await buildErrorReportWorkbook(preview);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const headerTexts: string[] = [];
    ws.getRow(1).eachCell((c) => headerTexts.push(String(c.value)));
    assert.ok(headerTexts.some((h) => h.includes("Resolution")));
    assert.ok(ws.rowCount >= 2);
  });
});
