import { ApiError, badRequest, invalidReference } from "../auth/errors";
import { nextDocumentNumber } from "../numbering";

/**
 * Customer self-service booking core.
 *
 * Pure of transport and of the concrete database: it reaches the database only
 * through the injectable `BookingDb` port, so the availability, tenant-scoping,
 * pricing and double-booking rules can be exercised against a PostgREST-like
 * recording stub. Production passes the service-role client.
 *
 * Identity and company scope are never read from the request: the route resolves
 * them from the authenticated session and passes them in here. Every read and
 * write is scoped by the resolved tenant, mirroring the RLS predicate
 * (`tenant_id is not distinct from <tenant>`): a tenant-less caller only ever
 * sees tenant-less rows, a tenant-bound caller only its own.
 */

type Row = Record<string, unknown>;
type QueryResult = { data: unknown; error: unknown };

export interface BookingQuery extends PromiseLike<QueryResult> {
  select(columns?: string): BookingQuery;
  eq(column: string, value: unknown): BookingQuery;
  is(column: string, value: null): BookingQuery;
  in(column: string, values: readonly string[]): BookingQuery;
  order(column: string, options?: { ascending?: boolean }): BookingQuery;
  limit(count: number): BookingQuery;
  maybeSingle(): Promise<QueryResult>;
  insert(rows: Row | Row[]): BookingQuery;
  single(): Promise<QueryResult>;
}

export interface BookingDb {
  from(table: string): BookingQuery;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<QueryResult>;
}

/** A rental document as presented to the customer portal (safe projection). */
export type AvailableCar = {
  id: string;
  make: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  category: string | null;
  seats: number | null;
  transmission: string | null;
  fuel_type: string | null;
  image_url: string | null;
  location: string | null;
  daily_rate: number | null;
  weekly_rate: number | null;
  monthly_rate: number | null;
};

export type RentalType = "daily" | "weekly" | "monthly";

export type BookingScope = {
  /** Company (tenant) the caller may book in. `null` = the tenant-less install. */
  tenantId: string | null;
  /** The caller's own `customers.id` (from the session), never from the body. */
  customerId: string | null;
};

export type CreateBookingInput = {
  carId: string;
  startDate: string;
  endDate: string;
  pickupLocation: string;
  dropoffLocation: string;
  notes?: string | null;
  rentalType?: RentalType;
};

export type CreatedBooking = {
  id: string;
  contractNumber: string;
  tenantId: string | null;
};

/**
 * A car is rentable when it is a rental vehicle and is not in a permanently
 * unavailable state.
 *
 * Availability is NOT read off `cars.status`. That flag is a denormalised cache
 * that the application only ever sets to `rented` and never resets when a rental
 * finishes, so a car that completed a contract stays `rented` forever and would
 * disappear from the booking list permanently. The authoritative "is this car
 * out" signal is an open contract (`BLOCKING_STATUSES`), which
 * `listAvailableCars` applies. `rented` is therefore a transient marker here,
 * not an exclusion.
 */
export const RENTABLE_CATEGORIES = ["rental", "both"] as const;

/** Vehicle states that permanently remove a car from the rental pool. */
export const UNRENTABLE_STATUSES = ["maintenance", "sold", "inactive", "out_of_service"] as const;

/** Statuses that occupy a car and therefore block an overlapping booking. */
export const BLOCKING_STATUSES = [
  "pending",
  "active",
  "confirmed",
  "reserved",
  "approved",
  "ongoing",
  "rented",
] as const;

/** Open-ended upper bound used to ask "which cars are out right now". */
const FAR_FUTURE = "9999-12-31";

const CAR_SELECT =
  "id,make,model,year,color,category,status,daily_rate,weekly_rate,monthly_rate,seats,transmission,fuel_type,image_url,location,tenant_id";

function text(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
}

