import { supabaseAdmin } from "../supabase-admin";
import { forbidden, notFound } from "./errors";
import type { AuthContext } from "./types";

/**
 * Loads a single row by id and verifies it belongs to the caller's tenant.
 *
 * Returns the row when the caller may act on it. Throws 404 when the row does
 * not exist and 403 when it exists in another tenant — the distinction is
 * intentional, because the caller already knows the id they asked for.
 */
export async function assertTenantOwnership(
  table: string,
  id: string,
  context: AuthContext,
  select = "id, tenant_id",
): Promise<Record<string, unknown>> {
  const { data } = await supabaseAdmin.from(table).select(select).eq("id", id).maybeSingle();
  if (!data) throw notFound(`${table} not found`);

  const row = data as unknown as Record<string, unknown>;
  if (context.tenantId && row.tenant_id && row.tenant_id !== context.tenantId) {
    throw forbidden(`${table} belongs to another tenant`);
  }
  return row;
}
