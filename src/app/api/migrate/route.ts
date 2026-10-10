import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { logAudit, requireContext, toErrorResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Schema maintenance endpoint.
 *
 * This route executes DDL through the service role, so it is restricted to
 * authenticated administrators. It is intentionally explicit about which
 * statements it will run and never accepts SQL from the request.
 */

const statements = [
  `create table if not exists oil_service_records (id uuid default gen_random_uuid() primary key, car_id uuid references cars(id) on delete cascade, change_date date not null, mileage_at_change integer not null, next_change_km integer default 5000, oil_type text, notes text, created_at timestamptz default now())`,
  `create table if not exists depreciation_schedules (id uuid default gen_random_uuid() primary key, car_id uuid references cars(id) on delete cascade, method text default 'straight_line', useful_life_years integer default 5, salvage_value numeric default 0, annual_rate numeric default 20, start_date date, created_at timestamptz default now())`,
  `alter table rental_contracts add column if not exists foc_days integer default 0`,
  `alter table rental_contracts add column if not exists billable_days integer`,
  `alter table rental_contracts add column if not exists pickup_mileage integer`,
  `alter table rental_contracts add column if not exists dropoff_mileage integer`,
  `alter table rental_contracts add column if not exists allowed_km_per_day integer`,
  `alter table rental_contracts add column if not exists extra_km_charge numeric`,
  `alter table rental_contracts add column if not exists scratch_photos text`,
  `alter table cars add column if not exists battery_capacity_kwh numeric`,
  `alter table cars add column if not exists battery_range_km integer`,
  `alter table cars add column if not exists battery_health_percent numeric`,
  `alter table customers add column if not exists has_police_case boolean default false`,
  `alter table customers add column if not exists police_case_notes text`,
  `alter table invoices add column if not exists rental_days integer`,
  `alter table invoices add column if not exists car_plate text`,
  `alter table payments add column if not exists car_plate text`,
];

export async function GET(request: Request) {
  try {
    // DDL is the highest-privilege operation in the system, so it is disabled
    // unless an operator explicitly opts in AND the caller is the global
    // operator. A company administrator cannot reach it.
    if (process.env.ENABLE_SCHEMA_MIGRATION_ENDPOINT !== "true") {
      return NextResponse.json(
        { error: "Schema migration endpoint is disabled", code: "endpoint_disabled" },
        { status: 404 },
      );
    }

    const context = await requireContext(request, { requireAdmin: true, requireSuperAdmin: true });

    const results: { statement: string; status: string }[] = [];
    for (const sql of statements) {
      const { error } = await supabaseAdmin.rpc("exec_sql", { sql });
      results.push({ statement: sql.slice(0, 50), status: error ? "failed" : "ok" });
    }

    await logAudit(context, {
      action: "settings_change",
      entity: "schema_migration",
      metadata: { statements: statements.length },
    });

    return NextResponse.json({ results });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
