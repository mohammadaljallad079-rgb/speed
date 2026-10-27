"use client";

import { useEffect, useState } from "react";

/**
 * The authenticated caller's tenant, for browser pages that must read or write a
 * tenant-owned row.
 *
 * `settings` is tenant-owned, so a page that writes it without a tenant is not
 * merely "single-tenant" — it reads and overwrites whichever tenant's row the
 * database returns first. The tenant therefore has to come from the session,
 * which is what `/api/me` resolves server-side. It must never be taken from a
 * form field, a cookie or localStorage.
 *
 * `ready` distinguishes "still resolving" from "resolved to no tenant": the
 * latter is the single-tenant install and is legitimately `null`. A caller that
 * cannot tell the two apart either renders another tenant's data or blocks the
 * single-tenant install.
 */
export function useTenantId(): { tenantId: string | null; ready: boolean } {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled) setTenantId(json?.tenantId ?? null);
      })
      .catch(() => {
        // An unresolved identity leaves the caller tenant-less, which reads and
        // writes the NULL-tenant rows rather than every tenant's.
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { tenantId, ready };
}
