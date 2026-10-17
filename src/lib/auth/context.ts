import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "../supabase-admin";
import {
  isAdminRole,
  mergePermissions,
  normaliseRole,
  permissionsFromJson,
  permissionsFromRows,
  type PermissionRow,
} from "./policy";
import { DEFAULT_ROLE_PERMISSIONS } from "./permissions";
import type { AuthContext, FinancialYear } from "./types";

/**
 * The two dependencies `resolveAuthContext` needs, split out so the resolution
 * rules can be exercised against a recording stub — the same injectable-client
 * pattern the accounting services use. Production passes the real anon session
 * reader and the service-role client.
 */
export type AuthSessionUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};
export type AuthSessionReader = () => Promise<{ user: AuthSessionUser | null }>;

type QueryResult = { data: unknown; error?: unknown };
type FilteredQuery = PromiseLike<QueryResult> & { maybeSingle: () => Promise<QueryResult> };
export type AuthResolverAdmin = {
  from: (table: string) => {
    select: (columns: string) => { eq: (column: string, value: string) => FilteredQuery };
  };
};

function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  if (!header) return [];
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf("=");
      if (idx === -1) return { name: part, value: "" };
      return { name: part.slice(0, idx), value: decodeURIComponent(part.slice(idx + 1)) };
    });
}

/**
 * The resolution core. Pure of transport: it takes the already-authenticated
 * auth user and an injectable admin client, and applies the application's
 * account-linking rules. Returns `null` for an inactive or unmapped account so
 * the caller can translate that into the correct HTTP outcome (401 vs 403).
 */
export async function resolveContextFrom(
  authUser: AuthSessionUser,
  admin: AuthResolverAdmin,
): Promise<AuthContext | null> {
  const metadataName =
    typeof authUser.user_metadata?.full_name === "string" ? authUser.user_metadata.full_name : null;

  // `users` is the primary application profile used by login.
  const { data: appUserData } = await admin
    .from("users")
    .select("id, email, full_name, role, tenant_id, customer_id, permissions, is_active")
    .eq("id", authUser.id)
    .maybeSingle();
  const appUser = appUserData as {
    email?: string | null;
    full_name?: string | null;
    role?: string | null;
    tenant_id?: string | null;
    customer_id?: string | null;
    permissions?: unknown;
    is_active?: boolean | null;
  } | null;

  if (appUser && appUser.is_active === false) return null;

  // `profiles` + `roles` is the secondary model used by Settings → Users.
  const { data: profileData } = await admin
    .from("profiles")
    .select("id, full_name, role_id, branch_id, is_active")
    .eq("id", authUser.id)
    .maybeSingle();
  const profile = profileData as {
    full_name?: string | null;
    role_id?: string | null;
    branch_id?: string | null;
    is_active?: boolean | null;
  } | null;

  if (!appUser && (!profile || profile.is_active === false)) return null;
  if (profile && profile.is_active === false) return null;

  let role = normaliseRole(appUser?.role);
  const roleId: string | null = profile?.role_id ?? null;

  if (roleId) {
    const { data: roleData } = await admin
      .from("roles")
      .select("id, name, is_active")
      .eq("id", roleId)
      .maybeSingle();
    const roleRow = roleData as { name?: string | null; is_active?: boolean | null } | null;
    // A role defined in the `roles` table wins only when the user has no
    // `users.role` (i.e. they were created through Settings → Users).
    if (roleRow && roleRow.is_active !== false && !appUser?.role) {
      role = normaliseRole(roleRow.name);
    }
  }

  const { data: permissionData } = roleId
    ? await admin.from("permissions").select("*").eq("role_id", roleId)
    : { data: [] as PermissionRow[] };

  let permissions = mergePermissions(
    DEFAULT_ROLE_PERMISSIONS[role] ?? {},
    permissionsFromRows((permissionData ?? []) as PermissionRow[]),
  );
  permissions = mergePermissions(permissions, permissionsFromJson(appUser?.permissions));

  return {
    authUserId: authUser.id,
    email: appUser?.email ?? authUser.email ?? null,
    fullName: appUser?.full_name ?? profile?.full_name ?? metadataName,
    role,
    tenantId: (appUser?.tenant_id as string | null) ?? null,
    customerId: (appUser?.customer_id as string | null) ?? null,
    branchIds: profile?.branch_id ? [profile.branch_id as string] : null,
    financialYearId: null,
    permissions,
    isAdmin: isAdminRole(role),
    isSuperAdmin: role === "super_admin",
  };
}

/**
 * Reads the Supabase auth session from the request cookies and resolves the
 * full authorization context. Returns `null` when there is no valid session.
 *
 * The session is read with the anon key (GoTrue validates the JWT), while the
 * app tables are read with the service-role client because those tables are
 * protected by RLS and the caller's identity must never be able to widen it.
 */
export async function resolveAuthContext(request: Request): Promise<AuthContext | null> {
  const cookies = parseCookieHeader(request.headers.get("cookie"));

  const authClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookies,
        setAll: () => {
          /* read-only resolution; token refresh is handled by middleware */
        },
      },
    },
  );

  const { data: userData, error: userError } = await authClient.auth.getUser();
  if (userError || !userData?.user) return null;

  return resolveContextFrom(
    userData.user as unknown as AuthSessionUser,
    supabaseAdmin as unknown as AuthResolverAdmin,
  );
}

/**
 * Resolves the active financial year for the tenant. Returns `null` when the
 * tenant has no financial year configured, in which case date validation is
 * skipped so that existing installations keep working unchanged.
 */
export async function getActiveFinancialYear(tenantId: string | null): Promise<FinancialYear | null> {
  let query = supabaseAdmin
    .from("financial_years")
    .select("id, name, start_date, end_date, is_current, status");

  query = tenantId ? query.eq("tenant_id", tenantId) : query;

  const { data } = await query
    .order("is_current", { ascending: false })
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as FinancialYear | null) ?? null;
}
