/**
 * Single call path for the `update_account_balance` RPC.
 *
 * WHY THIS EXISTS
 * ---------------
 * `accounts.balance` is a DENORMALISED CACHE, not the authoritative accounting
 * value. The authoritative value is always `sum(journal_lines.debit - credit)`
 * per account: every financial report derives it that way, and the canonical
 * engine (`postJournalEntry`) never writes `accounts.balance` at all. A handful
 * of modules additionally nudge the cached column through the
 * `update_account_balance` RPC so the petty-cash screen can show a running
 * figure.
 *
 * The RPC is NOT defined anywhere in this repository (no migration creates it),
 * so its sign convention cannot be verified from source. Callers therefore pass
 * the SAME signed delta they always did; this module does not reinterpret it.
 * What it adds is the one thing that was missing: a single, auditable call path
 * that surfaces a failure instead of swallowing it. Today every call ignores the
 * RPC result, so a missing or failing function leaves a silently stale balance.
 *
 * SIGN CONVENTION (as implemented by the existing callers)
 * --------------------------------------------------------
 * `amount` is a DEBIT-POSITIVE delta: `amount = Δdebit - Δcredit`.
 *   - debit an account  -> positive amount
 *   - credit an account -> negative amount
 * 8 of the 10 existing call sites follow this. The deposit-refund module is
 * internally inconsistent (see `ACCOUNT_BALANCE_KNOWN_DEVIATIONS`). Whether the
 * live RPC agrees is unverifiable from here; run
 * `supabase/ACCOUNT_BALANCE_VERIFICATION.sql` to confirm before changing a sign.
 */


/** Debit-positive sign convention, stated once so callers cannot drift. */
export const ACCOUNT_BALANCE_SIGN_CONVENTION =
  "amount = debit delta - credit delta (debit positive)";

/**
 * Call sites that do NOT follow the debit-positive convention. Kept explicit so
 * the deviation is tracked rather than silently propagated. `deposit-refund`
 * passes a negative delta for a DEBITED liability account (its sibling cash line
 * is a credit, so both got `-`). Resolve against the live RPC before changing.
 */
export const ACCOUNT_BALANCE_KNOWN_DEVIATIONS: ReadonlyArray<{
  file: string;
  account: string;
  note: string;
}> = [
  {
    file: "src/app/rentals/[id]/refund-deposit/page.tsx",
    account: "deposit liability (Dr)",
    note: "passes -amount for a debit; sibling cash (Cr) also passes -amount",
  },
];

type BalanceClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ error: { message: string; code?: string } | null }>;
};

/**
 * Apply a signed delta to the cached `accounts.balance`.
 *
 * Behaviour-preserving replacement for a bare
 * `supabase.rpc('update_account_balance', ...)`: the same `amount` reaches the
 * RPC. The only difference is that a failure is now logged instead of ignored,
 * and a missing function (SQLSTATE 42883) is called out explicitly, because on
 * an install where migrations 001-005 are not applied the RPC may not exist and
 * every balance would be stale while reports stay correct (they read the ledger).
 *
 * Never throws: the journal lines are already posted and are the source of
 * truth, so a cache-update failure must not abort an otherwise-valid posting.
 */
export async function applyAccountBalanceDelta(
  client: BalanceClient,
  accountId: string,
  amount: number,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const { error } = await client.rpc("update_account_balance", {
      account_id: accountId,
      amount,
    });
    if (error) {
      const missing = (error as { code?: string }).code === "42883";
      console.warn(
        missing
          ? "[account-balance] update_account_balance is not defined on this database; " +
              "accounts.balance will stay stale. Financial reports read journal_lines " +
              "and remain correct. Apply the account-balance migration to restore it."
          : `[account-balance] update_account_balance failed: ${error.message}`,
      );
      return { ok: false, error: error.message };
    }
    return { ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[account-balance] update_account_balance threw: ${message}`);
    return { ok: false, error: message };
  }
}
