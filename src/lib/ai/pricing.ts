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
};

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
