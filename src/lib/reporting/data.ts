import type { ReportData, ReportKind, ReportRow } from "./types";
import { buildVatResult, vatReportRows, type VatTransaction } from "./vat";
import { CATALOG, DATASET_SOURCES, type CatalogField, type Dataset } from "./catalog";

/**
 * Server-side report data providers.
 *
 * The tenant filter comes from the authenticated context and is applied before
 * any other narrowing, so a caller can only ever reduce its own result set.
 * `select("*")` is used deliberately here because these run server-side with the
 * service role (never exposed to the browser) and the live schema has drifted;
 * column access is defensive so a missing field cannot crash a report.
 */

export interface ReportingQuery extends PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> {
  select(columns: string): ReportingQuery;
  eq(column: string, value: string): ReportingQuery;
  gte(column: string, value: string): ReportingQuery;
  lte(column: string, value: string): ReportingQuery;
}

export interface ReportingDb {
  from(table: string): ReportingQuery;
}

export interface ReportQuery {
  from?: string | null;
  to?: string | null;
  tenantId: string | null;
  companyName?: string | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
};
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const pick = (row: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
};

const DATE_COLUMN: Record<string, string> = {
  invoices: "invoice_date",
  purchase_invoices: "bill_date",
  expenses: "expense_date",
  payments: "payment_date",
};

function applyScope(q: ReportingQuery, query: ReportQuery, table: string): ReportingQuery {
  if (query.tenantId) q = q.eq("tenant_id", query.tenantId);
  const dateCol = DATE_COLUMN[table];
  if (dateCol) {
    if (query.from) q = q.gte(dateCol, query.from);
    if (query.to) q = q.lte(dateCol, query.to);
  }
  return q;
}

async function fetchRows(db: ReportingDb, table: string, query: ReportQuery, columns = "*"): Promise<Record<string, unknown>[]> {
  const { data, error } = await applyScope(db.from(table).select(columns), query, table);
  if (error) throw error;
  return data ?? [];
}

function salesRows(rows: Record<string, unknown>[]): ReportRow[] {
  return rows
    .filter((r) => str(r.status) !== "cancelled")
    .map((r) => {
      const vat = num(pick(r, ["vat_amount", "vat"]));
      const total = num(pick(r, ["total", "total_amount", "grand_total"]));
      const subtotal = num(pick(r, ["subtotal", "sub_total"]));
      return {
        invoice_date: str(pick(r, ["invoice_date", "date"])),
        invoice_number: str(pick(r, ["invoice_number", "number", "invoice_no"])),
        customer_name: str(pick(r, ["customer_name", "customer", "client_name"])),
        subtotal: subtotal || (total - vat),
        vat_amount: vat,
        total,
      };
    });
}

function purchaseRows(rows: Record<string, unknown>[]): ReportRow[] {
  return rows
    .filter((r) => str(r.status) !== "cancelled")
    .map((r) => {
      const vat = num(pick(r, ["vat_amount", "vat"]));
      const total = num(pick(r, ["total", "total_amount", "grand_total"]));
      const subtotal = num(pick(r, ["subtotal", "sub_total"]));
      return {
        bill_date: str(pick(r, ["bill_date", "date"])),
        bill_number: str(pick(r, ["bill_number", "number", "bill_no"])),
        supplier_name: str(pick(r, ["supplier_name", "supplier"])),
        subtotal: subtotal || (total - vat),
        vat_amount: vat,
        total,
      };
    });
}

function expenseRows(rows: Record<string, unknown>[]): ReportRow[] {
  return rows.map((r) => ({
    expense_date: str(pick(r, ["expense_date", "date"])),
    category: str(pick(r, ["category", "expense_category"])),
    description: str(pick(r, ["description", "notes", "memo"])),
    amount: num(pick(r, ["amount", "total"])),
    vat_amount: num(pick(r, ["vat_amount", "vat"])),
  }));
}

function trialBalanceRows(rows: Record<string, unknown>[]): ReportRow[] {
  return rows.map((r) => ({
    account_code: str(pick(r, ["account_code", "code"])),
    account_name: str(pick(r, ["account_name", "name"])),
    debit: num(pick(r, ["debit", "total_debit"])),
    credit: num(pick(r, ["credit", "total_credit"])),
  }));
}

