import { scopeToTenantColumn } from "@/lib/auth/policy";
import {
  isDocumentKind,
  sanitizeTemplate,
  defaultTemplate,
  type DocumentKind,
  type DocumentTemplate,
} from "./document-templates";

/**
 * Document template store.
 *
 * Reuses the existing `settings` key/value table (no new table, no migration,
 * no second template engine). Every read/write is scoped by `tenant_id` derived
 * from the authenticated context - never from a request body or a model output -
 * so one company's branding can never be read or overwritten by another.
 *
 * The db surface is injectable so the store is unit-testable with a PostgREST
 * recording stub, matching the pattern used by `reporting/templates.ts`.
 */

export const DOCUMENT_TEMPLATES_KEY = "document_templates";
const MAX_VERSIONS = 10;

interface SettingsQuery extends PromiseLike<{ data: { value?: unknown } | null; error: unknown }> {
  eq(column: string, value: string): SettingsQuery;
  maybeSingle(): Promise<{ data: { value?: unknown } | null; error: unknown }>;
}

export interface TemplateDb {
  from(table: string): {
    select(columns: string): SettingsQuery;
    upsert(row: Record<string, unknown>, options?: { onConflict?: string }): Promise<{ error: unknown }>;
  };
}

interface StoredShape {
  templates: Record<string, DocumentTemplate>;
  history: Record<string, DocumentTemplate[]>;
}

const EMPTY: StoredShape = { templates: {}, history: {} };

function coerce(raw: unknown): StoredShape {
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  const r = raw as Partial<StoredShape>;
  return {
    templates: r.templates && typeof r.templates === "object" ? (r.templates as Record<string, DocumentTemplate>) : {},
    history: r.history && typeof r.history === "object" ? (r.history as Record<string, DocumentTemplate[]>) : {},
  };
}

/** Reads the tenant's stored templates, sanitising every entry. */
export async function loadDocumentTemplates(db: TemplateDb, tenantId: string | null): Promise<Record<string, DocumentTemplate>> {
  const query = scopeToTenantColumn(db.from("settings").select("value").eq("key", DOCUMENT_TEMPLATES_KEY), tenantId);
  const { data, error } = await query.maybeSingle();
  if (error || !data?.value) return {};
  const store = coerce(data.value);
  const out: Record<string, DocumentTemplate> = {};
  for (const [kind, tpl] of Object.entries(store.templates)) {
    const clean = sanitizeTemplate(tpl);
    if (clean && isDocumentKind(kind) && clean.kind === kind) out[kind] = clean;
  }
  return out;
}

/** The stored template for a kind, or the built-in default. */
export async function getDocumentTemplate(db: TemplateDb, tenantId: string | null, kind: DocumentKind): Promise<DocumentTemplate> {
  const all = await loadDocumentTemplates(db, tenantId);
  return all[kind] ?? defaultTemplate(kind);
}

export async function loadTemplateHistory(db: TemplateDb, tenantId: string | null, kind: DocumentKind): Promise<DocumentTemplate[]> {
  const query = scopeToTenantColumn(db.from("settings").select("value").eq("key", DOCUMENT_TEMPLATES_KEY), tenantId);
  const { data, error } = await query.maybeSingle();
  if (error || !data?.value) return [];
  const store = coerce(data.value);
  const list = store.history[kind] ?? [];
  return list.map((t) => sanitizeTemplate(t)).filter((t): t is DocumentTemplate => t !== null);
}

export interface SaveResult {
  ok: boolean;
  template: DocumentTemplate | null;
  error?: string;
}

/**
 * Persists a template for the tenant. Bumps the version, keeps a bounded
 * history for restore, and refuses a template whose kind does not match the
 * slot it is written to (a model cannot smuggle one document's layout into
 * another's).
 */
export async function saveDocumentTemplate(
  db: TemplateDb,
  tenantId: string | null,
  input: unknown,
): Promise<SaveResult> {
  const clean = sanitizeTemplate(input);
  if (!clean) return { ok: false, template: null, error: "invalid_template" };

  const query = scopeToTenantColumn(db.from("settings").select("value").eq("key", DOCUMENT_TEMPLATES_KEY), tenantId);
  const { data } = await query.maybeSingle();
  const store = coerce(data?.value);

  const existing = sanitizeTemplate(store.templates[clean.kind]);
  if (existing && existing.kind !== clean.kind) return { ok: false, template: null, error: "kind_mismatch" };

  const next: DocumentTemplate = {
    ...clean,
    version: (existing?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  const history = { ...store.history };
  if (existing) {
    history[clean.kind] = [existing, ...(history[clean.kind] ?? [])].slice(0, MAX_VERSIONS);
  }

  const value: StoredShape = { templates: { ...store.templates, [clean.kind]: next }, history };
  const row: Record<string, unknown> = {
    key: DOCUMENT_TEMPLATES_KEY,
    value,
    updated_at: next.updatedAt,
    ...(tenantId ? { tenant_id: tenantId } : {}),
  };
  const { error } = await db.from("settings").upsert(row, { onConflict: "tenant_id,key" });
  if (error) return { ok: false, template: null, error: "write_failed" };
  return { ok: true, template: next };
}

/** Restores the most recent prior version of a kind, as a new version. */
export async function restoreDocumentTemplate(
  db: TemplateDb,
  tenantId: string | null,
  kind: DocumentKind,
  version?: number,
): Promise<SaveResult> {
  const history = await loadTemplateHistory(db, tenantId, kind);
  if (history.length === 0) return { ok: false, template: null, error: "no_history" };
  const target = version ? history.find((h) => h.version === version) : history[0];
  if (!target) return { ok: false, template: null, error: "version_not_found" };
  return saveDocumentTemplate(db, tenantId, { ...target, name: `${target.name} (restored)` });
}
