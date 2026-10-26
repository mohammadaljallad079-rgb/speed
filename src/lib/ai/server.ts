import { completeWithFallback, type RouteEntry } from "./providers";
import { buildRoutes, loadAiSettings } from "./settings";
import { effectiveAiSettings, loadPlatformAiConfig, type PlatformAiDb } from "./platform-settings";
import type { AiCompletionResult, AiMessage, AiSettings, AiTaskKind } from "./types";

/**
 * Server-side glue between stored settings and the provider adapters.
 *
 * Kept separate from `assistant.ts` so the orchestration stays testable with an
 * injected `complete`, while production builds the real one here. This module
 * touches the network/SDK, so it is only imported from route handlers.
 *
 * Resolution order, which is what makes a single Super Admin save take effect
 * platform-wide without a restart:
 *
 *   1. a company's own `ai_settings` key, when the company supplied one;
 *   2. otherwise the PLATFORM configuration the Super Admin saved.
 *
 * The platform configuration is cached for a few seconds and the cache is
 * invalidated on save, so a change is visible to the very next request.
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

export interface ResolvedAi {
  settings: AiSettings;
  /** Where the effective configuration came from. */
  source: "tenant" | "platform" | "none";
}

/**
 * Resolves the effective AI settings for a caller.
 *
 * A company that configured its own key keeps it; everyone else inherits the
 * platform configuration. When neither exists the result is a disabled config
 * and `makeComplete` returns `undefined`, so the assistant degrades to its
 * deterministic answer instead of failing.
 */
export async function resolveEffectiveAi(
  db: PlatformAiDb,
  tenantId: string | null,
): Promise<ResolvedAi> {
  const tenant = await loadAiSettings(db as never, tenantId);
  const platform = await loadPlatformAiConfig(db);
  const effective = effectiveAiSettings(platform, tenant);

  const tenantHasKey = Boolean(tenant.apiKeys?.[tenant.provider] || tenant.apiKey);
  if (tenantHasKey && tenant.enabled === true) return { settings: effective, source: "tenant" };
  if (platform.enabled === true) return { settings: effective, source: "platform" };
  // Neither is enabled: report "none" so the caller knows AI is off rather than
  // misconfigured.
  return { settings: { ...effective, enabled: false }, source: "none" };
}

/** The provider routes for a task, given resolved settings. */
export function routesFor(settings: AiSettings, task: AiTaskKind): RouteEntry[] {
  return buildRoutes(settings, task);
}
