import {
  CATALOG,
  CATALOG_BY_KEY,
  DATASET_SOURCES,
  isDataset,
  type CatalogField,
  type Dataset,
} from "./catalog";
import type { ColumnType } from "./types";

/**
 * Natural-language report builder (Arabic + English), deterministic and
 * whitelisted. It turns a request into a structured `DynamicReportDefinition`
 * that references catalog keys only. Unknown fields are rejected with an
 * explanation — a value is never invented for data that does not exist.
 */

export type FilterOp = "eq" | "gte" | "lte" | "overdue" | "contains";

export interface ReportFilter {
  field: string;
  op: FilterOp;
  value?: string | number | null;
  /** Human reason, bilingual. */
  noteAr?: string;
  noteEn?: string;
}

export type AggregateFn = "sum" | "count" | "avg" | "min" | "max";

export interface ReportAggregate {
  field: string;
  fn: AggregateFn;
}

export interface ReportRequest {
  dataset: Dataset;
  fields: string[];
  filters: ReportFilter[];
  groupBy: string | null;
  aggregates: ReportAggregate[];
  sort: { field: string; dir: "asc" | "desc" } | null;
  titleAr?: string;
  titleEn?: string;
  notes: string[];
  warnings: string[];
  /** Fields the user named that are not in the catalog. */
  unknownFields: string[];
}

export interface DynamicReportDefinition {
  dataset: Dataset;
  table: string;
  fields: CatalogField[];
  filters: ReportFilter[];
  groupBy: CatalogField | null;
  aggregates: (ReportAggregate & { labelAr: string; labelEn: string })[];
  sort: { field: string; dir: "asc" | "desc" } | null;
  dateColumn: string;
  titleAr: string;
  titleEn: string;
  /** Fields deliberately excluded because the caller lacks the permission. */
  deniedFields: string[];
  structural: true;
}

const DATASET_KEYWORDS: { dataset: Dataset; ar: RegExp; en: RegExp }[] = [
  { dataset: "sales", ar: /(مبيعات|فواتير البيع|المبيعات|البيع)/, en: /\b(sales?|invoices?)\b/i },
  { dataset: "purchases", ar: /(مشتريات|المشتريات|فواتير الشراء)/, en: /\b(purchases?|bills?)\b/i },
  { dataset: "expenses", ar: /(مصروفات|المصروفات|المصاريف)/, en: /\b(expenses?)\b/i },
  { dataset: "payments", ar: /(مدفوعات|المدفوعات|الدفعات)/, en: /\b(payments?)\b/i },
  { dataset: "accounts", ar: /(حسابات|دليل الحسابات|شجرة الحسابات)/, en: /\b(accounts?|chart of accounts)\b/i },
];

function detectDataset(text: string): Dataset | null {
  for (const d of DATASET_KEYWORDS) {
    if (d.ar.test(text) || d.en.test(text)) return d.dataset;
  }
  return null;
}

