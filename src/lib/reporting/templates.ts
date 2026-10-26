import { scopeToTenantColumn } from "@/lib/auth/policy";
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
export const DEFINITIONS_SETTING_KEY = "report_definitions";
const MAX_TEMPLATES = 50;
const MAX_NAME = 60;
const MAX_VERSIONS = 10;

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
  const query = scopeToTenantColumn(db.from("settings").select("value").eq("key", TEMPLATES_SETTING_KEY), tenantId);
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

// --- Saved dynamic report definitions (with versions) -------------------------

export interface SavedDefinitionVersion {
  version: number;
  savedAt: string;
  /** The whitelisted, parsed request that can be replayed. */
  request: unknown;
}

export interface SavedDefinition {
  name: string;
  dataset: string;
  current: unknown;
  versions: SavedDefinitionVersion[];
}

async function readDefinitions(db: SettingsDb, tenantId: string | null): Promise<SavedDefinition[]> {
  const query = scopeToTenantColumn(db.from("settings").select("value").eq("key", DEFINITIONS_SETTING_KEY), tenantId);
  const { data, error } = await query.maybeSingle();
  if (error || !data?.value) return [];
  const raw = data.value;
  const list = Array.isArray(raw) ? raw : [];
  return list.filter((d): d is SavedDefinition => Boolean(d) && typeof (d as SavedDefinition).name === "string");
}

export async function loadDefinitions(db: SettingsDb, tenantId: string | null): Promise<SavedDefinition[]> {
  return readDefinitions(db, tenantId);
}

export function findDefinition(defs: SavedDefinition[], name: string): SavedDefinition | null {
  const needle = name.trim().toLowerCase();
  return defs.find((d) => d.name.toLowerCase() === needle) ?? defs.find((d) => d.name.toLowerCase().includes(needle)) ?? null;
}

/**
 * Saves a report definition, pushing the previous version onto a bounded
 * history so a definition can be restored. Returns the updated list.
 */
export async function saveDefinition(
  db: SettingsDb,
  tenantId: string | null,
  entry: { name: string; dataset: string; request: unknown },
): Promise<SavedDefinition[]> {
  const name = String(entry.name ?? "").trim().slice(0, MAX_NAME);
  if (!name) throw new Error("Definition name required");
  const existing = await readDefinitions(db, tenantId);
  const prior = existing.find((d) => d.name.toLowerCase() === name.toLowerCase());
  const versions = prior
    ? [{ version: (prior.versions[prior.versions.length - 1]?.version ?? 0) + 1, savedAt: new Date().toISOString(), request: prior.current }, ...prior.versions].slice(0, MAX_VERSIONS)
    : [];
  const next: SavedDefinition[] = [
    { name, dataset: entry.dataset, current: entry.request, versions },
    ...existing.filter((d) => d.name.toLowerCase() !== name.toLowerCase()),
  ].slice(0, MAX_TEMPLATES);
  const { error } = await db.from("settings").upsert(
    { key: DEFINITIONS_SETTING_KEY, value: next, ...(tenantId ? { tenant_id: tenantId } : {}), updated_at: new Date().toISOString() },
    { onConflict: "tenant_id,key" },
  );
  if (error) throw error;
  return next;
}

/** Restores a prior version as current, keeping the replaced one in history. */
export async function restoreDefinition(
  db: SettingsDb,
  tenantId: string | null,
  name: string,
  version: number,
): Promise<SavedDefinition[]> {
  const existing = await readDefinitions(db, tenantId);
  const def = existing.find((d) => d.name.toLowerCase() === name.trim().toLowerCase());
  if (!def) throw new Error("Definition not found");
  const target = def.versions.find((v) => v.version === version);
  if (!target) throw new Error("Version not found");
  return saveDefinition(db, tenantId, { name: def.name, dataset: def.dataset, request: target.request });
}
