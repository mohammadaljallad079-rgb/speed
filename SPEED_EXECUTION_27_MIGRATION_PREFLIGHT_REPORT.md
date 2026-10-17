# SPEED ERP — Execution 27 Report
## Duplicate Journal Preflight & Frozen Migration Bundle (R1 / R2 closure)

**Scope:** analysis + local-only execution on a throwaway PostgreSQL 17.
No push, no deploy, no production database contact, no SQL executed on
production, no migration applied to any database, no accounting record touched.
**Branch:** `feat/final-hardening-round5`
**HEAD at start:** `2228f9e` (Execution 26) — clean tree.
**Authorized repo:** `https://github.com/mohammadaljallad079-rgb/speed`
**Date:** 2026-10-17

---

## 1. R1 — the exact 005 conflict definition (Phase 1)

Migration `005_accounting_integrity.sql` (lines 61–81) creates this **partial
unique index**, inside a single `begin; … commit;` transaction:

```sql
create unique index if not exists journal_entries_one_posted_per_doc_uidx
  on public.journal_entries (entry_type, reference_number)
  where status = 'posted'
    and reference_number is not null
    and reference_number <> ''
    and entry_type in ('sale_invoice', 'supplier_payment')
```

A row is in conflict **only** when it satisfies **all** of:

| Condition | Meaning |
| --- | --- |
| `status = 'posted'` | draft / void rows are excluded |
| `reference_number is not null` | NULL references excluded |
| `reference_number <> ''` | empty-string references excluded |
| `entry_type in ('sale_invoice','supplier_payment')` | manual `journal_entry`, reversals, and every other type excluded |
| two+ rows share the same `(entry_type, reference_number)` | the actual duplicate |

The migration comment is explicit: a pre-existing duplicate makes
`create unique index` **fail loudly**, and because 005 is one transaction the
**whole migration rolls back** (no partial index, no view).

### 1.1 Ready-to-run live SELECT (read-only, NOT executed on production)

`supabase/EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql` (BLOCK 1) is the gate; it uses
the **same predicate**, so it flags exactly the rows that would abort 005 and
never mislabels an out-of-scope journal:

```sql
select entry_type, reference_number, count(*) as posted_copies,
       min(created_at) as first_posted_at, max(created_at) as last_posted_at
  from public.journal_entries
 where status = 'posted'
   and reference_number is not null
   and reference_number <> ''
   and entry_type in ('sale_invoice', 'supplier_payment')
 group by entry_type, reference_number
having count(*) > 1
 order by posted_copies desc, entry_type, reference_number;
```

**ZERO rows → safe to apply the package. ANY rows → resolve those journals first,
then re-run until zero.** The file also carries BLOCK 2 (the id list of the
conflicting rows, for review) and BLOCK 3 (a presence check for the 005 view).

### 1.2 Live result is UNKNOWN

This environment has **no production database access**, so the query was **not**
run against `chlkmdobhvfnldqkgdji`. The operator must run it (or the whole
preflight file) before applying 005. This is stated plainly, not assumed green.

---

## 2. R2 — frozen 005→006 activation bundle (Phase 2)

**Created:** `supabase/PRODUCTION_ACTIVATION_005_006.sql` (368 lines).

- The **two migration bodies are embedded verbatim** from
  `supabase/migrations/005_accounting_integrity.sql` and
  `006_ai_repair.sql`; each is preceded by a banner recording its SHA-256.
- **Generated, never hand-edited:** `scripts/generate-activation-bundle.mjs`
  reads the source files and writes the bundle. Re-running it reproduces the
  committed file exactly (verified — empty diff).
- **Structure:** PRE-FLIGHT (read-only: environment + dependency checks + the R1
  duplicate gate) → `-- BEGIN 005…` body → `-- BEGIN 006…` body → POST-FLIGHT
  (read-only verification) → `END OF PACKAGE`.
- **No migration appears twice:** each `-- BEGIN …` marker occurs exactly once
  (asserted by test).
- **Sources untouched:** migrations 001–006 were **not modified**.

### 2.1 Differences from the sources

None. Verified two ways:
- the generator output equals the source bytes (banner offsets only);
- `tests/activation-package-integrity.test.ts` extracts each embedded body with
  the *same algorithm used for 001–004* and asserts it is byte-identical to the
  migration file and that the recorded SHA-256 matches the actual bytes.

Recorded hashes:
- 005: `de8e1b7d8b3ef7624ab60b528d774c0d39508c4b8aeff280d4a814223164d104`
- 006: `37c0a7145dd5c7926b2cee611ee8d11ec6b6cdda60b55cde3778c5e08cb5d3ce`

### 2.2 Destructive / privilege statements

A scan of the non-comment lines found **none** of: `DROP TABLE`, `DROP COLUMN`,
`TRUNCATE`, `DELETE FROM`, `DROP SCHEMA`, `GRANT ALL`. The only privilege change
is 006's intended `revoke all on public.ai_repair_executions from anon` (the
"anon holds zero privileges" invariant). 005 adds two indexes and one read-only
view; 006 adds one table, three indexes, four RLS policies.

### 2.3 Transaction / partial-failure behaviour

| Step | If it fails |
| --- | --- |
| 005 unique index | whole 005 rolls back — no lookup index, no view |
| 005 later steps | same transaction → all of 005 rolls back |
| 006 (separate transaction) | whole 006 rolls back — table/indexes/policies all undone |

