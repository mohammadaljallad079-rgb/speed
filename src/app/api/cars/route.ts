import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { nextDocumentNumber } from "@/lib/numbering";
import {
  buildVehiclePurchaseJournal,
  VEHICLE_ACCOUNT_CODES,
} from "@/lib/accounting/vehicle-posting";
import { writeJournal } from "@/lib/accounting/manual-posting";
import {
  assertDateInOpenFinancialYear,
  assertReferences,
  assertWritableTenant,
  getActiveFinancialYear,
  logAudit,
  REF_SUPPLIER,
  requireContext,
  toErrorResponse,
} from "@/lib/auth";

/**
 * Vehicle acquisition.
 *
 * Creates the `cars` row and, when the caller is an administrator and the form
 * describes a purchase, the `car_loans` + `car_loan_installments` rows and the
 * balanced capitalisation journal (Dr 13001 fleet / Cr 11002 down payment /
 * Cr 22001 bank loan). It never recognises revenue. Identity, tenant and the
 * admin check come from the server session; the browser supplies only the car
 * attributes.
 */

type LoanInput = {
  loan_amount?: number | string;
  down_payment?: number | string;
  monthly_installment?: number | string;
  total_installments?: number | string;
  interest_rate?: number | string;
  start_date?: string;
};
type Body = Record<string, unknown> & { loan?: LoanInput };

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const CAR_FIELDS = [
  "plate_number", "make", "model", "year", "color", "vin", "chassis_number",
  "engine_number", "mileage", "category", "fuel_type", "transmission", "seats",
  "location", "status", "insurance_company", "insurance_policy_number",
  "insurance_expiry", "registration_expiry", "daily_rate", "weekly_rate",
  "monthly_rate", "sale_price", "tire_condition", "tire_last_changed",
  "next_service_date", "service_interval_km", "maintenance_vat_rate",
  "battery_capacity_kwh", "battery_range_km", "battery_health_percent", "notes",
  "image_url", "gallery_images", "car_expenses",
] as const;

const ADMIN_FIELDS = [
  "purchase_price", "purchase_date", "purchase_source", "supplier_id",
  "purchase_costs", "maintenance_costs", "salvage_value", "useful_life_years",
  "down_payment", "bank_name", "monthly_installment", "total_installments",
  "remaining_installments", "interest_rate",
] as const;

