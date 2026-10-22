/**
 * Operations reports (pure + one scoped loader).
 *
 * Four reports that were previously empty placeholders, now backed by the
 * existing schema and the definitions already established elsewhere in the repo:
 *
 *  - `monthly_receipts`      customer receipts grouped by month   (source: payments)
 *  - `monthly_invoices`      issued invoices grouped by month     (source: invoices)
 *  - `rented_vehicles`       cars whose status is `rented`        (source: cars)
 *  - `outstanding_by_client` open receivables per customer        (source: invoices)
 *
 * Definitions are **not invented** here:
 *  - "outstanding" = total_amount − paid_amount, excluding cancelled, keeping only
 *    positive balances — the same rule as `ai/tools.ts` (receivables_summary) and
 *    the `remaining` computed field in `catalog.ts`.
 *  - revenue is measured net of VAT and excludes cancelled documents — the same
 *    rule as `revenue.ts` / `data.ts`.
 *  - a "receipt" is a customer payment (`Payment` type: receipt_number/amount/
 *    payment_date) — the same source the dashboard and AI `payments_summary` use.
 *
 * Tenant scoping mirrors `data.ts` (`applyScope`): the tenant filter is applied
 * before any narrowing, so a caller can only ever reduce its own result set.
 */

import type { ReportingDb } from "./data";

export type OperationsReportKind =
  | "monthly_receipts"
  | "monthly_invoices"
  | "rented_vehicles"
  | "outstanding_by_client";

export const OPERATIONS_REPORT_KINDS: OperationsReportKind[] = [
  "monthly_receipts",
  "monthly_invoices",
  "rented_vehicles",
  "outstanding_by_client",
];

export function isOperationsReportKind(value: string): value is OperationsReportKind {
  return (OPERATIONS_REPORT_KINDS as string[]).includes(value);
}

export type ColumnType = "text" | "currency" | "number";

export interface ReportColumn {
  key: string;
  labelEn: string;
  labelAr: string;
  type: ColumnType;
}

export type ReportCell = string | number | null;
export type ReportRowOut = Record<string, ReportCell>;

