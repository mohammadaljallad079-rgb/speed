import { scopeToTenantColumn } from "@/lib/auth/policy";
import { isPlanId, PLANS, type PlanId } from "./entitlements";

/**
 * Reads and writes a tenant's subscription package.
 *
 * The package is a single row in the existing `settings` key/value store, scoped
 * by `tenant_id` — no new table, and the same conflict target the rest of the
 * settings layer uses. Reading fails closed to the free plan: an unreadable or
 * absent row must never grant a paid capability.
 */

export const TENANT_PLAN_KEY = "tenant_plan";

interface PlanQuery extends PromiseLike<{ data: { value?: unknown } | null; error: unknown }> {
  eq(column: string, value: string): PlanQuery;
  maybeSingle(): Promise<{ data: { value?: unknown } | null; error: unknown }>;
}

export interface TenantPlanDb {
  from(table: string): {
    select(columns: string): PlanQuery;
    upsert(row: Record<string, unknown>, options?: { onConflict?: string }): Promise<{ error: unknown }>;
  };
}

/** The plan id stored for a tenant, or `free` when absent/unreadable. */
export async function loadTenantPlan(db: TenantPlanDb, tenantId: string | null): Promise<PlanId> {
  try {
    const query = scopeToTenantColumn(db.from("settings").select("value").eq("key", TENANT_PLAN_KEY), tenantId);
    const { data, error } = await query.maybeSingle();
    if (error || !data?.value) return "free";
    const raw = data.value as { plan?: unknown } | string;
    const plan = typeof raw === "string" ? raw : raw?.plan;
    return isPlanId(plan) ? plan : "free";
  } catch {
    return "free";
  }
}

/** Persists a tenant's package. Only a known plan id is accepted. */
export async function saveTenantPlan(
  db: TenantPlanDb,
  tenantId: string | null,
  plan: PlanId,
): Promise<{ ok: boolean; error?: string }> {
  if (!isPlanId(plan)) return { ok: false, error: "unknown_plan" };
  const row: Record<string, unknown> = {
    key: TENANT_PLAN_KEY,
    value: { plan, name: PLANS[plan].nameEn, assignedAt: new Date().toISOString() },
  };
  if (tenantId) row.tenant_id = tenantId;
  const { error } = await db.from("settings").upsert(row, { onConflict: "tenant_id,key" });
  if (error) return { ok: false, error: String((error as { message?: string }).message ?? error) };
  return { ok: true };
}
