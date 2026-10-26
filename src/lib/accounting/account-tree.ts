/**
 * Turning a company's chart of accounts into the list a journal line may pick
 * from.
 *
 * WHY THIS IS A MODULE
 * --------------------
 * The rule "which accounts can receive a journal line" is accounting logic, not
 * presentation, and it has to hold on two different chart shapes:
 *
 *   - a hierarchical chart, where a parent that HAS children is a group heading
 *     and only its leaves are postable;
 *   - the flat chart the live install uses today, where every account has no
 *     parent. There a parentless account IS the ledger account.
 *
 * The manual journal editor used to treat every parentless account as a heading.
 * On the flat chart that made NOTHING selectable: the dropdown showed every
 * account as a heading and offered only "(No sub-accounts)" placeholders. The
 * rule lives here so it can be tested directly and reused by any screen that
 * needs the same list.
 *
 * `is_postable` (migration 014) is authoritative when the column is present.
 */

export type ChartAccountRow = {
  id: string;
  name: string;
  code: string;
  parent_code?: string | null;
  is_active?: boolean | null;
  is_postable?: boolean | null;
};

export type AccountTreeEntry =
  | { type: "header"; id: string; label: string }
  | { type: "item"; id: string; label: string };

/**
 * A `00`-suffixed code is a group heading — EXCEPT the codes the posting path
 * names, which end in `00` on the live chart yet carry real postings. Keep this
 * in step with `isPostableCode` in `src/lib/records/sources.ts` and
 * `POSTING_CODES_IN_USE` in `src/lib/accounting/chart.ts`.
 */
const POSTABLE_EXCEPTIONS: readonly string[] = ["24000", "25000"];

export function isPostableAccountCode(code: unknown): boolean {
  const c = String(code ?? "").trim();
  if (!/^\d{5}$/.test(c)) return false;
  if (POSTABLE_EXCEPTIONS.includes(c)) return true;
  return !c.endsWith("00");
}

/**
 * May a journal line point at this account?
 *
 * `hasChildren` distinguishes the two chart shapes: a parentless account with
 * children is a heading; a parentless account with none is a ledger account.
 */
export function isSelectableJournalAccount(a: ChartAccountRow, hasChildren: boolean): boolean {
  if (a.is_active === false) return false;
  if (a.is_postable === false) return false;
  if (a.is_postable === true) return true;
  if (!isPostableAccountCode(a.code)) return false;
  return !hasChildren;
}

/** Every account a journal line may use, in chart order. */
export function selectableAccounts(accounts: ChartAccountRow[]): ChartAccountRow[] {
  return accounts.filter((a) => isSelectableJournalAccount(a, false));
}

/**
 * The dropdown model: headings interleaved with the selectable leaves beneath
 * them. A heading is rendered but cannot be chosen.
 */
export function buildAccountTree(accounts: ChartAccountRow[]): AccountTreeEntry[] {
  const childrenOf = (code: string) => accounts.filter((a) => a.parent_code === code);
  const parents = accounts.filter((a) => !a.parent_code);
  const label = (a: ChartAccountRow) => `${a.code} - ${a.name}`;

  // No hierarchy at all: every account is a leaf, so list them flat rather than
  // labelling each one a heading.
  if (parents.length === 0) return accounts.map((a) => ({ type: "item" as const, id: a.id, label: label(a) }));

  const tree: AccountTreeEntry[] = [];
  parents.forEach((parent) => {
    const children = childrenOf(parent.code);
    if (isSelectableJournalAccount(parent, children.length > 0)) {
      tree.push({ type: "item", id: parent.id, label: label(parent) });
      return;
    }
    tree.push({ type: "header", id: `hdr-${parent.id}`, label: label(parent) });
    const selectable = children.filter((c) => isSelectableJournalAccount(c, false));
    selectable.forEach((child) => tree.push({ type: "item", id: child.id, label: `    ${label(child)}` }));
    if (selectable.length === 0) tree.push({ type: "header", id: `empty-${parent.id}`, label: "    (No sub-accounts)" });
  });

  const knownCodes = new Set(parents.map((p) => p.code));
  const orphans = accounts.filter((a) => a.parent_code && !knownCodes.has(a.parent_code));
  if (orphans.length > 0) {
    tree.push({ type: "header", id: "orphan-hdr", label: "Other Accounts" });
    orphans.forEach((a) => tree.push({ type: "item", id: a.id, label: label(a) }));
  }
  return tree;
}
