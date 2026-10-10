import { supabaseAdmin } from "../supabase-admin";
import { sanitizeMetadata } from "./policy";
import type { AuthContext, AuditAction } from "./types";

export type AuditEvent = {
  action: AuditAction;
  /** Entity/table the action was performed on, e.g. `invoices`. */
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Writes an audit event.
 *
 * Audit logging is best-effort by design: a failure to log must never abort a
 * business operation that has already been authorized and validated. Failures
 * are surfaced on the server console only. `sanitizeMetadata` strips
 * credentials before anything reaches the database.
 */
export async function logAudit(context: AuthContext | null, event: AuditEvent): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("activity_logs").insert({
      tenant_id: context?.tenantId ?? null,
      user_id: context?.authUserId ?? null,
      user_email: context?.email ?? null,
      action: event.action,
      entity: event.entity,
      entity_id: event.entityId ?? null,
      metadata: sanitizeMetadata(event.metadata ?? {}),
    });
    if (error) console.error("[audit] failed to write activity log:", error.message);
  } catch (error) {
    console.error("[audit] unexpected failure:", error);
  }
}

export { sanitizeMetadata };
