import Anthropic from "@anthropic-ai/sdk";

import { estimateCostUsd } from "./pricing";
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProviderConfig,
  AiProviderId,
  AiTaskKind,
} from "./types";

/**
 * Provider abstraction.
 *
 * The ERP is not hard-wired to one vendor: a provider is a small adapter behind
 * `complete()`. Anthropic is the built-in default (its SDK is already a
 * dependency); OpenAI and any OpenAI-compatible / self-hosted endpoint are
 * reached over HTTP so no new mandatory dependency or paid subscription is
 * introduced. A self-hosted model is selected with `provider:
 * "openai_compatible"` + `baseUrl`, and is not assumed to be free — it still
 * needs the host.
 */

export const DEFAULT_MODELS: Record<AiProviderId, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  openai_compatible: "local-model",
};

const OPENAI_BASE = "https://api.openai.com/v1";

export interface ProviderCallInput {
  apiKey: string;
  baseUrl?: string | null;
  request: AiCompletionRequest;
  model: string;
  signal?: AbortSignal;
}

/** Resolves the model for a task class, falling back to the default model. */
export function resolveModel(
  config: Pick<AiProviderConfig, "models" | "defaultModel">,
  task: AiTaskKind,
  provider: AiProviderId,
): string {
  return config.models?.[task] ?? config.defaultModel ?? DEFAULT_MODELS[provider];
}

async function callAnthropic(input: ProviderCallInput): Promise<AiCompletionResult> {
  const client = new Anthropic({ apiKey: input.apiKey, ...(input.baseUrl ? { baseURL: input.baseUrl } : {}) });
  const { request, model } = input;
  const system = request.system;
  const message = await client.messages.create(
    {
      model,
      max_tokens: request.maxTokens ?? 2000,
      temperature: request.temperature,
      ...(system ? { system } : {}),
      messages: request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    },
    input.signal ? { signal: input.signal } : undefined,
  );
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const inputTokens = message.usage?.input_tokens ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;
  return {
    text,
    usage: {
      inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(model, inputTokens, outputTokens),
      model,
      provider: "anthropic",
    },
  };
}

/** OpenAI chat-completions shape; also used by compatible / self-hosted gateways. */
async function callOpenAiLike(
  input: ProviderCallInput,
  provider: AiProviderId,
): Promise<AiCompletionResult> {
  const { request, model } = input;
  const base = (input.baseUrl || OPENAI_BASE).replace(/\/$/, "");
  const messages = [
    ...(request.system ? [{ role: "system", content: request.system }] : []),
    ...request.messages.filter((m) => m.role !== "system"),
  ];
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: request.maxTokens ?? 2000,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    }),
    signal: input.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Provider ${provider} responded ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = (json.choices?.[0]?.message?.content ?? "").trim();
  const inputTokens = json.usage?.prompt_tokens ?? 0;
  const outputTokens = json.usage?.completion_tokens ?? 0;
  return {
    text,
    usage: {
      inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(model, inputTokens, outputTokens),
      model,
      provider,
    },
  };
}

/** Dispatches to the provider adapter for a single call. */
export async function completeWithProvider(
  provider: AiProviderId,
  input: ProviderCallInput,
): Promise<AiCompletionResult> {
  if (provider === "anthropic") return callAnthropic(input);
  if (provider === "openai") return callOpenAiLike(input, "openai");
  return callOpenAiLike(input, "openai_compatible");
}

export interface RoutedResult extends AiCompletionResult {
  /** Providers tried, in order, before one succeeded. */
  attempted: AiProviderId[];
}

export interface RouteEntry {
  provider: AiProviderId;
  apiKey: string;
  baseUrl?: string | null;
  model: string;
}

/**
 * Tries each route in order and returns the first success. Used so a provider
 * outage degrades to the fallback instead of failing the request.
 */
export async function completeWithFallback(
  routes: RouteEntry[],
  request: AiCompletionRequest,
  signal?: AbortSignal,
): Promise<RoutedResult> {
  if (routes.length === 0) throw new Error("No AI provider is configured");
  const attempted: AiProviderId[] = [];
  let lastError: unknown = null;
  for (const route of routes) {
    attempted.push(route.provider);
    try {
      const result = await completeWithProvider(route.provider, {
        apiKey: route.apiKey,
        baseUrl: route.baseUrl,
        model: route.model,
        request: { ...request, model: route.model },
        signal,
      });
      return { ...result, attempted };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("All AI providers failed");
}
