/**
 * Purchasing and expense reports (pure).
 *
 * Execution 54 found the purchasing module had documents but no reporting: the
 * purchase register, supplier ledger, supplier aging, expenses by vehicle /
 * branch / category, the input-VAT report, the monthly expense report and
 * vehicle profitability all had no implementation. These builders derive every
 * figure from rows the caller already loaded, so the arithmetic is testable
 * without a database and every report shares one definition of "outstanding",
 * "VAT-inclusive" and "net".
 *
 * Conventions, all shared with the rest of the reporting layer and NOT re-invented:
 *  - `purchase_invoices.total_amount` is VAT-INCLUSIVE, so the taxable base is
 *    `total − vat` (same rule as `vat.ts` and Exec 18).
 *  - `expenses.amount` is stored PRE-VAT, so the taxable base is `amount` and the
 *    VAT is `vat_amount` (same rule as `vat.ts`).
 *  - a supplier bill's outstanding balance is `total_amount − paid_amount`,
 *    excluding cancelled documents, keeping only positive balances.
 *  - a debit note reduces what is owed to the supplier.
 *
 * Nothing here reads or writes a database.
 */

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export type ColumnType = "text" | "currency" | "number";
export interface ReportColumn {
  key: string;
  labelEn: string;
  labelAr: string;
  type: ColumnType;
}
export type ReportRow = Record<string, string | number | null>;

export interface PurchasingReport {
  kind: PurchasingReportKind;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, number>;
  periodFrom: string | null;
  periodTo: string | null;
}

export type PurchasingReportKind =
  | "purchase_register"
  | "supplier_ledger"
  | "supplier_aging"
  | "expenses_by_vehicle"
  | "expenses_by_branch"
  | "expenses_by_category"
  | "vat_purchases"
  | "monthly_expenses"
  | "vehicle_profitability";

export const PURCHASING_REPORT_KINDS: PurchasingReportKind[] = [
  "purchase_register",
  "supplier_ledger",
  "supplier_aging",
  "expenses_by_vehicle",
  "expenses_by_branch",
  "expenses_by_category",
  "vat_purchases",
  "monthly_expenses",
  "vehicle_profitability",
];

export function isPurchasingReportKind(value: string): value is PurchasingReportKind {
  return (PURCHASING_REPORT_KINDS as string[]).includes(value);
}

function isCancelled(row: Record<string, unknown>): boolean {
  const s = str(row.status).toLowerCase();
  return s === "cancelled" || s === "canceled" || s === "void";
}

/** Taxable base of a VAT-inclusive supplier bill. */
export function billTaxableBase(row: Record<string, unknown>): number {
  const total = num(row.total_amount ?? row.total);
  const vat = num(row.vat_amount ?? row.vat);
  return round3(total - vat);
}

/** Outstanding balance of a supplier bill (0 when cancelled or settled). */
export function billOutstanding(row: Record<string, unknown>): number {
  if (isCancelled(row)) return 0;
  return round3(num(row.total_amount ?? row.total) - num(row.paid_amount ?? row.paid));
}

