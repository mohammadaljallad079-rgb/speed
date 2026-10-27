import { NextResponse } from "next/server";

import { requireContext } from "@/lib/auth";
import { toErrorResponse } from "@/lib/auth/errors";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getCarAvailability, listAvailableCars, type BookingDb } from "@/lib/rental/booking-service";

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
 *
 * An optional `car=<id>` resolves ONE car explicitly (`selected`) — this is what
 * a deep link from the fleet page needs. The list alone cannot serve it: the car
 * may be absent from the list (busy for the window) and the form would silently
 * drop the customer's choice.
 */
export async function GET(request: Request) {
  try {
    const context = await requireContext(request, { allowRoles: ["client"] });
    const url = new URL(request.url);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    const carId = url.searchParams.get("car");

    const db = supabaseAdmin as unknown as BookingDb;

    const [cars, selected] = await Promise.all([
      listAvailableCars(db, { tenantId: context.tenantId, start, end }),
      carId ? getCarAvailability(db, { tenantId: context.tenantId, carId, start, end }) : Promise.resolve(null),
    ]);

    return NextResponse.json({ cars, selected });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
