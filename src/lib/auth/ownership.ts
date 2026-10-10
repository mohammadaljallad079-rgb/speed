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
  const reader = () => supabaseAdmin.from(table).select(select).eq("id", id);

  // The tenant scope is part of the lookup, so a row owned by another tenant is
  // never even loaded — a post-fetch comparison alone would let the row exist in
  // memory before being rejected.
  if (context.tenantId) {
    const { data: own } = await reader().eq("tenant_id", context.tenantId).maybeSingle();
    if (own) return own as unknown as Record<string, unknown>;
  }

  if (context.isSuperAdmin) {
    const { data: any } = await reader().maybeSingle();
    if (!any) throw notFound(`${table} not found`);
    return any as unknown as Record<string, unknown>;
  }

  // Tenant-less caller / shared row: only a tenant-less row is addressable.
  const { data: shared } = await reader().is("tenant_id", null).maybeSingle();
  if (shared) return shared as unknown as Record<string, unknown>;

  // Distinguish "exists but belongs to someone else" (403) from "missing" (404).
  const { data: existing } = await reader().maybeSingle();
  if (existing) throw forbidden(`${table} belongs to another tenant`);
  throw notFound(`${table} not found`);
}
