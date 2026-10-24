import { NextResponse } from "next/server";

import { requireContext } from "@/lib/auth";
import { toErrorResponse } from "@/lib/auth/errors";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { listAvailableCars, type BookingDb } from "@/lib/rental/booking-service";

export const dynamic = "force-dynamic";

/**
 * Cars the signed-in customer may book.
 *
 * Company scope comes from the session (`context.tenantId`) and is applied in the
 * query; the browser cannot widen it. Only a `client` account may call this, and
 * the projection is limited to presentation fields — cost, supplier, VIN and
 * purchase columns are never exposed.
 *
 * An optional `start`/`end` window hides cars that already hold a blocking
 * booking for that period, so the form shows what is genuinely free.
 */
export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { allowRoles: ["client"] });
    const url = new URL(request.url);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");

    const cars = await listAvailableCars(supabaseAdmin as unknown as BookingDb, {
      tenantId: context.tenantId,
      start,
      end,
    });

    return NextResponse.json({ cars });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