/** Matches the catalog fields mentioned in the text, in order of appearance. */
function matchFields(text: string, allowed: CatalogField[]): { found: string[]; unknown: string[] } {
  const found: { key: string; index: number }[] = [];
  for (const f of allowed) {
    const candidates = [f.labelAr, f.labelEn, f.key, ...(f.aliases ?? [])];
    let best = -1;
    for (const c of candidates) {
      const idx = findTerm(text, c);
      if (idx >= 0 && (best === -1 || idx < best)) best = idx;
    }
    if (best >= 0) found.push({ key: f.key, index: best });
  }
  const known = new Set(found.map((f) => f.key));
  // Unknown-field heuristic: quoted tokens, or "<word> <word>" phrases we could
  // not map, are reported so the user knows what was ignored.
  const unknown: string[] = [];
  const quoted = text.match(/["«]([^"»]{2,40})["»]/g) ?? [];
  for (const q of quoted) {
    const inner = q.replace(/["«»]/g, "").trim();
    if (!inner) continue;
    const matched = allowed.some(
      (f) =>
        f.labelAr.includes(inner) ||
        f.labelEn.toLowerCase().includes(inner.toLowerCase()) ||
        (f.aliases ?? []).some((a) => a.toLowerCase() === inner.toLowerCase() || a.toLowerCase().includes(inner.toLowerCase())),
    );
    if (!matched && !isDataset(inner)) unknown.push(inner);
  }
  void known;
  return { found: found.sort((a, b) => a.index - b.index).map((f) => f.key), unknown };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds a catalog term in free text. Arabic words take prefixes/suffixes
 * (و، ف، ال، ـه) without a space, so the boundary rule treats a preceding
 * letter that is not part of the term as still acceptable for Arabic scripts,
 * while ASCII/Latin terms keep a strict boundary.
 */
function findTerm(text: string, term: string): number {
  const t = term.trim();
  if (!t) return -1;
  const isLatin = /^[\x00-\x7F]+$/.test(t);
  const pattern = isLatin
    ? `(?:^|[^A-Za-z0-9])${escapeRegExp(t)}(?:$|[^A-Za-z0-9])`
    : `${escapeRegExp(t)}`;
  const m = new RegExp(pattern, "iu").exec(text);
  return m ? m.index : -1;
}

function monthBounds(ref: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const to = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

export interface ParseOptions {
  /** Server clock, so "this month" is deterministic in tests. */
  now?: Date;
  /** Fields permitted for the caller's module set. */
  allow?: (field: CatalogField) => boolean;
  /** Default dataset when the request does not name one. */
  defaultDataset?: Dataset;
}

export function parseReportRequest(text: string, options: ParseOptions = {}): ReportRequest {
  const raw = (text ?? "").trim();
  const notes: string[] = [];
  const warnings: string[] = [];

  const dataset = detectDataset(raw) ?? options.defaultDataset ?? "sales";
  const source = DATASET_SOURCES[dataset];
  const allowed = CATALOG.filter(
    (f) => f.source === source.table || source.columns.some((c) => f.column === c),
  );
  const permitted = options.allow ? allowed.filter(options.allow) : allowed;

  const { found, unknown } = matchFields(raw, permitted);
  const unknownFields = unknown;

  // Grouping: "حسب العميل" / "by customer" / "group by month".
  let groupBy: string | null = null;
  const groupMatch = /(?:حسب|مجموعة حسب|by|group\s*by)\s*([^\n,.]+)/i.exec(raw);
  if (groupMatch) {
    const seg = groupMatch[1];
    const candidate =
      permitted.find((f) => findTerm(seg, f.labelAr) >= 0) ??
      permitted.find((f) => findTerm(seg, f.labelEn) >= 0) ??
      permitted.find((f) => (f.aliases ?? []).some((a) => findTerm(seg, a) >= 0)) ??
      (/(شهر|month|monthly)/i.test(seg) ? "invoice_date" : null);
    if (candidate) {
      const key = typeof candidate === "string" ? candidate : candidate.key;
      groupBy = permitted.find((f) => f.key === key)?.key ?? null;
      if (groupBy) notes.push(`تجميع حسب: ${CATALOG_BY_KEY[groupBy]?.labelAr ?? groupBy}`);
    }
  }
  if (/(حسب\s*الشهر|monthly|by\s*month)/i.test(raw)) groupBy = "invoice_date";

  // Aggregates: sum/مجموع, count/عدد, avg/متوسط.
  const aggregates: ReportAggregate[] = [];
  if (/(مجموع|إجمالي|total|sum)/i.test(raw)) {
    const target = found.find((k) => CATALOG_BY_KEY[k]?.total) ?? found[0];
    if (target) aggregates.push({ field: target, fn: "sum" });
  }
  if (/(عدد|count)/i.test(raw)) aggregates.push({ field: "*", fn: "count" });
  const avg = /(متوسط|average|avg)\s*([^\n,.]+)?/i.exec(raw);
  if (avg) {
    const target = found.find((k) => CATALOG_BY_KEY[k]?.type === "currency") ?? null;
    if (target) aggregates.push({ field: target, fn: "avg" });
  }
  if (aggregates.length) notes.push(`تجميعات: ${aggregates.map((a) => a.fn).join(", ")}`);

  // Filters.
  const filters: ReportFilter[] = [];
  if (/(هذا الشهر|الشهر الحالي|this month|current month)/i.test(raw)) {
    const { from, to } = monthBounds(options.now ?? new Date());
    filters.push({ field: source.dateColumn, op: "gte", value: from });
    filters.push({ field: source.dateColumn, op: "lte", value: to });
    notes.push(`فترة: من ${from} إلى ${to}`);
  }
  if (/(متأخر|متأخرة|overdue|unpaid|غير مدفوع)/i.test(raw) && dataset === "sales") {
    filters.push({ field: "due_date", op: "overdue", noteAr: "الاستحقاق قبل اليوم والمتبقي > 0", noteEn: "due before today and remaining > 0" });
    notes.push("تصفية: الفواتير المتأخرة");
  }
  if (/(ملغاة|cancelled|canceled)/i.test(raw)) {
    filters.push({ field: "status", op: "eq", value: "cancelled" });
  }
  if (/(متبقي|remaining)/i.test(raw)) {
    filters.push({ field: "remaining", op: "gte", value: 0, noteAr: "عرض المتبقي", noteEn: "show remaining" });
  }

  // Sorting: "رتّب ... حسب X" / "sort by".
  let sort: ReportRequest["sort"] = null;
  const sortMatch = /(?:رتّب|رتب|sort(?:ed)?\s*by|order\s*by)\s*([^\n,.]+)/i.exec(raw);
  if (sortMatch) {
    const seg = sortMatch[1];
    const dir: "asc" | "desc" = /(تنازلي|الأكبر|desc|value)/i.test(seg) ? "desc" : "asc";
    const target =
      permitted.find((f) => findTerm(seg, f.labelAr) >= 0) ??
      permitted.find((f) => findTerm(seg, f.labelEn) >= 0) ??
      permitted.find((f) => (f.aliases ?? []).some((a) => findTerm(seg, a) >= 0)) ??
      permitted.find((f) => f.key === "invoice_date");
    if (target) sort = { field: target.key, dir };
  }

  const fields = found.length ? found : [...source.defaultFields];
  const titleEn = `${dataset} report`;
  const titleAr = `تقرير ${dataset}`;

  if (unknownFields.length) {
    warnings.push(`حقول غير معروفة تم تجاهلها: ${unknownFields.join(", ")}`);
  }

  return { dataset, fields, filters, groupBy, aggregates, sort, titleAr, titleEn, notes, warnings, unknownFields };
}

/** Resolves a parsed request into a validated, permission-checked definition. */
export function buildDynamicDefinition(
  request: ReportRequest,
  allow?: (field: CatalogField) => boolean,
): DynamicReportDefinition {
  const source = DATASET_SOURCES[request.dataset];
  const deniedFields: string[] = [];
  const keep = (key: string): boolean => {
    const f = CATALOG_BY_KEY[key];
    if (!f) return false;
    if (allow && !allow(f)) {
      deniedFields.push(key);
      return false;
    }
    return true;
  };

  const fields = request.fields.map((k) => CATALOG_BY_KEY[k]).filter((f): f is CatalogField => Boolean(f) && keep(f!.key));
  const groupBy = request.groupBy && CATALOG_BY_KEY[request.groupBy] && keep(request.groupBy) ? CATALOG_BY_KEY[request.groupBy] : null;
  const aggregates = request.aggregates
    .filter((a) => a.field === "*" || keep(a.field))
    .map((a) => {
      const f = a.field === "*" ? null : CATALOG_BY_KEY[a.field];
      return {
        ...a,
        labelAr: a.fn === "count" ? "العدد" : `${f?.labelAr ?? a.field} (${a.fn})`,
        labelEn: a.fn === "count" ? "Count" : `${f?.labelEn ?? a.field} (${a.fn})`,
      };
    });

  return {
    dataset: request.dataset,
    table: source.table,
    fields,
    filters: request.filters,
    groupBy,
    aggregates,
    sort: request.sort,
    dateColumn: source.dateColumn,
    titleAr: request.titleAr ?? "تقرير",
    titleEn: request.titleEn ?? "Report",
    deniedFields,
    structural: true,
  };
}

/**
 * Column metadata for the built definition (used by the Excel renderer).
 *
 * When the report is ungrouped, aggregates are meaningless and are dropped —
 * the totals row already covers them through each column's `total` flag. When
 * grouped, the group key and one column per aggregate are produced.
 */
export function definitionColumns(def: DynamicReportDefinition) {
  if (!def.groupBy) {
    return def.fields.map((f) => ({
      key: f.key,
      labelAr: f.labelAr,
      labelEn: f.labelEn,
      type: f.type as ColumnType,
      total: f.total,
    }));
  }
  return [
    { key: def.groupBy.key, labelAr: def.groupBy.labelAr, labelEn: def.groupBy.labelEn, type: def.groupBy.type as ColumnType, total: false },
    ...def.aggregates.map((a, i) => ({
      key: `agg_${i}`,
      labelAr: a.labelAr,
      labelEn: a.labelEn,
      type: (a.fn === "count" ? "number" : "currency") as ColumnType,
      total: a.fn === "sum" || a.fn === "count",
    })),
  ];
}
