import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * Public vehicle feed for the marketing pages (home, fleet, vehicle detail).
 *
 * These pages are reachable without a session, so they cannot read the `cars`
 * table directly any more: after the core-security migration that table has RLS
 * enabled and no `anon` grant. This route is the sanctioned public read path.
 *
 * It uses the service-role client (which bypasses RLS) but projects an explicit
 * PUBLIC-SAFE column list, so internal commercial data — purchase cost, supplier,
 * VIN/chassis/engine numbers, bank/finance terms, insurance policy, notes — can
 * never leave the server even though the caller is anonymous.
 */

/**
 * The public marketing pages need the catalogue and display fields, so those are
 * projected too. What must never appear: purchase cost / supplier / date,
 * VIN / chassis / engine numbers, insurance and registration terms, maintenance
 * cost and internal notes. Those stay server-side even for an anonymous caller.
 */
const PUBLIC_VEHICLE_COLUMNS = [
  "id",
  "make",
  "model",
  "year",
  "color",
  "category",
  "mileage",
  "status",
  "created_at",
  "daily_rate",
  "weekly_rate",
  "monthly_rate",
  "sale_price",
  "fuel_type",
  "transmission",
  "seats",
  "location",
  "image_url",
  "gallery_images",
  "plate_number",
  "body_type",
  "condition",
  "description",
  "features",
].join(", ");

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const limitParam = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : null;

  if (id) {
    const { data, error } = await supabaseAdmin
      .from("cars")
      .select(PUBLIC_VEHICLE_COLUMNS)
      .eq("id", id)
      .limit(1);

    if (error) {
      return NextResponse.json({ data: null, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ data: (data ?? [])[0] ?? null });
  }

  // The public list is always the available fleet; no caller-controlled status,
  // so the endpoint cannot be used to enumerate other lifecycle states.
  let query = supabaseAdmin
    .from("cars")
    .select(PUBLIC_VEHICLE_COLUMNS)
    .eq("status", "available")
    .order("created_at", { ascending: false });

  if (limit) {
    query = query.limit(limit);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ data: [], error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: data ?? [] });
}
