import { NextResponse } from "next/server";
import { getActiveFinancialYear, resolveAuthContext } from "./context";
import { ApiError, forbidden, toErrorResponse, unauthorized } from "./errors";
import { logAudit, type AuditEvent } from "./audit";
import { can } from "./policy";
import type { AuthContext } from "./types";
import type { PermissionAction } from "./permissions";

export type GuardOptions = {
  /** Module checked against the permission catalogue, e.g. `invoices`. */
  module?: string;
  /** Action checked against the permission catalogue. */
  action?: PermissionAction;
  /** Extra roles allowed regardless of the permission matrix (rarely needed). */
  allowRoles?: AuthContext["role"][];
  /** When true the caller must be an administrator. */
  requireAdmin?: boolean;
  /**
   * When true the caller must be the *global* operator (`super_admin`), not a
   * company-scoped `admin`. This is the explicit boundary for global-only
   * features; a company administrator is rejected with 403.
   */
  requireSuperAdmin?: boolean;
  /** Set to false for endpoints that must be reachable without a session. */
  requireAuth?: boolean;
};

/** Applies the role checks shared by every guard entry point. */
function assertRole(context: AuthContext, options: GuardOptions): void {
  if (options.requireSuperAdmin && !context.isSuperAdmin) {
    throw forbidden("Global administrator access required");
  }
  if (options.requireAdmin && !context.isAdmin) throw forbidden("Administrator access required");
  if (options.allowRoles && !options.allowRoles.includes(context.role) && !context.isAdmin) {
    throw forbidden();
  }
}

/**
 * The pure authorization decision behind every guarded route. Returns the
 * resolved context on success and throws the exact `ApiError` (401/403) a route
 * must return otherwise, so the rules are exercised without a Next request:
 *
 *   - no context + auth required          -> 401 `unauthenticated`
 *   - no context + `requireAuth: false`   -> null (anonymous handler)
 *   - `requireSuperAdmin` & not super      -> 403 `forbidden` (global-only)
 *   - `requireAdmin` & not admin           -> 403 `forbidden`
 *   - `allowRoles` miss                    -> 403 `forbidden`
 *   - module/action permission miss        -> 403 `forbidden`
 *   - otherwise                            -> the context
 *
 * A valid administrator passes; an inactive or unmapped account resolves to no
 * context and is rejected exactly like an anonymous caller.
 */
export function authorize(
  context: AuthContext | null,
  options: GuardOptions,
): AuthContext | null {
  const requireAuth = options.requireAuth !== false;
  if (!context) {
    if (requireAuth) throw unauthorized();
    return null;
  }
  assertRole(context, options);
  if (options.module && options.action && !can(context, options.module, options.action)) {
    throw forbidden(`Missing permission: ${options.module}.${options.action}`);
  }
  return context;
}

/**
 * Central entry point for every privileged route handler.
 *
 * It performs, in order:
 *   1. authentication  — a valid Supabase session must exist
 *   2. authorization   — the role/permission matrix must allow the operation
 *   3. tenant context  — the resolved tenant is attached to the context used by
 *                        all subsequent queries
 *
 * Nothing here trusts the request body: identity and permissions come from the
 * session and the database only.
 */
export async function withAuth<T>(
  request: Request,
  options: GuardOptions,
  handler: (context: AuthContext) => Promise<T>,
): Promise<NextResponse> {
  try {
    const context = authorize(await resolveAuthContext(request), options);
    const result = await handler(context as AuthContext);
    return NextResponse.json(result);
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/** Same as `withAuth` but for handlers that need the full NextResponse. */
export async function withAuthResponse(
  request: Request,
  options: GuardOptions,
  handler: (context: AuthContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const context = authorize(await resolveAuthContext(request), options);
    return await handler(context as AuthContext);
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/**
 * Convenience wrapper: resolves the context, verifies the permission and
 * returns both so a handler can keep using plain imperative code.
 */
export async function requireContext(
  request: Request,
  options: GuardOptions = {},
): Promise<AuthContext> {
  const context = authorize(await resolveAuthContext(request), options);
  return context as AuthContext;
}

export { getActiveFinancialYear, logAudit, can, ApiError };
export type { AuditEvent, AuthContext };
