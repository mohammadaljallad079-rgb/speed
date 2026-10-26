import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { attributionHeaders, getPreset, isPresetId, PRESET_IDS, PROVIDER_PRESETS, resolveBaseUrl } from "@/lib/ai/presets";
import {
  AI_OPERATIONS,
  loadPlatformAiConfig,
  platformApiKey,
  savePlatformAiConfig,
  toPublicPlatformConfig,
  type PlatformAiDb,
  type SavePlatformAiInput,
} from "@/lib/ai/platform-settings";
import { SecretKeyMissingError } from "@/lib/ai/secret-box";
import { testProviderConnection } from "@/lib/ai/providers";
import { summarizeUsage, type UsageDb } from "@/lib/ai/usage";
import type { AiTaskKind } from "@/lib/ai/types";

export const dynamic = "force-dynamic";

/**
 * The Super Admin AI Control Center.
 *
 * Global-only (`requireSuperAdmin`). It is the ONLY place the platform's AI
 * provider credential is written, and it is the reason an operator can enable
 * AI without touching source code, environment variables or a rebuild:
 *
 *   GET   -> the browser-safe configuration (a masked key, never the secret),
 *            the provider catalogue and the usage/cost summary.
 *   PATCH -> validate + persist, invalidate the config cache, and report.
 *   POST  -> `op=test` performs a REAL round-trip to the configured provider.
 *
 * Every write is audited. The audit records which provider/model changed and
 * WHETHER a key was set — never the key itself.
 */

const TASKS: AiTaskKind[] = ["analysis", "assistant", "report", "repair", "development"];

