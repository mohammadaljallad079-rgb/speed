import { scopeToTenantColumn } from "@/lib/auth/policy";
import { getPreset, isPresetId, resolveBaseUrl, type PresetId } from "./presets";
import {
  ENCRYPTION_SETUP_MESSAGE,
  SecretKeyMissingError,
  encryptSecret,
  isEncryptionConfigured,
  maskSecret,
  tryDecryptSecret,
} from "./secret-box";
import { DEFAULT_MODELS, resolveModel } from "./providers";
import type { AiProviderId, AiSettings, AiTaskKind } from "./types";

/**
 * Platform-wide AI provider configuration (the Super Admin control center).
 *
 * This is deliberately SEPARATE from the tenant `ai_settings` row:
 *
 *   - the tenant row (`tenant_id = <uuid>`) is a company's own override;
 *   - the platform row (`tenant_id IS NULL`) is the operator's configuration,
 *     and it is what makes AI work across the whole platform after one save.
 *
 * Secrets are stored ONLY as encrypted envelopes (`enc:v1:…`) produced by
 * `secret-box.ts`. A key is never written in plaintext, never returned to the
 * browser (only a mask), and never logged. If no encryption key is configured
 * the write is refused with an explicit setup requirement — the store never
 * silently downgrades to plaintext.
 *
 * Activation is immediate: the in-process cache is invalidated on save, so the
 * very next AI request builds its routes from the new configuration. No restart,
 * no rebuild, no environment change.
 */

export const PLATFORM_AI_SETTINGS_KEY = "ai_settings";

export interface AiLimits {
  /** Maximum tokens a single company may consume per day. `null` = unlimited. */
  perCompanyDailyTokens: number | null;
  /** Maximum tokens the platform may consume per day. `null` = unlimited. */
  dailyTokens: number | null;
  /** Maximum tokens the platform may consume per calendar month. */
  monthlyTokens: number | null;
  /** Maximum estimated USD spend per day. `null` = unlimited. */
  dailyCostUsd: number | null;
  /** Maximum estimated USD spend per calendar month. */
  monthlyCostUsd: number | null;
}

export interface AiConnectionTest {
  at: string;
  ok: boolean;
  preset: PresetId;
  model: string | null;
  latencyMs: number | null;
  /** Sanitised failure reason. Never contains the key or a raw provider body. */
  errorSanitized: string | null;
  /** Provider-reported text length, proving a real completion was received. */
  replyChars: number | null;
}

