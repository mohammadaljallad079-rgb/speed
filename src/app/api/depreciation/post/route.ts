import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import {
  calculateDepreciation,
  postDepreciation,
  type DepreciationMethod,
} from "@/lib/accounting/depreciation-posting";
import {
  assertDateInOpenFinancialYear,
  getActiveFinancialYear,
  logAudit,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Post one period of depreciation for an asset.
 *
 * The depreciation screen used to compute a schedule in the browser and write
 * nothing to the ledger, so the P&L overstated profit and the balance sheet
 * carried the vehicle at full cost forever. This route is the single
 * server-side path that turns a schedule into a balanced journal:
 *
 *   Dr Depreciation expense (52001) / Cr Accumulated depreciation (14001)
 *
 * The amount is NOT taken from the request body: it is recomputed here from the
 * schedule and the accumulated depreciation already posted, so a caller cannot
 * charge an arbitrary amount or depreciate an asset twice.
 */

type Body = {
  schedule_id?: string;
  /** Depreciation period end date; defaults to today. */
  entry_date?: string;
  /** Years covered by this charge; defaults to 1 (one full year). */
  period_years?: number | string;
  description?: string | null;
};

const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { module: "accounting", action: "create" });
    const body = ((await request.json()) ?? {}) as Body;

    const scheduleId = body.schedule_id;
    if (!scheduleId || typeof scheduleId !== "string") {
      return NextResponse.json({ error: "schedule_id is required", code: "bad_request" }, { status: 400 });
    }

    const periodYears = body.period_years !== undefined ? Number(body.period_years) : 1;
    if (!Number.isFinite(periodYears) || periodYears <= 0) {
      return NextResponse.json({ error: "period_years must be positive", code: "bad_request" }, { status: 400 });
    }

    const entryDate = body.entry_date ?? new Date().toISOString().slice(0, 10);
    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(year, entryDate, "depreciation date");

    // Load the schedule with its vehicle. Tenant scoping is applied in the query
    // for a tenant-bound caller; a tenant-less install reads NULL-tenant rows.
    // A super admin is the only cross-tenant reader and is never scoped (the
    // same rule as `scopeToCompany`).
    let scheduleQuery = supabaseAdmin
      .from("depreciation_schedules")
      .select("*, car:cars(id,make,model,year,plate_number,purchase_price,purchase_date,tenant_id)")
      .eq("id", scheduleId);
    if (!context.isSuperAdmin) {
      scheduleQuery = context.tenantId
        ? scheduleQuery.eq("tenant_id", context.tenantId)
        : scheduleQuery.is("tenant_id", null);
    }
    const { data: schedule, error: scheduleErr } = await scheduleQuery.maybeSingle();
    if (scheduleErr) throw scheduleErr;
    if (!schedule) {
      return NextResponse.json({ error: "Depreciation schedule not found", code: "not_found" }, { status: 404 });
    }

    const car = (
      schedule as {
        car?: {
          id: string;
          make?: string;
          model?: string;
          year?: number;
          plate_number?: string;
          purchase_price?: number;
        };
      }
    ).car;
    const cost = round3(Number(car?.purchase_price) || 0);
    if (cost <= 0) {
      return NextResponse.json(
        { error: "The vehicle has no purchase price to depreciate", code: "bad_request" },
        { status: 400 },
      );
    }

    const method = (schedule as { method?: DepreciationMethod }).method ?? "straight_line";
    const salvageValue = round3(Number((schedule as { salvage_value?: number }).salvage_value) || 0);
    const usefulLifeYears = Number((schedule as { useful_life_years?: number }).useful_life_years) || 5;
    const annualRate = Number((schedule as { annual_rate?: number }).annual_rate) || 0;

    // Accumulated depreciation is derived from the LEDGER (the posted
    // depreciation journals for this asset), never from a client figure, so the
    // charge can never drive the book value below salvage. It is tenant-scoped
    // too: reading another tenant's depreciation for the same asset id would
    // inflate the accumulated total and wrongly suppress this charge.
    let postedQuery = supabaseAdmin
      .from("journal_entries")
      .select("id")
      .eq("entry_type", "depreciation")
      .like("reference_number", `DEP-${car?.id}-%`);
    if (!context.isSuperAdmin) {
      postedQuery = context.tenantId
        ? postedQuery.eq("tenant_id", context.tenantId)
        : postedQuery.is("tenant_id", null);
    }
    const { data: posted, error: postedErr } = await postedQuery;
    if (postedErr) throw postedErr;
    const postedIds = ((posted as Array<{ id: string }>) || []).map((r) => r.id);

    let accumulatedToDate = 0;
    if (postedIds.length > 0) {
      const { data: lines, error: linesErr } = await supabaseAdmin
        .from("journal_lines")
        .select("debit")
        .in("journal_entry_id", postedIds);
      if (linesErr) throw linesErr;
      accumulatedToDate = round3(
        ((lines as Array<{ debit: number }>) || []).reduce((s, l) => s + (Number(l.debit) || 0), 0),
      );
    }

    const amount = calculateDepreciation(
      { method, cost, salvageValue, usefulLifeYears, annualRate, accumulatedToDate },
      periodYears,
    );
    if (amount <= 0) {
      return NextResponse.json(
        {
          error: "This asset is fully depreciated (or the schedule has no depreciable base)",
          code: "fully_depreciated",
          accumulated_to_date: accumulatedToDate,
        },
        { status: 409 },
      );
    }

    // One posted journal per (asset, period end date). A retry of the same
    // period returns the existing journal instead of charging twice.
    const reference = `DEP-${car?.id}-${entryDate}`;
    const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
    const description =
      (typeof body.description === "string" && body.description) ||
      `Depreciation - ${car?.make ?? ""} ${car?.model ?? ""} ${car?.plate_number ?? ""}`.trim();

    const { journalId, created } = await postDepreciation(supabaseAdmin as never, {
      journalNumber,
      reference,
      date: entryDate,
      description,
      amount,
      tenantId: context.tenantId,
    });

    // On an idempotent re-post nothing was charged, so the accumulated total and
    // book value are unchanged — reporting `accumulated + amount` here would
    // imply a second charge that did not happen.
    const accumulatedAfter = created ? round3(accumulatedToDate + amount) : accumulatedToDate;

    await logAudit(context, {
      action: "depreciation",
      entity: "journal_entries",
      entityId: journalId,
      metadata: {
        schedule_id: scheduleId,
        car_id: car?.id ?? null,
        reference,
        amount,
        accumulated_before: accumulatedToDate,
        accumulated_after: accumulatedAfter,
        method,
        journal_created: created,
      },
    });

    return NextResponse.json({
      journal_id: journalId,
      journal_created: created,
      reference,
      amount,
      accumulated_before: accumulatedToDate,
      accumulated_after: accumulatedAfter,
      book_value_after: round3(cost - accumulatedAfter),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
