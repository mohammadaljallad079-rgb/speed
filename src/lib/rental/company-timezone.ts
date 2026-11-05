/**
 * The rental company's timezone, read from the existing `settings` store.
 *
 * A booking is a wall-clock reading in the branch's zone, so the zone has to come
 * from the company, not from the browser (a customer abroad still books the
 * branch's hours) and not from the server (the same code runs in several
 * regions). It lives in the key/value `settings` table that the rest of the
 * platform already uses - no new table, and the same `tenant_id,key` conflict
 * target, so one company can never overwrite another's row.
 *
 * Reads are tenant-scoped and fail closed to `DEFAULT_COMPANY_TIMEZONE`: a
 * company that has not chosen a zone, or a `settings` table that is not migrated
 * yet, must not stop a booking.
 */

import { DEFAULT_COMPANY_TIMEZONE, resolveCompanyTimezone } from "./timezone";

export const COMPANY_TIMEZONE_KEY = "company_timezone";

type Row = Record<string, unknown>;

export interface TimezoneQuery extends PromiseLike<{ data: unknown; error: unknown }> {
  select(columns?: string): TimezoneQuery;
  eq(column: string, value: unknown): TimezoneQuery;
  is(column: string, value: null): TimezoneQuery;
  maybeSingle(): Promise<{ data: unknown; error: unknown }>;
}

export interface TimezoneDb {
  from(table: string): TimezoneQuery;
}

function scope(query: TimezoneQuery, tenantId: string | null): TimezoneQuery {
  return tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
}

/** Extract a zone from a `settings.value` cell, which may be a bare string or JSON. */
function readZone(value: unknown): string | null {
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return null;
    // The store holds JSON for structured settings; accept both shapes.
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw) as Row;
        const inner = parsed.timezone ?? parsed.timeZone ?? parsed.tz;
        return typeof inner === "string" ? inner : null;
      } catch {
        return null;
      }
    }
    return raw;
  }
  if (value && typeof value === "object") {
    const o = value as Row;
    const inner = o.timezone ?? o.timeZone ?? o.tz;
    return typeof inner === "string" ? inner : null;
  }
  return null;
}

/**
 * The company's timezone, or the default.
 *
 * Never throws: an unreadable settings row is reported as the default rather than
 * failing the booking, because the default is the home market's zone and every
 * window is still stored as an unambiguous instant.
 */
export async function getCompanyTimezone(
  db: TimezoneDb,
  tenantId: string | null,
): Promise<string> {
  try {
    const { data, error } = await scope(
      db.from("settings").select("value").eq("key", COMPANY_TIMEZONE_KEY),
      tenantId,
    ).maybeSingle();
    if (error) return DEFAULT_COMPANY_TIMEZONE;
    const row = data as Row | null;
    if (!row) return DEFAULT_COMPANY_TIMEZONE;
    return resolveCompanyTimezone(readZone(row.value));
  } catch {
    return DEFAULT_COMPANY_TIMEZONE;
  }
}
