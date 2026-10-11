import type { FormatTemplate } from "./plan";
import { isReportKind } from "./definitions";

/**
 * Saved format templates.
 *
 * Reuses the existing `settings` key/value table (no new table, migration or
 * duplicate store). Every read/write is scoped by `tenant_id` derived from the
 * authenticated context — never from a request body or an uploaded file.
 */

export const TEMPLATES_SETTING_KEY = "report_format_templates";
const MAX_TEMPLATES = 50;
const MAX_NAME = 60;

/** Fluent query builder that also awaits, mirroring PostgREST's thenable builder. */
interface SettingsQuery extends PromiseLike<{ data: { value?: unknown } | null; error: unknown }> {
  eq(column: string, value: string): SettingsQuery;
  maybeSingle(): Promise<{ data: { value?: unknown } | null; error: unknown }>;
}

/** Minimal PostgREST-like surface, so the store is testable with a stub. */
export interface SettingsDb {
  from(table: string): {
    select(columns: string): SettingsQuery;
    upsert(
      row: Record<string, unknown>,
      options?: { onConflict?: string },
    ): Promise<{ error: unknown }>;
  };
}

export function sanitizeTemplate(template: FormatTemplate): FormatTemplate | null {
  if (!template || typeof template !== "object") return null;
  if (!isReportKind(template.kind)) return null;
  const name = String(template.name ?? "").trim().slice(0, MAX_NAME);
  if (!name) return null;
  return { ...template, name };
}

/** Fluent query builder that also awaits, mirroring PostgREST's thenable builder. */
interface SettingsQuery extends PromiseLike<{ data: { value?: unknown } | null; error: unknown }> {
  eq(column: string, value: string): SettingsQuery;
  maybeSingle(): Promise<{ data: { value?: unknown } | null; error: unknown }>;
}

/** Reads the tenant's templates; a malformed store yields an empty list. */
export async function loadTemplates(db: SettingsDb, tenantId: string | null): Promise<FormatTemplate[]> {
  let query = db.from("settings").select("value").eq("key", TEMPLATES_SETTING_KEY);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { data, error } = await query.maybeSingle();
  if (error || !data?.value) return [];
  const raw = data.value;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw && Array.isArray((raw as { templates?: unknown }).templates)
      ? (raw as { templates: unknown[] }).templates
      : [];
  return list.map((t) => sanitizeTemplate(t as FormatTemplate)).filter((t): t is FormatTemplate => t !== null);
}

export function findTemplate(templates: FormatTemplate[], name: string): FormatTemplate | null {
  const needle = name.trim().toLowerCase();
  return (
    templates.find((t) => t.name.toLowerCase() === needle) ??
    templates.find((t) => t.name.toLowerCase().includes(needle)) ??
    null
  );
}

/** Saves (or replaces by name) a template and returns the new list. */
export async function saveTemplate(
  db: SettingsDb,
  tenantId: string | null,
  template: FormatTemplate,
): Promise<FormatTemplate[]> {
  const clean = sanitizeTemplate(template);
  if (!clean) throw new Error("Invalid template");
  const existing = await loadTemplates(db, tenantId);
  const next = [clean, ...existing.filter((t) => t.name.toLowerCase() !== clean.name.toLowerCase())].slice(
    0,
    MAX_TEMPLATES,
  );
  const { error } = await db.from("settings").upsert(
    {
      key: TEMPLATES_SETTING_KEY,
      value: next,
      ...(tenantId ? { tenant_id: tenantId } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,key" },
  );
  if (error) throw error;
  return next;
}