export function isCarRentable(car: Row): boolean {
  const status = text(car.status ?? "available") || "available";
  if ((UNRENTABLE_STATUSES as readonly string[]).includes(status)) return false;
  const category = text(car.category ?? "rental") || "rental";
  return (RENTABLE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Half-open overlap test: a booking occupies `[start, end)`, so a rental ending
 * the morning another begins is a turnover, not a conflict. ISO `YYYY-MM-DD`
 * strings compare correctly as strings.
 */
export function periodsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function assertDateRange(start: unknown, end: unknown): void {
  if (!isIsoDate(start) || !isIsoDate(end)) throw badRequest("startDate and endDate are required (YYYY-MM-DD)");
  if (end <= start) throw badRequest("endDate must be after startDate");
}

function project(car: Row): AvailableCar {
  return {
    id: String(car.id),
    make: (car.make as string) ?? null,
    model: (car.model as string) ?? null,
    year: (car.year as number) ?? null,
    color: (car.color as string) ?? null,
    category: (car.category as string) ?? null,
    seats: (car.seats as number) ?? null,
    transmission: (car.transmission as string) ?? null,
    fuel_type: (car.fuel_type as string) ?? null,
    image_url: (car.image_url as string) ?? null,
    location: (car.location as string) ?? null,
    daily_rate: (car.daily_rate as number) ?? null,
    weekly_rate: (car.weekly_rate as number) ?? null,
    monthly_rate: (car.monthly_rate as number) ?? null,
  };
}

/** Scopes a query to the caller's company (or the tenant-less install). */
function scope(query: BookingQuery, tenantId: string | null): BookingQuery {
  return tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
}

/** Car ids that already hold a blocking booking overlapping the window. */
async function busyCarIds(
  db: BookingDb,
  start: string,
  end: string,
  tenantId: string | null,
): Promise<Set<string>> {
  const query = scope(
    db.from("rental_contracts").select("car_id,start_date,end_date,status"),
    tenantId,
  ).in("status", BLOCKING_STATUSES);

  const { data, error } = await query;
  if (error) throw error;

  const busy = new Set<string>();
  for (const row of (data ?? []) as Row[]) {
    if (!row.car_id) continue;
    if (periodsOverlap(start, end, String(row.start_date), String(row.end_date))) {
      busy.add(String(row.car_id));
    }
  }
  return busy;
}

/**
 * Cars the caller may book: rentable, in the caller's company, and free.
 *
 * Free is decided by the rental contracts, never by `cars.status`:
 *   - with a date window, a car holding a blocking booking that overlaps it is
 *     hidden for that window only;
 *   - with no window, a car that is currently out (a blocking contract whose
 *     period has not ended) is hidden, and every other rentable car is offered.
 *
 * This is why the old `.eq("status", "available")` filter is gone: it excluded
 * every car that had ever been rented, because nothing resets the flag.
 */
export async function listAvailableCars(
  db: BookingDb,
  scopeIn: { tenantId: string | null; start?: string | null; end?: string | null; today?: string | null },
): Promise<AvailableCar[]> {
  const tenantId = scopeIn.tenantId ?? null;

  const carsQuery = scope(db.from("cars").select(CAR_SELECT), tenantId);
  const { data, error } = await carsQuery.order("created_at", { ascending: false });
  if (error) throw error;

  let cars = ((data ?? []) as Row[]).filter(isCarRentable);

  const start = scopeIn.start ?? null;
  const end = scopeIn.end ?? null;
  const today = isIsoDate(scopeIn.today) ? scopeIn.today : new Date().toISOString().slice(0, 10);

  if (isIsoDate(start) && isIsoDate(end) && end > start) {
    const busy = await busyCarIds(db, start, end, tenantId);
    cars = cars.filter((c) => !busy.has(String(c.id)));
  } else {
    const busy = await busyCarIds(db, today, FAR_FUTURE, tenantId);
    cars = cars.filter((c) => !busy.has(String(c.id)));
  }

  return cars.map(project);
}

/**
 * Resolves a SINGLE car for the booking form, with its availability.
 *
 * The booking form needs this because a car can be reached by a deep link
 * (`/customer-dashboard?tab=booking&car=<id>`) that does not pass through the
 * availability list. Without an explicit lookup the `<select>` silently falls
 * back to its placeholder when the car is absent from the freshly-loaded list,
 * which is how a customer ended up on a form that had quietly discarded their
 * choice.
 *
 * The result distinguishes the three cases the UI must render differently:
 *   - `found: false`               -> not in this company (or not rentable)
 *   - `found: true, available: false` -> real, but busy for the requested window
 *   - `found: true, available: true`  -> selectable
 *
 * Scope comes from the session, exactly as `listAvailableCars`, so a deep link
 * cannot reference another company's car.
 */
export interface CarAvailability {
  found: boolean;
  available: boolean;
  car: AvailableCar | null;
  /** When unavailable, why. Shown to the customer verbatim. */
  reason: "not_found" | "not_rentable" | "busy" | null;
  /** Conflicting window, when the reason is `busy`. */
  conflict?: { startDate: string | null; endDate: string | null } | null;
}

export async function getCarAvailability(
  db: BookingDb,
  scopeIn: { tenantId: string | null; carId: string; start?: string | null; end?: string | null },
): Promise<CarAvailability> {
  if (!scopeIn.carId) return { found: false, available: false, car: null, reason: "not_found" };

  const query = scope(db.from("cars").select(CAR_SELECT).eq("id", scopeIn.carId), scopeIn.tenantId ?? null);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  const car = data as Row | null;
  if (!car) return { found: false, available: false, car: null, reason: "not_found" };
  if (!isCarRentable(car)) {
    return { found: true, available: false, car: project(car), reason: "not_rentable" };
  }

  const start = scopeIn.start ?? null;
  const end = scopeIn.end ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const windowStart = isIsoDate(start) ? start : today;
  const windowEnd = isIsoDate(end) && isIsoDate(start) && end > start ? end : FAR_FUTURE;

  const conflictQuery = scope(
    db.from("rental_contracts").select("id,start_date,end_date,status,car_id").eq("car_id", String(car.id)),
    (car.tenant_id as string | null) ?? null,
  ).in("status", BLOCKING_STATUSES);
  const { data: existing, error: conflictError } = await conflictQuery;
  if (conflictError) throw conflictError;

  const conflict = ((existing ?? []) as Row[]).find((r) =>
    periodsOverlap(windowStart, windowEnd, String(r.start_date), String(r.end_date)),
  );

  return {
    found: true,
    available: !conflict,
    car: project(car),
    reason: conflict ? "busy" : null,
    conflict: conflict
      ? { startDate: (conflict.start_date as string) ?? null, endDate: (conflict.end_date as string) ?? null }
      : null,
  };
}

/** Price for a window, computed server-side from the car's own rates. */
export function computePrice(
  car: Row,
  start: string,
  end: string,
  rentalType: RentalType,
): { dailyRate: number; totalDays: number; units: number; subtotal: number } {
  const totalDays = Math.max(1, Math.ceil((Date.parse(end) - Date.parse(start)) / 86_400_000));
  const daily = num(car.daily_rate);
  const weekly = num(car.weekly_rate);
  const monthly = num(car.monthly_rate);

  if (rentalType === "weekly" && weekly > 0) {
    const units = Math.ceil(totalDays / 7);
    return { dailyRate: weekly / 7, totalDays, units, subtotal: weekly * units };
  }
  if (rentalType === "monthly" && monthly > 0) {
    const units = Math.ceil(totalDays / 30);
    return { dailyRate: monthly / 30, totalDays, units, subtotal: monthly * units };
  }
  return { dailyRate: daily, totalDays, units: totalDays, subtotal: daily * totalDays };
}

/**
 * Creates a booking for the caller's own customer record.
 *
 * The company is derived from the *car's* tenant (which the scoped read already
 * proved is the caller's own), so a caller cannot book into another company by
 * changing `car_id` or supplying a `tenant_id`. An overlapping blocking booking
 * for the same car is rejected with 409 before any write.
 */
export async function createBooking(
  db: BookingDb,
  scopeIn: BookingScope,
  input: CreateBookingInput,
): Promise<CreatedBooking> {
  if (!scopeIn.customerId) throw badRequest("This account is not linked to a customer record");
  if (!input.carId) throw badRequest("carId is required");
  assertDateRange(input.startDate, input.endDate);

  const pickup = (input.pickupLocation ?? "").trim();
  const dropoff = (input.dropoffLocation ?? "").trim();
  if (!pickup || !dropoff) throw badRequest("pickupLocation and dropoffLocation are required");

  const carQuery = scope(
    db.from("cars").select("id,category,status,daily_rate,weekly_rate,monthly_rate,tenant_id").eq("id", input.carId),
    scopeIn.tenantId ?? null,
  );
  const { data: carData, error: carError } = await carQuery.maybeSingle();
  if (carError) throw carError;
  const car = carData as Row | null;
  // Not found in the caller's company == unauthorized. 422, never a silent insert.
  if (!car) throw invalidReference("car_id");
  if (!isCarRentable(car)) throw badRequest("This car is not available for rent");

  const carTenant = (car.tenant_id as string | null) ?? null;

  const conflictQuery = scope(
    db.from("rental_contracts").select("id,start_date,end_date,status,car_id").eq("car_id", String(car.id)),
    carTenant,
  ).in("status", BLOCKING_STATUSES);
  const { data: existing, error: conflictError } = await conflictQuery;
  if (conflictError) throw conflictError;
  const overlapping = ((existing ?? []) as Row[]).some((r) =>
    periodsOverlap(input.startDate, input.endDate, String(r.start_date), String(r.end_date)),
  );
  if (overlapping) {
    throw new ApiError(409, "car_unavailable", "This car is already booked for the selected period");
  }

  const rentalType: RentalType = input.rentalType ?? "daily";
  const price = computePrice(car, input.startDate, input.endDate, rentalType);
  const contractNumber = await nextDocumentNumber(db, "rental_contract", "RC");

  const row: Row = {
    customer_id: scopeIn.customerId,
    car_id: String(car.id),
    start_date: input.startDate,
    end_date: input.endDate,
    pickup_location: pickup,
    dropoff_location: dropoff,
    status: "pending",
    contract_number: contractNumber,
    notes: input.notes?.trim() || null,
    daily_rate: price.dailyRate,
    total_days: price.totalDays,
    subtotal: price.subtotal,
    discount: 0,
    vat_rate: 0,
    vat_amount: 0,
    total_amount: price.subtotal,
    paid_amount: 0,
    deposit_amount: 0,
    rental_type: rentalType,
  };
  // The authorized company is the car's tenant, never a value from the body.
  if (carTenant) row.tenant_id = carTenant;

  const { data: created, error: insertError } = await db
    .from("rental_contracts")
    .insert(row)
    .select("id,contract_number")
    .single();
  if (insertError) throw insertError;

  const record = (created ?? {}) as Row;
  return {
    id: String(record.id),
    contractNumber: String(record.contract_number ?? contractNumber),
    tenantId: carTenant,
  };
}
