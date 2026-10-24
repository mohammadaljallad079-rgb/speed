import { forbidden, notFound } from "../auth/errors";
import { assertSuperAdmin, tenantStatus, type TenantStatus } from "./policy";

/**
 * Read model for the global Super Admin console.
 *
 * Every query here runs on the service-role client (bypassing RLS) and is
 * reached only through a `super_admin`-guarded route, so the caller is the global
 * operator by construction. Nothing is read from the request: the console lists
 * every company by design, and the guard is what limits who may ask.
 *
 * The shape is deliberately built from tables that exist in the live schema
 * (`tenants`, `users`, `activity_logs`) so it works without any migration.
 */

type Row = Record<string, unknown>;
type Result = { data: unknown; error: unknown };

export interface AdminQuery extends PromiseLike<Result> {
  select(columns?: string): AdminQuery;
  eq(column: string, value: unknown): AdminQuery;
  is(column: string, value: null): AdminQuery;
  in(column: string, values: readonly string[]): AdminQuery;
  order(column: string, options?: { ascending?: boolean }): AdminQuery;
  limit(count: number): AdminQuery;
  maybeSingle(): Promise<Result>;
  single(): Promise<Result>;
  update(values: Row): AdminQuery;
  insert(values: Row | Row[]): AdminQuery;
  delete(): AdminQuery;
}

export interface AdminDb {
  from(table: string): AdminQuery;
}

export type TenantSummary = {
  id: string;
  name: string;
  nameEn: string | null;
  createdAt: string | null;
  status: TenantStatus;
  plan: "free";
  userCount: number;
  activeUserCount: number;
  adminCount: number;
  lastActivityAt: string | null;
  branches: number;
};

export type TenantUser = {
  id: string;
  email: string | null;
  fullName: string | null;
  role: string;
  isActive: boolean;
  customerId: string | null;
  createdAt: string | null;
};

export type AuditEntry = {
  id: string;
  action: string | null;
  entity: string | null;
  entityId: string | null;
  userEmail: string | null;
  tenantId: string | null;
  createdAt: string | null;
  metadata: Row | null;
};

export type ConsoleOverview = {
  totals: {
    tenants: number;
    users: number;
    activeTenants: number;
    suspendedTenants: number;
    adminUsers: number;
    staffUsers: number;
    clientUsers: number;
    superAdmins: number;
  };
  tenants: TenantSummary[];
  recentActivity: AuditEntry[];
};

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function readAll(db: AdminDb, table: string, columns: string): Promise<Row[]> {
  const { data, error } = await db.from(table).select(columns);
  if (error) throw error;
  return (data ?? []) as Row[];
}

/**
 * Builds the console overview from live tables. Tenant state, user counts and the
 * audit feed are all derived, never stored, so there is no second source of truth
 * for a company's status.
 */
export async function buildOverview(db: AdminDb): Promise<ConsoleOverview> {
  const [tenants, users, branches, activity] = await Promise.all([
    readAll(db, "tenants", "id, name, name_en, created_at"),
    readAll(db, "users", "id, email, full_name, role, tenant_id, customer_id, is_active, created_at"),
    readAll(db, "branches", "id, tenant_id"),
    readAll(db, "activity_logs", "id, action, entity, entity_id, user_email, tenant_id, created_at, metadata"),
  ]);

  const usersByTenant = new Map<string, Row[]>();
  for (const u of users) {
    const tid = asString(u.tenant_id);
    if (!tid) continue;
    const list = usersByTenant.get(tid) ?? [];
    list.push(u);
    usersByTenant.set(tid, list);
  }

  const branchCount = new Map<string, number>();
  for (const b of branches) {
    const tid = asString(b.tenant_id);
    if (!tid) continue;
    branchCount.set(tid, (branchCount.get(tid) ?? 0) + 1);
  }

  const lastActivity = new Map<string, string>();
  for (const a of activity) {
    const tid = asString(a.tenant_id);
    const at = asString(a.created_at);
    if (!tid || !at) continue;
    const prev = lastActivity.get(tid);
    if (!prev || at > prev) lastActivity.set(tid, at);
  }

  const summaries: TenantSummary[] = tenants
    .map((t) => {
      const id = String(t.id);
      const tenantUsers = usersByTenant.get(id) ?? [];
      const activeUserCount = tenantUsers.filter((u) => u.is_active !== false).length;
      const adminCount = tenantUsers.filter((u) => u.role === "admin" || u.role === "super_admin").length;
      return {
        id,
        name: (asString(t.name) ?? asString(t.name_en) ?? id) as string,
        nameEn: asString(t.name_en),
        createdAt: asString(t.created_at),
        status: tenantStatus({ userCount: tenantUsers.length, activeUserCount }),
        plan: "free" as const,
        userCount: tenantUsers.length,
        activeUserCount,
        adminCount,
        lastActivityAt: lastActivity.get(id) ?? null,
        branches: branchCount.get(id) ?? 0,
      };
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  const recentActivity: AuditEntry[] = [...activity]
    .sort((a, b) => (asString(b.created_at) ?? "").localeCompare(asString(a.created_at) ?? ""))
    .slice(0, 25)
    .map((a) => ({
      id: String(a.id),
      action: asString(a.action),
      entity: asString(a.entity),
      entityId: asString(a.entity_id),
      userEmail: asString(a.user_email),
      tenantId: asString(a.tenant_id),
      createdAt: asString(a.created_at),
      metadata: (a.metadata as Row) ?? null,
    }));

  const activeTenants = summaries.filter((t) => t.status === "active").length;
  const suspendedTenants = summaries.filter((t) => t.status === "suspended").length;

  return {
    totals: {
      tenants: tenants.length,
      users: users.length,
      activeTenants,
      suspendedTenants,
      adminUsers: users.filter((u) => u.role === "admin").length,
      staffUsers: users.filter((u) => u.role === "staff").length,
      clientUsers: users.filter((u) => u.role === "client").length,
      superAdmins: users.filter((u) => u.role === "super_admin").length,
    },
    tenants: summaries,
    recentActivity,
  };
}

/** Users of a single company, for the tenant detail drawer. */
export async function listTenantUsers(db: AdminDb, tenantId: string): Promise<TenantUser[]> {
  const { data, error } = await db
    .from("users")
    .select("id, email, full_name, role, tenant_id, customer_id, is_active, created_at")
    .eq("tenant_id", tenantId);
  if (error) throw error;
  return ((data ?? []) as Row[]).map((u) => ({
    id: String(u.id),
    email: asString(u.email),
    fullName: asString(u.full_name),
    role: String(u.role ?? "staff"),
    isActive: u.is_active !== false,
    customerId: asString(u.customer_id),
    createdAt: asString(u.created_at),
  }));
}

/**
 * Sets a user's active flag. Only the flag is written; role and tenant are left
 * untouched, so the console can disable an account without ever moving it between
 * companies (which migration 004 forbids for a non-super caller anyway).
 */
export async function setUserActive(db: AdminDb, userId: string, isActive: boolean): Promise<void> {
  const { error } = await db.from("users").update({ is_active: isActive }).eq("id", userId);
  if (error) throw error;
}

/**
 * Changes a company-scoped role. The caller must have already passed
 * `assertRoleChangeAllowed`; this only performs the write. The role is written to
 * `users.role` (the model login actually reads) and never to `super_admin`.
 */
export async function setUserRole(db: AdminDb, userId: string, role: string): Promise<void> {
  if (role === "super_admin") throw forbidden("The super_admin role is not managed from this console");
  const { error } = await db.from("users").update({ role }).eq("id", userId);
  if (error) throw error;
}

export { assertSuperAdmin, notFound };
