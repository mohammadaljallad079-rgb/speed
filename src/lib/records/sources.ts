/**
 * Record-field integration rules (pure, infrastructure-free).
 *
 * Every transaction form that references an existing record — a customer on a
 * sales invoice, a supplier on a purchase, a bank on a payment, an account on a
 * journal line — must select that record from its OWN module and must be able to
 * create one inline without leaving the form. This module holds the decision
 * rules behind the reusable `<RecordSelect />`, so the mapping between a field
 * and the module that owns it is declared in exactly one place and can be unit
 * tested without a browser.
 *
 * The invariant this file protects: a customer is never selected from the
 * supplier list, a bank is never selected from the chart of accounts, and an
 * inline creation always writes to the module that owns the record.
 */

/** The record types a transaction form may reference. */
export type RecordKind = "customer" | "supplier" | "bank" | "account" | "car";

export type RecordSource = {
  kind: RecordKind;
  /** The table the record actually lives in (its owning module). */
  table: string;
  /** Columns the searchable list shows. */
  listColumns: string;
  /** Column used as the option label. */
  labelColumn: string;
  /** Route of the module's canonical create page (for reference / fallback). */
  createRoute: string;
  ar: string;
  en: string;
};

/**
 * The canonical mapping. Each record kind maps to exactly one table, so a field
 * can never pull its options from the wrong module.
 *
 * `account` deliberately exposes a `listColumns` subset: the chart of accounts is
 * the only source of accounting accounts, and posting validity is still enforced
 * server-side by the accounting core (never by this list).
 */
export const RECORD_SOURCES: Record<RecordKind, RecordSource> = {
  customer: {
    kind: "customer",
    table: "customers",
    listColumns: "id, full_name, phone, customer_type, status",
    labelColumn: "full_name",
    createRoute: "/customers/new",
    ar: "العميل",
    en: "Customer",
  },
  supplier: {
    kind: "supplier",
    table: "suppliers",
    listColumns: "id, name, phone, email",
    labelColumn: "name",
    createRoute: "/suppliers",
    ar: "المورد",
    en: "Supplier",
  },
  bank: {
    kind: "bank",
    table: "banks",
    listColumns: "id, name, account_number",
    labelColumn: "name",
    createRoute: "/accounting/bank-transfer",
    ar: "البنك",
    en: "Bank",
  },
  account: {
    kind: "account",
    table: "accounts",
    listColumns: "id, code, name_ar, name_en, type, is_active",
    labelColumn: "name_ar",
    createRoute: "/accounting/chart-of-accounts",
    ar: "الحساب المحاسبي",
    en: "Account",
  },
  car: {
    kind: "car",
    table: "cars",
    listColumns: "id, make, model, plate_number, status",
    labelColumn: "plate_number",
    createRoute: "/cars/new",
    ar: "المركبة",
    en: "Vehicle",
  },
};

/**
 * Account types that may be posted to. Kept in sync with the accounting core's
 * usable-account rule: an inactive account is never selectable, and the list is
 * filtered to real ledger accounts.
 */
export function isSelectableAccount(account: { is_active?: boolean | null }): boolean {
  return account.is_active !== false;
}

/** The label to show for a record row, falling back across the known columns. */
export function recordLabel(source: RecordSource, row: Record<string, unknown>): string {
  const primary = row[source.labelColumn];
  if (typeof primary === "string" && primary.trim()) return primary;
  for (const key of ["name", "full_name", "name_ar", "name_en", "plate_number"]) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return String(row.id ?? "");
}

/** A secondary line shown under the label (phone / code / account number). */
export function recordSublabel(row: Record<string, unknown>): string | null {
  for (const key of ["phone", "code", "account_number", "email"]) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** Case-insensitive match used by the searchable dropdown. */
export function recordMatches(source: RecordSource, row: Record<string, unknown>, term: string): boolean {
  const q = term.trim().toLowerCase();
  if (!q) return true;
  return [row[source.labelColumn], row.name, row.full_name, row.name_ar, row.name_en, row.code, row.phone, row.plate_number]
    .filter((v): v is string => typeof v === "string")
    .some((v) => v.toLowerCase().includes(q));
}
