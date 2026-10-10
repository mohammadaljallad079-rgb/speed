import type { AppRole, PermissionMap } from "./permissions";

/**
 * The single source of truth for "who is calling and what may they do".
 * It is resolved server-side only, from the authenticated session, never from
 * request input.
 */
export type AuthContext = {
  /** Supabase auth user id (`auth.users.id`). */
  authUserId: string;
  email: string | null;
  fullName: string | null;
  role: AppRole;
  /**
   * Tenant (company) the user belongs to. `null` while the installation is
   * single-tenant, in which case data isolation falls back to "no tenant
   * scoping" exactly like the project behaves today.
   */
  tenantId: string | null;
  /** Customer record for `role === 'client'` portal users. */
  customerId: string | null;
  /**
   * Branches this user may operate on.
   * `null` means "every branch of the tenant" (multi-branch administrator),
   * an empty array means "no branch restriction configured".
   */
  branchIds: string[] | null;
  /** Active financial year, when the tenant has one configured. */
  financialYearId: string | null;
  permissions: PermissionMap;
  isAdmin: boolean;
};

export type FinancialYear = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
  status: string | null;
};

export type AuditAction =
  | "login"
  | "logout"
  | "create"
  | "update"
  | "delete"
  | "import"
  | "export"
  | "payment"
  | "invoice"
  | "purchase"
  | "sale"
  | "journal_entry"
  | "permission_change"
  | "settings_change";
