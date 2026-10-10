import { forbidden } from "./errors";
import {
  DEFAULT_ROLE_PERMISSIONS,
  isPermissionModule,
  type AppRole,
  type PermissionAction,
  type PermissionMap,
} from "./permissions";
import type { AuthContext, FinancialYear } from "./types";

/**
 * Pure authorization policy.
 *
 * Everything in this module is side-effect free and free of infrastructure
 * imports, so the decision rules can be unit tested directly and reused from
 * any runtime (route handler, server component, middleware).
 */

export function normaliseRole(value: unknown): AppRole {
  return value === "admin" || value === "staff" || value === "client" ? value : "staff";
}

export function mergePermissions(base: PermissionMap, overrides: PermissionMap): PermissionMap {
  const merged: PermissionMap = { ...base };
  for (const [module, grant] of Object.entries(overrides)) {
    if (!isPermissionModule(module) || !grant) continue;
    merged[module] = { ...grant };
  }
  return merged;
}

export type PermissionRow = {
  module: string | null;
  can_view: boolean | null;
  can_create: boolean | null;
  can_edit: boolean | null;
  can_delete: boolean | null;
};

export function permissionsFromRows(rows: PermissionRow[]): PermissionMap {
  const map: PermissionMap = {};
  for (const row of rows) {
    if (!row.module || !isPermissionModule(row.module)) continue;
    map[row.module] = {
      view: row.can_view === true,
      create: row.can_create === true,
      edit: row.can_edit === true,
      delete: row.can_delete === true,
    };
  }
  return map;
}

/** jsonb `users.permissions` overrides, keyed by module. */
export function permissionsFromJson(value: unknown): PermissionMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const overrides: PermissionMap = {};
  for (const [module, grant] of Object.entries(value as Record<string, unknown>)) {
    if (!isPermissionModule(module) || !grant || typeof grant !== "object") continue;
    const g = grant as Record<string, unknown>;
    overrides[module] = {
      view: g.view === true,
      create: g.create === true,
      edit: g.edit === true,
      delete: g.delete === true,
    };
  }
  return overrides;
}

/**
 * The single authorization decision used by every guarded route.
 * Administrators bypass the matrix; everyone else must have an explicit grant,
 * and modules outside the catalogue are always denied.
 */
export function can(context: AuthContext, module: string, action: PermissionAction): boolean {
  if (context.isAdmin) return true;
  if (!isPermissionModule(module)) return false;
  return context.permissions[module]?.[action] === true;
}

/** The tenant value that must be written on INSERT. */
export function tenantValueFor(context: AuthContext): string | null {
  return context.tenantId;
}

/** Applies a `tenant_id` filter to a query when the caller has a tenant. */
export function scopeToTenant<T>(query: T, context: AuthContext): T {
  if (!context.tenantId) return query;
  return (query as unknown as { eq: (column: string, value: string) => T }).eq(
    "tenant_id",
    context.tenantId,
  );
}

/**
 * Rejects a write that would place a row in a tenant other than the caller's.
 * `undefined`/`null` incoming values are replaced with the caller's tenant.
 */
export function assertWritableTenant(context: AuthContext, incoming: unknown): string | null {
  if (incoming === undefined || incoming === null || incoming === "") return context.tenantId;
  if (context.tenantId && incoming !== context.tenantId) {
    throw forbidden("Cannot write data for another tenant");
  }
  return context.tenantId;
}

/**
 * Branch scoping.
 *
 * `branchIds === null` means the user may use every branch of the tenant
 * (multi-branch administrator) — legitimate multi-branch access is preserved.
 */
export function canAccessBranch(context: AuthContext, branchId: string | null | undefined): boolean {
  if (!branchId) return true;
  if (context.branchIds === null) return true;
  return context.branchIds.includes(branchId);
}

export function assertBranchAccess(context: AuthContext, branchId: string | null | undefined): void {
  if (!canAccessBranch(context, branchId)) {
    throw forbidden("You do not have access to this branch");
  }
}

export function isDateInFinancialYear(date: string, year: FinancialYear): boolean {
  return date >= year.start_date && date <= year.end_date;
}

/**
 * Financial-year enforcement. When no financial year is configured for the
 * tenant validation is skipped, so installations that never used the feature
 * are unaffected.
 */
export function assertDateInOpenFinancialYear(
  year: FinancialYear | null,
  date: string | null | undefined,
  label = "date",
): void {
  if (!year || !date) return;
  if (year.status === "closed" || year.status === "locked") {
    throw forbidden(`Financial year ${year.name} is closed`);
  }
  if (!isDateInFinancialYear(date, year)) {
    throw forbidden(`The ${label} falls outside the active financial year (${year.name})`);
  }
}

const SENSITIVE_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|private/i;

/**
 * Strips anything that looks like a credential before it can be persisted.
 * Audit rows must never contain passwords, tokens or API keys.
 */
export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (value === undefined) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      clean[key] = value;
    } else if (Array.isArray(value)) {
      clean[key] = value.slice(0, 50).map((v) =>
        v === null || ["string", "number", "boolean"].includes(typeof v) ? v : "[object]",
      );
    } else if (typeof value === "object") {
      clean[key] = sanitizeMetadata(value as Record<string, unknown>);
    }
  }
  return clean;
}

export { DEFAULT_ROLE_PERMISSIONS };
