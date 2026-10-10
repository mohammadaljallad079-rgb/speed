import { supabaseAdmin } from "../supabase-admin";
import { invalidReference } from "./errors";
import type { AuthContext } from "./types";

/**
 * Foreign-key reference validation.
 *
 * Business tables store plain uuid columns without composite (id, tenant_id)
 * constraints, so a caller could otherwise submit `customer_id` pointing at a
 * row owned by another tenant and have it accepted. These helpers verify that
 * every referenced row exists *and* belongs to the caller's tenant before the
 * write is performed.
 */

export type ReferenceSpec = {
  /** Request body field, e.g. `customer_id`. */
  field: string;
  /** Table the field points at. */
  table: string;
};

/** Reference columns shared by most transactional documents. */
export const REF_CUSTOMER: ReferenceSpec = { field: "customer_id", table: "customers" };
export const REF_SUPPLIER: ReferenceSpec = { field: "supplier_id", table: "suppliers" };
export const REF_CAR: ReferenceSpec = { field: "car_id", table: "cars" };
export const REF_BRANCH: ReferenceSpec = { field: "branch_id", table: "branches" };
export const REF_FINANCIAL_YEAR: ReferenceSpec = { field: "financial_year_id", table: "financial_years" };
export const REF_EMPLOYEE: ReferenceSpec = { field: "employee_id", table: "employees" };
export const REF_ACCOUNT: ReferenceSpec = { field: "account_id", table: "accounts" };
export const REF_EXPENSE_ACCOUNT: ReferenceSpec = { field: "expense_account_id", table: "expense_accounts" };
export const REF_INVOICE: ReferenceSpec = { field: "invoice_id", table: "invoices" };
export const REF_RENTAL_CONTRACT: ReferenceSpec = { field: "rental_contract_id", table: "rental_contracts" };

/**
 * Verifies a single reference. Missing/empty values are ignored (the column is
 * optional). A value that does not resolve, or resolves into another tenant,
 * throws a 422 so the server — not the client — rejects the request.
 *
 * The tenant scope is applied *in the query*, never as a post-fetch comparison:
 * a caller with a tenant may only resolve rows in its own tenant (or a shared,
 * tenant-less reference row such as the global chart of accounts); a tenant-less
 * caller may only resolve tenant-less rows. This mirrors the RLS predicate and
 * cannot be widened by a crafted id.
 */
export async function assertReference(
  spec: ReferenceSpec,
  value: unknown,
  context: AuthContext,
): Promise<void> {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") throw invalidReference(spec.field);

  const reader = () => supabaseAdmin.from(spec.table).select("id, tenant_id").eq("id", value);

  if (context.tenantId) {
    const { data: own } = await reader().eq("tenant_id", context.tenantId).maybeSingle();
    if (own) return;
  }

  // Shared reference data (tenant_id is null) is usable by any authenticated
  // caller; a tenant-less caller can therefore only ever resolve these rows.
  const { data: shared } = await reader().is("tenant_id", null).maybeSingle();
  if (!shared) throw invalidReference(spec.field);
}

/** Verifies every reference declared for a payload. */
export async function assertReferences(
  specs: ReferenceSpec[],
  payload: Record<string, unknown>,
  context: AuthContext,
): Promise<void> {
  for (const spec of specs) {
    await assertReference(spec, payload[spec.field], context);
  }
}

/**
 * Batch variant used for header/line documents (journal lines, invoice items).
 */
export async function assertReferenceList(
  spec: ReferenceSpec,
  values: unknown[],
  context: AuthContext,
): Promise<void> {
  const unique = [...new Set(values.filter((v): v is string => typeof v === "string" && v !== ""))];
  if (unique.length === 0) return;

  const found = new Set<string>();
  if (context.tenantId) {
    const { data: own } = await supabaseAdmin
      .from(spec.table)
      .select("id, tenant_id")
      .in("id", unique)
      .eq("tenant_id", context.tenantId);
    for (const row of (own ?? []) as { id: string }[]) found.add(row.id);
  }

  const { data: shared } = await supabaseAdmin
    .from(spec.table)
    .select("id, tenant_id")
    .in("id", unique)
    .is("tenant_id", null);
  for (const row of (shared ?? []) as { id: string }[]) found.add(row.id);

  // Every id must resolve to a row the caller may use (own tenant or shared).
  if (found.size !== unique.length) throw invalidReference(spec.field);
}