export async function POST(request: Request) {
  let createdCarId: string | null = null;
  let createdJournalId: string | null = null;
  try {
    const context = await requireContext(request, { module: "cars", action: "create" });
    const body = (await request.json()) as Body;

    if (!body.plate_number || !body.make || !body.model) {
      return NextResponse.json({ error: "plate_number, make and model are required", code: "bad_request" }, { status: 400 });
    }

    const payload: Record<string, unknown> = {};
    for (const f of CAR_FIELDS) if (body[f] !== undefined) payload[f] = body[f];

    // Purchase/financing fields are administrator-only; a non-admin request
    // cannot smuggle them in.
    if (context.isAdmin) {
      for (const f of ADMIN_FIELDS) if (body[f] !== undefined) payload[f] = body[f];
    }

    if (payload.supplier_id) {
      await assertReferences([REF_SUPPLIER], payload, context);
    }

    const tenantId = assertWritableTenant(context, body.tenant_id);
    if (tenantId) payload.tenant_id = tenantId;

    const year = await getActiveFinancialYear(context.tenantId);
    assertDateInOpenFinancialYear(
      year,
      typeof payload.purchase_date === "string" ? payload.purchase_date : null,
      "purchase date",
    );

    const { data: car, error: carErr } = await supabaseAdmin
      .from("cars")
      .insert([payload])
      .select("id,plate_number,make,model,tenant_id")
      .single();
    if (carErr) throw carErr;
    createdCarId = (car as { id: string }).id;

    // Financing is an admin-only, best-effort side effect (as in the legacy screen).
    const loan = body.loan;
    const wantsLoan = context.isAdmin && !!loan && num(loan.loan_amount) > 0 && num(loan.total_installments) > 0;
    if (wantsLoan && loan) {
      try {
        const loanAmount = num(loan.loan_amount);
        const downPayment = num(loan.down_payment);
        const monthlyInstallment = num(loan.monthly_installment);
        const totalInstallments = Math.max(0, Math.floor(num(loan.total_installments)));
        const annualRate = num(loan.interest_rate);
        const monthlyRate = annualRate / 100 / 12;
        const startDate = (typeof loan.start_date === "string" && loan.start_date) || new Date().toISOString().slice(0, 10);

        const loanRow: Record<string, unknown> = {
          car_id: createdCarId,
          loan_amount: loanAmount,
          down_payment: downPayment,
          monthly_installment: monthlyInstallment,
          total_installments: totalInstallments,
          paid_installments: 0,
          start_date: startDate,
          status: "active",
        };
        if (tenantId) loanRow.tenant_id = tenantId;
        const { data: newLoan, error: loanErr } = await supabaseAdmin
          .from("car_loans")
          .insert(loanRow)
          .select("id")
          .single();
        if (loanErr) throw loanErr;
        const loanId = (newLoan as { id: string }).id;

        if (totalInstallments > 0) {
          let balance = loanAmount;
          const installments: Record<string, unknown>[] = [];
          const start = new Date(startDate);
          for (let i = 1; i <= totalInstallments; i++) {
            const interestPortion = balance * monthlyRate;
            let principalPortion = monthlyInstallment - interestPortion;
            if (i === totalInstallments || principalPortion > balance) principalPortion = balance;
            balance = Math.max(0, balance - principalPortion);
            const dueDate = new Date(start);
            dueDate.setMonth(dueDate.getMonth() + i);
            installments.push({
              loan_id: loanId,
              installment_number: i,
              due_date: dueDate.toISOString().slice(0, 10),
              amount: round3(principalPortion + interestPortion),
              paid_amount: 0,
              status: "pending",
            });
          }
          const { error: instErr } = await supabaseAdmin.from("car_loan_installments").insert(installments);
          if (instErr) throw instErr;
        }

        const purchasePrice = num(payload.purchase_price);
        const accountCodes = [VEHICLE_ACCOUNT_CODES.fleet, VEHICLE_ACCOUNT_CODES.bank, VEHICLE_ACCOUNT_CODES.bankLoan];
        let accountQuery = supabaseAdmin.from("accounts").select("id,code,tenant_id").in("code", accountCodes);
        accountQuery = context.tenantId
          ? accountQuery.or(`tenant_id.eq.${context.tenantId},tenant_id.is.null`)
          : accountQuery.is("tenant_id", null);
        const { data: accountRows } = await accountQuery;
        const rows = (accountRows as Array<{ id: string; code: string }>) || [];
        const byCode = (code: string) => rows.find((r) => r.code === code)?.id as string;

        const journalNumber = await nextDocumentNumber(supabaseAdmin as never, "journal_entry", "JV");
        const journal = buildVehiclePurchaseJournal({
          journalNumber,
          reference: (car as { plate_number?: string }).plate_number || createdCarId,
          date: startDate,
          description: `Vehicle purchase ${(car as { make?: string }).make ?? ""} ${(car as { model?: string }).model ?? ""}`.trim(),
          purchasePrice,
          downPayment,
          loanAmount,
          fleetAccountId: byCode(VEHICLE_ACCOUNT_CODES.fleet),
          bankAccountId: byCode(VEHICLE_ACCOUNT_CODES.bank),
          loanAccountId: byCode(VEHICLE_ACCOUNT_CODES.bankLoan),
        });
        if (journal) {
          createdJournalId = await writeJournal(supabaseAdmin as never, journal, context.tenantId);
        }
      } catch (loanErr) {
        // Financing is best-effort: the car is already created and must not be
        // rolled back because the loan/journal failed.
        console.error("Vehicle financing posting failed:", loanErr);
      }
    }

    await logAudit(context, {
      action: "create",
      entity: "cars",
      entityId: createdCarId,
      metadata: { plate_number: payload.plate_number, journal_id: createdJournalId },
    });

    return NextResponse.json({ id: createdCarId, journal_id: createdJournalId });
  } catch (error) {
    if (createdCarId && !createdJournalId) {
      try {
        await supabaseAdmin.from("cars").delete().eq("id", createdCarId);
      } catch {
        /* best effort */
      }
    }
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
