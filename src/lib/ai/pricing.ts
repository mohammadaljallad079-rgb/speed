/**
 * Model pricing table (USD per 1M tokens).
 *
 * Used only to *estimate* cost for the AI control dashboard. Values are
 * deliberately conservative and clearly marked as estimates; an unknown model
 * yields `null` rather than a wrong number. Self-hosted models have no API
 * price here — their cost is infrastructure, not per-token.
 */

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic
  "claude-sonnet-4-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-opus-4-1": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
  // OpenAI
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  // DeepSeek / Kimi (OpenAI-compatible providers offered in the console)
  "deepseek-chat": { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
  "moonshot-v1-8k": { inputPerMillion: 0.17, outputPerMillion: 0.17 },
  "moonshot-v1-32k": { inputPerMillion: 0.34, outputPerMillion: 0.34 },
  "moonshot-v1-128k": { inputPerMillion: 0.85, outputPerMillion: 0.85 },
  // OpenRouter free tier. Priced at exactly 0 so the cost dashboard shows the
  // operator the truth: a free model costs nothing and cannot silently bill.
  "openrouter/free": { inputPerMillion: 0, outputPerMillion: 0 },
  "meta-llama/llama-3.3-70b-instruct:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "deepseek/deepseek-chat-v3-0324:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "google/gemini-2.0-flash-exp:free": { inputPerMillion: 0, outputPerMillion: 0 },
  "qwen/qwen-2.5-72b-instruct:free": { inputPerMillion: 0, outputPerMillion: 0 },
};

/** True when a model is known to be free, so a paid fallback is never implied. */
export function isFreeModel(model: string): boolean {
  const price = MODEL_PRICES[model];
  if (price) return price.inputPerMillion === 0 && price.outputPerMillion === 0;
  return model.endsWith(":free") || model === "openrouter/free";
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  const cost =
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion;
  // Round to 6 decimals so small calls do not collapse to 0.
  return Math.round(cost * 1e6) / 1e6;
}
