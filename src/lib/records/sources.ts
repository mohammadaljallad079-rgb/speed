/**
 * Record-field integration rules (pure, infrastructure-free).
 *
 * Every transaction form that references an existing record — a customer on a
 * sales invoice, a supplier on a purchase, a bank account on a transfer, a ledger
 * account on a journal line — must select that record from its OWN module and
 * must be able to create one inline without leaving the form. This module holds
 * the decision rules behind the reusable `<RecordSelect />`, so the mapping
 * between a field and the module that owns it is declared in exactly one place
 * and can be unit tested without a browser.
 *
 * The invariant this file protects: a customer is never selected from the
 * supplier list, a supplier is never selected from the customer list, every
 * record kind maps to a table that really exists in the live schema, and an
 * inline creation always writes to the module that owns the record.
 */

/** The record types a transaction form may reference. */
export type RecordKind = "customer" | "supplier" | "account" | "car" | "employee";

export type RecordSource = {
  kind: RecordKind;
  /** The table the record actually lives in (its owning module). */
  table: string;
  /** Columns the searchable list shows. */
  listColumns: string;
  /**
   * Optional wider column list for a source whose postability metadata is added
   * by a later migration. Attempted first; `listColumns` is the fallback when the
   * schema is older, because naming an absent column fails the whole SELECT.
   */
  listColumnsWithPostable?: string;
  /** Column used as the option label. */
  labelColumn: string;
  /** Route of the module's canonical create page (for reference / fallback). */
  createRoute: string;
  ar: string;
  en: string;
  /**
   * Optional richer label for a kind whose identity is more than one column.
   * A vehicle is recognised as "Toyota Corolla (12345)", not by its plate
   * alone; without this the picker shows a bare number and the user cannot
   * tell two cars apart. Falls back to `labelColumn` when it returns empty.
   */
  describe?: (row: Record<string, unknown>) => string;
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
  /**
   * There is deliberately no `bank` source. SPEED ERP has no `banks` table
   * (verified against the live schema and the migration harness table list); a
   * bank is a ledger account, so a bank field selects from the chart of accounts
   * (`kind: "account"`) filtered to the bank accounts. A `banks` relation would
   * fail the whole PostgREST request and silently empty the dropdown.
   */
  account: {
    kind: "account",
    table: "accounts",
    listColumns: "id, code, name_ar, name_en, type, is_active",
    // `is_postable` is added by migration 014. Naming a column the live schema
    // does not yet have fails the whole PostgREST SELECT, which empties the
    // dropdown; so the wider list is attempted first and the narrower one is the
    // fallback (see `load` in RecordSelect).
    listColumnsWithPostable: "id, code, name_ar, name_en, type, is_active, is_postable",
    labelColumn: "name_ar",
    createRoute: "/accounting/chart-of-accounts",
    ar: "الحساب المحاسبي",
    en: "Account",
  },
  employee: {
    kind: "employee",
    table: "employees",
    listColumns: "id, full_name, job_title, position, phone, status",
    labelColumn: "full_name",
    createRoute: "/hr/employees",
    ar: "الموظف",
    en: "Employee",
    describe: (row) => {
      const name = typeof row.full_name === "string" ? row.full_name.trim() : "";
      const job = (typeof row.job_title === "string" && row.job_title.trim()) || (typeof row.position === "string" && row.position.trim()) || "";
      if (name && job) return `${name} — ${job}`;
      return name || job;
    },
  },
  car: {
    kind: "car",
    table: "cars",
    listColumns: "id, make, model, plate_number, status",
    labelColumn: "plate_number",
    createRoute: "/cars/new",
    ar: "المركبة",
    en: "Vehicle",
    describe: (row) => {
      const name = [row.make, row.model].filter((v): v is string => typeof v === "string" && v.trim() !== "").join(" ").trim();
      const plate = typeof row.plate_number === "string" ? row.plate_number.trim() : "";
      if (name && plate) return `${name} (${plate})`;
      return name || plate;
    },
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

/**
 * A code that is only a GROUP HEADING can never receive a journal line, so it
 * must not be offered as a postable account. The rule mirrors
 * `isPostable` in `@/lib/accounting/chart` (headings end in `00`), but it is
 * re-stated here as a plain predicate so this module stays import-free and
 * client-safe.
 *
 * The two exceptions are the codes the posting services actually name, which
 * happen to end in `00` on the live chart: `24000` (output VAT) and `25000`
 * (customer deposits). Filtering them out would leave a form unable to pick the
 * VAT account a sale posts to.
 */
const POSTABLE_EXCEPTIONS: readonly string[] = ["24000", "25000"];

export function isPostableCode(code: unknown): boolean {
  const c = String(code ?? "").trim();
  if (!/^\d{5}$/.test(c)) return false;
  if (POSTABLE_EXCEPTIONS.includes(c)) return true;
  return !c.endsWith("00");
}

/**
 * The filter every account picker should use: active AND postable. Passing this
 * as `filter` on a `<RecordSelect kind="account" />` keeps group headings such as
 * `11000 Cash and Bank` out of a field that feeds a journal line — an invalid
 * account id that only fails when the user presses Save.
 */
export function isSelectablePostableAccount(
  account: { is_active?: boolean | null; code?: unknown; is_postable?: boolean | null },
): boolean {
  if (!isSelectableAccount(account)) return false;
  // Prefer the stored flag when migration 014 has been applied: it is the
  // authoritative value for a company that re-shaped its own chart, and it
  // carries a deliberate exception for the codes the posting path names.
  if (typeof account.is_postable === "boolean") return account.is_postable;
  return isPostableCode(account.code);
}

/** The label to show for a record row, falling back across the known columns. */
export function recordLabel(source: RecordSource, row: Record<string, unknown>): string {
  const described = source.describe?.(row);
  if (described) return described;
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
