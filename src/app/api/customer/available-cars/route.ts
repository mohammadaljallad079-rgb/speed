import { NextResponse } from "next/server";

import { requireContext } from "@/lib/auth";
import { toErrorResponse } from "@/lib/auth/errors";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getCarAvailability, listAvailableCars, type BookingDb } from "@/lib/rental/booking-service";
import { getCompanyTimezone, type TimezoneDb } from "@/lib/rental/company-timezone";

export const dynamic = "force-dynamic";

/**
 * Cars the signed-in customer may book.
 *
 * Company scope comes from the session (`context.tenantId`) and is applied in the
 * query; the browser cannot widen it. Only a `client` account may call this, and
 * the projection is limited to presentation fields — cost, supplier, VIN and
 * purchase columns are never exposed.
 *
 * An optional `start`/`end` window (with optional `start_time`/`end_time`) hides
 * cars that already hold a blocking booking for that period, so the form shows
 * what is genuinely free. Times are wall-clock in the company's timezone, which is
 * resolved server-side.
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
    const startTime = url.searchParams.get("start_time");
    const end = url.searchParams.get("end");
    const endTime = url.searchParams.get("end_time");
    const carId = url.searchParams.get("car");

    const db = supabaseAdmin as unknown as BookingDb;
    const timeZone = await getCompanyTimezone(
      supabaseAdmin as unknown as TimezoneDb,
      context.tenantId,
    );

    const window = { tenantId: context.tenantId, start, startTime, end, endTime, timeZone };

    const [cars, selected] = await Promise.all([
      listAvailableCars(db, window),
      carId ? getCarAvailability(db, { ...window, carId }) : Promise.resolve(null),
    ]);

    // `timeZone` is returned so the form can label the times it collects. It is
    // presentation data, not a security boundary: the booking route resolves the
    // zone itself and never trusts a client-supplied one.
    return NextResponse.json({ cars, selected, timeZone });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
