/**
 * Tenant-scoped reads/writes of the `settings` key/value store, for the browser.
 *
 * `settings` is tenant-owned. A read or write that omits the tenant is not
 * "single-tenant behaviour" — it is a cross-tenant leak: the query returns (or
 * overwrites) whichever tenant's row the database happens to return first. The
 * `company_profile` defect on the public homepage was exactly this shape.
 *
 * The tenant must come from the authenticated session (`/api/me`), never from a
 * form field, a cookie or localStorage.
 *
 * A tenant-less caller (`null`) is the single-tenant install and is scoped with
 * `is("tenant_id", null)`. Upserts are done as an explicit find-then-write
 * because `onConflict: "tenant_id,key"` cannot be relied on for a NULL tenant:
 * PostgreSQL treats NULLs as distinct in a unique index, so an upsert there would
 * keep inserting new rows instead of replacing one.
 */

export interface ScopedSettingsClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        eq(column: string, value: string): Promise<{ data: Array<{ id: string; value: unknown }> | null; error: unknown }>;
        is(column: string, value: null): Promise<{ data: Array<{ id: string; value: unknown }> | null; error: unknown }>;
      };
    };
    insert(row: Record<string, unknown>): Promise<{ error: unknown }>;
    update(row: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: unknown }>;
    };
  };
}

function scope(query: unknown, tenantId: string | null, key: string) {
  const q = query as {
    eq(column: string, value: string): unknown;
    is(column: string, value: null): unknown;
  };
  const byKey = q.eq("key", key);
  return tenantId
    ? (byKey as { eq(column: string, value: string): unknown }).eq("tenant_id", tenantId)
    : (byKey as { is(column: string, value: null): unknown }).is("tenant_id", null);
}

/** Reads one setting for a tenant. Returns `null` when absent or unreadable. */
export async function readScopedSetting(
  client: ScopedSettingsClient,
  tenantId: string | null,
  key: string,
): Promise<unknown> {
  try {
    const base = client.from("settings").select("id,value").eq("key", key);
    const query = scope(base, tenantId, key) as PromiseLike<{ data: Array<{ id: string; value: unknown }> | null; error: unknown }>;
    const { data, error } = await query;
    if (error) return null;
    return (data ?? [])[0]?.value ?? null;
  } catch {
    return null;
  }
}

/** Writes one setting for a tenant, replacing the tenant's existing row. */
export async function writeScopedSetting(
  client: ScopedSettingsClient,
  tenantId: string | null,
  key: string,
  value: unknown,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const base = client.from("settings").select("id,value").eq("key", key);
    const query = scope(base, tenantId, key) as PromiseLike<{ data: Array<{ id: string }> | null; error: unknown }>;
    const { data } = await query;
    const existingId = (data ?? [])[0]?.id;

    if (existingId) {
      const { error } = await client
        .from("settings")
        .update({ value, updated_at: new Date().toISOString() })
        .eq("id", existingId);
      if (error) return { ok: false, error: String((error as { message?: string })?.message ?? error) };
      return { ok: true };
    }

    const row: Record<string, unknown> = { key, value, updated_at: new Date().toISOString() };
    if (tenantId) row.tenant_id = tenantId;
    const { error } = await client.from("settings").insert(row);
    if (error) return { ok: false, error: String((error as { message?: string })?.message ?? error) };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
