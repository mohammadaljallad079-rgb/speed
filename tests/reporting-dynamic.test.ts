import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { CATALOG_BY_KEY, DATASET_SOURCES } from "../src/lib/reporting/catalog.ts";
import { parseReportRequest, buildDynamicDefinition, definitionColumns } from "../src/lib/reporting/report-def.ts";
import {
  validateReport,
  summarizeIssues,
  applicableFixes,
  type ValidationColumn,
} from "../src/lib/reporting/validation.ts";
import {
  applyFilters,
  aggregateRows,
  buildDynamicPreview,
  buildDynamicFile,
  type DynamicContext,
} from "../src/lib/reporting/dynamic.ts";
import { loadDynamicRows, type ReportingDb, type ReportingQuery } from "../src/lib/reporting/data.ts";
import { saveDefinition, loadDefinitions, restoreDefinition, findDefinition } from "../src/lib/reporting/templates.ts";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ----------------------------------------------------------------------------
// Recording PostgREST-like stub with relation tables.
// ----------------------------------------------------------------------------
type Row = Record<string, unknown>;
class FakeQuery implements PromiseLike<{ data: Row[] | null; error: unknown }> {
  rows: Row[];
  filters: { col: string; op: string; val: unknown }[] = [];
  constructor(rows: Row[]) { this.rows = rows; }
  select() { return this; }
  eq(col: string, val: string) { this.filters.push({ col, op: "eq", val }); return this; }
  gte(col: string, val: string) { this.filters.push({ col, op: "gte", val }); return this; }
  lte(col: string, val: string) { this.filters.push({ col, op: "lte", val }); return this; }
  private apply() {
    return this.rows.filter((r) => this.filters.every((f) => {
      const v = r[f.col];
      if (f.op === "eq") return String(v) === String(f.val);
      if (f.op === "gte") return String(v) >= String(f.val);
      if (f.op === "lte") return String(v) <= String(f.val);
      return true;
    }));
  }
  then<R1, R2 = never>(res: (v: { data: Row[] | null; error: unknown }) => R1 | PromiseLike<R1>, rej?: (e: unknown) => R2 | PromiseLike<R2>) {
    return Promise.resolve({ data: this.apply(), error: null }).then(res, rej);
  }
}
class FakeDb {
  tables: Record<string, Row[]>;
  queries: FakeQuery[] = [];
  constructor(tables: Record<string, Row[]>) { this.tables = tables; }
  from(table: string) { const q = new FakeQuery(this.tables[table] ?? []); this.queries.push(q); return q; }
}

