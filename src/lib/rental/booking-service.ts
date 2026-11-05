import { ApiError, badRequest, invalidReference } from "../auth/errors";
import { nextDocumentNumber } from "../numbering";
import {
  BookingWindowError,
  companyToday,
  DEFAULT_COMPANY_TIMEZONE,
  instantsOverlap,
  isIsoDate as isIsoDateValue,
  isIsoTime,
  rentalDays,
  resolveBookingWindow,
  resolveCompanyTimezone,
} from "./timezone";

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
  or(filter: string): BookingQuery;
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
  /**
   * The rental company's IANA timezone. The customer's wall-clock pickup/return
   * reading is interpreted in THIS zone, not the browser's and not the server's:
   * a customer abroad still books the branch's opening hours. Falls back to
   * `DEFAULT_COMPANY_TIMEZONE` when the company has not configured one.
   */
  timeZone?: string | null;
};

export type CreateBookingInput = {
  carId: string;
  /** `YYYY-MM-DD`, wall-clock in the company's timezone. */
  startDate: string;
  /** `HH:MM` (24h), wall-clock in the company's timezone. REQUIRED. */
  startTime: string;
  endDate: string;
  /** `HH:MM` (24h), wall-clock in the company's timezone. REQUIRED. */
  endTime: string;
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
 * Half-open overlap test on calendar dates, kept for callers that only have
 * dates. A booking occupies `[start, end)`, so a rental ending the morning
 * another begins is a turnover, not a conflict.
 *
 * NEW BOOKINGS USE {@link bookingWindowsOverlap} INSTEAD. A date-only test is
 * wrong once a booking carries a time: 09:00-11:00 and 10:00-12:00 on one day
 * are different rentals that a date-only test calls identical. This function
 * remains because a legacy row with no time genuinely has day precision, and
 * refusing to compare it at all would let it block nothing.
 */
export function periodsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * A booking window reduced to the two representations that can be compared.
 *
 * `start_at`/`end_at` are true instants (the precise form). A row that predates
 * migration 018 has only `start_date`/`end_date` (+ optional `start_time`/
 * `end_time`), which is a wall-clock reading in the COMPANY's zone - so it is
 * resolved to instants with the same function a new booking uses. Comparing a
 * legacy row and a new one therefore compares like with like.
 */
export function windowOf(row: Row, zone: string): { startAt: number; endAt: number } | null {
  const at = (v: unknown) => (typeof v === "string" && v.trim() ? Date.parse(v) : Number.NaN);
  const startAt = at(row.start_at);
  const endAt = at(row.end_at);
  if (Number.isFinite(startAt) && Number.isFinite(endAt)) return { startAt, endAt };

  const sd = String(row.start_date ?? "");
  const ed = String(row.end_date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd) || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) return null;
  const st = typeof row.start_time === "string" && row.start_time ? String(row.start_time).slice(0, 5) : "00:00";
  const et = typeof row.end_time === "string" && row.end_time ? String(row.end_time).slice(0, 5) : "00:00";
  try {
    const w = resolveBookingWindow(
      { startDate: sd, startTime: st, endDate: ed, endTime: et },
      zone,
    );
    const s = Date.parse(w.startAt);
    const e = Date.parse(w.endAt);
    return Number.isFinite(s) && Number.isFinite(e) ? { startAt: s, endAt: e } : null;
  } catch {
    return null;
  }
}

/**
 * Do two booking windows overlap, at the precision they actually carry?
 *
 * Half-open `[start, end)`: a car returned at 09:00 may go out again at 09:00.
 * Instants, so two rows written in different offsets still compare correctly.
 */
export function bookingWindowsOverlap(a: Row, b: Row, zone: string): boolean {
  const wa = windowOf(a, zone);
  const wb = windowOf(b, zone);
  if (!wa || !wb) return false;
  return wa.startAt < wb.endAt && wb.startAt < wa.endAt;
}

