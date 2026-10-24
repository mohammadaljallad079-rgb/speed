/**
 * Which company a self-registered customer belongs to (pure).
 *
 * The customer portal scopes every car it shows to the caller's `tenant_id`
 * (`listAvailableCars` filters by it), so a customer assigned to the WRONG
 * tenant sees an empty list — the "no cars available" defect. The choice must
 * therefore be derived from the cars the customer is about to browse, never
 * from a bare `tenants` row that may own none of them.
 *
 * The rules, in order:
 *   1. available cars owned by exactly one tenant -> that tenant;
 *   2. available cars split across tenants, or all tenant-less -> no assignment
 *      (the tenant-less scope, which is where tenant-less cars live);
 *   3. no available cars at all -> a single unambiguous `tenants` row, else
 *      none.
 *
 * Returning `null` is a real answer: it selects the tenant-less scope and is the
 * correct choice whenever guessing would hide the cars. It is never a fallback
 * to "the only tenant that exists".
 */

export type CarTenantRow = { tenant_id?: string | null };
export type TenantRow = { id: string };

export function resolveCustomerTenantId(cars: CarTenantRow[], tenants: TenantRow[]): string | null {
  const carTenants = [...new Set(cars.map((c) => c.tenant_id).filter((id): id is string => Boolean(id)))];
  if (carTenants.length === 1) return carTenants[0];
  // Cars exist but are split (or all tenant-less): do not guess, because any
  // tenant we picked would hide the others' cars from this customer.
  if (cars.length > 0) return null;

  const tenantIds = tenants.map((t) => t.id).filter(Boolean);
  return tenantIds.length === 1 ? tenantIds[0] : null;
}
