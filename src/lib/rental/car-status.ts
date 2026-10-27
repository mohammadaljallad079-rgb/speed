/**
 * The `cars.status` display flag as a function of a rental contract's state.
 *
 * `cars.status` is a denormalised cache: it is shown in the vehicle list and the
 * dashboard counters. Availability itself is decided by the open contracts
 * (`src/lib/rental/booking-service.ts`), so a stale flag can no longer hide a
 * car — but it can still mislabel one, so every terminal contract transition
 * releases the car here rather than leaving it stuck on `rented` forever.
 */

/** Contract states in which the vehicle is back in the pool. */
const RELEASING_CONTRACT_STATUSES = ["completed", "cancelled", "closed", "returned"] as const;

/**
 * The car status to persist after a contract moves to `contractStatus`, or
 * `null` when the flag must not be touched (the rental is still live).
 */
export function carStatusForContractChange(contractStatus: string | null | undefined): "available" | null {
  const status = String(contractStatus ?? "").trim().toLowerCase();
  return (RELEASING_CONTRACT_STATUSES as readonly string[]).includes(status) ? "available" : null;
}
