import { scopeToTenantColumn } from "@/lib/auth/policy";
import { DEFAULT_MODELS, resolveModel, type RouteEntry } from "./providers";
import type { AiProviderId, AiSettings, AiTaskKind } from "./types";

/**
 * AI provider settings.
 *
 * Reuses the existing `settings` key/value table (key `ai_settings`), scoped by
 * `tenant_id` from the authenticated session — never a new table and never a
 * value taken from the request body. Secrets (API keys) live here server-side
 * and are stripped by `toPublicSettings` before anything is returned to the
 * browser.
 */

export const AI_SETTINGS_KEY = "ai_settings";
const PROVIDERS: AiProviderId[] = ["anthropic", "openai", "openai_compatible"];

interface SettingsQuery extends PromiseLike<{ data: { value?: unknown } | null; error: unknown }> {
  eq(column: string, value: string): SettingsQuery;
  maybeSingle(): Promise<{ data: { value?: unknown } | null; error: unknown }>;
}

export interface AiSettingsDb {
  from(table: string): {
    select(columns: string): SettingsQuery;
    upsert(row: Record<string, unknown>, options?: { onConflict?: string }): Promise<{ error: unknown }>;
  };
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "anthropic",
  apiKey: "",
  apiKeys: {},
  baseUrl: null,
  models: {},
  defaultModel: undefined,
  fallback: [],
  enabled: false,
};

function isProvider(v: unknown): v is AiProviderId {
  return typeof v === "string" && (PROVIDERS as string[]).includes(v);
}

/** Normalises a stored/partial settings object into a complete `AiSettings`. */
export function normalizeSettings(raw: unknown): AiSettings {
  const value = (raw ?? {}) as Partial<AiSettings>;
  const provider = isProvider(value.provider) ? value.provider : "anthropic";
  const apiKeys = { ...(value.apiKeys ?? {}) };
  // Migrate the legacy single-key field into the per-provider map.
  if (value.apiKey && !apiKeys[provider]) apiKeys[provider] = value.apiKey;
  const models: Partial<Record<AiTaskKind, string>> = {};
  for (const [k, v] of Object.entries(value.models ?? {})) {
    if (typeof v === "string" && v.trim()) models[k as AiTaskKind] = v.trim();
  }
  const fallback = Array.isArray(value.fallback)
    ? value.fallback
        .filter((f) => f && isProvider(f.provider))
        .slice(0, 3)
        .map((f) => ({ provider: f.provider, baseUrl: f.baseUrl ?? null, model: f.model }))
    : [];
  return {
    provider,
    apiKey: apiKeys[provider] ?? value.apiKey ?? "",
    apiKeys,
    baseUrl: value.baseUrl ?? null,
    models,
    defaultModel: value.defaultModel,
    fallback,
    enabled: value.enabled === true,
  };
}

export async function loadAiSettings(
  db: AiSettingsDb,
  tenantId: string | null,
): Promise<AiSettings> {
  const query = scopeToTenantColumn(db.from("settings").select("value").eq("key", AI_SETTINGS_KEY), tenantId);
  const { data, error } = await query.maybeSingle();
  if (error || !data?.value) return { ...DEFAULT_AI_SETTINGS };
  return normalizeSettings(data.value);
}

export async function saveAiSettings(
  db: AiSettingsDb,
  tenantId: string | null,
  incoming: Partial<AiSettings>,
): Promise<AiSettings> {
  const existing = await loadAiSettings(db, tenantId);
  const merged = normalizeSettings({
    ...existing,
    ...incoming,
    apiKeys: { ...existing.apiKeys, ...(incoming.apiKeys ?? {}) },
    models: { ...existing.models, ...(incoming.models ?? {}) },
  });
  // A blank key on an update means "keep the stored one", never "erase it".
  const keys = merged.apiKeys ?? {};
  if (!keys[merged.provider]) keys[merged.provider] = existing.apiKeys?.[existing.provider] ?? "";
  merged.apiKeys = keys;
  merged.apiKey = keys[merged.provider] ?? "";
  const row: Record<string, unknown> = {
    key: AI_SETTINGS_KEY,
    value: merged,
    updated_at: new Date().toISOString(),
  };
  if (tenantId) row.tenant_id = tenantId;
  // Conflict target matches the canonical settings pattern: settings are keyed
  // per tenant, so two tenants must be able to hold the same key independently.
  const { error } = await db.from("settings").upsert(row, { onConflict: "tenant_id,key" });
  if (error) throw error;
  return merged;
}

/**
 * The browser-safe projection. The API key is replaced by a boolean so the UI
 * can show "configured" without ever receiving the secret.
 */
export interface PublicAiSettings {
  provider: AiProviderId;
  enabled: boolean;
  baseUrl: string | null;
  models: Partial<Record<AiTaskKind, string>>;
  defaultModel: string | null;
  fallback: Array<{ provider: AiProviderId; model?: string }>;
  hasApiKey: boolean;
  availableProviders: AiProviderId[];
}

export function toPublicSettings(settings: AiSettings): PublicAiSettings {
  return {
    provider: settings.provider,
    enabled: settings.enabled === true,
    baseUrl: settings.baseUrl ?? null,
    models: settings.models ?? {},
    defaultModel: settings.defaultModel ?? null,
    fallback: (settings.fallback ?? []).map((f) => ({ provider: f.provider, model: f.model })),
    hasApiKey: Boolean(settings.apiKeys?.[settings.provider] || settings.apiKey),
    availableProviders: PROVIDERS,
  };
}

/**
 * Builds the ordered provider routes for a task: primary first, then any
 * configured fallbacks that actually have a key. Providers without a key are
 * skipped so a missing fallback never blocks the primary.
 */
export function buildRoutes(settings: AiSettings, task: AiTaskKind): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const primaryKey = settings.apiKeys?.[settings.provider] ?? settings.apiKey ?? "";
  if (primaryKey) {
    routes.push({
      provider: settings.provider,
      apiKey: primaryKey,
      baseUrl: settings.baseUrl ?? null,
      model: resolveModel(settings, task, settings.provider),
    });
  }
  for (const fb of settings.fallback ?? []) {
    const key = settings.apiKeys?.[fb.provider] ?? "";
    if (!key) continue;
    routes.push({
      provider: fb.provider,
      apiKey: key,
      baseUrl: fb.baseUrl ?? null,
      model: fb.model ?? resolveModel(settings, task, fb.provider) ?? DEFAULT_MODELS[fb.provider],
    });
  }
  return routes;
}