export interface OperationsReport {
  kind: OperationsReportKind;
  columns: ReportColumn[];
  rows: ReportRowOut[];
  totals: Record<string, number>;
  periodFrom: string | null;
  periodTo: string | null;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const pick = (row: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
};

/** ISO `YYYY-MM` bucket of a date-ish string, or "" when unparseable. */
export function monthKey(value: unknown): string {
  const s = str(value);
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isCancelled(row: Record<string, unknown>): boolean {
  const s = str(row.status).toLowerCase();
  return s === "cancelled" || s === "canceled" || s === "void";
}

// --- Pure builders ------------------------------------------------------------

export function buildMonthlyReceipts(rows: Record<string, unknown>[]): OperationsReport {
  const buckets = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    if (isCancelled(r)) continue;
    const key = monthKey(pick(r, ["payment_date", "date", "created_at"]));
    if (!key) continue;
    const b = buckets.get(key) ?? { count: 0, total: 0 };
    b.count += 1;
    b.total = round3(b.total + num(pick(r, ["amount", "total"])));
    buckets.set(key, b);
  }
  const sorted = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out: ReportRowOut[] = sorted.map(([month, b]) => ({ month, receipts: b.count, total: b.total }));
  return {
    kind: "monthly_receipts",
    columns: [
      { key: "month", labelEn: "Month", labelAr: "الشهر", type: "text" },
      { key: "receipts", labelEn: "Receipts", labelAr: "عدد الإيصالات", type: "number" },
      { key: "total", labelEn: "Total", labelAr: "الإجمالي", type: "currency" },
    ],
    rows: out,
    totals: {
      receipts: out.reduce((s, r) => s + num(r.receipts), 0),
      total: round3(out.reduce((s, r) => s + num(r.total), 0)),
    },
    periodFrom: null,
    periodTo: null,
  };
}

export function buildMonthlyInvoices(rows: Record<string, unknown>[]): OperationsReport {
  const buckets = new Map<string, { count: number; gross: number; net: number }>();
  for (const r of rows) {
    if (isCancelled(r)) continue;
    const key = monthKey(pick(r, ["invoice_date", "date", "created_at"]));
    if (!key) continue;
    const b = buckets.get(key) ?? { count: 0, gross: 0, net: 0 };
    const gross = num(pick(r, ["total_amount", "total", "amount"]));
    const vat = num(pick(r, ["vat_amount", "vat"]));
    b.count += 1;
    b.gross = round3(b.gross + gross);
    b.net = round3(b.net + (gross - vat));
    buckets.set(key, b);
  }
  const sorted = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out: ReportRowOut[] = sorted.map(([month, b]) => ({ month, invoices: b.count, total: b.gross, net: b.net }));
  return {
    kind: "monthly_invoices",
    columns: [
      { key: "month", labelEn: "Month", labelAr: "الشهر", type: "text" },
      { key: "invoices", labelEn: "Invoices", labelAr: "عدد الفواتير", type: "number" },
      { key: "total", labelEn: "Total (incl. VAT)", labelAr: "الإجمالي (شامل الضريبة)", type: "currency" },
      { key: "net", labelEn: "Net (excl. VAT)", labelAr: "الصافي (بدون الضريبة)", type: "currency" },
    ],
    rows: out,
    totals: {
      invoices: out.reduce((s, r) => s + num(r.invoices), 0),
      total: round3(out.reduce((s, r) => s + num(r.total), 0)),
      net: round3(out.reduce((s, r) => s + num(r.net), 0)),
    },
    periodFrom: null,
    periodTo: null,
  };
}

export function buildRentedVehicles(rows: Record<string, unknown>[]): OperationsReport {
  const out: ReportRowOut[] = rows
    .filter((r) => str(r.status).toLowerCase() === "rented")
    .map((r) => ({
      plate_number: str(pick(r, ["plate_number", "plate"])),
      make: str(pick(r, ["make"])),
      model: str(pick(r, ["model"])),
      year: num(pick(r, ["year"])) || null,
      daily_rate: num(pick(r, ["daily_rate"])) || null,
      monthly_rate: num(pick(r, ["monthly_rate"])) || null,
    }))
    .sort((a, b) => str(a.plate_number).localeCompare(str(b.plate_number)));
  return {
    kind: "rented_vehicles",
    columns: [
      { key: "plate_number", labelEn: "Plate", labelAr: "رقم اللوحة", type: "text" },
      { key: "make", labelEn: "Make", labelAr: "الماركة", type: "text" },
      { key: "model", labelEn: "Model", labelAr: "الموديل", type: "text" },
      { key: "year", labelEn: "Year", labelAr: "السنة", type: "number" },
      { key: "daily_rate", labelEn: "Daily Rate", labelAr: "السعر اليومي", type: "currency" },
      { key: "monthly_rate", labelEn: "Monthly Rate", labelAr: "السعر الشهري", type: "currency" },
    ],
    rows: out,
    totals: { vehicles: out.length },
    periodFrom: null,
    periodTo: null,
  };
}

export interface OutstandingCustomer {
  id?: string | null;
  full_name?: string | null;
  name?: string | null;
}

export function buildOutstandingByClient(
  invoices: Record<string, unknown>[],
  customers: OutstandingCustomer[] = [],
): OperationsReport {
  const nameById = new Map<string, string>();
  for (const c of customers) {
    if (c && c.id) nameById.set(String(c.id), str(c.full_name) || str(c.name) || "");
  }
  const buckets = new Map<string, { label: string; invoices: number; total: number; paid: number; outstanding: number }>();
  for (const r of invoices) {
    if (isCancelled(r)) continue;
    const total = num(pick(r, ["total_amount", "total", "amount"]));
    const paid = num(pick(r, ["paid_amount", "paid"]));
    const outstanding = round3(total - paid);
    if (outstanding <= 0) continue;
    const id = str(pick(r, ["customer_id"]));
    const label = nameById.get(id) || str(pick(r, ["customer_name", "customer"])) || id || "—";
    const key = id || label;
    const b = buckets.get(key) ?? { label, invoices: 0, total: 0, paid: 0, outstanding: 0 };
    b.invoices += 1;
    b.total = round3(b.total + total);
    b.paid = round3(b.paid + paid);
    b.outstanding = round3(b.outstanding + outstanding);
    buckets.set(key, b);
  }
  const out: ReportRowOut[] = [...buckets.entries()]
    .map(([id, b]) => ({ client_id: id, client: b.label, invoices: b.invoices, total: b.total, paid: b.paid, outstanding: b.outstanding }))
    .sort((a, b) => num(b.outstanding) - num(a.outstanding));
  return {
    kind: "outstanding_by_client",
    columns: [
      { key: "client", labelEn: "Client", labelAr: "العميل", type: "text" },
      { key: "invoices", labelEn: "Open Invoices", labelAr: "فواتير مستحقة", type: "number" },
      { key: "total", labelEn: "Total", labelAr: "الإجمالي", type: "currency" },
      { key: "paid", labelEn: "Paid", labelAr: "المدفوع", type: "currency" },
      { key: "outstanding", labelEn: "Outstanding", labelAr: "المستحق", type: "currency" },
    ],
    rows: out,
    totals: {
      invoices: out.reduce((s, r) => s + num(r.invoices), 0),
      total: round3(out.reduce((s, r) => s + num(r.total), 0)),
      paid: round3(out.reduce((s, r) => s + num(r.paid), 0)),
      outstanding: round3(out.reduce((s, r) => s + num(r.outstanding), 0)),
    },
    periodFrom: null,
    periodTo: null,
  };
}

// --- Scoped loader (server-side, service role) --------------------------------

const DATE_COLUMN: Partial<Record<string, string>> = {
  payments: "payment_date",
  invoices: "invoice_date",
};

async function fetchScoped(
  db: ReportingDb,
  table: string,
  columns: string,
  tenantId: string | null,
  from?: string | null,
  to?: string | null,
): Promise<Record<string, unknown>[]> {
  let q = db.from(table).select(columns);
  if (tenantId) q = q.eq("tenant_id", tenantId);
  const dateCol = DATE_COLUMN[table];
  if (dateCol) {
    if (from) q = q.gte(dateCol, from);
    if (to) q = q.lte(dateCol, to);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Record<string, unknown>[];
}

export interface OperationsQuery {
  tenantId: string | null;
  from?: string | null;
  to?: string | null;
}

export async function loadOperationsReport(
  db: ReportingDb,
  kind: OperationsReportKind,
  query: OperationsQuery,
): Promise<OperationsReport> {
  const { tenantId, from = null, to = null } = query;
  let report: OperationsReport;
  switch (kind) {
    case "monthly_receipts":
      report = buildMonthlyReceipts(await fetchScoped(db, "payments", "*", tenantId, from, to));
      break;
    case "monthly_invoices":
      report = buildMonthlyInvoices(await fetchScoped(db, "invoices", "*", tenantId, from, to));
      break;
    case "rented_vehicles":
      report = buildRentedVehicles(await fetchScoped(db, "cars", "*", tenantId));
      break;
    case "outstanding_by_client": {
      const [invoices, customers] = await Promise.all([
        fetchScoped(db, "invoices", "*", tenantId, from, to),
        fetchScoped(db, "customers", "id,full_name,name", tenantId),
      ]);
      report = buildOutstandingByClient(invoices, customers as OutstandingCustomer[]);
      break;
    }
  }
  report.periodFrom = from;
  report.periodTo = to;
  return report;
}
