/**
 * Shared AI types.
 *
 * Pure type surface — no infrastructure imports, so it can be used from the
 * server, the browser and tests alike.
 */

export type AiProviderId = "anthropic" | "openai" | "openai_compatible";

/** Task classes route to different models; cost vs. capability trade-off. */
export type AiTaskKind =
  | "analysis" // financial / Excel narrative analysis
  | "assistant" // in-ERP chat answers
  | "report" // report build/format intelligence
  | "repair" // data-quality repair suggestions
  | "development"; // development-request planning

export interface AiProviderConfig {
  provider: AiProviderId;
  /** Present only for self-hosted / gateway providers (openai_compatible). */
  baseUrl?: string | null;
  /** Model id per task class; falls back to `defaultModel`. */
  models?: Partial<Record<AiTaskKind, string>>;
  defaultModel?: string;
  /**
   * Ordered fallback providers, tried when the primary fails. Each entry names
   * a provider and (optionally) an override model.
   */
  fallback?: Array<{ provider: AiProviderId; baseUrl?: string | null; model?: string }>;
  enabled?: boolean;
}

export interface AiSettings {
  provider: AiProviderId;
  /** Legacy single-key field kept for backward compatibility. */
  apiKey: string;
  /** Per-provider keys; the legacy `apiKey` maps to the primary provider. */
  apiKeys?: Partial<Record<AiProviderId, string>>;
  /** Provider base URL for self-hosted / compatible endpoints. */
  baseUrl?: string | null;
  models?: Partial<Record<AiTaskKind, string>>;
  defaultModel?: string;
  fallback?: AiProviderConfig["fallback"];
  enabled?: boolean;
}

export interface AiMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AiCompletionRequest {
  messages: AiMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  system?: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD estimate; null when pricing is unknown for the model. */
  costUsd: number | null;
  model: string;
  provider: AiProviderId;
}

export interface AiCompletionResult {
  text: string;
  usage: AiUsage;
}

/** A single structured fact the assistant may quote, with its provenance. */
export interface AssistantSource {
  label: string;
  value: string | number | null;
  dataset: string;
  /** Human-readable pointer to where the number came from. */
  ref: string;
}

export interface AssistantAnswer {
  answer: string;
  sources: AssistantSource[];
  /** True when the model/provider was unavailable and the answer is data-only. */
  degraded: boolean;
  usage: AiUsage | null;
  provider: AiProviderId | null;
  /** Actions the assistant could take but which need explicit approval. */
  requiresApproval: boolean;
}
