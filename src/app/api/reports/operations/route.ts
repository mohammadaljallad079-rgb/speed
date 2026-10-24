import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireContext, toErrorResponse } from "@/lib/auth";
import {
  isOperationsReportKind,
  loadOperationsReport,
  type OperationsReportKind,
} from "@/lib/reporting/operations-reports";
import type { ReportingDb } from "@/lib/reporting/data";

/**
 * Operations reports (privileged, service-role, read-only).
 *
 * Backs the four previously-empty report pages. The caller must hold
 * `reports.view`. The tenant filter comes from the session (`requireContext`)
 * and is applied inside `loadOperationsReport` before any narrowing, so a
 * caller can only ever reduce its own result set.
 *
 * GET /api/reports/operations?kind=<kind>&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { module: "reports", action: "view" });
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") ?? "";
    if (!isOperationsReportKind(kind)) {
      return NextResponse.json({ error: "Unknown report", code: "unknown_report" }, { status: 400 });
    }
    const report = await loadOperationsReport(
      supabaseAdmin as unknown as ReportingDb,
      kind as OperationsReportKind,
      {
        tenantId: context.tenantId,
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
      },
    );
    return NextResponse.json(report);
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