export interface PlatformAiConfig {
  enabled: boolean;
  preset: PresetId;
  /** Explicit endpoint; falls back to the preset's default when blank. */
  baseUrl: string | null;
  /** Default model for every task unless a task override exists. */
  defaultModel: string;
  models: Partial<Record<AiTaskKind, string>>;
  /** Encrypted key envelopes, one per preset. Never plaintext. */
  encryptedApiKeys: Partial<Record<PresetId, string>>;
  /**
   * Whether the agent may perform financial writes. Held `false` by default:
   * invoice issuance, reversal and journal posting stay behind the existing
   * approval workflow until tenant isolation and atomic posting are verified.
   */
  allowFinancialWrites: boolean;
  /** The closed set of operations the AI may perform. */
  allowedOperations: string[];
  limits: AiLimits;
  lastTest: AiConnectionTest | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Operations the operator may enable. Writes are separate and off by default. */
export const AI_OPERATIONS = [
  "assistant_chat",
  "business_analysis",
  "fleet_analysis",
  "booking_questions",
  "financial_summary",
  "operational_recommendations",
  "report_builder",
  "data_diagnostics",
] as const;

export const DEFAULT_LIMITS: AiLimits = {
  perCompanyDailyTokens: null,
  dailyTokens: null,
  monthlyTokens: null,
  dailyCostUsd: null,
  monthlyCostUsd: null,
};

export const DEFAULT_PLATFORM_AI_CONFIG: PlatformAiConfig = {
  enabled: false,
  preset: "openrouter",
  baseUrl: null,
  defaultModel: "openrouter/free",
  models: {},
  encryptedApiKeys: {},
  allowFinancialWrites: false,
  allowedOperations: [...AI_OPERATIONS],
  limits: { ...DEFAULT_LIMITS },
  lastTest: null,
  updatedAt: null,
  updatedBy: null,
};

interface SettingsQuery extends PromiseLike<{ data: { value?: unknown } | null; error: unknown }> {
  eq(column: string, value: string): SettingsQuery;
  maybeSingle(): Promise<{ data: { value?: unknown } | null; error: unknown }>;
}

export interface PlatformAiDb {
  from(table: string): {
    select(columns: string): SettingsQuery;
    upsert(row: Record<string, unknown>, options?: { onConflict?: string }): Promise<{ error: unknown }>;
  };
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function sanitizeLimits(raw: unknown): AiLimits {
  const v = (raw ?? {}) as Record<string, unknown>;
  return {
    perCompanyDailyTokens: numOrNull(v.perCompanyDailyTokens),
    dailyTokens: numOrNull(v.dailyTokens),
    monthlyTokens: numOrNull(v.monthlyTokens),
    dailyCostUsd: numOrNull(v.dailyCostUsd),
    monthlyCostUsd: numOrNull(v.monthlyCostUsd),
  };
}

function sanitizeOperations(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...AI_OPERATIONS];
  const allowed = raw.filter((o): o is string => typeof o === "string" && (AI_OPERATIONS as readonly string[]).includes(o));
  // An empty selection would silently disable every read operation; treat it as
  // "all read operations", since writes are gated separately.
  return allowed.length ? allowed : [...AI_OPERATIONS];
}

function sanitizeTest(raw: unknown): AiConnectionTest | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.at !== "string") return null;
  return {
    at: v.at,
    ok: v.ok === true,
    preset: isPresetId(v.preset) ? v.preset : "openrouter",
    model: typeof v.model === "string" ? v.model : null,
    latencyMs: numOrNull(v.latencyMs),
    errorSanitized: typeof v.errorSanitized === "string" ? v.errorSanitized.slice(0, 300) : null,
    replyChars: numOrNull(v.replyChars),
  };
}

/** Normalises a stored/partial object into a complete, safe config. */
export function normalizePlatformConfig(raw: unknown): PlatformAiConfig {
  const value = (raw ?? {}) as Partial<PlatformAiConfig>;
  const preset = isPresetId(value.preset) ? value.preset : "openrouter";
  const encrypted: Partial<Record<PresetId, string>> = {};
  for (const [k, v] of Object.entries(value.encryptedApiKeys ?? {})) {
    if (isPresetId(k) && typeof v === "string" && v) encrypted[k] = v;
  }
  const models: Partial<Record<AiTaskKind, string>> = {};
  for (const [k, v] of Object.entries(value.models ?? {})) {
    if (typeof v === "string" && v.trim()) models[k as AiTaskKind] = v.trim();
  }
  return {
    enabled: value.enabled === true,
    preset,
    baseUrl: typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl.trim() : null,
    defaultModel: typeof value.defaultModel === "string" && value.defaultModel.trim()
      ? value.defaultModel.trim()
      : getPreset(preset).defaultModel,
    models,
    encryptedApiKeys: encrypted,
    allowFinancialWrites: value.allowFinancialWrites === true,
    allowedOperations: sanitizeOperations(value.allowedOperations),
    limits: sanitizeLimits(value.limits),
    lastTest: sanitizeTest(value.lastTest),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : null,
  };
}

// ---------------------------------------------------------------------------
// Instant activation: a short-lived cache with an explicit invalidation hook.
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  value: PlatformAiConfig;
}

const CACHE_TTL_MS = 5_000;
let cache: CacheEntry | null = null;
let cacheGeneration = 0;

/**
 * Drops the cached platform configuration.
 *
 * Called after every successful save so the next AI request — in this process —
 * sees the new provider, model or key immediately. Without it, a long-lived
 * server would keep serving the old routes until the TTL expired.
 */
export function invalidatePlatformAiCache(): void {
  cache = null;
  cacheGeneration += 1;
}

/** Test-only visibility into cache state. */
export function _cacheGeneration(): number {
  return cacheGeneration;
}

