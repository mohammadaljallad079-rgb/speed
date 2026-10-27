import { forbidden } from "../auth/errors";
import type { AuthContext } from "../auth/types";

/**
 * Pure rules for the global Super Admin console.
 *
 * The console is the only place that reads across every company, so its
 * authorization decision is kept here — infrastructure-free and unit testable —
 * rather than being re-derived in each route. `super_admin` is the *only* role
 * allowed in; a company `admin` is rejected, and a `client` never resolves to an
 * administrator in the first place.
 */

export function assertSuperAdmin(context: AuthContext): void {
  if (!context.isSuperAdmin) throw forbidden("Global administrator access required");
}

/**
 * A company's lifecycle state.
 *
 * `tenants` has no lifecycle column in the live schema, so the state is derived
 * from data that actually exists: a company with no user row is suspended (the
 * operator's lever for pausing a tenant without deleting anything), a company
 * with only inactive users is dormant, otherwise it is active.
 */
export type TenantStatus = "active" | "suspended" | "dormant";

export function tenantStatus(input: {
  userCount: number;
  activeUserCount: number;
}): TenantStatus {
  if (input.userCount === 0) return "suspended";
  if (input.activeUserCount === 0) return "dormant";
  return "active";
}

/** True when a tenant name/email/id matches a free-text search term. */
export function matchesSearch(term: string, ...fields: Array<string | null | undefined>): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

/**
 * Plans are a presentation label, not a billing system.
 *
 * SPEED ERP has no subscription/billing tables, so a company's plan is reported
 * honestly as "free" and nothing here pretends a paid tier exists. When a real
 * subscription table is added, this is the single place to read it.
 */
export const PLAN_LABEL = "free";

/** Roles the global operator may assign to a tenant user through the console. */
export const ASSIGNABLE_ROLES = ["admin", "staff", "client"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

/**
 * A global operator may never use the console to grant or revoke the
 * `super_admin` role — that is a deliberate operator/provisioning action, and
 * migration 004 enforces it in the database too. The console only manages
 * company-scoped roles.
 */
export function assertRoleChangeAllowed(nextRole: unknown): asserts nextRole is AssignableRole {
  if (nextRole === "super_admin") {
    throw forbidden("The super_admin role is not managed from this console");
  }
  if (!isAssignableRole(nextRole)) {
    throw forbidden("Unsupported role for this console");
  }
}

/**
 * The console may not change the role of a global operator.
 *
 * `assertRoleChangeAllowed` inspects only the *requested* role, so on its own it
 * stops a super_admin being *granted* but not one being *demoted* to a
 * company-scoped role - which is the same privilege change in the other
 * direction. The current role therefore has to be checked as well, and the global
 * role is only ever set by provisioning (`scripts/provision-admin-accounts.mjs`).
 */
export function assertRoleTargetEditable(currentRole: unknown): void {
  if (currentRole === "super_admin") {
    throw forbidden("The super_admin role is not managed from this console");
  }
}
