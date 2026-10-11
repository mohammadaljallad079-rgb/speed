import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { AGENTS, resolveAgent } from "@/lib/ai/agents";
import { allowedTools } from "@/lib/ai/policy";
import { loadAiSettings, saveAiSettings, toPublicSettings } from "@/lib/ai/settings";
import type { AiProviderId, AiTaskKind } from "@/lib/ai/types";

/**
 * AI control settings.
 *
 * GET is available to any user who can view settings so the assistant UI can
 * learn whether AI is enabled — but it never returns the API key (only a
 * boolean). Writes require an administrator and `settings.edit`. The tenant
 * always comes from the session; nothing here is read from the body.
 */

export const dynamic = "force-dynamic";

const TASKS: AiTaskKind[] = ["analysis", "assistant", "report", "repair", "development"];
const PROVIDERS: AiProviderId[] = ["anthropic", "openai", "openai_compatible"];

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "settings", action: "view" });
    const settings = await loadAiSettings(supabaseAdmin as never, context.tenantId);
    const agents = AGENTS.map((a) => {
      const effective = resolveAgent(context, a.id);
      return {
        id: a.id,
        nameEn: a.nameEn,
        nameAr: a.nameAr,
        task: a.task,
        requiresHumanReview: a.requiresHumanReview,
        descriptionEn: a.descriptionEn,
        descriptionAr: a.descriptionAr,
        allowedTools: effective ? effective.tools.map((t) => t.name) : [],
      };
    });
    return NextResponse.json({
      success: true,
      settings: toPublicSettings(settings),
      agents,
      myTools: allowedTools(context).map((t) => ({ name: t.name, module: t.module, description: t.description })),
      tasks: TASKS,
      providers: PROVIDERS,
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await requireContext(request, { module: "settings", action: "edit", requireAdmin: true });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const incoming: Parameters<typeof saveAiSettings>[2] = {};
    if (body.provider !== undefined) {
      const p = String(body.provider) as AiProviderId;
      if (!PROVIDERS.includes(p)) {
        return NextResponse.json({ error: "Unknown provider", code: "bad_request" }, { status: 400 });
      }
      incoming.provider = p;
    }
    if (body.enabled !== undefined) incoming.enabled = body.enabled === true;
    if (body.baseUrl !== undefined) incoming.baseUrl = body.baseUrl ? String(body.baseUrl) : null;
    if (body.defaultModel !== undefined) incoming.defaultModel = body.defaultModel ? String(body.defaultModel) : undefined;
    if (body.models && typeof body.models === "object") {
      const models: Partial<Record<AiTaskKind, string>> = {};
      for (const [k, v] of Object.entries(body.models as Record<string, unknown>)) {
        if (TASKS.includes(k as AiTaskKind) && typeof v === "string" && v.trim()) models[k as AiTaskKind] = v.trim();
      }
      incoming.models = models;
    }
    if (body.fallback && Array.isArray(body.fallback)) {
      incoming.fallback = (body.fallback as Array<Record<string, unknown>>)
        .filter((f) => f && PROVIDERS.includes(String(f.provider) as AiProviderId))
        .slice(0, 3)
        .map((f) => ({
          provider: String(f.provider) as AiProviderId,
          baseUrl: f.baseUrl ? String(f.baseUrl) : null,
          model: f.model ? String(f.model) : undefined,
        }));
    }
    // An API key is written but never read back. A blank string is ignored so a
    // form save cannot accidentally erase a stored key.
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      const provider = incoming.provider ?? (body.provider ? (String(body.provider) as AiProviderId) : undefined);
      const current = await loadAiSettings(supabaseAdmin as never, context.tenantId);
      const target = provider ?? current.provider;
      incoming.apiKeys = { [target]: body.apiKey.trim() } as Partial<Record<AiProviderId, string>>;
    }

    const saved = await saveAiSettings(supabaseAdmin as never, context.tenantId, incoming);
    await logAudit(context, {
      action: "update",
      entity: "ai_settings",
      metadata: {
        provider: saved.provider,
        enabled: saved.enabled === true,
        has_key: Boolean(saved.apiKeys?.[saved.provider]),
        // The key value is never logged.
      },
    });
    return NextResponse.json({ success: true, settings: toPublicSettings(saved) });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
