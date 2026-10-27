/**
 * Resolve the role behind an authenticated session, for the Edge middleware.
 *
 * The middleware runs before every request and must answer one question: *which
 * area does this authenticated identity belong to?* It cannot call
 * `resolveAuthContext` (that module pulls `server-only` and Node APIs), so this
 * is the smallest possible resolver: one authenticated read of the caller's own
 * `users` row.
 *
 * Why this is safe to run on the caller's session rather than the service role:
 *
 *   - the read is scoped to the caller's OWN row (`id = auth.uid()`), which the
 *     `users_self_select` policy (migration 004) permits;
 *   - RLS is the authority. If the caller's row is not readable, no role is
 *     returned and the request is treated as unauthenticated - fail closed;
 *   - the resolved role is only ever used to ALLOW a path the role is entitled
 *     to. It can never widen access: a role that resolves to `client` is
 *     confined to the customer portal, and the route-level guards re-check
 *     permissions against the same session server-side.
 *
 * If the `users` read fails for any reason (policy not applied, transient error)
 * the caller is treated as having no role. That is the fail-closed direction:
 * an ERP path is refused rather than served.
 */
import type { AppRole } from "./permissions";

/**
 * The minimal surface this resolver needs. Declaring it structurally (rather
 * than as `SupabaseClient<Database, ...>`) keeps the middleware free of a
 * generated-database-type dependency and lets tests pass a recording stub.
 */
export type RoleReaderClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{ data: unknown; error?: unknown }>;
      };
    };
  };
};
const KNOWN_ROLES: readonly AppRole[] = ["super_admin", "admin", "staff", "client"];
/**
 * Parse a role STRICTLY. Unlike `normaliseRole` (which defaults an unrecognised
 * value to `staff` because it is used to *describe* a user in the UI), an
 * unrecognised role here must grant NOTHING. Defaulting to `staff` would turn a
 * malformed or unexpected `users.role` - precisely the shape a stray customer
 * row can have - into ERP access. For an access decision the only safe default
 * is "no area".
 */
function strictRole(value: unknown): AppRole | null {
  return typeof value === "string" && (KNOWN_ROLES as readonly string[]).includes(value)
    ? (value as AppRole)
    : null;
}
/**
 * Read the caller's own application role. Returns `null` when the identity has
 * no readable `users` row, is inactive, or carries an unrecognised role.
 */
export async function readSessionRole(
  supabase: RoleReaderClient,
  authUserId: string,
): Promise<AppRole | null> {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("role, is_active")
      .eq("id", authUserId)
      .maybeSingle();
    if (error) return null;
    const row = data as { role?: string | null; is_active?: boolean | null } | null;
    if (!row) return null;
    if (row.is_active === false) return null;
    return strictRole(row.role);
  } catch {
    return null;
  }
}