/** Does `candidate` (an instant window) overlap `existing` (a row)? */
export function windowOverlapsRow(
  candidate: { startAt: string; endAt: string },
  existing: Row,
  zone: string,
): boolean {
  const w = windowOf(existing, zone);
  if (!w) return false;
  const cs = Date.parse(candidate.startAt);
  const ce = Date.parse(candidate.endAt);
  if (!Number.isFinite(cs) || !Number.isFinite(ce)) return false;
  return cs < w.endAt && w.startAt < ce;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Whether a write error is migration 017's double-booking guard.
 *
 * The guard raises `exclusion_violation` (SQLSTATE 23P01) from the trigger, and
 * the exclusion constraint raises the same code, so the code alone is enough.
 * The message is checked too because PostgREST does not always surface
 * `code` on a constraint violation, and a false negative here would show the
 * customer a 500 instead of "already booked".
 */
export function isOverlapViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; details?: unknown };
  if (String(e.code ?? "") === "23P01") return true;
  const haystack = `${e.message ?? ""} ${e.details ?? ""}`.toLowerCase();
  return (
    haystack.includes("already booked") ||
    haystack.includes("exclusion") ||
    haystack.includes("conflicting contract") ||
    haystack.includes("rental_contracts_no_car_overlap")
  );
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

/**
 * The columns a conflict decision needs.
 *
 * Both the precise form (`start_at`/`end_at`) and the legacy date/time columns
 * are requested, so the same code compares a new booking and a pre-018 row.
 * A narrow install without the new columns simply returns nulls for them.
 */
const CONFLICT_SELECT =
  "id,car_id,status,start_date,end_date,start_time,end_time,start_at,end_at,tenant_id";