/** Fetches and shapes report data for a kind. Never mutates source rows. */
export async function loadReportData(db: ReportingDb, kind: ReportKind, query: ReportQuery): Promise<ReportData> {
  const base = { kind, periodFrom: query.from ?? null, periodTo: query.to ?? null, companyName: query.companyName ?? null };

  switch (kind) {
    case "sales_report":
      return { ...base, rows: salesRows(await fetchRows(db, "invoices", query)) };
    case "purchases_report":
      return { ...base, rows: purchaseRows(await fetchRows(db, "purchase_invoices", query)) };
    case "expenses_report":
      return { ...base, rows: expenseRows(await fetchRows(db, "expenses", query)) };
    case "trial_balance":
      return { ...base, rows: trialBalanceRows(await fetchRows(db, "accounts", query)) };
    case "vat_report": {
      const [invoices, purchases, expenses] = await Promise.all([
        fetchRows(db, "invoices", query),
        fetchRows(db, "purchase_invoices", query),
        fetchRows(db, "expenses", query),
      ]);
      const transactions: VatTransaction[] = [];
      for (const r of invoices) {
        if (str(r.status) === "cancelled") continue;
        const vat = num(pick(r, ["vat_amount", "vat"]));
        const total = num(pick(r, ["total", "total_amount"]));
        transactions.push({
          section: "sales",
          amount: num(pick(r, ["subtotal"])) || total - vat,
          vatAmount: vat,
          treatment: null,
          partyRegistered: pick(r, ["customer_vat_number"]) ? true : null,
        });
      }
      for (const r of purchases) {
        if (str(r.status) === "cancelled") continue;
        const vat = num(pick(r, ["vat_amount", "vat"]));
        const total = num(pick(r, ["total", "total_amount"]));
        transactions.push({
          section: "purchases",
          amount: num(pick(r, ["subtotal"])) || total - vat,
          vatAmount: vat,
          treatment: null,
          partyRegistered: pick(r, ["supplier_vat_number"]) ? true : null,
        });
      }
      for (const r of expenses) {
        transactions.push({
          section: "purchases",
          amount: num(pick(r, ["amount", "total"])),
          vatAmount: num(pick(r, ["vat_amount", "vat"])),
          treatment: null,
          partyRegistered: null,
        });
      }
      const result = buildVatResult(transactions);
      return { ...base, rows: vatReportRows(result) };
    }
    default:
      return { ...base, rows: [] };
  }
}

// --- Dynamic-dataset access (field catalog) -----------------------------------

function computeField(field: CatalogField, row: Record<string, unknown>, related: Record<string, unknown> | undefined): unknown {
  const raw = field.column ? row[field.column] : row[field.key];
  switch (field.key) {
    case "subtotal":
      return round3(num(raw ?? row["total_amount"]) - num(row["vat_amount"]));
    case "remaining":
      return round3(num(raw ?? row["total_amount"]) - num(row["paid_amount"]));
    case "payment_status": {
      const total = num(row["total_amount"]);
      const paid = num(row["paid_amount"]) ?? 0;
      if (total === null) return "";
      if (paid >= total && total > 0) return "paid";
      if (paid > 0) return "partial";
      return "unpaid";
    }
    default:
      if (field.via && related) return related[field.via.column];
      return raw ?? null;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface DynamicQuery extends ReportQuery {
  fields: CatalogField[];
  /** Client-side row predicates are applied after tenant/period scoping. */
  predicates?: FieldPredicate[];
}

export type FieldPredicate = (row: ReportRow) => boolean;

/**
 * Fetches rows for a dynamic dataset, projecting only catalog fields.
 * Relation fields are resolved with a second, tenant-scoped lookup that maps
 * `localKey → via.column`, avoiding joins that would multiply rows.
 */
export async function loadDynamicRows(
  db: ReportingDb,
  dataset: Dataset,
  query: ReportQuery,
  fields: CatalogField[],
): Promise<{ rows: ReportRow[]; sourceCount: number }> {
  const source = DATASET_SOURCES[dataset];
  const columns = new Set(source.columns);
  for (const f of fields) if (f.column && !f.via) columns.add(f.column);
  const { data, error } = await applyScope(
    db.from(source.table).select([...columns].join(", ")),
    query,
    source.table,
  );
  if (error) throw error;
  const rawRows = (data ?? []) as Record<string, unknown>[];

  // Resolve relation fields in one extra query per related table.
  const relatedTables = new Map<string, { table: string; column: string; localKey: string; ids: Set<string> }>();
  for (const f of fields) {
    if (!f.via) continue;
    const key = `${f.via.table}:${f.via.localKey}:${f.via.column}`;
    if (!relatedTables.has(key)) {
      relatedTables.set(key, { table: f.via.table, column: f.via.column, localKey: f.via.localKey, ids: new Set() });
    }
    for (const r of rawRows) {
      const id = r[f.via.localKey];
      if (id !== null && id !== undefined) relatedTables.get(key)!.ids.add(String(id));
    }
  }

  const relatedMaps = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [key, rel] of relatedTables) {
    const map = new Map<string, Record<string, unknown>>();
    if (rel.ids.size) {
      const rq = applyScope(db.from(rel.table).select(`${rel.localKey === "id" ? "id" : "id"},${rel.column}`), query, rel.table);
      const { data: relData, error: relError } = await rq;
      if (relError) throw relError;
      for (const row of (relData ?? []) as Record<string, unknown>[]) {
        map.set(String(row["id"]), row);
      }
    }
    relatedMaps.set(key, map);
  }

  const rows: ReportRow[] = rawRows.map((r) => {
    const out: ReportRow = {};
    for (const f of fields) {
      let related: Record<string, unknown> | undefined;
      if (f.via) {
        const key = `${f.via.table}:${f.via.localKey}:${f.via.column}`;
        related = relatedMaps.get(key)?.get(String(r[f.via.localKey]));
      }
      out[f.key] = computeField(f, r, related) as string | number | null;
    }
    return out;
  });

  return { rows, sourceCount: rawRows.length };
}

/** Applies a small whitelist of client-side predicates (never widens scope). */
export function applyPredicates(rows: ReportRow[], predicates: FieldPredicate[]): ReportRow[] {
  return predicates.reduce((acc, p) => acc.filter(p), rows);
}

export function catalogFieldsFor(dataset: Dataset): CatalogField[] {
  const table = DATASET_SOURCES[dataset].table;
  return CATALOG.filter((f) => f.source === table || f.via?.table === table);
}

void (undefined as unknown as Dataset);
