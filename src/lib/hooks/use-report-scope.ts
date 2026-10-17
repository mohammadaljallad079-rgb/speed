"use client";

import { useEffect, useState } from "react";

import type { ReportScope } from "@/lib/auth/scope";

export type ReportScopeState =
  | { status: "loading" }
  | { status: "ready"; scope: ReportScope; hasTenantColumn: boolean };

/**
 * Resolve the current user's financial-report scope.
 *
 * The role/tenant decision is taken by the SERVER (`/api/me` -> AuthContext),
 * never from anything the browser sends, so a forged client value cannot widen
 * the scope. This hook only relays that decision to the report pages.
 *
 * `hasTenantColumn` reports whether `journal_entries` actually has a `tenant_id`
 * column. Migration 001 adds it, but on a live install where 001 is not yet
 * applied the column is absent, and filtering on it would error — the reports
 * must keep working (single-tenant) until the migration lands. We probe once by
 * selecting the column with a zero-row limit; PostgREST returns an error for an
 * unknown column and no error for a known one.
 */
export function useReportScope(): ReportScopeState {
  const [state, setState] = useState<ReportScopeState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      let identity: unknown = null;
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        if (res.ok) identity = await res.json();
      } catch {
        identity = null;
      }

      // Lazy import keeps the pure module and the browser client out of any
      // server bundle that might reference this hook.
      const [{ resolveReportScope }, { supabase }] = await Promise.all([
        import("@/lib/auth/scope"),
        import("@/lib/supabase"),
      ]);

      const scope = resolveReportScope(identity as never);

      let hasTenantColumn = false;
      try {
        const probe = await supabase
          .from("journal_entries")
          .select("tenant_id")
          .limit(0);
        hasTenantColumn = !probe.error;
      } catch {
        hasTenantColumn = false;
      }

      if (!cancelled) setState({ status: "ready", scope, hasTenantColumn });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/**
 * The effective scope to apply given the live schema. When the tenant column is
 * absent the only faithful scope is `null` (the single-tenant install); a
 * `tenant` scope cannot be honoured without the column.
 */
export function effectiveReportScope(
  scope: ReportScope,
  hasTenantColumn: boolean,
): ReportScope {
  if (scope.kind === "tenant" && !hasTenantColumn) return { kind: "null" };
  return scope;
}
