import {
  bookingCancelled,
  bookingConfirmed,
  bookingCreated,
  extensionDecided,
  extensionRequested,
  type NotificationInput,
} from "./notifications";
import { insertNotifications, type NotificationDb } from "./notification-store";

/**
 * Server-side notification emission for operational contract events.
 *
 * Execution 60, Section 7. Execution 58 built the notification store and the
 * date-driven scan, but the real-time events were emitted by one page
 * (`rentals/new`) calling the API inline, and the customer self-service booking
 * route emitted nothing at all - so a booking made from the customer portal was
 * invisible to the office. This module is the single place an event becomes a
 * notification, so both entry points share one rule.
 *
 * The CONTENT is rebuilt from the contract row the server reads, tenant-scoped.
 * A caller names an event and a contract; it can never supply a title, a
 * recipient or a tenant.
 */

export type ContractEvent =
  | "booking_new"
  | "booking_confirmed"
  | "booking_cancelled"
  | "extension_requested"
  | "extension_decided";

export const CONTRACT_EVENTS: ContractEvent[] = [
  "booking_new",
  "booking_confirmed",
  "booking_cancelled",
  "extension_requested",
  "extension_decided",
];

export function isContractEvent(value: unknown): value is ContractEvent {
  return typeof value === "string" && (CONTRACT_EVENTS as string[]).includes(value);
}

/** The columns the event builders read. Keep in sync with the contract table. */
export interface ContractEventRow {
  contract_number?: string | null;
  status?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  customers?: { full_name?: string | null } | null;
  cars?: { make?: string | null; model?: string | null; plate_number?: string | null } | null;
}

export interface EmitInput {
  event: ContractEvent;
  contractId: string;
  /** Only for `extension_requested`/`extension_decided`. */
  newEndDate?: string | null;
  approved?: boolean;
}

/**
 * Pure: turns a contract row + an event into the notification to store. Returns
 * `null` for an event that does not apply (so a caller cannot be forced to
 * invent content). The dedupe key is derived from the event and the contract, so
 * a repeated emit for the same event is a no-op at the store.
 */
export function buildContractEvent(
  event: ContractEvent,
  contractId: string,
  row: ContractEventRow,
  opts: { newEndDate?: string | null; approved?: boolean } = {},
): NotificationInput | null {
  const number = String(row.contract_number ?? contractId.slice(0, 8));
  const customer = row.customers?.full_name ?? "";
  const car = row.cars ?? {};
  const carLabel = [car.make, car.model].filter(Boolean).join(" ") || car.plate_number || "";
  const startDate = String(row.start_date ?? "");
  const endDate = String(row.end_date ?? "");

  switch (event) {
    case "booking_new":
      return bookingCreated({ contractId, contractNumber: number, customerName: customer, carLabel, startDate });
    case "booking_confirmed":
      return bookingConfirmed({ contractId, contractNumber: number });
    case "booking_cancelled":
      return bookingCancelled({ contractId, contractNumber: number });
    case "extension_requested":
      return extensionRequested({ contractId, contractNumber: number, newEndDate: opts.newEndDate ?? endDate });
    case "extension_decided":
      return extensionDecided({ contractId, contractNumber: number, approved: opts.approved === true, newEndDate: endDate });
    default:
      return null;
  }
}

/** The minimal client shape this needs (a Supabase service client satisfies it). */
export interface ContractQuery extends PromiseLike<{ data: unknown }> {
  eq(column: string, value: unknown): ContractQuery;
}

export interface ContractReader {
  from(table: string): { select(columns: string): ContractQuery };
}

export interface EmitResult {
  ok: boolean;
  inserted: number;
  skipped: number;
  error: string | null;
}

/**
 * Reads the contract (tenant-scoped), builds the notification and inserts it
 * idempotently. Never throws: a notification is a side effect of a business
 * action, so a store that is missing (pre-migration) or a contract that cannot
 * be read must not fail the booking that triggered it.
 */
export async function emitContractEvent(
  db: NotificationDb,
  reader: ContractReader,
  tenantId: string | null,
  input: EmitInput,
): Promise<EmitResult> {
  try {
    const base = reader
      .from("rental_contracts")
      .select("id, contract_number, status, start_date, end_date, customers(full_name), cars(make, model, plate_number)")
      .eq("id", input.contractId);
    // Always narrow by id; additionally confine to the caller's tenant. A
    // tenant-less caller (the single-tenant install) reads the row by id alone.
    const query = tenantId ? base.eq("tenant_id", tenantId) : base;
    const res = (await query) as { data: unknown };
    const row = (Array.isArray(res.data) ? res.data[0] : res.data) as ContractEventRow | undefined;
    if (!row) return { ok: false, inserted: 0, skipped: 0, error: "contract_not_found" };

    const item = buildContractEvent(input.event, input.contractId, row, {
      newEndDate: input.newEndDate,
      approved: input.approved,
    });
    if (!item) return { ok: false, inserted: 0, skipped: 0, error: "unsupported_event" };

    const inserted = await insertNotifications(db, tenantId, null, [item]);
    return { ok: inserted.ok || inserted.inserted > 0, inserted: inserted.inserted, skipped: inserted.skipped, error: inserted.error ?? null };
  } catch (error) {
    return { ok: false, inserted: 0, skipped: 0, error: (error as Error)?.message ?? "emit_failed" };
  }
}
