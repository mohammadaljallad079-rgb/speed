import { capabilitiesFor, type PlanCapabilities, type PlanId } from "./entitlements";
import { loadTenantPlan } from "./tenant-plan";
import { loadTrialState } from "./trial-store";
import type { TenantTrialDb } from "./trial-store";
import type { TenantPlanDb } from "./tenant-plan";
import type { TrialState } from "./trial";

/**
 * The ONE place the server decides what a tenant may actually do right now.
 *
 * Before this, a route asked `loadTenantPlan` and stopped there. That answers
 * "what package did we assign?" but not "is it still in force?", so a seven-day
 * trial had nowhere to expire. Every capability decision must go through
 * `resolveEntitlements` so the plan and the trial cannot disagree.
 *
 * The composition rule, in order:
 *
 *   1. A global super admin is never gated (it operates the platform).
 *   2. An ACTIVE trial grants the trial package's capabilities.
 *   3. Otherwise the tenant's assigned package applies.
 *
 * Expiry is therefore a server decision made on every request from the stored
 * `trial_ends_at` — there is no cached "trialing" flag a client could hold on
 * to, and nothing in the request influences it.
 */

/** The package a trial grants while it runs. */
export const TRIAL_PLAN: PlanId = "standard";

export interface EffectiveEntitlements {
  /** The package assigned to the tenant (not what is currently in force). */
  plan: PlanId;
  /** The trial's state: active / expired / none. */
  trial: TrialState;
  /** The capabilities in force right now. */
  capabilities: PlanCapabilities;
  /** True when the trial (not the assigned package) is what grants them. */
  onTrial: boolean;
}

export interface EntitlementDb extends TenantPlanDb, TenantTrialDb {}

/**
 * Resolves the capabilities in force for a caller.
 *
 * `tenantId` comes from the session, never the request. A tenant-less caller
 * gets the free package: it has no subscription of its own to be entitled by.
 */
export async function resolveEntitlements(
  db: EntitlementDb,
  tenantId: string | null,
  options: { isSuperAdmin?: boolean; now?: Date } = {},
): Promise<EffectiveEntitlements> {
  const now = options.now ?? new Date();

  if (options.isSuperAdmin) {
    return {
      plan: "enterprise",
      trial: { status: "none", daysLeft: null, endsAt: null },
      capabilities: capabilitiesFor("enterprise"),
      onTrial: false,
    };
  }

  const plan = await loadTenantPlan(db, tenantId);
  const trial = await loadTrialState(db, tenantId, now);

  if (trial.status === "active") {
    return { plan, trial, capabilities: capabilitiesFor(TRIAL_PLAN), onTrial: true };
  }

  return { plan, trial, capabilities: capabilitiesFor(plan), onTrial: false };
}

/** Whether a specific capability is in force. Fails closed on an unknown key. */
export function entitlementGrants(
  entitlements: EffectiveEntitlements,
  capability: keyof PlanCapabilities,
): boolean {
  return entitlements.capabilities[capability] === true;
}

/**
 * The package id currently in force, for callers that pass a plan id around
 * (`planAllowsEffect`). While a trial runs this is `TRIAL_PLAN`; otherwise the
 * assigned package. Never the assigned package while its trial has expired.
 */
export function effectivePlanId(entitlements: EffectiveEntitlements): PlanId {
  return entitlements.onTrial ? TRIAL_PLAN : entitlements.plan;
}
