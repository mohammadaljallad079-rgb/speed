/**
 * Booking time, in the rental company's own timezone.
 *
 * WHY THIS EXISTS
 * ---------------
 * A rental booking is a *time* window, not a calendar window: 09:00-11:00 and
 * 10:00-12:00 on the same day are different rentals, and a car returned at 09:00
 * can go out again at 09:00. A date-only guard cannot express either, so it
 * either refuses a legitimate booking or admits a conflicting one.
 *
 * The customer picks a wall-clock date and time ("2026-03-01 09:00") in the
 * *company's* timezone - a customer in another country still books the branch's
 * opening hours. That wall-clock reading is only meaningful together with the
 * zone, so it is converted to a true instant here and stored as `timestamptz`.
 * Storing a naive local timestamp instead would silently reinterpret itself if
 * the server's zone changed, and would compare wrongly across a DST boundary.
 *
 * `Intl.DateTimeFormat` is used rather than a date library: the conversion is
 * the only timezone arithmetic in the codebase, and `Intl` is already a
 * dependency of the runtime. This module is pure - no clock, no I/O - so it is
 * unit-testable and behaves identically on the server and in the browser.
 */

/** Fallback zone when a company has not configured one. Bahrain is the home market. */
export const DEFAULT_COMPANY_TIMEZONE = "Asia/Bahrain";

/** How a booking window is expressed on the wire, before it is resolved. */
export type LocalWindow = {
  /** `YYYY-MM-DD`, wall-clock in the company's timezone. */
  startDate: string;
  /** `HH:MM` (24h), wall-clock in the company's timezone. */
  startTime: string;
  endDate: string;
  endTime: string;
};

export type InstantWindow = {
  /** ISO-8601 with an explicit UTC offset, e.g. `2026-03-01T09:00:00+03:00`. */
  startAt: string;
  endAt: string;
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value.trim());
  if (!m) return false;
  return isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function isIsoTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = TIME_RE.exec(value.trim());
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = m[3] ? Number(m[3]) : 0;
  return h <= 23 && min <= 59 && s <= 59;
}

/** `HH:MM` -> minutes since midnight. */
export function minutesOfDay(time: string): number {
  const m = TIME_RE.exec(time.trim());
  if (!m) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Is `zone` a timezone this runtime recognises? */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone.trim() });
    return true;
  } catch {
    return false;
  }
}

/** The zone to use, falling back when a company has none or a bad one. */
export function resolveCompanyTimezone(zone?: string | null): string {
  return isValidTimeZone(zone) ? zone.trim() : DEFAULT_COMPANY_TIMEZONE;
}

/**
 * The zone's UTC offset, in minutes, at a given instant.
 *
 * Derived by formatting the instant in the target zone and re-reading it as if
 * it were UTC; the difference is the offset. This is the standard `Intl` trick
 * and it is DST-correct, because the offset is sampled *at* the instant.
 */
function offsetMinutesAt(instant: Date, zone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  // `hour` can format as "24" for midnight in some locales; normalise it.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  // Compare at second resolution: the formatter has no sub-second field.
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Convert a wall-clock reading in `zone` to a true instant.
 *
 * The offset depends on the instant we are trying to find, so it is solved
 * iteratively: guess with the offset at the naive UTC reading, then re-sample at
 * the candidate instant and correct. Two passes converge for every real zone
 * (offsets change by at most a few hours, and a zone's offset is constant across
 * the hours around a transition). A wall-clock time that does not exist (inside
 * a spring-forward gap) resolves to the instant just after the gap, which is the
 * conventional behaviour and never produces an invalid Date.
 */
export function zonedWallClockToInstant(
  date: string,
  time: string,
  zone: string,
): Date {
  const d = DATE_RE.exec(date.trim());
  const t = TIME_RE.exec(time.trim());
  if (!d || !t) throw new RangeError(`Invalid wall-clock value: ${date} ${time}`);
  const target = Date.UTC(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
    t[3] ? Number(t[3]) : 0,
  );

  let instant = new Date(target - offsetMinutesAt(new Date(target), zone) * 60_000);
  // Re-sample at the candidate: corrects the case where the first guess landed
  // on the other side of a DST transition.
  instant = new Date(target - offsetMinutesAt(instant, zone) * 60_000);
  return instant;
}

/**
 * Render an instant as an ISO-8601 string carrying the ZONE's offset, so the
 * stored value is unambiguous and the wall-clock reading the customer chose is
 * still readable in the row.
 *
 * `toISOString()` would emit `Z` (UTC), which is correct but forces every reader
 * to convert. Emitting `+03:00` keeps "09:00 in Bahrain" legible in the database
 * while remaining an exact instant that PostgreSQL parses into `timestamptz`.
 */
export function toZonedIso(instant: Date, zone: string): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError("Invalid instant");
  const off = offsetMinutesAt(instant, zone);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  // Shift the instant by the offset and read the UTC fields: that is the local
  // wall-clock reading, which is what we want to print next to the offset.
  const shifted = new Date(instant.getTime() + off * 60_000);
  const base = shifted.toISOString().replace(/\.\d{3}Z$/, "");
  return `${base}${sign}${hh}:${mm}`;
}