/** ISO `YYYY-MM` bucket, or "" when unparseable. */
export function monthKey(value: unknown): string {
  const s = str(value);
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function supplierName(row: Record<string, unknown>, suppliers: Record<string, unknown>[]): string {
  const id = str(row.supplier_id);
  const s = suppliers.find((x) => str(x.id) === id);
  return str(s?.name) || str(s?.company_name) || str(row.supplier_name) || id || "—";
}

function vehicleName(row: Record<string, unknown>, cars: Record<string, unknown>[]): string {
  const id = str(row.car_id);
  const c = cars.find((x) => str(x.id) === id);
  if (c) return str(c.plate_number) || `${str(c.make)} ${str(c.model)}`.trim() || id;
  return str(row.car_plate) || id || "—";
}

// --- Purchase register --------------------------------------------------------

/**
 * Every supplier bill in the period, with its taxable base, VAT and outstanding
 * balance. This is the "what did we buy, from whom, and what do we still owe"
 * report the purchasing module never had.
 */
export function buildPurchaseRegister(
  bills: Record<string, unknown>[],
  suppliers: Record<string, unknown>[] = [],
): PurchasingReport {
  const rows: ReportRow[] = bills
    .filter((b) => !isCancelled(b))
    .map((b) => ({
      invoice_number: str(b.invoice_number ?? b.bill_number),
      bill_date: str(b.bill_date ?? b.date),
      due_date: str(b.due_date) || null,
      supplier: supplierName(b, suppliers),
      taxable: billTaxableBase(b),
      vat: round3(num(b.vat_amount ?? b.vat)),
      total: round3(num(b.total_amount ?? b.total)),
      paid: round3(num(b.paid_amount ?? b.paid)),
      outstanding: billOutstanding(b),
      status: str(b.status),
    }))
    .sort((a, b) => str(a.bill_date).localeCompare(str(b.bill_date)));
  return {
    kind: "purchase_register",
    columns: [
      { key: "invoice_number", labelEn: "Bill No.", labelAr: "رقم الفاتورة", type: "text" },
      { key: "bill_date", labelEn: "Date", labelAr: "التاريخ", type: "text" },
      { key: "due_date", labelEn: "Due", labelAr: "الاستحقاق", type: "text" },
      { key: "supplier", labelEn: "Supplier", labelAr: "المورد", type: "text" },
      { key: "taxable", labelEn: "Taxable", labelAr: "الخاضع للضريبة", type: "currency" },
      { key: "vat", labelEn: "VAT", labelAr: "الضريبة", type: "currency" },
      { key: "total", labelEn: "Total", labelAr: "الإجمالي", type: "currency" },
      { key: "paid", labelEn: "Paid", labelAr: "المدفوع", type: "currency" },
      { key: "outstanding", labelEn: "Outstanding", labelAr: "المتبقي", type: "currency" },
      { key: "status", labelEn: "Status", labelAr: "الحالة", type: "text" },
    ],
    rows,
    totals: {
      taxable: round3(rows.reduce((s, r) => s + num(r.taxable), 0)),
      vat: round3(rows.reduce((s, r) => s + num(r.vat), 0)),
      total: round3(rows.reduce((s, r) => s + num(r.total), 0)),
      paid: round3(rows.reduce((s, r) => s + num(r.paid), 0)),
      outstanding: round3(rows.reduce((s, r) => s + num(r.outstanding), 0)),
      bills: rows.length,
    },
    periodFrom: null,
    periodTo: null,
  };
}

// --- Supplier ledger ----------------------------------------------------------

export interface LedgerInputs {
  bills: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  debitNotes?: Record<string, unknown>[];
  suppliers?: Record<string, unknown>[];
}

/**
 * One supplier's account: bills increase what we owe (credit), payments and debit
 * notes decrease it (debit), and the running balance is shown after every line.
 * This is what a supplier statement is, and it reconciles with the AP account
 * because every bill posts Dr expense / Cr AP and every payment posts Dr AP.
 */
export function buildSupplierLedger(input: LedgerInputs, supplierId?: string | null): PurchasingReport {
  const { bills, payments, debitNotes = [], suppliers = [] } = input;
  const match = (row: Record<string, unknown>) => !supplierId || str(row.supplier_id) === str(supplierId);

  type Movement = { date: string; doc: string; type: string; description: string; debit: number; credit: number };
  const movements: Movement[] = [];

  for (const b of bills) {
    if (!match(b) || isCancelled(b)) continue;
    movements.push({
      date: str(b.bill_date ?? b.date),
      doc: str(b.invoice_number ?? b.bill_number),
      type: "bill",
      description: supplierName(b, suppliers),
      debit: 0,
      credit: round3(num(b.total_amount ?? b.total)),
    });
  }
  for (const p of payments) {
    if (!match(p) || isCancelled(p)) continue;
    movements.push({
      date: str(p.payment_date ?? p.date),
      doc: str(p.payment_number ?? p.receipt_number),
      type: "payment",
      description: str(p.notes) || "Supplier payment",
      debit: round3(num(p.amount)),
      credit: 0,
    });
  }
  for (const d of debitNotes) {
    if (!match(d) || isCancelled(d)) continue;
    movements.push({
      date: str(d.note_date ?? d.date),
      doc: str(d.note_number),
      type: "debit_note",
      description: str(d.reason) || "Debit note",
      debit: round3(num(d.amount)),
      credit: 0,
    });
  }

  movements.sort((a, b) => (a.date === b.date ? a.doc.localeCompare(b.doc) : a.date.localeCompare(b.date)));

  let balance = 0;
  const rows: ReportRow[] = movements.map((m) => {
    balance = round3(balance + m.credit - m.debit);
    return {
      date: m.date,
      doc: m.doc,
      type: m.type,
      description: m.description,
      debit: m.debit,
      credit: m.credit,
      balance,
    };
  });

  return {
    kind: "supplier_ledger",
    columns: [
      { key: "date", labelEn: "Date", labelAr: "التاريخ", type: "text" },
      { key: "doc", labelEn: "Document", labelAr: "المستند", type: "text" },
      { key: "type", labelEn: "Type", labelAr: "النوع", type: "text" },
      { key: "description", labelEn: "Description", labelAr: "البيان", type: "text" },
      { key: "debit", labelEn: "Debit", labelAr: "مدين", type: "currency" },
      { key: "credit", labelEn: "Credit", labelAr: "دائن", type: "currency" },
      { key: "balance", labelEn: "Balance", labelAr: "الرصيد", type: "currency" },
    ],
    rows,
    totals: {
      debit: round3(rows.reduce((s, r) => s + num(r.debit), 0)),
      credit: round3(rows.reduce((s, r) => s + num(r.credit), 0)),
      balance,
    },
    periodFrom: null,
    periodTo: null,
  };
}

// --- Supplier aging -----------------------------------------------------------

export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Days past due, floored at 0. A bill not yet due is `current`. */
export function agingBucket(dueDate: string, asOf: string): AgingBucket {
  if (!dueDate) return "current";
  const due = new Date(`${dueDate}T00:00:00Z`).getTime();
  const ref = new Date(`${asOf}T00:00:00Z`).getTime();
  if (Number.isNaN(due) || Number.isNaN(ref)) return "current";
  const days = Math.floor((ref - due) / 86_400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/**
 * Outstanding supplier balances bucketed by age. The same convention as the
 * receivable aging: a bill's outstanding balance is placed in exactly one bucket,
 * so the buckets sum to the total owed.
 */
export function buildSupplierAging(
  bills: Record<string, unknown>[],
  suppliers: Record<string, unknown>[] = [],
  asOf?: string,
): PurchasingReport {
  const asOfDate = asOf || new Date().toISOString().slice(0, 10);
  const bySupplier = new Map<string, { name: string; buckets: Record<AgingBucket, number> }>();
  for (const b of bills) {
    const outstanding = billOutstanding(b);
    if (outstanding <= 0) continue;
    const id = str(b.supplier_id) || "—";
    const entry = bySupplier.get(id) ?? {
      name: supplierName(b, suppliers),
      buckets: { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 },
    };
    const bucket = agingBucket(str(b.due_date) || str(b.bill_date ?? b.date), asOfDate);
    entry.buckets[bucket] = round3(entry.buckets[bucket] + outstanding);
    bySupplier.set(id, entry);
  }
  const rows: ReportRow[] = [...bySupplier.entries()]
    .map(([id, e]) => ({
      supplier_id: id,
      supplier: e.name,
      current: e.buckets.current,
      "1-30": e.buckets["1-30"],
      "31-60": e.buckets["31-60"],
      "61-90": e.buckets["61-90"],
      "90+": e.buckets["90+"],
      total: round3(Object.values(e.buckets).reduce((s, v) => s + v, 0)),
    }))
    .sort((a, b) => str(a.supplier).localeCompare(str(b.supplier)));
  const sum = (k: string) => round3(rows.reduce((s, r) => s + num(r[k]), 0));
  return {
    kind: "supplier_aging",
    columns: [
      { key: "supplier", labelEn: "Supplier", labelAr: "المورد", type: "text" },
      { key: "current", labelEn: "Current", labelAr: "غير مستحق", type: "currency" },
      { key: "1-30", labelEn: "1-30 days", labelAr: "1-30 يوم", type: "currency" },
      { key: "31-60", labelEn: "31-60 days", labelAr: "31-60 يوم", type: "currency" },
      { key: "61-90", labelEn: "61-90 days", labelAr: "61-90 يوم", type: "currency" },
      { key: "90+", labelEn: "90+ days", labelAr: "أكثر من 90 يوم", type: "currency" },
      { key: "total", labelEn: "Total", labelAr: "الإجمالي", type: "currency" },
    ],
    rows,
    totals: {
      current: sum("current"),
      "1-30": sum("1-30"),
      "31-60": sum("31-60"),
      "61-90": sum("61-90"),
      "90+": sum("90+"),
      total: sum("total"),
    },
    periodFrom: null,
    periodTo: asOfDate,
  };
}

// --- Expense breakdowns -------------------------------------------------------

function buildExpenseBreakdown(
  kind: PurchasingReportKind,
  groupLabelEn: string,
  groupLabelAr: string,
  bills: Record<string, unknown>[],
  expenses: Record<string, unknown>[],
  keyOf: (row: Record<string, unknown>) => string,
  labelOf: (row: Record<string, unknown>) => string,
): PurchasingReport {
  const buckets = new Map<string, { label: string; taxable: number; vat: number; total: number; count: number }>();
  const add = (key: string, label: string, taxable: number, vat: number, total: number) => {
    const b = buckets.get(key) ?? { label, taxable: 0, vat: 0, total: 0, count: 0 };
    b.taxable = round3(b.taxable + taxable);
    b.vat = round3(b.vat + vat);
    b.total = round3(b.total + total);
    b.count += 1;
    buckets.set(key, b);
  };

  for (const b of bills) {
    if (isCancelled(b)) continue;
    const key = keyOf(b) || "—";
    // Supplier bills are VAT-inclusive.
    add(key, labelOf(b) || key, billTaxableBase(b), round3(num(b.vat_amount ?? b.vat)), round3(num(b.total_amount ?? b.total)));
  }
  for (const e of expenses) {
    if (isCancelled(e)) continue;
    const key = keyOf(e) || "—";
    // Expenses are stored pre-VAT.
    add(key, labelOf(e) || key, round3(num(e.amount)), round3(num(e.vat_amount ?? e.vat)), round3(num(e.amount) + num(e.vat_amount ?? e.vat)));
  }

  const rows: ReportRow[] = [...buckets.entries()]
    .map(([key, b]) => ({ key, label: b.label, taxable: b.taxable, vat: b.vat, total: b.total, count: b.count }))
    .sort((a, b) => num(b.total) - num(a.total));

  return {
    kind,
    columns: [
      { key: "label", labelEn: groupLabelEn, labelAr: groupLabelAr, type: "text" },
      { key: "count", labelEn: "Documents", labelAr: "المستندات", type: "number" },
      { key: "taxable", labelEn: "Taxable", labelAr: "الخاضع للضريبة", type: "currency" },
      { key: "vat", labelEn: "VAT", labelAr: "الضريبة", type: "currency" },
      { key: "total", labelEn: "Total", labelAr: "الإجمالي", type: "currency" },
    ],
    rows,
    totals: {
      count: rows.reduce((s, r) => s + num(r.count), 0),
      taxable: round3(rows.reduce((s, r) => s + num(r.taxable), 0)),
      vat: round3(rows.reduce((s, r) => s + num(r.vat), 0)),
      total: round3(rows.reduce((s, r) => s + num(r.total), 0)),
    },
    periodFrom: null,
    periodTo: null,
  };
}

export function buildExpensesByVehicle(
  bills: Record<string, unknown>[],
  expenses: Record<string, unknown>[],
  cars: Record<string, unknown>[] = [],
): PurchasingReport {
  return buildExpenseBreakdown(
    "expenses_by_vehicle",
    "Vehicle",
    "المركبة",
    bills,
    expenses,
    (r) => str(r.car_id),
    (r) => vehicleName(r, cars),
  );
}

export function buildExpensesByBranch(
  bills: Record<string, unknown>[],
  expenses: Record<string, unknown>[],
): PurchasingReport {
  return buildExpenseBreakdown(
    "expenses_by_branch",
    "Branch",
    "الفرع",
    bills,
    expenses,
    (r) => str(r.branch),
    (r) => str(r.branch) || "—",
  );
}

export function buildExpensesByCategory(
  bills: Record<string, unknown>[],
  expenses: Record<string, unknown>[],
): PurchasingReport {
  return buildExpenseBreakdown(
    "expenses_by_category",
    "Category",
    "الفئة",
    bills,
    expenses,
    (r) => str(r.expense_category ?? r.category),
    (r) => str(r.expense_category ?? r.category) || "—",
  );
}

// --- Input VAT ----------------------------------------------------------------

/**
 * Input VAT by source, matching the screen and the return: the taxable base and
 * the VAT are shown separately for each source, never collapsed. Supplier bills
 * are VAT-inclusive, expenses are pre-VAT.
 */
export function buildVatPurchases(
  bills: Record<string, unknown>[],
  expenses: Record<string, unknown>[],
): PurchasingReport {
  const sources = [
    { key: "supplier_bills", labelEn: "Supplier bills", labelAr: "فواتير الموردين" },
    { key: "expenses", labelEn: "Expenses", labelAr: "المصروفات" },
  ];
  const rows: ReportRow[] = [];
  const billTaxable = round3(bills.filter((b) => !isCancelled(b)).reduce((s, b) => s + billTaxableBase(b), 0));
  const billVat = round3(bills.filter((b) => !isCancelled(b)).reduce((s, b) => s + num(b.vat_amount ?? b.vat), 0));
  rows.push({
    source: sources[0].labelEn,
    source_ar: sources[0].labelAr,
    taxable: billTaxable,
    vat: billVat,
    total: round3(billTaxable + billVat),
  });
  const expTaxable = round3(expenses.filter((e) => !isCancelled(e)).reduce((s, e) => s + num(e.amount), 0));
  const expVat = round3(expenses.filter((e) => !isCancelled(e)).reduce((s, e) => s + num(e.vat_amount ?? e.vat), 0));
  rows.push({
    source: sources[1].labelEn,
    source_ar: sources[1].labelAr,
    taxable: expTaxable,
    vat: expVat,
    total: round3(expTaxable + expVat),
  });
  return {
    kind: "vat_purchases",
    columns: [
      { key: "source", labelEn: "Source", labelAr: "المصدر", type: "text" },
      { key: "taxable", labelEn: "Taxable", labelAr: "الخاضع للضريبة", type: "currency" },
      { key: "vat", labelEn: "Input VAT", labelAr: "ضريبة المدخلات", type: "currency" },
      { key: "total", labelEn: "Total", labelAr: "الإجمالي", type: "currency" },
    ],
    rows,
    totals: {
      taxable: round3(rows.reduce((s, r) => s + num(r.taxable), 0)),
      vat: round3(rows.reduce((s, r) => s + num(r.vat), 0)),
      total: round3(rows.reduce((s, r) => s + num(r.total), 0)),
    },
    periodFrom: null,
    periodTo: null,
  };
}

// --- Monthly expenses ---------------------------------------------------------

export function buildMonthlyExpenses(
  bills: Record<string, unknown>[],
  expenses: Record<string, unknown>[],
): PurchasingReport {
  const buckets = new Map<string, { taxable: number; vat: number; total: number; count: number }>();
  const add = (date: unknown, taxable: number, vat: number, total: number) => {
    const key = monthKey(date);
    if (!key) return;
    const b = buckets.get(key) ?? { taxable: 0, vat: 0, total: 0, count: 0 };
    b.taxable = round3(b.taxable + taxable);
    b.vat = round3(b.vat + vat);
    b.total = round3(b.total + total);
    b.count += 1;
    buckets.set(key, b);
  };
  for (const b of bills) {
    if (isCancelled(b)) continue;
    add(b.bill_date ?? b.date, billTaxableBase(b), round3(num(b.vat_amount ?? b.vat)), round3(num(b.total_amount ?? b.total)));
  }
  for (const e of expenses) {
    if (isCancelled(e)) continue;
    const vat = round3(num(e.vat_amount ?? e.vat));
    add(e.expense_date ?? e.date ?? e.created_at, round3(num(e.amount)), vat, round3(num(e.amount) + vat));
  }
  const rows: ReportRow[] = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, b]) => ({ month, count: b.count, taxable: b.taxable, vat: b.vat, total: b.total }));
  return {
    kind: "monthly_expenses",
    columns: [
      { key: "month", labelEn: "Month", labelAr: "الشهر", type: "text" },
      { key: "count", labelEn: "Documents", labelAr: "المستندات", type: "number" },
      { key: "taxable", labelEn: "Taxable", labelAr: "الخاضع للضريبة", type: "currency" },
      { key: "vat", labelEn: "VAT", labelAr: "الضريبة", type: "currency" },
      { key: "total", labelEn: "Total", labelAr: "الإجمالي", type: "currency" },
    ],
    rows,
    totals: {
      count: rows.reduce((s, r) => s + num(r.count), 0),
      taxable: round3(rows.reduce((s, r) => s + num(r.taxable), 0)),
      vat: round3(rows.reduce((s, r) => s + num(r.vat), 0)),
      total: round3(rows.reduce((s, r) => s + num(r.total), 0)),
    },
    periodFrom: null,
    periodTo: null,
  };
}

