"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Financial-report freshness (Exec 29, Item 9).
 *
 * Reports were only re-fetched when a page first mounted or when the user
 * pressed GO, so a transaction posted elsewhere in the same session (a new
 * invoice, a payment, an expense) could leave an already-open report showing
 * stale numbers until a manual reload.
 *
 * This module gives every report a single, dependency-free revalidation signal:
 *
 *   - `notifyDataChanged()` is called by the pages that mutate financial data
 *     after a successful post;
 *   - `useReportRefresh(fn)` re-runs the page's own loader when that signal
 *     arrives, and also when the tab regains focus/visibility (so returning to a
 *     report always shows committed data);
 *
 * It re-runs the existing loader - it does not add a second data path and never
 * writes to the ledger, so it cannot introduce duplicate entries.
 */

export const DATA_CHANGED_EVENT = "speed:data-changed";

/** Announce that financial data changed so open reports revalidate. */
export function notifyDataChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DATA_CHANGED_EVENT));
}

/**
 * Subscribe a report loader to the freshness signals. `refresh` is called on the
 * data-changed event and on focus/visibility regain, coalescing bursts so a page
 * never fires several overlapping fetches. Returns the timestamp of the last
 * refresh for an "updated at" indicator.
 */
export function useReportRefresh(refresh: () => void, enabled = true): Date | null {
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        refreshRef.current();
        setLastRefreshed(new Date());
      }, 120);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    window.addEventListener(DATA_CHANGED_EVENT, run);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(DATA_CHANGED_EVENT, run);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled]);

  return lastRefreshed;
}