/** The zone's current offset as a label, e.g. `UTC+03:00`. */
export function timezoneLabel(zone: string, at: Date = new Date()): string {
  // Resolve first: this is display text, and an unset or unparseable company zone
  // must render a fallback label rather than throwing inside a component.
  const off = offsetMinutesAt(at, resolveCompanyTimezone(zone));
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export class BookingWindowError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = "BookingWindowError";
  }
}

/**
 * Turn the customer's wall-clock selection into an instant window.
 *
 * Half-open `[start, end)`, matching `periodsOverlap` and migration 017/018: a
 * rental that ends at 09:00 and the next that begins at 09:00 are a turnover,
 * not a conflict. A zero-length or reversed window is rejected.
 */
export function resolveBookingWindow(
  input: LocalWindow,
  zoneInput?: string | null,
): InstantWindow {
  const zone = resolveCompanyTimezone(zoneInput);

  if (!isIsoDate(input.startDate)) throw new BookingWindowError("startDate is required (YYYY-MM-DD)", "startDate");
  if (!isIsoDate(input.endDate)) throw new BookingWindowError("endDate is required (YYYY-MM-DD)", "endDate");
  if (!isIsoTime(input.startTime)) throw new BookingWindowError("startTime is required (HH:MM)", "startTime");
  if (!isIsoTime(input.endTime)) throw new BookingWindowError("endTime is required (HH:MM)", "endTime");

  const start = zonedWallClockToInstant(input.startDate, input.startTime, zone);
  const end = zonedWallClockToInstant(input.endDate, input.endTime, zone);

  if (end.getTime() <= start.getTime()) {
    throw new BookingWindowError("The return must be after the pickup", "endDate");
  }

  return { startAt: toZonedIso(start, zone), endAt: toZonedIso(end, zone) };
}

/**
 * Overlap on true instants, half-open.
 *
 * `Date.parse` handles the stored offset correctly, so two bookings expressed in
 * different offsets still compare as the instants they are.
 */
export function instantsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = Date.parse(aStart);
  const ae = Date.parse(aEnd);
  const bs = Date.parse(bStart);
  const be = Date.parse(bEnd);
  if ([as, ae, bs, be].some((n) => Number.isNaN(n))) return false;
  return as < be && bs < ae;
}

/**
 * Billable rental days for a window, counted in the COMPANY's wall clock.
 *
 * The unit is a whole 24-hour period of branch-local time, so:
 *   09:00 -> 11:00 the same day   = 1  (a part day is still a day)
 *   09:00 Monday -> 09:00 Tuesday = 1  (exactly 24h)
 *   09:00 Monday -> 11:00 Tuesday = 2  (the second day was entered)
 *   09:00 -> 09:00 a week later   = 7
 *
 * Measured on the wall clock rather than on elapsed milliseconds so a DST change
 * does not silently add or remove a billable day: 09:00 to 09:00 across a
 * spring-forward is 23 real hours but is still one rental day.
 *
 * A window that does not move forward is 1, never 0 or negative - a zero would
 * make a rental free and a negative would invert the price.
 */
export function rentalDays(startAt: string, endAt: string, zoneInput?: string | null): number {
  const zone = resolveCompanyTimezone(zoneInput);
  const start = new Date(Date.parse(startAt));
  const end = new Date(Date.parse(endAt));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;

  // Each instant rendered as branch-local wall-clock, then read back as UTC, so
  // the subtraction is a wall-clock difference with no zone or DST in it.
  const wallClockMs = (d: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(d);
    const o: Record<string, string> = {};
    for (const part of parts) if (part.type !== "literal") o[part.type] = part.value;
    const hour = o.hour === "24" ? "00" : o.hour;
    return Date.UTC(+o.year, +o.month - 1, +o.day, +hour, +o.minute, +o.second);
  };

  const elapsed = wallClockMs(end) - wallClockMs(start);
  if (elapsed <= 0) return 1;
  return Math.max(1, Math.ceil(elapsed / 86_400_000));
}

/** The company's "today" as `YYYY-MM-DD`, so the form's minimum matches its zone. */
export function companyToday(zoneInput?: string | null, at: Date = new Date()): string {
  const zone = resolveCompanyTimezone(zoneInput);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** The company's current wall-clock time as `HH:MM`. */
export function companyNow(zoneInput?: string | null, at: Date = new Date()): string {
  const zone = resolveCompanyTimezone(zoneInput);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
  return parts === "24:00" ? "00:00" : parts;
}
