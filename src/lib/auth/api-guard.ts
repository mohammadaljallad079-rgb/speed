import { NextResponse } from "next/server";
import { getActiveFinancialYear, resolveAuthContext } from "./context";
import { can } from "./policy";
import { forbidden, toErrorResponse, unauthorized } from "./errors";
import { logAudit, type AuditEvent } from "./audit";
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
  /** Set to false for endpoints that must be reachable without a session. */
  requireAuth?: boolean;
};

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
    const requireAuth = options.requireAuth !== false;
    const context = await resolveAuthContext(request);

    if (!context) {
      if (requireAuth) throw unauthorized();
      return NextResponse.json(await handler(null as unknown as AuthContext));
    }

    if (options.requireAdmin && !context.isAdmin) throw forbidden("Administrator access required");
    if (options.allowRoles && !options.allowRoles.includes(context.role) && !context.isAdmin) {
      throw forbidden();
    }
    if (options.module && options.action && !can(context, options.module, options.action)) {
      throw forbidden(`Missing permission: ${options.module}.${options.action}`);
    }

    const result = await handler(context);
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
    const requireAuth = options.requireAuth !== false;
    const context = await resolveAuthContext(request);

    if (!context) {
      if (requireAuth) throw unauthorized();
      return await handler(null as unknown as AuthContext);
    }

    if (options.requireAdmin && !context.isAdmin) throw forbidden("Administrator access required");
    if (options.allowRoles && !options.allowRoles.includes(context.role) && !context.isAdmin) {
      throw forbidden();
    }
    if (options.module && options.action && !can(context, options.module, options.action)) {
      throw forbidden(`Missing permission: ${options.module}.${options.action}`);
    }

    return await handler(context);
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
  const context = await resolveAuthContext(request);
  if (!context) throw unauthorized();
  if (options.requireAdmin && !context.isAdmin) throw forbidden("Administrator access required");
  if (options.module && options.action && !can(context, options.module, options.action)) {
    throw forbidden(`Missing permission: ${options.module}.${options.action}`);
  }
  return context;
}

export { getActiveFinancialYear, logAudit, can };
export type { AuditEvent, AuthContext };
