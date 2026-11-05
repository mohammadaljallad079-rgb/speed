import { NextResponse } from "next/server";

import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  dueDateNotifications,
  NOTIFICATION_LABELS,
  sortByUrgency,
} from "@/lib/notifications/notifications";
import { emitContractEvent, isContractEvent, type ContractReader } from "@/lib/notifications/emit";
import {
  insertNotifications,
  listNotifications,
  markNotificationRead,
  type NotificationDb,
} from "@/lib/notifications/notification-store";

/**
 * Notifications API (Execution 58).
 *
 * GET  ?op=list            -> the tenant's notifications, newest first.
 * GET  ?op=catalog         -> the notification kinds + labels.
 * POST ?op=scan            -> runs the deterministic date rules and stores what
 *                             is due (idempotent: a re-run inserts nothing new).
 * POST ?op=read            -> marks one notification read (tenant-scoped).
 *
 * Identity, tenant and permissions come from the session via `requireContext`.
 * The scan reads operational tables and performs an idempotent insert into the
 * notification store; it never touches the ledger. Before migration 012 is
 * applied the store reports `table_missing` and the API degrades instead of
 * failing.
 */

export const dynamic = "force-dynamic";

const db = supabaseAdmin as unknown as NotificationDb;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { requireErp: true });
    const url = new URL(request.url);
    const op = url.searchParams.get("op") ?? "list";

    if (op === "catalog") {
      return NextResponse.json({
        success: true,
        kinds: Object.entries(NOTIFICATION_LABELS).map(([kind, label]) => ({ kind, ...label })),
      });
    }

    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
    const unreadOnly = url.searchParams.get("unread") === "1";
    const result = await listNotifications(db, context.tenantId, null, { limit, unreadOnly });
    if (!result.ok) {
      // The table is absent (012 not applied) or unreadable: return an empty,
      // flagged list rather than a 500, so a page still renders.
      return NextResponse.json({
        success: true,
        available: false,
        reason: result.error ?? "unavailable",
        notifications: [],
        unread: 0,
      });
    }
    return NextResponse.json({
      success: true,
      available: true,
      unread: result.unread,
      notifications: sortByUrgency(
        result.records.map((r) => ({
          id: r.id,
          kind: r.kind,
          titleAr: r.titleAr,
          titleEn: r.titleEn,
          bodyAr: r.bodyAr,
          bodyEn: r.bodyEn,
          severity: r.severity,
          entity: r.entity,
          entityId: r.entityId,
          dueDate: r.dueDate,
          readAt: r.readAt,
          createdAt: r.createdAt,
        })),
      ),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { requireErp: true });
    const url = new URL(request.url);
    const op = url.searchParams.get("op") ?? "scan";

    if (op === "read") {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) {
        return NextResponse.json({ success: false, error: "An id is required", code: "bad_request" }, { status: 400 });
      }
      const res = await markNotificationRead(db, context.tenantId, null, id);
      if (!res.ok) {
        return NextResponse.json({ success: false, error: res.error, code: res.error ?? "failed" }, { status: 409 });
      }
      return NextResponse.json({ success: true });
    }

    if (op === "emit") {
      // A real-time operational event (a booking was created/confirmed/cancelled,
      // an extension was requested/decided). The body names the event and the
      // contract; the notification CONTENT is rebuilt from the contract row the
      // server reads, tenant-scoped - the client cannot inject a title, a tenant
      // or a recipient. The logic lives in `@/lib/notifications/emit` so the
      // customer booking route and this endpoint share one rule.
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const event = body.event;
      const contractId = typeof body.contractId === "string" ? body.contractId : "";
      if (!isContractEvent(event) || !contractId) {
        return NextResponse.json({ success: false, error: "event and contractId are required", code: "bad_request" }, { status: 400 });
      }

      const result = await emitContractEvent(
        db,
        supabaseAdmin as unknown as ContractReader,
        context.tenantId,
        {
          event,
          contractId,
          newEndDate: typeof body.newEndDate === "string" ? body.newEndDate : null,
          approved: body.approved === true,
        },
      );

      await logAudit(context, {
        action: "create",
        entity: "notifications",
        entityId: contractId,
        metadata: { event, inserted: result.inserted, skipped: result.skipped, reason: result.error },
      });
      return NextResponse.json({
        success: result.ok,
        available: result.ok,
        inserted: result.inserted,
        skipped: result.skipped,
        reason: result.error,
      });
    }

    if (op === "scan") {
      // Read the operational rows the date rules need, scoped to the tenant.
      const contractsQuery = supabaseAdmin
        .from("rental_contracts")
        .select("id, contract_number, status, end_date");
      const contractsRes = context.tenantId
        ? await contractsQuery.eq("tenant_id", context.tenantId)
        : await contractsQuery;
      const carsQuery = supabaseAdmin
        .from("cars")
        .select("id, plate_number, registration_expiry, insurance_expiry");
      const carsRes = context.tenantId ? await carsQuery.eq("tenant_id", context.tenantId) : await carsQuery;

      const candidates = dueDateNotifications({
        today: today(),
        contracts: (contractsRes.data ?? []) as Parameters<typeof dueDateNotifications>[0]["contracts"],
        vehicles: (carsRes.data ?? []) as Parameters<typeof dueDateNotifications>[0]["vehicles"],
      });

      const inserted = await insertNotifications(db, context.tenantId, null, candidates);

      await logAudit(context, {
        action: "update",
        entity: "notifications",
        entityId: "scan",
        metadata: {
          candidates: candidates.length,
          inserted: inserted.inserted,
          skipped: inserted.skipped,
          ok: inserted.ok,
          reason: inserted.error ?? null,
        },
      });

      return NextResponse.json({
        success: true,
        available: inserted.ok || inserted.inserted > 0,
        candidates: candidates.length,
        inserted: inserted.inserted,
        skipped: inserted.skipped,
        reason: inserted.error ?? null,
      });
    }

    return NextResponse.json({ success: false, error: "Unknown operation", code: "bad_request" }, { status: 400 });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
