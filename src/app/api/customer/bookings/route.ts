import { NextResponse } from "next/server";

import { requireContext } from "@/lib/auth";
import { toErrorResponse } from "@/lib/auth/errors";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createBooking, type BookingDb, type RentalType } from "@/lib/rental/booking-service";
import { emitContractEvent, type ContractReader } from "@/lib/notifications/emit";
import type { NotificationDb } from "@/lib/notifications/notification-store";

export const dynamic = "force-dynamic";

const RENTAL_TYPES: RentalType[] = ["daily", "weekly", "monthly"];

/**
 * Creates a rental booking for the signed-in customer.
 *
 * The browser supplies only the car, the window and the pickup/drop-off text.
 * The customer id and the company come from the session (`context.customerId`,
 * `context.tenantId`), so a caller cannot book on someone else's behalf, into
 * another company, or pick a car outside their own company — the service rejects
 * a car it cannot resolve within the caller's tenant (422) and an overlapping
 * booking (409) before writing.
 */
export async function POST(request: Request) {
  try {
    const context = await requireContext(request, { allowRoles: ["client"] });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const rentalType = RENTAL_TYPES.includes(body.rental_type as RentalType)
      ? (body.rental_type as RentalType)
      : "daily";

    const booking = await createBooking(
      supabaseAdmin as unknown as BookingDb,
      { tenantId: context.tenantId, customerId: context.customerId },
      {
        carId: String(body.car_id ?? ""),
        startDate: String(body.start_date ?? ""),
        endDate: String(body.end_date ?? ""),
        pickupLocation: String(body.pickup_location ?? ""),
        dropoffLocation: String(body.dropoff_location ?? ""),
        notes: typeof body.notes === "string" ? body.notes : null,
        rentalType,
      },
    );

    // Notify the office that a customer booked. Best-effort and never blocking:
    // a notification store that is not migrated yet must not fail the booking.
    const notified = await emitContractEvent(
      supabaseAdmin as unknown as NotificationDb,
      supabaseAdmin as unknown as ContractReader,
      context.tenantId,
      { event: "booking_new", contractId: booking.id },
    );

    return NextResponse.json({
      id: booking.id,
      contract_number: booking.contractNumber,
      tenant_id: booking.tenantId,
      notified: notified.ok,
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
