import type { NotificationInput } from "./notifications";
import { dedupeNotifications } from "./notifications";

/**
 * Notification store.
 *
 * Writes to the `notifications` table (migration 012). The db surface is
 * injectable so the store is unit-testable with a recording stub, and so the
 * caller can pass a service-role client that bypasses RLS. Every query is
 * scoped by `tenant_id` from the session - never from a request body - matching
 * the rest of the core.
 *
 * Before 012 is applied the table does not exist; the store reports that as a
 * `table_missing` outcome rather than throwing, so the UI degrades to "no
 * notifications" instead of breaking a page.
 */

export interface NotificationRecord extends NotificationInput {
  id: string;
  tenantId: string | null;
  recipientId: string | null;
  readAt: string | null;
  createdAt: string;
}

interface QueryResult<T> {
  data: T | null;
  error: { code?: string; message?: string } | null;
}

interface SelectQuery extends PromiseLike<QueryResult<Record<string, unknown>[]>> {
  eq(column: string, value: string): SelectQuery;
  is(column: string, value: null): SelectQuery;
  order(column: string, options?: { ascending?: boolean }): SelectQuery;
  limit(n: number): SelectQuery;
  maybeSingle(): Promise<QueryResult<Record<string, unknown>>>;
}

/**
 * The update builder. It must expose BOTH `eq` and `is`, because a tenant-less
 * caller (the single-tenant install) scopes its row with `tenant_id is null` —
 * `eq("tenant_id", "")` never matches a NULL column, which silently made
 * "mark read" a no-op that still reported success.
 */
export interface UpdateQuery extends PromiseLike<QueryResult<unknown>> {
  eq(column: string, value: string): UpdateQuery;
  is(column: string, value: null): UpdateQuery;
}

export interface NotificationDb {
  from(table: string): {
    select(columns: string): SelectQuery;
    insert(rows: Record<string, unknown> | Record<string, unknown>[]): Promise<QueryResult<unknown>>;
    update(values: Record<string, unknown>): UpdateQuery;
  };
}

export interface InsertResult {
  ok: boolean;
  inserted: number;
  skipped: number;
  /** Set when the table is absent (012 not applied) or another write error occurred. */
  error?: string;
}

const MISSING_TABLE_CODES = ["42P01", "PGRST205", "PGRST204"];

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code && MISSING_TABLE_CODES.includes(error.code)) return true;
  const msg = (error.message ?? "").toLowerCase();
  return msg.includes("does not exist") || msg.includes("could not find the table");
}

function isDuplicate(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  return (error.message ?? "").toLowerCase().includes("duplicate key");
}

/**
 * Inserts notifications, skipping any whose dedupe key already exists. The
 * unique index does the real work; a duplicate error is treated as "skipped",
 * not a failure, so a re-run or a retry is safe.
 */
export async function insertNotifications(
  db: NotificationDb,
  tenantId: string | null,
  recipientId: string | null,
  items: NotificationInput[],
): Promise<InsertResult> {
  const unique = dedupeNotifications(items);
  if (unique.length === 0) return { ok: true, inserted: 0, skipped: 0 };

  let inserted = 0;
  let skipped = 0;
  for (const n of unique) {
    const row: Record<string, unknown> = {
      kind: n.kind,
      title_ar: n.titleAr,
      title_en: n.titleEn,
      body_ar: n.bodyAr,
      body_en: n.bodyEn,
      severity: n.severity,
      entity: n.entity,
      entity_id: n.entityId,
      due_date: n.dueDate,
      dedupe_key: n.dedupeKey,
      ...(tenantId ? { tenant_id: tenantId } : {}),
      ...(recipientId ? { recipient_id: recipientId } : {}),
    };
    const { error } = await db.from("notifications").insert(row);
    if (!error) {
      inserted++;
    } else if (isDuplicate(error)) {
      skipped++;
    } else if (isMissingTable(error)) {
      return { ok: false, inserted, skipped, error: "table_missing" };
    } else {
      return { ok: false, inserted, skipped, error: error.message ?? "insert_failed" };
    }
  }
  return { ok: true, inserted, skipped };
}

function toRecord(row: Record<string, unknown>): NotificationRecord {
  return {
    id: String(row.id),
    tenantId: (row.tenant_id as string | null) ?? null,
    recipientId: (row.recipient_id as string | null) ?? null,
    kind: row.kind as NotificationRecord["kind"],
    titleAr: String(row.title_ar ?? ""),
    titleEn: String(row.title_en ?? ""),
    bodyAr: String(row.body_ar ?? ""),
    bodyEn: String(row.body_en ?? ""),
    severity: (row.severity as NotificationRecord["severity"]) ?? "info",
    entity: String(row.entity ?? ""),
    entityId: String(row.entity_id ?? ""),
    dueDate: (row.due_date as string | null) ?? null,
    dedupeKey: String(row.dedupe_key ?? ""),
    readAt: (row.read_at as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
  };
}

export interface ListResult {
  ok: boolean;
  records: NotificationRecord[];
  unread: number;
  error?: string;
}

/** Lists a recipient's notifications, tenant-scoped, newest first. */
export async function listNotifications(
  db: NotificationDb,
  tenantId: string | null,
  recipientId: string | null,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<ListResult> {
  let query = db.from("notifications").select("*").order("created_at", { ascending: false }).limit(options.limit ?? 50);
  query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
  if (recipientId) query = query.eq("recipient_id", recipientId);
  const { data, error } = await query;
  if (error) {
    return { ok: false, records: [], unread: 0, error: isMissingTable(error) ? "table_missing" : error.message };
  }
  let records = (data ?? []).map(toRecord);
  if (options.unreadOnly) records = records.filter((r) => !r.readAt);
  return { ok: true, records, unread: records.filter((r) => !r.readAt).length };
}

/** Marks one notification read, scoped so a foreign id is not writable. */
export async function markNotificationRead(
  db: NotificationDb,
  tenantId: string | null,
  recipientId: string | null,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  // The row is scoped by tenant first (NULL-safe, matching `listNotifications`),
  // then by recipient when one is known. A tenant-less caller must use
  // `tenant_id is null`; `eq("tenant_id", "")` matches nothing and would leave
  // the row unread while still returning success.
  let query = db.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
  query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
  if (recipientId) query = query.eq("recipient_id", recipientId);
  const { error } = await query;
  if (!error) return { ok: true };
  return { ok: false, error: isMissingTable(error) ? "table_missing" : error.message };
}
