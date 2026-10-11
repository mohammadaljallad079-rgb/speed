import { completeWithFallback } from "./providers";
import { buildRoutes } from "./settings";
import type { AiCompletionResult, AiMessage, AiSettings, AiTaskKind } from "./types";

/**
 * Server-side glue between stored settings and the provider adapters.
 *
 * Kept separate from `assistant.ts` so the orchestration stays testable with an
 * injected `complete`, while production builds the real one here. This module
 * touches the network/SDK, so it is only imported from route handlers.
 */

export type CompleteFn = (
  task: AiTaskKind,
  messages: AiMessage[],
  system: string,
) => Promise<AiCompletionResult>;

export function makeComplete(settings: AiSettings): CompleteFn | undefined {
  if (settings.enabled !== true) return undefined;
  const routes = buildRoutes(settings, "assistant");
  if (routes.length === 0) return undefined;
  return async (task, messages, system) => {
    const taskRoutes = buildRoutes(settings, task);
    const result = await completeWithFallback(taskRoutes, {
      messages,
      system,
      maxTokens: 2000,
    });
    return { text: result.text, usage: result.usage };
  };
}
