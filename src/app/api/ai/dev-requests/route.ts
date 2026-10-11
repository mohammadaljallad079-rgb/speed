import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  buildPatchArtifact,
  createDevRequest,
  decideDevRequest,
  loadDevRequests,
  persistDevRequest,
  type DevRequestDb,
} from "@/lib/ai/dev-requests";

/**
 * Development-request workflow endpoint.
 *
 * Administrator-only. It records a request, produces a scoped plan and an
 * approval decision, and can render a review-only patch artifact. It never
 * executes code, git or shell, and never applies a change — a human does that on
 * a branch. High-risk requests additionally require a global super admin.
 */

export const dynamic = "force-dynamic";

const db = supabaseAdmin as unknown as DevRequestDb;

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "settings", action: "view", requireAdmin: true });
    const requests = await loadDevRequests(db, context.tenantId);
    return NextResponse.json({
      success: true,
      requests: requests.map((r) => ({
        id: r.id,
        title: r.title,
        risk: r.risk,
        status: r.status,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        affectedPaths: r.affectedPaths,
      })),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "settings", action: "edit", requireAdmin: true });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "create");

    if (action === "create") {
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) {
        return NextResponse.json({ error: "A development request is required", code: "bad_request" }, { status: 400 });
      }
      const created = createDevRequest(prompt, context.email ?? "", new Date(), body.baseCommit ? String(body.baseCommit) : null);
      await persistDevRequest(db, context.tenantId, created);
      await logAudit(context, {
        action: "create",
        entity: "ai_dev_request",
        entityId: created.id,
        metadata: { risk: created.risk, status: created.status, paths: created.affectedPaths },
      });
      return NextResponse.json({ success: true, request: created });
    }

    const id = String(body.id ?? "");
    if (!id) {
      return NextResponse.json({ error: "Request id required", code: "bad_request" }, { status: 400 });
    }
    const requests = await loadDevRequests(db, context.tenantId);
    const existing = requests.find((r) => r.id === id);
    if (!existing) {
      return NextResponse.json({ error: "Request not found", code: "not_found" }, { status: 404 });
    }

    if (action === "approve" || action === "reject") {
      const updated = decideDevRequest(
        existing,
        action,
        { email: context.email ?? "", isSuperAdmin: context.isSuperAdmin, isAdmin: context.isAdmin },
        body.note ? String(body.note).slice(0, 500) : null,
      );
      await persistDevRequest(db, context.tenantId, updated);
      await logAudit(context, {
        action: "update",
        entity: "ai_dev_request",
        entityId: id,
        metadata: { decision: action, risk: updated.risk },
      });
      return NextResponse.json({ success: true, request: updated });
    }

    if (action === "artifact") {
      // Review-only. Rendering an artifact never applies anything.
      const artifact = buildPatchArtifact(existing);
      return NextResponse.json({ success: true, artifact });
    }

    return NextResponse.json({ error: "Unknown action", code: "bad_request" }, { status: 400 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
