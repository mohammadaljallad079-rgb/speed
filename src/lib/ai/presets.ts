import type { AiProviderId } from "./types";

/**
 * Provider presets for the AI Control Center.
 *
 * A preset is the whole configuration a provider needs: the adapter to use, the
 * endpoint, a sensible default model, and the model list the operator may pick
 * from. Keeping them here means adding a provider is a data change, not a code
 * change scattered across the UI and the route.
 *
 * OpenRouter is the intended default. It speaks the OpenAI chat-completions
 * protocol, so it reuses the existing `openai_compatible` adapter — no new
 * dependency, no new code path.
 *
 * `openrouter/free` is a router alias that resolves to a free model. It is the
 * default so a new install cannot accidentally start spending money, and the
 * model stays replaceable from the console. When a free model is rate-limited
 * the request FAILS; the platform never silently upgrades to a paid model,
 * because an unexpected charge is worse than a visible error.
 */

export type PresetId =
  | "openrouter"
  | "openai"
  | "deepseek"
  | "kimi"
  | "custom"
  | "anthropic";

export interface ProviderPreset {
  id: PresetId;
  /** The adapter that actually performs the call. */
  adapter: AiProviderId;
  displayName: string;
  /** Chat-completions base URL (no trailing slash). `null` = adapter default. */
  baseUrl: string | null;
  defaultModel: string;
  /** Suggested models, shown as a datalist. The operator may type any value. */
  models: string[];
  /** Where the operator obtains a key, shown as a hint. */
  keyHintEn: string;
  keyHintAr: string;
  /** True when the endpoint is OpenAI chat-completions compatible. */
  openAiCompatible: boolean;
}

export const PROVIDER_PRESETS: Record<PresetId, ProviderPreset> = {
  openrouter: {
    id: "openrouter",
    adapter: "openai_compatible",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/free",
    models: [
      "openrouter/free",
      "openrouter/auto",
      "meta-llama/llama-3.3-70b-instruct:free",
      "deepseek/deepseek-chat-v3-0324:free",
      "google/gemini-2.0-flash-exp:free",
      "qwen/qwen-2.5-72b-instruct:free",
    ],
    keyHintEn: "Create a key at openrouter.ai/keys",
    keyHintAr: "أنشئ مفتاحًا من openrouter.ai/keys",
    openAiCompatible: true,
  },
  openai: {
    id: "openai",
    adapter: "openai",
    displayName: "OpenAI",
    baseUrl: null,
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
    keyHintEn: "Create a key at platform.openai.com/api-keys",
    keyHintAr: "أنشئ مفتاحًا من platform.openai.com/api-keys",
    openAiCompatible: true,
  },
  deepseek: {
    id: "deepseek",
    adapter: "openai_compatible",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyHintEn: "Create a key at platform.deepseek.com",
    keyHintAr: "أنشئ مفتاحًا من platform.deepseek.com",
    openAiCompatible: true,
  },
  kimi: {
    id: "kimi",
    adapter: "openai_compatible",
    displayName: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "moonshot-v1-8k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "kimi-k2-0711-preview"],
    keyHintEn: "Create a key at platform.moonshot.ai",
    keyHintAr: "أنشئ مفتاحًا من platform.moonshot.ai",
    openAiCompatible: true,
  },
  custom: {
    id: "custom",
    adapter: "openai_compatible",
    displayName: "Custom (OpenAI-compatible)",
    baseUrl: null,
    defaultModel: "",
    models: [],
    keyHintEn: "Any endpoint that implements POST /chat/completions",
    keyHintAr: "أي خدمة تدعم POST /chat/completions",
    openAiCompatible: true,
  },
  anthropic: {
    id: "anthropic",
    adapter: "anthropic",
    displayName: "Anthropic",
    baseUrl: null,
    defaultModel: "claude-sonnet-4-5",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    keyHintEn: "Create a key at console.anthropic.com",
    keyHintAr: "أنشئ مفتاحًا من console.anthropic.com",
    openAiCompatible: false,
  },
};

export const PRESET_IDS = Object.keys(PROVIDER_PRESETS) as PresetId[];

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && (PRESET_IDS as string[]).includes(value);
}

export function getPreset(id: unknown): ProviderPreset {
  return isPresetId(id) ? PROVIDER_PRESETS[id] : PROVIDER_PRESETS.openrouter;
}

/**
 * Resolves the endpoint a call must use.
 *
 * A stored `baseUrl` always wins, because the operator may be pointing at a
 * proxy or a self-hosted gateway; the preset is only the starting suggestion.
 * A custom provider with no base URL is a misconfiguration, reported as such
 * rather than sent to a default host the operator did not choose.
 */
export function resolveBaseUrl(preset: PresetId, storedBaseUrl: string | null | undefined): string | null {
  const explicit = typeof storedBaseUrl === "string" ? storedBaseUrl.trim().replace(/\/+$/, "") : "";
  if (explicit) return explicit;
  return PROVIDER_PRESETS[preset]?.baseUrl ?? null;
}

/**
 * Header hints OpenRouter uses for attribution. They are optional and never
 * carry a secret; sending them keeps the platform identifiable in the provider's
 * dashboard. Other providers ignore unknown headers.
 */
export function attributionHeaders(preset: PresetId): Record<string, string> {
  if (preset !== "openrouter") return {};
  return {
    "HTTP-Referer": "https://speed.harbourconsultancies.com",
    "X-Title": "SPEED ERP",
  };
}