export async function loadPlatformAiConfig(
  db: PlatformAiDb,
  options: { useCache?: boolean } = {},
): Promise<PlatformAiConfig> {
  const useCache = options.useCache !== false;
  if (useCache && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const query = scopeToTenantColumn(
    db.from("settings").select("value").eq("key", PLATFORM_AI_SETTINGS_KEY),
    null,
  );
  const { data, error } = await query.maybeSingle();
  if (error || !data?.value) {
    const fallback = { ...DEFAULT_PLATFORM_AI_CONFIG };
    cache = { at: Date.now(), value: fallback };
    return fallback;
  }
  const config = normalizePlatformConfig(data.value);
  cache = { at: Date.now(), value: config };
  return config;
}

export interface SavePlatformAiInput {
  enabled?: boolean;
  preset?: PresetId;
  baseUrl?: string | null;
  defaultModel?: string;
  models?: Partial<Record<AiTaskKind, string>>;
  /** A NEW plaintext key. Omitted/blank means "keep the stored one". */
  apiKey?: string;
  /** Removes the stored key for the given (or current) preset. */
  revokeKey?: boolean;
  allowFinancialWrites?: boolean;
  allowedOperations?: string[];
  limits?: Partial<AiLimits>;
  lastTest?: AiConnectionTest | null;
  updatedBy?: string | null;
}

/**
 * Persists the platform configuration.
 *
 * The only branch that can throw `SecretKeyMissingError` is the one that has a
 * secret to store — and it throws BEFORE the upsert, so an unkeyed server never
 * writes a plaintext credential even transiently.
 */
export async function savePlatformAiConfig(
  db: PlatformAiDb,
  incoming: SavePlatformAiInput,
): Promise<PlatformAiConfig> {
  const existing = await loadPlatformAiConfig(db, { useCache: false });
  const preset = incoming.preset ?? existing.preset;
  const presetChanged = incoming.preset !== undefined && incoming.preset !== existing.preset;

  const encrypted: Partial<Record<PresetId, string>> = { ...existing.encryptedApiKeys };

  if (incoming.revokeKey) {
    delete encrypted[preset];
  }

  const newKey = typeof incoming.apiKey === "string" ? incoming.apiKey.trim() : "";
  if (newKey) {
    if (!isEncryptionConfigured()) {
      // Fail safe: refuse rather than store the credential in the clear.
      throw new SecretKeyMissingError(ENCRYPTION_SETUP_MESSAGE);
    }
    encrypted[preset] = encryptSecret(newKey);
  }

  const models = { ...existing.models, ...(incoming.models ?? {}) };
  const next: PlatformAiConfig = {
    enabled: incoming.enabled ?? existing.enabled,
    preset,
    baseUrl: incoming.baseUrl !== undefined ? (incoming.baseUrl ? incoming.baseUrl.trim().replace(/\/+$/, "") : null) : existing.baseUrl,
    defaultModel: incoming.defaultModel?.trim()
      ? incoming.defaultModel.trim()
      : presetChanged
        ? getPreset(preset).defaultModel
        : existing.defaultModel,
    models,
    encryptedApiKeys: encrypted,
    allowFinancialWrites: incoming.allowFinancialWrites ?? existing.allowFinancialWrites,
    allowedOperations: incoming.allowedOperations ? sanitizeOperations(incoming.allowedOperations) : existing.allowedOperations,
    limits: { ...existing.limits, ...sanitizeLimits({ ...existing.limits, ...(incoming.limits ?? {}) }) },
    lastTest: incoming.lastTest !== undefined ? incoming.lastTest : existing.lastTest,
    updatedAt: new Date().toISOString(),
    updatedBy: incoming.updatedBy ?? null,
  };

  const row: Record<string, unknown> = {
    key: PLATFORM_AI_SETTINGS_KEY,
    value: next,
    updated_at: new Date().toISOString(),
  };
  // Platform scope: the NULL-tenant row. Conflict target matches the settings
  // convention so re-saving replaces the platform row rather than adding one.
  const { error } = await db.from("settings").upsert(row, { onConflict: "tenant_id,key" });
  if (error) throw error;

  invalidatePlatformAiCache();
  cache = { at: Date.now(), value: next };
  return next;
}

/** Decrypts the configured key for a preset, or `null` when unset/unreadable. */
export function platformApiKey(config: PlatformAiConfig, preset: PresetId = config.preset): string | null {
  return tryDecryptSecret(config.encryptedApiKeys[preset]);
}

/** The browser-safe projection: a mask, never the key. */
export interface PublicPlatformAiConfig {
  enabled: boolean;
  preset: PresetId;
  providerDisplayName: string;
  adapter: AiProviderId;
  baseUrl: string | null;
  effectiveBaseUrl: string | null;
  defaultModel: string;
  models: Partial<Record<AiTaskKind, string>>;
  hasApiKey: boolean;
  /** e.g. `sk-or-…4f2a`, or null when no key is stored. */
  apiKeyMask: string | null;
  configuredPresets: PresetId[];
  allowFinancialWrites: boolean;
  allowedOperations: string[];
  limits: AiLimits;
  lastTest: AiConnectionTest | null;
  updatedAt: string | null;
  updatedBy: string | null;
  encryptionConfigured: boolean;
  encryptionSetupMessage: string | null;
}

export function toPublicPlatformConfig(config: PlatformAiConfig): PublicPlatformAiConfig {
  const preset = getPreset(config.preset);
  const plaintext = platformApiKey(config);
  const encryptionConfigured = isEncryptionConfigured();
  return {
    enabled: config.enabled,
    preset: config.preset,
    providerDisplayName: preset.displayName,
    adapter: preset.adapter,
    baseUrl: config.baseUrl,
    effectiveBaseUrl: resolveBaseUrl(config.preset, config.baseUrl) ?? preset.baseUrl,
    defaultModel: config.defaultModel,
    models: config.models,
    hasApiKey: Boolean(config.encryptedApiKeys[config.preset]),
    apiKeyMask: maskSecret(plaintext),
    configuredPresets: Object.keys(config.encryptedApiKeys) as PresetId[],
    allowFinancialWrites: config.allowFinancialWrites,
    allowedOperations: config.allowedOperations,
    limits: config.limits,
    lastTest: config.lastTest,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
    encryptionConfigured,
    encryptionSetupMessage: encryptionConfigured ? null : ENCRYPTION_SETUP_MESSAGE,
  };
}

// ---------------------------------------------------------------------------
// Effective settings: platform config + optional tenant override.
// ---------------------------------------------------------------------------

/**
 * Converts the platform config into the runtime `AiSettings` the providers use.
 *
 * `override` is a tenant's own `ai_settings` row. When the tenant has its own
 * key it wins — a company that brought its own credential is billed for its own
 * usage and is not silently redirected to the platform's provider. When it does
 * not, the platform configuration applies, which is what makes one Super Admin
 * save take effect platform-wide.
 */
export function effectiveAiSettings(
  platform: PlatformAiConfig,
  override?: AiSettings | null,
): AiSettings {
  const platformKey = platformApiKey(platform);

  const overrideKey = override ? override.apiKeys?.[override.provider] ?? override.apiKey ?? "" : "";
  if (overrideKey) {
    return {
      provider: override!.provider,
      apiKey: overrideKey,
      apiKeys: override!.apiKeys,
      baseUrl: override!.baseUrl ?? null,
      models: override!.models,
      defaultModel: override!.defaultModel,
      fallback: [],
      enabled: override!.enabled === true,
    };
  }

  if (!platformKey) {
    return { ...DEFAULT_EMPTY_SETTINGS };
  }

  const preset = getPreset(platform.preset);
  const models: Partial<Record<AiTaskKind, string>> = {};
  for (const task of ["analysis", "assistant", "report", "repair", "development"] as AiTaskKind[]) {
    models[task] = resolveModel(
      { models: platform.models, defaultModel: platform.defaultModel },
      task,
      preset.adapter,
    );
  }
  return {
    provider: preset.adapter,
    apiKey: platformKey,
    apiKeys: { [preset.adapter]: platformKey },
    baseUrl: resolveBaseUrl(platform.preset, platform.baseUrl),
    models,
    defaultModel: platform.defaultModel || DEFAULT_MODELS[preset.adapter],
    fallback: [],
    enabled: platform.enabled === true,
  };
}

const DEFAULT_EMPTY_SETTINGS: AiSettings = {
  provider: "anthropic",
  apiKey: "",
  apiKeys: {},
  baseUrl: null,
  models: {},
  defaultModel: undefined,
  fallback: [],
  enabled: false,
};