Because 005 and 006 are **separate transactions**, a 005 failure stops the
script before 006 runs (006 objects are never created). This is proven in
Scenario C of the local harness (§3).

### 2.4 Re-runnability

Declared idempotent **only after** local execution (§3, Scenario B): every
statement is `if not exists` / `drop policy if exists` before `create`, and a
re-apply produces no error and preserves existing rows.

---

## 3. Local tests (Phase 3)

New harness: `supabase/tests/activation_005_006_harness/run.sh` — runs the
**bundle file itself** against a throwaway PostgreSQL 17 (base schema + 001→004,
then the package). Three scenarios:

| Scenario | Assertions | Result |
| --- | --- | --- |
| **A. Clean ledger** | applies with no error; both 005 indexes; integrity view present & empty; `ai_repair_executions` present; RLS on; both unique indexes; delete policy RESTRICTIVE; anon has no privilege; duplicate query = 0; null-tenant claim accepted; duplicate null-tenant claim blocked; same key allowed for a real tenant | **15/15 PASS** |
| **B. Re-apply** | re-applies with no error; unique index still exactly one; existing rows preserved (no reset) | **3/3 PASS** |
| **C. Pre-existing duplicate** | preflight query **detects** the conflict; the bundle **aborts**; **no partial change** — 005 lookup index, 005 unique index, 005 view and 006 table are all **absent** | **6/6 PASS** |

**Total: 24 passed, 0 failed — `ACTIVATION 005_006: PASS`.**

The preflight file was also executed directly (read-only) against clean and
duplicate ledgers: 0 rows when clean, and it listed the two conflicting
`INV-DUP` rows when present. No production credentials or external connections
were used.

---

## 4. Final verification (Phase 4)

| Gate | Command | Result |
| --- | --- | --- |
| Full suite | `npm test` | **575 tests · 569 pass · 0 fail · 6 skipped** |
| — baseline (Exec 26) | — | 568 / 562 / 0 / 6 → **+7 pass, 0 new fail** |
| Integrity test | `tests/activation-package-integrity.test.ts` | **16/16 pass** (9 were pre-existing; +7 for 005→006) |
| TypeScript | `npm run typecheck` | **129** — unchanged baseline |
| Bundle execution | `supabase/tests/activation_005_006_harness/run.sh` | **24/24 pass** |

No regression; the +7 tests are the new bundle-integrity assertions.

---

## 5. R1 / R2 status

| Blocker | Status | Evidence |
| --- | --- | --- |
| **R1** — 005 can abort on existing duplicates | **Mitigated, not eliminated** | Exact predicate documented; read-only gate SQL delivered and locally verified to detect conflicts; the harness proves the failure mode is a clean full rollback. **The live check has NOT been run** (no production access), so it remains an operator action before applying 005. |
| **R2** — no frozen 005/006 bundle | **Closed** | `PRODUCTION_ACTIVATION_005_006.sql` created, byte-identical to sources, hash-verified, reproducible via `scripts/generate-activation-bundle.mjs`, and regression-guarded by tests. |

R1 cannot be *fully* closed from this environment: closing it requires running
the read-only preflight against the live ledger, which the rules forbid here.

---

## 6. Files created / changed

- **New** `supabase/PRODUCTION_ACTIVATION_005_006.sql` — the frozen bundle.
- **New** `supabase/EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql` — read-only gate.
- **New** `supabase/tests/activation_005_006_harness/run.sh` — local execution harness.
- **New** `scripts/generate-activation-bundle.mjs` — reproducible generator.
- **Changed** `tests/activation-package-integrity.test.ts` — +7 tests for 005→006.
- **Changed** `AGENTS.md` — Execution 27 invariants.

No application code changed; no AI/Excel feature rebuilt; no source migration
edited; no inventory introduced.

---

## 7. Decision

### **READY** — for the migration package itself (R2 closed; R1 gated).

The package is now a reviewable, hash-verified, locally executed artifact with a
built-in read-only duplicate gate. Applying it is safe **provided** the operator
first runs the preflight and it returns zero rows.

### **NOT READY** — to apply 005→006 to production **blind**.

R1 is only mitigated: if the live ledger already holds duplicate posted
journals, the package will (correctly) abort. The one remaining operator step is
to run `supabase/EXEC27_DUPLICATE_JOURNAL_PREFLIGHT.sql` against
`chlkmdobhvfnldqkgdji` and confirm **zero rows** before applying the bundle.

### Exact next action

1. Run the preflight (read-only) on the live project → expect **zero rows**.
2. If zero: apply `PRODUCTION_ACTIVATION_001_002_003.sql`, then
   `PRODUCTION_ACTIVATION_004.sql`, then `PRODUCTION_ACTIVATION_005_006.sql`,
   then run each file's POST-FLIGHT and `supabase/ANON_VERIFICATION.sql`.
3. If not zero: review/repair the conflicting journals (BLOCK 2 lists them),
   re-run the preflight until zero, then proceed.

---

## 8. Compliance

- No push, no deploy, no `git reset --hard` / `git clean`, no file deletion.
- No production database connection; no SQL run against production.
- No migration applied to any database.
- No real accounting record modified or deleted.
- No app behaviour changed; no AI/Excel rebuild; no inventory added.
- No secret, key or credential printed.
