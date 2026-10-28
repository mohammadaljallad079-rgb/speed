import { scopeToTenantColumn } from "@/lib/auth/policy";
import {
  TENANT_TRIAL_KEY,
  readTrial,
  trialState,
  trialWindow,
  type TrialRecord,
  type TrialState,
} from "./trial";

/**
 * Reads and writes a tenant's free trial.
 *
 * The trial is one row in the existing `settings` key/value store, scoped by
 * `tenant_id` — the same store, the same conflict target (`tenant_id,key`) and
 * the same fail-closed read shape as `tenant-plan.ts`. No new table.
 *
 * Reading fails closed to "no trial": an unreadable or malformed row must never
 * be reported as an active trial, because that is the direction that would grant
 * a paid capability for free.
 */

interface TrialQuery extends PromiseLike<{ data: { value?: unknown } | null; error: unknown }> {
  eq(column: string, value: string): TrialQuery;
  maybeSingle(): Promise<{ data: { value?: unknown } | null; error: unknown }>;
}

export interface TenantTrialDb {
  from(table: string): {
    select(columns: string): TrialQuery;
    upsert(row: Record<string, unknown>, options?: { onConflict?: string }): Promise<{ error: unknown }>;
  };
}

/** The stored trial record for a tenant, or null when there is none. */
export async function loadTenantTrial(
  db: TenantTrialDb,
  tenantId: string | null,
): Promise<TrialRecord | null> {
  try {
    const query = scopeToTenantColumn(
      db.from("settings").select("value").eq("key", TENANT_TRIAL_KEY),
      tenantId,
    );
    const { data, error } = await query.maybeSingle();
    if (error || !data) return null;
    return readTrial(data.value);
  } catch {
    return null;
  }
}

/** The trial's state at `now`, resolved from the stored record. */
export async function loadTrialState(
  db: TenantTrialDb,
  tenantId: string | null,
  now: Date = new Date(),
): Promise<TrialState> {
  return trialState(await loadTenantTrial(db, tenantId), now);
}

/**
 * Grants (or restarts) a tenant's trial.
 *
 * `restart` defaults to false so a re-run of provisioning cannot silently extend
 * a trial that already exists — the expiry is a promise to the customer, and
 * extending it must be a deliberate act. Pass `restart: true` only from an
 * explicit operator action.
 */
export async function grantTenantTrial(
  db: TenantTrialDb,
  tenantId: string | null,
  options: { now?: Date; restart?: boolean } = {},
): Promise<{ ok: boolean; record?: TrialRecord; error?: string }> {
  const now = options.now ?? new Date();

  if (!options.restart) {
    const existing = await loadTenantTrial(db, tenantId);
    if (existing) return { ok: true, record: existing };
  }

  const record = trialWindow(now);
  const row: Record<string, unknown> = {
    key: TENANT_TRIAL_KEY,
    value: record,
  };
  if (tenantId) row.tenant_id = tenantId;

  const { error } = await db.from("settings").upsert(row, { onConflict: "tenant_id,key" });
  if (error) {
    return { ok: false, error: String((error as { message?: string }).message ?? error) };
  }
  return { ok: true, record };
}
