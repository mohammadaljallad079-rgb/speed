/**
 * Client-safe financial-report scoping (pure, infrastructure-free).
 *
 * The financial report pages are client components that query Supabase
 * directly. They must scope their journal reads to the caller's tenant and must
 * never trust a tenant id from a request body or a URL parameter. This module
 * holds only the decision rules, so they can be unit tested without a browser or
 * a database, and reused by both the client hook and the server scope route.
 *
 * No imports on purpose: this file must stay loadable from a client component
 * (importing the `@/lib/auth` barrel pulls `server-only`).
 */

export type ReportScopeKind = "all" | "tenant" | "null" | "denied";

export type ReportScopeDeniedReason =
  | "unauthenticated"
  | "unprovisioned"
  | "forbidden_role";

export type ReportScope =
  | { kind: "all" }
  | { kind: "tenant"; tenantId: string }
  | { kind: "null" }
  | { kind: "denied"; reason: ReportScopeDeniedReason };

/** The subset of `/api/me` this decision needs. */
export type ReportScopeIdentity = {
  role?: string | null;
  tenantId?: string | null;
  isSuperAdmin?: boolean;
} | null;

/**
 * Resolve the caller's report scope from the SERVER-resolved identity.
 *
 * - `super_admin`   -> `all`     (the only cross-tenant reader; never scoped)
 * - `admin`/`staff` with a tenant -> `tenant` (scoped to that tenant)
 * - `admin`/`staff` without a tenant -> `null` (single-tenant install:
 *   `tenant_id IS NULL`, never every tenant's rows)
 * - any other role (e.g. `client`) -> `denied` (reports are back-office only)
 * - no identity (no session / not provisioned) -> `denied`
 *
 * A missing identity is denied, never treated as "single tenant", so an
 * unauthenticated or unlinked caller cannot read financial data.
 */
export function resolveReportScope(identity: ReportScopeIdentity): ReportScope {
  if (!identity) return { kind: "denied", reason: "unauthenticated" };
  if (identity.isSuperAdmin === true) return { kind: "all" };
  if (identity.role !== "admin" && identity.role !== "staff") {
    return { kind: "denied", reason: "forbidden_role" };
  }
  const tenantId =
    typeof identity.tenantId === "string" && identity.tenantId.length > 0
      ? identity.tenantId
      : null;
  return tenantId ? { kind: "tenant", tenantId } : { kind: "null" };
}

/** True when the scope permits reading financial data at all. */
export function isReportScopeAllowed(
  scope: ReportScope,
): scope is Exclude<ReportScope, { kind: "denied" }> {
  return scope.kind !== "denied";
}

/** A valid UUID that no tenant owns; used to make a denied scope return no rows. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Apply a report scope to a Supabase query builder over a tenant-owned table.
 *
 * `all` is left unfiltered (super admin only). A `denied` scope must never reach
 * the database — but if a bug ever does route it here, it is filtered to a
 * non-existent tenant rather than left unfiltered, so it fails closed.
 */
export function applyReportScope<T>(query: T, scope: ReportScope): T {
  const q = query as unknown as {
    eq: (column: string, value: string) => T;
    is: (column: string, value: null) => T;
  };
  switch (scope.kind) {
    case "all":
      return query;
    case "tenant":
      return q.eq("tenant_id", scope.tenantId);
    case "null":
      return q.is("tenant_id", null);
    case "denied":
      return q.eq("tenant_id", NIL_UUID);
  }
}