class FakeSettingsDb {
  store: Row[] = [];
  from() {
    const self = this;
    const chain = {
      _f: [] as { col: string; val: unknown }[],
      select() { return chain; },
      eq(col: string, val: string) { chain._f.push({ col, val }); return chain; },
      async maybeSingle() {
        const found = self.store.find((r) => chain._f.every((f) => r[f.col] === f.val));
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

const NOW = new Date("2026-01-15T12:00:00Z");

function db() {
  return new FakeDb({
    invoices: [
      { id: "i1", tenant_id: "A", invoice_number: "INV-1", invoice_date: "2026-01-05", status: "issued", vat_amount: 10, total_amount: 110, paid_amount: 110, due_date: "2026-01-20", customer_id: "c1" },
      { id: "i2", tenant_id: "A", invoice_number: "INV-2", invoice_date: "2026-01-10", status: "issued", vat_amount: 20, total_amount: 220, paid_amount: 0, due_date: "2026-01-01", customer_id: "c2" },
      { id: "i3", tenant_id: "B", invoice_number: "INV-3", invoice_date: "2026-01-11", status: "issued", vat_amount: 5, total_amount: 55, paid_amount: 0, due_date: "2026-01-25", customer_id: "c9" },
      { id: "i4", tenant_id: "A", invoice_number: "INV-1", invoice_date: "2026-01-05", status: "issued", vat_amount: 10, total_amount: 110, paid_amount: 0, due_date: "2026-01-20", customer_id: "c1" },
    ],
    customers: [
      { id: "c1", tenant_id: "A", full_name: "Alpha" },
      { id: "c2", tenant_id: "A", full_name: "Beta" },
      { id: "c9", tenant_id: "B", full_name: "Other" },
    ],
    expenses: [
      { id: "e1", tenant_id: "A", expense_date: "2026-01-03", category: "fuel", description: "Fuel", amount: 50, vat_amount: 5, branch: "Main" },
      { id: "e2", tenant_id: "A", expense_date: "2026-01-04", category: "rent", description: "Rent", amount: 500, vat_amount: 0, branch: "Main" },
    ],
    purchase_invoices: [],
    payments: [],
    accounts: [],
  });
}
const ctx = (d = db(), allowField?: DynamicContext["allowField"]): DynamicContext => ({ db: d as unknown as ReportingDb, tenantId: "A", allowField });

// ----------------------------------------------------------------------------
describe("mandatory 1-2: create a report from an Arabic/English request", () => {
  test("Arabic request builds a sales-by-customer definition", () => {
    const req = parseReportRequest("أنشئ تقرير مبيعات حسب العميل خلال هذا الشهر", { now: NOW });
    assert.equal(req.dataset, "sales");
    assert.ok(req.groupBy === "customer_name" || req.fields.includes("customer_name"));
    assert.ok(req.filters.some((f) => f.field === "invoice_date" && f.op === "gte"));
  });

  test("English request names fields and sorting", () => {
    const req = parseReportRequest("sales report with invoice number, date and total sorted by total desc", { now: NOW });
    assert.equal(req.dataset, "sales");
    assert.ok(req.fields.includes("invoice_number"));
    assert.ok(req.fields.includes("total"));
    assert.equal(req.sort?.field, "total");
    assert.equal(req.sort?.dir, "desc");
  });
});

describe("mandatory 3-4: add a real field; reject an unknown field without inventing", () => {
  test("a real field is added", () => {
    const req = parseReportRequest("أضف رقم الفاتورة وحالة السداد والمتبقي", { now: NOW, defaultDataset: "sales" });
    assert.ok(req.fields.includes("invoice_number"));
    assert.ok(req.fields.includes("payment_status"));
    assert.ok(req.fields.includes("remaining"));
  });

  test("an unknown quoted field is reported, not invented", () => {
    const req = parseReportRequest('مبيعات مع عمود "اللون" و "الحجم"', { now: NOW });
    assert.ok(req.unknownFields.includes("اللون"));
    assert.ok(req.warnings.some((w) => w.includes("اللون")));
    assert.ok(!req.fields.includes("اللون"));
  });
});

describe("mandatory 5: filters, columns and grouping compose correctly", () => {
  test("overdue filter plus remaining column behaves", async () => {
    const preview = await buildDynamicPreview(ctx(), { prompt: "اعرض الفواتير المتأخرة والمبالغ المتبقية", now: NOW });
    assert.ok(preview.rows.every((r) => r["remaining"] !== null));
    // INV-2 is overdue (due 2026-01-01, remaining 220); INV-1 is paid.
    const numbers = preview.rows.map((r) => r["invoice_number"]);
    assert.ok(numbers.includes("INV-2"));
    assert.ok(!numbers.includes("INV-1"));
  });

  test("grouping by customer aggregates", async () => {
    const preview = await buildDynamicPreview(ctx(), { prompt: "تقرير مبيعات حسب العميل مع مجموع الإجمالي", now: NOW });
    assert.ok(preview.definition.groupBy);
    assert.equal(preview.definition.groupBy!.key, "customer_name");
    assert.ok(preview.columns.some((c) => c.key.startsWith("agg_")));
  });
});

describe("mandatory 6-8: detect wrong totals, duplicates, wrongly excluded records", () => {
  const columns: ValidationColumn[] = [
    { key: "invoice_number", labelAr: "رقم", labelEn: "No", type: "text" },
    { key: "total", labelAr: "الإجمالي", labelEn: "Total", type: "currency", total: true },
  ];

  test("a wrong stated total is an error with evidence", () => {
    const issues = validateReport({ columns, rows: [{ total: 100 }, { total: 200 }], totals: { total: 999 } });
    const calc = issues.find((i) => i.category === "calculation");
    assert.ok(calc);
    assert.equal(calc!.current, 999);
    assert.equal(calc!.expected, 300);
  });

  test("duplicate keys that would double-count are flagged", () => {
    const issues = validateReport({ columns, rows: [{ invoice_number: "INV-1", total: 100 }, { invoice_number: "INV-1", total: 100 }] });
    assert.ok(issues.some((i) => i.category === "data" && i.titleEn.includes("Duplicate")));
  });

  test("report row count vs source count mismatch is flagged", () => {
    const issues = validateReport({ columns, rows: [{ total: 1 }], sourceCount: 5 });
    assert.ok(issues.some((i) => i.id === "logic-source-count" && i.fixClass === 2));
  });
});

describe("mandatory 9-10: missing data, unclassified VAT, Excel formula errors", () => {
  test("missing required values are reported", () => {
    const cols: ValidationColumn[] = [{ key: "invoice_number", labelAr: "رقم", labelEn: "No", type: "text" }];
    const issues = validateReport({ columns: cols, rows: [{ invoice_number: "" }, { invoice_number: "X" }], required: ["invoice_number"] });
    assert.ok(issues.some((i) => i.id.startsWith("data-missing")));
  });

  test("VAT not matching 10% is info + sensitive class 3", () => {
    const cols: ValidationColumn[] = [
      { key: "subtotal", labelAr: "قبل", labelEn: "Subtotal", type: "currency" },
      { key: "vat_amount", labelAr: "ضريبة", labelEn: "VAT", type: "currency" },
    ];
    const issues = validateReport({ columns: cols, rows: [{ subtotal: 1000, vat_amount: 50 }] });
    const vat = issues.find((i) => i.id === "data-vat-rate");
    assert.ok(vat && vat.fixClass === 3);
  });

  test("a totals row with a broken formula is caught (value mismatch)", () => {
    const cols: ValidationColumn[] = [{ key: "x", labelAr: "x", labelEn: "x", type: "currency", total: true }];
    const issues = validateReport({ columns: cols, rows: [{ x: 1 }, { x: 2 }], totals: { x: 4 } });
    assert.equal(issues.filter((i) => i.category === "calculation").length, 1);
  });
});

describe("mandatory 11: totals verified before and after (no mutation)", () => {
  test("computed totals equal row sums and source rows are untouched", async () => {
    const d = db();
    const before = JSON.stringify(d.tables.invoices);
    const preview = await buildDynamicPreview(ctx(d), { prompt: "تقرير مبيعات مع مجموع الإجمالي", now: NOW });
    const sum = preview.rows.reduce((s, r) => s + (Number(r["total"]) || 0), 0);
    assert.equal(Math.round(preview.totals["total"] * 1000) / 1000, Math.round(sum * 1000) / 1000);
    assert.equal(JSON.stringify(d.tables.invoices), before);
  });
});

describe("mandatory 12: formatting never changes source data", () => {
  test("build-preview leaves the dataset unchanged", async () => {
    const d = db();
    const before = JSON.stringify(d.tables);
    await buildDynamicPreview(ctx(d), { prompt: "رتّب المصروفات حسب التصنيف والقيمة", now: NOW });
    assert.equal(JSON.stringify(d.tables), before);
  });
});

describe("mandatory 13: sensitive repair is refused; only class-1 fixes are applicable", () => {
  test("applicableFixes returns only safe display fixes", () => {
    const issues = validateReport({
      columns: [
        { key: "total", labelAr: "إجمالي", labelEn: "Total", type: "currency", total: true },
        { key: "total2", labelAr: "إجمالي", labelEn: "Total", type: "currency" },
      ],
      rows: [{ total: 1, total2: 2 }],
      totals: { total: 999 },
    });
    const safe = applicableFixes(issues);
    assert.ok(safe.every((i) => i.fixClass === 1));
    // The wrong total (class 2) and nothing sensitive is auto-applied.
    assert.ok(!safe.some((i) => i.category === "calculation"));
  });

  test("a data-change request is flagged and not applied", async () => {
    const d = db();
    const preview = await buildDynamicPreview(ctx(d), { prompt: "عدّل المبلغ في الفاتورة إلى 500", now: NOW });
    assert.equal(preview.dataChangeRequested, true);
    assert.equal(d.tables.invoices[0].total_amount, 110);
  });
});

describe("mandatory 14: permissions and tenant isolation", () => {
  test("only the caller's tenant rows are returned", async () => {
    const d = db();
    const { rows, sourceCount } = await loadDynamicRows(
      d as unknown as ReportingDb,
      "sales",
      { tenantId: "A" },
      [CATALOG_BY_KEY["invoice_number"], CATALOG_BY_KEY["customer_name"]],
    );
    assert.equal(sourceCount, 3); // 3 of 4 rows belong to tenant A
    assert.ok(rows.every((r) => r["invoice_number"] !== "INV-3"));
    assert.equal(d.queries[0].filters.find((f) => f.col === "tenant_id")?.val, "A");
  });

  test("a denied permission removes the field and records it", async () => {
    const allowField = (f: { key: string }) => f.key !== "customer_name";
    const preview = await buildDynamicPreview(
      ctx(db(), allowField as DynamicContext["allowField"]),
      { prompt: "تقرير مبيعات حسب العميل مع اسم العميل", now: NOW },
    );
    assert.ok(preview.definition.deniedFields.includes("customer_name"));
    assert.ok(!preview.columns.some((c) => c.key === "customer_name"));
  });

  test("relation fields never multiply rows (no join duplication)", async () => {
    const d = db();
    const { rows } = await loadDynamicRows(
      d as unknown as ReportingDb,
      "sales",
      { tenantId: "A" },
      [CATALOG_BY_KEY["invoice_number"], CATALOG_BY_KEY["customer_name"]],
    );
    assert.equal(rows.length, 3);
  });
});

describe("mandatory 15: generated Excel file integrity", () => {
  test("buildDynamicFile yields a verified buffer", async () => {
    const { buffer, verification, filename } = await buildDynamicFile(ctx(), {
      prompt: "تقرير مبيعات حسب العميل مع مجموع الإجمالي",
      now: NOW,
    });
    assert.equal(verification.ok, true, verification.errors.join("; "));
    assert.ok(buffer.length > 0);
    assert.match(filename, /SPEED_sales_\d{4}-\d{2}-\d{2}\.xlsx/);
  });
});

describe("mandatory 16: save a definition and restore a prior version", () => {
  test("versions accumulate and restore returns the old request", async () => {
    const sdb = new FakeSettingsDb();
    await saveDefinition(sdb as never, "A", { name: "Rep", dataset: "sales", request: { v: 1 } });
    await saveDefinition(sdb as never, "A", { name: "Rep", dataset: "sales", request: { v: 2 } });
    const defs = await loadDefinitions(sdb as never, "A");
    const def = findDefinition(defs, "rep")!;
    assert.equal(def.versions.length, 1);
    assert.deepEqual(def.current, { v: 2 });
    await restoreDefinition(sdb as never, "A", "Rep", def.versions[0].version);
    const after = findDefinition(await loadDefinitions(sdb as never, "A"), "Rep")!;
    assert.deepEqual(after.current, { v: 1 });
  });

  test("definitions are tenant-scoped", async () => {
    const sdb = new FakeSettingsDb();
    await saveDefinition(sdb as never, "A", { name: "Rep", dataset: "sales", request: {} });
    assert.equal((await loadDefinitions(sdb as never, "B")).length, 0);
  });
});

describe("mandatory 17: audit is used and no secrets leak", () => {
  test("route logs to the existing activity_logs and never returns a key", () => {
    const route = read("src/app/api/financial/report-format/route.ts");
    assert.match(route, /logAudit\(/);
    assert.match(route, /requireContext\(/);
    assert.doesNotMatch(route, /body\.tenant_id|body\.tenantId|form\.get\(['"]tenant/);
    assert.doesNotMatch(route, /return[\s\S]{0,40}(SERVICE_ROLE_KEY|ANTHROPIC_API_KEY)/);
    assert.match(route, /can\(context, field\.module, "view"\)/);
  });

  test("no random SQL/code execution path is introduced", () => {
    for (const f of ["dynamic.ts", "report-def.ts", "validation.ts", "catalog.ts"]) {
      const src = read(`src/lib/reporting/${f}`);
      assert.doesNotMatch(src, /\beval\(|new Function\(|exec_sql/i);
    }
  });

  test("the dynamic UI never reads tenant id from the browser", () => {
    const ui = read("src/components/reporting/DynamicReportBuilder.tsx");
    assert.doesNotMatch(ui, /tenant_id|tenantId/);
  });
});

describe("grouping and filtering logic (pure)", () => {
  test("applyFilters handles overdue and eq", () => {
    const rows = [{ due_date: "2026-01-01", remaining: 10 }, { due_date: "2026-02-01", remaining: 10 }];
    const out = applyFilters(rows as never, [{ field: "due_date", op: "overdue" }], NOW);
    assert.equal(out.length, 1);
  });

  test("aggregateRows sums by group", () => {
    const out = aggregateRows(
      [
        { customer_name: "A", total: 10 },
        { customer_name: "A", total: 5 },
        { customer_name: "B", total: 7 },
      ] as never,
      "customer_name",
      [{ field: "total", fn: "sum" }],
    );
    const a = out.find((r) => r["customer_name"] === "A")!;
    assert.equal(a["agg_0"], 15);
    assert.equal(out.length, 2);
  });

  test("datasets declare the columns they need", () => {
    for (const ds of Object.values(DATASET_SOURCES)) {
      assert.ok(ds.table && ds.dateColumn && ds.defaultFields.length);
    }
  });
});

describe("unknown dataset / field safety", () => {
  test("buildDynamicDefinition marks structurally valid output", () => {
    const req = parseReportRequest("تقرير مبيعات", { now: NOW });
    const def = buildDynamicDefinition(req);
    assert.equal(def.structural, true);
    assert.equal(def.table, "invoices");
    assert.ok(definitionColumns(def).length > 0);
  });

  test("summarizeIssues counts by severity", () => {
    const issues = validateReport({
      columns: [{ key: "x", labelAr: "x", labelEn: "x", type: "currency", total: true }],
      rows: [{ x: 1 }],
      totals: { x: 2 },
    });
    assert.equal(summarizeIssues(issues).error, 1);
  });
});

void (undefined as unknown as ReportingQuery);
