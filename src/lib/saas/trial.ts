/**
 * Free-trial policy (pure).
 *
 * "Start Free" is a SEVEN-DAY trial of the free plan, not an open-ended account.
 * Everything that decides whether a trial is still running is here, so the rule
 * is unit-testable and identical on the server and in the UI.
 *
 * Two deliberate choices:
 *
 *   1. The trial length is a named constant (`TRIAL_DAYS`), never a literal
 *      scattered through the signup route and the settings screen.
 *   2. Expiry is computed from the STORED `trial_ends_at`, never from
 *      "now minus created_at". Recomputing from `created_at` would let a trial
 *      be extended by editing an unrelated field, and it makes the answer depend
 *      on when the query runs rather than on what was granted.
 *
 * A tenant with no trial record is NOT on a trial: `trialState` returns
 * `status: "none"`, which is the fail-closed answer for the paid-capability
 * checks that consume it. The `free` plan's own capabilities still apply, so an
 * account created before trials existed keeps working with what free grants.
 */

/** Length of a new account's trial, in days. */
export const TRIAL_DAYS = 7;

/** The settings key a tenant's trial is stored under (same store as the plan). */
export const TENANT_TRIAL_KEY = "tenant_trial";

export type TrialStatus = "active" | "expired" | "none";

export interface TrialRecord {
  /** ISO timestamp the trial started. */
  startedAt: string;
  /** ISO timestamp the trial ends (exclusive). */
  endsAt: string;
}

export interface TrialState {
  status: TrialStatus;
  /** Whole days left, floored at 0. `null` when there is no trial. */
  daysLeft: number | null;
  /** The stored end timestamp, when there is one. */
  endsAt: string | null;
}

/**
 * The trial window for a signup at `now`.
 *
 * `startedAt` and `endsAt` are both stored so the grant is auditable and an
 * operator can see exactly what was promised, rather than inferring it.
 */
export function trialWindow(now: Date = new Date()): TrialRecord {
  const start = new Date(now.getTime());
  const end = new Date(now.getTime() + TRIAL_DAYS * 86_400_000);
  return { startedAt: start.toISOString(), endsAt: end.toISOString() };
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Coerces a stored settings value into a trial record, or null if malformed. */
export function readTrial(value: unknown): TrialRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const startedAt = parseDate(raw.startedAt ?? raw.started_at);
  const endsAt = parseDate(raw.endsAt ?? raw.ends_at);
  if (!startedAt || !endsAt) return null;
  return { startedAt: startedAt.toISOString(), endsAt: endsAt.toISOString() };
}

/**
 * Whether a trial is still running at `now`.
 *
 * The boundary is EXCLUSIVE: at exactly `endsAt` the trial has ended. A clock
 * that runs slightly behind the server therefore cannot buy an extra request.
 */
export function trialState(record: TrialRecord | null, now: Date = new Date()): TrialState {
  if (!record) return { status: "none", daysLeft: null, endsAt: null };
  const end = parseDate(record.endsAt);
  if (!end) return { status: "none", daysLeft: null, endsAt: null };
  const msLeft = end.getTime() - now.getTime();
  if (msLeft <= 0) return { status: "expired", daysLeft: 0, endsAt: record.endsAt };
  return { status: "active", daysLeft: Math.floor(msLeft / 86_400_000), endsAt: record.endsAt };
}

export function isTrialActive(record: TrialRecord | null, now: Date = new Date()): boolean {
  return trialState(record, now).status === "active";
}

/**
 * Whether a trial-gated capability may be used.
 *
 * A capability that the free plan itself grants (exports) is NOT gated by the
 * trial: locking a customer out of their own data at day 8 would be a data
 * hostage, not an upsell. Only capabilities ABOVE the free plan are gated, and
 * only while the trial runs. `none`/`expired` therefore deny them.
 */
export function trialAllowsPaidCapability(
  record: TrialRecord | null,
  freeGrants: boolean,
  now: Date = new Date(),
): boolean {
  if (freeGrants) return true;
  return isTrialActive(record, now);
}
