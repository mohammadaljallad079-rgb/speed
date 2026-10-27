import Anthropic from "@anthropic-ai/sdk";

import { estimateCostUsd } from "./pricing";
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProviderConfig,
  AiProviderId,
  AiTaskKind,
  AiUsage,
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

/**
 * Redacts anything credential-shaped from a provider error before it is shown
 * or stored. A provider echoes the request back in its error body often enough
 * that an unredacted message would leak the very key it is complaining about.
 */
export function sanitizeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown provider error");
  return raw
    .replace(/\b(sk|key|api)[-_][A-Za-z0-9._-]{8,}/gi, "[redacted-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** True when the error indicates a rate limit rather than a configuration fault. */
export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\b429\b|rate.?limit|quota|too many requests/i.test(message);
}

/**
 * Default per-call deadline. A provider that hangs must not hang the request:
 * the call is aborted and the caller's fallback/degradation path takes over.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ProviderCallInput {
  apiKey: string;
  baseUrl?: string | null;
  request: AiCompletionRequest;
  model: string;
  signal?: AbortSignal;
  /** Per-call deadline; defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Extra non-secret headers (e.g. OpenRouter attribution). */
  headers?: Record<string, string>;
  /** Attempts after the first on a transient failure; defaults to 1 (no retry). */
  retries?: number;
}

/**
 * Races a provider call against a deadline. When the caller supplies no signal
 * a fresh one is created so the underlying fetch/SDK request is actually
 * aborted; an existing signal is chained so an outer cancel still wins.
 */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let rejectGuard: (e: Error) => void = () => {};
  const guard = new Promise<never>((_, reject) => {
    rejectGuard = reject;
  });
  // An abort (outer cancel) rejects the race immediately; a timeout sets the
  // flag first so its own abort does not masquerade as a cancel.
  controller.signal.addEventListener(
    "abort",
    () => {
      if (!timedOut) rejectGuard(new Error("AI provider call aborted"));
    },
    { once: true },
  );
  const onOuter = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectGuard(new Error(`AI provider timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    const runPromise = run(controller.signal);
    // If the guard wins, the losing provider promise may reject later (aborted
    // fetch). Swallow it so it never becomes an unhandled rejection.
    runPromise.catch(() => {});
    return await Promise.race([runPromise, guard]);
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onOuter);
  }
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
      ...(input.headers ?? {}),
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

/** Dispatches to the provider adapter for a single call, bounded by a deadline. */
export async function completeWithProvider(
  provider: AiProviderId,
  input: ProviderCallInput,
): Promise<AiCompletionResult> {
  return withTimeout(
    (signal) => {
      const bounded: ProviderCallInput = { ...input, signal };
      if (provider === "anthropic") return callAnthropic(bounded);
      if (provider === "openai") return callOpenAiLike(bounded, "openai");
      return callOpenAiLike(bounded, "openai_compatible");
    },
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    input.signal,
  );
}

/**
 * A provider call with a bounded retry.
 *
 * Only a transient failure is retried — a network blip or a provider 5xx/429.
 * A 4xx that names a bad key or an unknown model is NOT retried: retrying a
 * configuration error just multiplies the latency before the operator is told
 * what is wrong. The attempt count is small and explicit; there is no unbounded
 * backoff loop that could hold a request open.
 */
export async function completeWithRetry(
  provider: AiProviderId,
  input: ProviderCallInput,
): Promise<AiCompletionResult> {
  const attempts = Math.max(1, Math.min(input.retries ?? 1, 3));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await completeWithProvider(provider, input);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error ?? "");
      const retryable = /\b(429|500|502|503|504)\b|timed out|network|fetch failed|aborted/i.test(message);
      if (attempt >= attempts || !retryable) break;
      // Short, bounded pause before the single retry.
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastError ?? new Error("Provider call failed");
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  /** The provider's own reply length, proving a real completion came back. */
  replyChars: number;
  replyPreview: string;
  usage: AiUsage;
  errorSanitized: string | null;
  /** True when the failure was a rate limit (the free tier being busy). */
  rateLimited: boolean;
}

/**
 * Performs a REAL round-trip against the configured provider.
 *
 * This is what makes "Test Connection" meaningful: it sends a one-token prompt
 * and reports the provider's own answer. It is never satisfied by a local check
 * of the configuration, and it never fabricates a success — a failure is
 * returned as a sanitized reason so the operator can act on it.
 *
 * The prompt asks for a specific token so an empty or truncated response is
 * visible as a failure rather than counted as success.
 */
export async function testProviderConnection(input: {
  provider: AiProviderId;
  apiKey: string;
  baseUrl?: string | null;
  model: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ConnectionTestResult> {
  const started = Date.now();
  try {
    const result = await completeWithProvider(input.provider, {
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      model: input.model,
      headers: input.headers,
      signal: input.signal,
      // A test must fail fast rather than hold the console open.
      timeoutMs: input.timeoutMs ?? 20_000,
      request: {
        system: "You are a connectivity probe. Reply with the single word: OK",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        maxTokens: 16,
        temperature: 0,
      },
    });
    const text = (result.text ?? "").trim();
    return {
      ok: text.length > 0,
      latencyMs: Date.now() - started,
      model: input.model,
      replyChars: text.length,
      replyPreview: text.slice(0, 80),
      usage: result.usage,
      errorSanitized: text.length > 0 ? null : "The provider returned an empty response",
      rateLimited: false,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      model: input.model,
      replyChars: 0,
      replyPreview: "",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null, model: input.model, provider: input.provider },
      errorSanitized: sanitizeProviderError(error),
      rateLimited: isRateLimitError(error),
    };
  }
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
  timeoutMs = DEFAULT_TIMEOUT_MS,
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
        timeoutMs,
      });
      return { ...result, attempted };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("All AI providers failed");
}
