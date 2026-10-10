/**
 * Permission catalogue for the ERP core.
 *
 * Modules map 1:1 to the `permissions.module` column so that DB-configured
 * permissions (role_id + module + can_view/can_create/can_edit/can_delete)
 * override the built-in role matrix without any code change.
 */

export const PERMISSION_MODULES = [
  "customers",
  "suppliers",
  "cars",
  "rentals",
  "sales",
  "purchases",
  "invoices",
  "payments",
  "expenses",
  "accounting",
  "payroll",
  "hr",
  "users",
  "settings",
  "reports",
  "exports",
  "imports",
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export type PermissionAction = "view" | "create" | "edit" | "delete";

export type PermissionKey = `${PermissionModule}.${PermissionAction}`;

export type AppRole = "admin" | "staff" | "client";

export type PermissionGrant = Record<PermissionAction, boolean>;

export type PermissionMap = Partial<Record<PermissionModule, PermissionGrant>>;

const ALL: PermissionGrant = { view: true, create: true, edit: true, delete: true };
const READ_ONLY: PermissionGrant = { view: true, create: false, edit: false, delete: false };

/**
 * Built-in defaults. They intentionally reproduce the behaviour the project
 * already had (admin and staff can operate every module, client is confined to
 * the customer portal) so that enabling enforcement does not change existing
 * business behaviour for legitimate users.
 */
const ADMIN_MODULES: PermissionModule[] = [...PERMISSION_MODULES];
const STAFF_MODULES: PermissionModule[] = PERMISSION_MODULES.filter(
  (m) => m !== "users" && m !== "settings",
);

function grantsFor(modules: PermissionModule[], grant: PermissionGrant): PermissionMap {
  return Object.fromEntries(modules.map((m) => [m, { ...grant }])) as PermissionMap;
}

export const DEFAULT_ROLE_PERMISSIONS: Record<AppRole, PermissionMap> = {
  admin: grantsFor(ADMIN_MODULES, ALL),
  staff: {
    ...grantsFor(STAFF_MODULES, ALL),
    reports: { ...READ_ONLY },
    exports: { view: true, create: true, edit: false, delete: false },
    imports: { view: true, create: true, edit: false, delete: false },
  },
  // Customers never operate the admin/ERP modules directly; their data access
  // is limited to their own records through the customer portal.
  client: {},
};

export function isPermissionModule(value: string): value is PermissionModule {
  return (PERMISSION_MODULES as readonly string[]).includes(value);
}

export function isPermissionAction(value: string): value is PermissionAction {
  return value === "view" || value === "create" || value === "edit" || value === "delete";
}

export function parsePermissionKey(
  key: string,
): { module: PermissionModule; action: PermissionAction } | null {
  const [module, action] = key.split(".");
  if (!module || !action) return null;
  if (!isPermissionModule(module) || !isPermissionAction(action)) return null;
  return { module, action };
}