// --- Vehicle profitability ----------------------------------------------------

/**
 * Revenue earned by each vehicle minus the cost allocated to it. Revenue comes
 * from rental/sale invoices that name a vehicle; cost comes from supplier bills
 * and expenses that name one. Only vehicles with either are listed, so the report
 * does not pad itself with empty rows.
 */
export function buildVehicleProfitability(
  invoices: Record<string, unknown>[],
  bills: Record<string, unknown>[],
  expenses: Record<string, unknown>[],
  cars: Record<string, unknown>[] = [],
): PurchasingReport {
  const buckets = new Map<string, { revenue: number; cost: number }>();
  const ensure = (id: string) => {
    const b = buckets.get(id) ?? { revenue: 0, cost: 0 };
    buckets.set(id, b);
    return b;
  };
  for (const i of invoices) {
    if (isCancelled(i)) continue;
    const id = str(i.car_id);
    if (!id) continue;
    const gross = num(i.total_amount ?? i.total ?? i.amount);
    const vat = num(i.vat_amount ?? i.vat);
    ensure(id).revenue = round3(ensure(id).revenue + (gross - vat));
  }
  for (const b of bills) {
    if (isCancelled(b)) continue;
    const id = str(b.car_id);
    if (!id) continue;
    ensure(id).cost = round3(ensure(id).cost + billTaxableBase(b));
  }
  for (const e of expenses) {
    if (isCancelled(e)) continue;
    const id = str(e.car_id);
    if (!id) continue;
    ensure(id).cost = round3(ensure(id).cost + num(e.amount));
  }

  const nameOf = (id: string) => {
    const c = cars.find((x) => str(x.id) === id);
    return c ? str(c.plate_number) || `${str(c.make)} ${str(c.model)}`.trim() || id : id;
  };

  const rows: ReportRow[] = [...buckets.entries()]
    .map(([id, b]) => ({
      car_id: id,
      vehicle: nameOf(id),
      revenue: b.revenue,
      cost: b.cost,
      profit: round3(b.revenue - b.cost),
      margin: b.revenue > 0 ? Math.round(((b.revenue - b.cost) / b.revenue) * 1000) / 10 : null,
    }))
    .sort((a, b) => num(b.profit) - num(a.profit));

  return {
    kind: "vehicle_profitability",
    columns: [
      { key: "vehicle", labelEn: "Vehicle", labelAr: "المركبة", type: "text" },
      { key: "revenue", labelEn: "Revenue (net)", labelAr: "الإيراد (صافي)", type: "currency" },
      { key: "cost", labelEn: "Cost", labelAr: "التكلفة", type: "currency" },
      { key: "profit", labelEn: "Profit", labelAr: "الربح", type: "currency" },
      { key: "margin", labelEn: "Margin %", labelAr: "الهامش %", type: "number" },
    ],
    rows,
    totals: {
      revenue: round3(rows.reduce((s, r) => s + num(r.revenue), 0)),
      cost: round3(rows.reduce((s, r) => s + num(r.cost), 0)),
      profit: round3(rows.reduce((s, r) => s + num(r.profit), 0)),
      vehicles: rows.length,
    },
    periodFrom: null,
    periodTo: null,
  };
}