/** Car ids that already hold a blocking booking overlapping the window. */
async function busyCarIds(
  db: BookingDb,
  window: { startAt: string; endAt: string },
  tenantId: string | null,
  zone: string,
): Promise<Set<string>> {
  const query = scope(db.from("rental_contracts").select(CONFLICT_SELECT), tenantId).in(
    "status",
    BLOCKING_STATUSES,
  );

  const { data, error } = await query;
  if (error) throw error;

  const busy = new Set<string>();
  for (const row of (data ?? []) as Row[]) {
    if (!row.car_id) continue;
    if (windowOverlapsRow(window, row, zone)) busy.add(String(row.car_id));
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
export type AvailabilityQuery = {
  tenantId: string | null;
  /** `YYYY-MM-DD` wall-clock in the company's timezone. */
  start?: string | null;
  /** `HH:MM`; defaults to `00:00` so a date-only caller keeps working. */
  startTime?: string | null;
  end?: string | null;
  /** `HH:MM`; defaults to `00:00`, which is the exclusive end of the day before. */
  endTime?: string | null;
  /** `YYYY-MM-DD` used as "now" when no window is given (tests pin this). */
  today?: string | null;
  /** Company timezone; the wall-clock window is interpreted in it. */
  timeZone?: string | null;
};

export async function listAvailableCars(
  db: BookingDb,
  scopeIn: AvailabilityQuery,
): Promise<AvailableCar[]> {
  const tenantId = scopeIn.tenantId ?? null;
  const zone = resolveCompanyTimezone(scopeIn.timeZone);

  const carsQuery = scope(db.from("cars").select(CAR_SELECT), tenantId);
  const { data, error } = await carsQuery.order("created_at", { ascending: false });
  if (error) throw error;

  let cars = ((data ?? []) as Row[]).filter(isCarRentable);

  const window = availabilityWindow(scopeIn, zone);
  const busy = await busyCarIds(db, window, tenantId, zone);
  cars = cars.filter((c) => !busy.has(String(c.id)));

  return cars.map(project);
}

/**
 * The window availability is judged against.
 *
 * With a full date+time selection the customer's exact window is used, so a car
 * free from 11:00 is offered for an 11:00 pickup even though it is out until
 * then. With dates only, the window runs from the start date at 00:00 to the end
 * date at 00:00 - i.e. `[start, end)` in days, which is what a date-granular
 * caller means. With neither, it runs from the company's today to the far future.
 */
function availabilityWindow(
  scopeIn: AvailabilityQuery,
  zone: string,
): { startAt: string; endAt: string } {
  const start = isIsoDate(scopeIn.start) ? scopeIn.start : null;
  const end = isIsoDate(scopeIn.end) ? scopeIn.end : null;
  const today = isIsoDate(scopeIn.today) ? scopeIn.today : companyToday(zone);
  const hasTimes = isIsoTime(scopeIn.startTime) && isIsoTime(scopeIn.endTime);
  const startTime = isIsoTime(scopeIn.startTime) ? scopeIn.startTime : "00:00";
  const endTime = isIsoTime(scopeIn.endTime) ? scopeIn.endTime : "00:00";

  if (start && end) {
    // A window is usable when it moves forward. On the SAME date that depends on
    // the TIMES: 09:00 -> 11:00 is a real rental, 09:00 -> 09:00 is not. Testing
    // only `end > start` discarded every same-day booking - the commonest rental
    // of all - and fell through to "free forever", which offered a car that was
    // already out.
    if (end > start || (end === start && hasTimes && endTime > startTime)) {
      return resolveBookingWindow(
        { startDate: start, startTime, endDate: end, endTime },
        zone,
      );
    }
    // A same-day DATE-ONLY request means that one day, `[00:00, next 00:00)`.
    // Without this it also fell through to "free forever", which is not what a
    // caller who named a single date asked for.
    if (end === start) {
      const next = new Date(`${start}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      return resolveBookingWindow(
        { startDate: start, startTime: "00:00", endDate: next.toISOString().slice(0, 10), endTime: "00:00" },
        zone,
      );
    }
  }
  return resolveBookingWindow(
    { startDate: today, startTime: "00:00", endDate: FAR_FUTURE, endTime: "00:00" },
    zone,
  );
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
  /** Conflicting window, when the reason is `busy`, in the company's timezone. */
  conflict?: {
    startDate: string | null;
    endDate: string | null;
    startTime: string | null;
    endTime: string | null;
    label: string;
  } | null;
}

export async function getCarAvailability(
  db: BookingDb,
  scopeIn: AvailabilityQuery & { carId: string },
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

  const zone = resolveCompanyTimezone(scopeIn.timeZone);
  const window = availabilityWindow(scopeIn, zone);

  const conflictQuery = scope(
    db.from("rental_contracts").select(CONFLICT_SELECT).eq("car_id", String(car.id)),
    (car.tenant_id as string | null) ?? null,
  ).in("status", BLOCKING_STATUSES);
  const { data: existing, error: conflictError } = await conflictQuery;
  if (conflictError) throw conflictError;

  const conflict = ((existing ?? []) as Row[]).find((r) => windowOverlapsRow(window, r, zone));

  return {
    found: true,
    available: !conflict,
    car: project(car),
    reason: conflict ? "busy" : null,
    conflict: conflict ? conflictWindow(conflict, zone) : null,
  };
}

/**
 * The conflicting booking, as the customer should see it: the wall-clock reading
 * in the COMPANY's zone, so "booked 01/03 09:00 - 01/03 11:00" matches the times
 * they picked rather than a UTC rendering of them.
 */
function conflictWindow(
  row: Row,
  zone: string,
): { startDate: string | null; endDate: string | null; startTime: string | null; endTime: string | null; label: string } {
  const w = windowOf(row, zone);
  if (!w) {
    return { startDate: null, endDate: null, startTime: null, endTime: null, label: "" };
  }
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = (ms: number) => {
    const o: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = p.value;
    return o;
  };
  const a = parts(w.startAt);
  const b = parts(w.endAt);
  const hh = (v: string) => (v === "24" ? "00" : v);
  return {
    startDate: `${a.year}-${a.month}-${a.day}`,
    startTime: `${hh(a.hour)}:${a.minute}`,
    endDate: `${b.year}-${b.month}-${b.day}`,
    endTime: `${hh(b.hour)}:${b.minute}`,
    label: `${a.year}-${a.month}-${a.day} ${hh(a.hour)}:${a.minute} -> ${b.year}-${b.month}-${b.day} ${hh(b.hour)}:${b.minute}`,
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
  return computePriceForDays(car, totalDays, rentalType);
}

/**
 * Price for a booking window, counting rental days on the COMPANY's wall clock.
 *
 * A rental day is a calendar day in the branch's zone, so a 09:00 Monday pickup
 * returning 09:00 Tuesday is one day even though it spans a night. Counting the
 * raw elapsed hours in UTC would make a late-evening pickup look like two days.
 */
export function computePriceForWindow(
  car: Row,
  startAt: string,
  endAt: string,
  rentalType: RentalType,
  zone?: string | null,
): { dailyRate: number; totalDays: number; units: number; subtotal: number } {
  return computePriceForDays(car, rentalDays(startAt, endAt, zone), rentalType);
}

function computePriceForDays(
  car: Row,
  totalDays: number,
  rentalType: RentalType,
): { dailyRate: number; totalDays: number; units: number; subtotal: number } {
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

  const zone = resolveCompanyTimezone(scopeIn.timeZone);

  // The customer's wall-clock reading, resolved to true instants in the COMPANY's
  // timezone. A bad or missing time is a 400 that names the field, never a
  // silently-widened day.
  let window: { startAt: string; endAt: string };
  try {
    window = resolveBookingWindow(
      {
        startDate: input.startDate,
        startTime: input.startTime,
        endDate: input.endDate,
        endTime: input.endTime,
      },
      zone,
    );
  } catch (e) {
    if (e instanceof BookingWindowError) throw badRequest(e.message);
    throw e;
  }

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
    db.from("rental_contracts").select(CONFLICT_SELECT).eq("car_id", String(car.id)),
    carTenant,
  ).in("status", BLOCKING_STATUSES);
  const { data: existing, error: conflictError } = await conflictQuery;
  if (conflictError) throw conflictError;
  const overlapping = ((existing ?? []) as Row[]).some((r) => windowOverlapsRow(window, r, zone));
  if (overlapping) {
    throw new ApiError(409, "car_unavailable", "This car is already booked for the selected period");
  }

  const rentalType: RentalType = input.rentalType ?? "daily";
  const price = computePriceForWindow(car, window.startAt, window.endAt, rentalType, zone);
  const contractNumber = await nextDocumentNumber(db, "rental_contract", "RC");

  const row: Row = {
    customer_id: scopeIn.customerId,
    car_id: String(car.id),
    // The wall-clock reading the customer chose, kept readable in the row.
    start_date: input.startDate,
    end_date: input.endDate,
    start_time: input.startTime,
    end_time: input.endTime,
    // The precise instants: the authoritative window, and what the guard compares.
    start_at: window.startAt,
    end_at: window.endAt,
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

  const created = await insertTolerant(db, row);
  const record = (created ?? {}) as Row;
  return {
    id: String(record.id),
    contractNumber: String(record.contract_number ?? contractNumber),
    tenantId: carTenant,
  };
}

/**
 * Is this error "the column you named does not exist"?
 *
 * PostgREST reports it as 42703, or PGRST204 when the column is missing from the
 * schema cache. Only that shape justifies retrying without the column - anything
 * else is a real failure and must propagate.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (String(e.code ?? "") === "42703" || String(e.code ?? "") === "PGRST204") return true;
  const m = String(e.message ?? "").toLowerCase();
  return m.includes("column") && (m.includes("does not exist") || m.includes("could not find"));
}

/**
 * Insert a booking, dropping only the columns the live database does not have.
 *
 * Migration 018 adds `start_at`/`end_at` (the precise instants) and
 * `start_time`/`end_time`. Until it is applied, naming them is a hard error, so a
 * booking would fail entirely - the app must keep working across the migration,
 * not only after it. This drops the newest columns first and retries, in the same
 * spirit as the tolerant write elsewhere in the codebase. The window is never
 * silently widened: the legacy date/time columns carry the same reading, and the
 * application overlap check has already run at full precision.
 */
async function insertTolerant(db: BookingDb, row: Row): Promise<Row | null> {
  // Ordered newest-first: each retry removes one generation of columns.
  const droppable: string[][] = [
    ["start_at", "end_at"],
    ["start_time", "end_time"],
  ];

  let attempt: Row = { ...row };
  let lastError: unknown = null;

  for (let i = 0; i <= droppable.length; i++) {
    const { data, error } = await db
      .from("rental_contracts")
      .insert(attempt)
      .select("id,contract_number")
      .single();

    if (!error) return (data ?? {}) as Row;

    lastError = error;
    // The database's own double-booking guard is a real rejection: translate it
    // into the same 409 the pre-check returns, so the customer who lost the race
    // sees "already booked" rather than a 500. Never retried.
    if (isOverlapViolation(error)) {
      throw new ApiError(409, "car_unavailable", "This car is already booked for the selected period");
    }
    if (i === droppable.length || !isMissingColumnError(error)) throw error;

    const drop = new Set(droppable[i]);
    attempt = Object.fromEntries(Object.entries(attempt).filter(([k]) => !drop.has(k)));
  }

  throw lastError ?? new Error("Could not create the booking");
}
