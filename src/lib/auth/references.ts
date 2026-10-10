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
 */
export async function assertReference(
  spec: ReferenceSpec,
  value: unknown,
  context: AuthContext,
): Promise<void> {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") throw invalidReference(spec.field);

  const { data } = await supabaseAdmin
    .from(spec.table)
    .select("id, tenant_id")
    .eq("id", value)
    .maybeSingle();

  if (!data) throw invalidReference(spec.field);

  const tenantId = (data as { tenant_id?: string | null }).tenant_id ?? null;
  if (context.tenantId && tenantId && tenantId !== context.tenantId) {
    throw invalidReference(spec.field);
  }
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

  const { data } = await supabaseAdmin.from(spec.table).select("id, tenant_id").in("id", unique);
  const rows = (data ?? []) as { id: string; tenant_id?: string | null }[];

  if (rows.length !== unique.length) throw invalidReference(spec.field);
  for (const row of rows) {
    if (context.tenantId && row.tenant_id && row.tenant_id !== context.tenantId) {
      throw invalidReference(spec.field);
    }
  }
}