function db(): PlatformAiDb {
  return supabaseAdmin as unknown as PlatformAiDb;
}

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { requireSuperAdmin: true });
    const config = await loadPlatformAiConfig(db());
    const usage = await summarizeUsage(supabaseAdmin as unknown as UsageDb, { allTenants: true });

    return NextResponse.json({
      success: true,
      settings: toPublicPlatformConfig(config),
      presets: PRESET_IDS.map((id) => {
        const p = PROVIDER_PRESETS[id];
        return {
          id: p.id,
          displayName: p.displayName,
          adapter: p.adapter,
          baseUrl: p.baseUrl,
          defaultModel: p.defaultModel,
          models: p.models,
          keyHintEn: p.keyHintEn,
          keyHintAr: p.keyHintAr,
          openAiCompatible: p.openAiCompatible,
        };
      }),
      operations: AI_OPERATIONS,
      tasks: TASKS,
      usage,
      // Financial writes stay off until the isolation + atomic-posting
      // prerequisites are independently verified; the UI shows them disabled.
      financialWritesAvailable: false,
      financialWritesReason:
        "Financial AI writes remain disabled until tenant isolation and atomic journal posting (migration 011) are verified on the live database.",
      actor: { email: context.email, role: context.role },
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await requireContext(request, { requireSuperAdmin: true });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const incoming: SavePlatformAiInput = { updatedBy: context.email ?? context.authUserId };

    if (body.preset !== undefined) {
      if (!isPresetId(body.preset)) {
        return NextResponse.json({ error: "Unknown provider preset", code: "bad_request" }, { status: 400 });
      }
      incoming.preset = body.preset;
    }
    if (body.enabled !== undefined) incoming.enabled = body.enabled === true;
    if (body.baseUrl !== undefined) incoming.baseUrl = body.baseUrl ? String(body.baseUrl) : null;
    if (body.defaultModel !== undefined) incoming.defaultModel = String(body.defaultModel);
    if (body.allowFinancialWrites !== undefined) {
      // Deliberately ignored until the prerequisite is verified: a request body
      // must not be able to switch on financial writes.
      incoming.allowFinancialWrites = false;
    }
    if (body.allowedOperations !== undefined) {
      incoming.allowedOperations = Array.isArray(body.allowedOperations)
        ? (body.allowedOperations as unknown[]).filter((o): o is string => typeof o === "string")
        : [];
    }
    if (body.models && typeof body.models === "object") {
      const models: Partial<Record<AiTaskKind, string>> = {};
      for (const [k, v] of Object.entries(body.models as Record<string, unknown>)) {
        if (TASKS.includes(k as AiTaskKind) && typeof v === "string" && v.trim()) {
          models[k as AiTaskKind] = v.trim();
        }
      }
      incoming.models = models;
    }
    if (body.limits && typeof body.limits === "object") {
      const l = body.limits as Record<string, unknown>;
      const pick = (k: string) => (l[k] === null || l[k] === "" || l[k] === undefined ? null : Number(l[k]));
      incoming.limits = {
        perCompanyDailyTokens: pick("perCompanyDailyTokens"),
        dailyTokens: pick("dailyTokens"),
        monthlyTokens: pick("monthlyTokens"),
        dailyCostUsd: pick("dailyCostUsd"),
        monthlyCostUsd: pick("monthlyCostUsd"),
      };
    }
    if (body.revokeKey === true) incoming.revokeKey = true;
    // The key is written and never read back. A blank value keeps the stored one.
    if (typeof body.apiKey === "string" && body.apiKey.trim()) incoming.apiKey = body.apiKey.trim();

    const saved = await savePlatformAiConfig(db(), incoming);

    await logAudit(context, {
      action: "update",
      entity: "ai_platform_settings",
      metadata: {
        preset: saved.preset,
        enabled: saved.enabled,
        default_model: saved.defaultModel,
        has_key: Boolean(saved.encryptedApiKeys[saved.preset]),
        key_changed: Boolean(incoming.apiKey),
        key_revoked: incoming.revokeKey === true,
        // The key value is never logged — `sanitizeMetadata` would strip it, and
        // it is not placed in the object at all.
      },
    });

    return NextResponse.json({ success: true, settings: toPublicPlatformConfig(saved) });
  } catch (error) {
    if (error instanceof SecretKeyMissingError) {
      // Fail safe with an actionable setup requirement rather than a 500.
      return NextResponse.json(
        { error: error.message, code: error.code, setupRequired: true },
        { status: 409 },
      );
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

/**
 * `op=test` — a REAL provider round-trip.
 *
 * It tests the key currently in effect: a key supplied in the body is used for
 * this call only and is never persisted, which lets the operator verify a
 * credential before committing it. A failure is reported with a sanitized
 * reason; a success reports the provider's own latency and reply length.
 */
export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { requireSuperAdmin: true });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const op = String(body.op ?? "test");
    if (op !== "test") {
      return NextResponse.json({ error: "Unknown operation", code: "bad_request" }, { status: 400 });
    }

    const config = await loadPlatformAiConfig(db(), { useCache: false });
    const preset = isPresetId(body.preset) ? body.preset : config.preset;
    const presetDef = getPreset(preset);

    const supplied = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const apiKey = supplied || platformApiKey(config, preset) || "";
    if (!apiKey) {
      return NextResponse.json(
        {
          success: false,
          ok: false,
          error: "No API key is configured for this provider",
          code: "missing_key",
        },
        { status: 400 },
      );
    }

    const model = (typeof body.model === "string" && body.model.trim())
      ? body.model.trim()
      : config.defaultModel || presetDef.defaultModel;
    if (!model) {
      return NextResponse.json(
        { success: false, ok: false, error: "No model is selected", code: "missing_model" },
        { status: 400 },
      );
    }

    const baseUrl = resolveBaseUrl(preset, typeof body.baseUrl === "string" ? body.baseUrl : config.baseUrl);
    if (presetDef.openAiCompatible && !baseUrl) {
      return NextResponse.json(
        { success: false, ok: false, error: "This provider requires a base URL", code: "missing_base_url" },
        { status: 400 },
      );
    }

    const result = await testProviderConnection({
      provider: presetDef.adapter,
      apiKey,
      baseUrl,
      model,
      headers: attributionHeaders(preset),
    });

    const lastTest = {
      at: new Date().toISOString(),
      ok: result.ok,
      preset,
      model,
      latencyMs: result.latencyMs,
      errorSanitized: result.errorSanitized,
      replyChars: result.replyChars,
    };

    // Only a test against the SAVED configuration is recorded on the config; a
    // test with a one-off key would otherwise report a state that is not stored.
    if (!supplied) {
      await savePlatformAiConfig(db(), { lastTest, updatedBy: context.email ?? context.authUserId });
    }

    await logAudit(context, {
      action: result.ok ? "update" : "export",
      entity: "ai_platform_connection_test",
      metadata: {
        preset,
        model,
        ok: result.ok,
        latency_ms: result.latencyMs,
        rate_limited: result.rateLimited,
        // The reason is already sanitized; it can never contain the key.
        error: result.errorSanitized,
      },
    });

    return NextResponse.json({
      success: true,
      ok: result.ok,
      latencyMs: result.latencyMs,
      model,
      provider: presetDef.displayName,
      replyChars: result.replyChars,
      replyPreview: result.replyPreview,
      error: result.errorSanitized,
      rateLimited: result.rateLimited,
      usage: result.usage,
      lastTest,
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
