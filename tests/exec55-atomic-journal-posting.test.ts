import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { writeJournal, type PostingClient } from "../src/lib/accounting/manual-posting.ts";
import { buildBankTransferJournal } from "../src/lib/accounting/manual-postings.ts";

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Execution 55 — atomic journal posting (migration 011).
 *
 * The defect: a journal was written as two independent PostgREST calls (header,
 * then lines). A failure between them left a header with no lines - an entry
 * every report ignores (reports read `journal_lines`) but `journal_entries`
 * counts. The application compensated by deleting the header, but that
 * compensation is itself a third request and does not run if the process dies.
 *
 * `writeJournal` now prefers the `post_journal_entry` RPC, which writes the
 * header and its lines in one database transaction, and only falls back to the
 * two-request path when the RPC is genuinely unavailable. These tests pin that
 * contract, including the dangerous case: a real database error must NOT be
 * swallowed into a non-atomic retry.
 */

/** A client that records which path was taken. */
function makeClient(opts: {
  rpc?: "ok" | "unavailable" | "error";
  failLines?: boolean;
}) {
  const calls = { rpc: 0, headerInsert: 0, lineInsert: 0, headerDelete: 0 };
  let seq = 0;

  class Q {
    table: string;
    op = "select";
    filters: [string, unknown][] = [];
    row: unknown = null;
    constructor(t: string) {
      this.table = t;
    }
    select() {
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push([c, v]);
      return this;
    }
    is() {
      return this;
    }
    in() {
      return this;
    }
    or() {
      return this;
    }
    limit() {
      return this;
    }
    insert(r: unknown) {
      this.op = "insert";
      this.row = r;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    async single() {
      if (this.op === "insert" && this.table === "journal_entries") {
        calls.headerInsert++;
        return { data: { id: `je-${++seq}` }, error: null };
      }
      return { data: null, error: null };
    }
    async maybeSingle() {
      return { data: null, error: null };
    }
    async then(res: (v: unknown) => unknown) {
      if (this.op === "select" && this.table === "accounts") {
        // A shared (NULL-tenant) chart: every referenced id is usable.
        return res({ data: [{ id: "acc-cash", code: "11001", tenant_id: null }, { id: "acc-bank", code: "11002", tenant_id: null }], error: null });
      }
      if (this.op === "insert" && this.table === "journal_lines") {
        calls.lineInsert++;
        if (opts.failLines) return res({ data: null, error: { message: "line insert failed" } });
        return res({ data: [], error: null });
      }
      if (this.op === "delete" && this.table === "journal_entries") {
        calls.headerDelete++;
        return res({ data: null, error: null });
      }
      return res({ data: null, error: null });
    }
  }

  const client: Record<string, unknown> = { from: (t: string) => new Q(t) };

  if (opts.rpc) {
    client.rpc = async (fn: string, _args?: Record<string, unknown>) => {
      calls.rpc++;
      assert.equal(fn, "post_journal_entry", "writeJournal must call the atomic RPC");
      if (opts.rpc === "ok") return { data: "je-atomic", error: null };
      if (opts.rpc === "unavailable") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.post_journal_entry" } };
      }
      // A genuine failure: a refused unbalanced journal, a permission denial.
      return { data: null, error: { code: "23514", message: "journal does not balance" } };
    };
  }

  return { client: client as unknown as PostingClient, calls };
}

const journal = buildBankTransferJournal({
  journalNumber: "JV-1",
  date: "2026-01-01",
  description: "transfer",
  amount: 99,
  fromAccountId: "acc-cash",
  toAccountId: "acc-bank",
  reference: "BT-1",
})!;

describe("the atomic RPC is the preferred write path", () => {
  test("when the RPC succeeds, no direct insert is made at all", async () => {
    const { client, calls } = makeClient({ rpc: "ok" });
    const id = await writeJournal(client, journal);
    assert.equal(id, "je-atomic");
    assert.equal(calls.rpc, 1);
    assert.equal(calls.headerInsert, 0, "the header must not be inserted separately when the RPC succeeded");
    assert.equal(calls.lineInsert, 0, "the lines must not be inserted separately when the RPC succeeded");
  });

  test("the RPC receives the header and the lines as one call", async () => {
    let seen: Record<string, unknown> | undefined;
    const client = {
      from: () => {
        throw new Error("should not be called");
      },
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        seen = args;
        return { data: "je-x", error: null };
      },
    } as unknown as PostingClient;

    await writeJournal(client, journal);
    assert.ok(seen, "rpc was not called");
    assert.equal((seen as Record<string, unknown>).p_header, journal.header);
    assert.equal((seen as Record<string, unknown>).p_lines, journal.lines);
  });
});

describe("the fallback path is used only when the RPC is genuinely absent", () => {
  test("an unavailable RPC falls back to the two-request write", async () => {
    const { client, calls } = makeClient({ rpc: "unavailable" });
    const id = await writeJournal(client, journal);
    assert.equal(id, "je-1");
    assert.equal(calls.rpc, 1);
    assert.equal(calls.headerInsert, 1);
    assert.equal(calls.lineInsert, 1);
  });

  test("a client with no rpc takes the two-request path", async () => {
    const { client, calls } = makeClient({});
    const id = await writeJournal(client, journal);
    assert.equal(id, "je-1");
    assert.equal(calls.rpc, 0);
    assert.equal(calls.headerInsert, 1);
    assert.equal(calls.lineInsert, 1);
  });

  test("a failed line insert still removes the orphan header", async () => {
    const { client, calls } = makeClient({ failLines: true });
    await assert.rejects(() => writeJournal(client, journal));
    assert.equal(calls.headerDelete, 1, "the orphan header must be compensated");
  });

  test("a REAL rpc error is NOT swallowed into a non-atomic retry", async () => {
    // This is the dangerous case. If a genuine failure (an unbalanced journal, a
    // permission denial, a constraint violation) were treated as "RPC missing",
    // the code would retry with the weaker two-request path and could post a
    // journal the database had just refused.
    const { client, calls } = makeClient({ rpc: "error" });
    await assert.rejects(() => writeJournal(client, journal), /atomically/);
    assert.equal(calls.rpc, 1);
    assert.equal(calls.headerInsert, 0, "a refused post must not be retried with a direct insert");
    assert.equal(calls.lineInsert, 0, "a refused post must not be retried with a direct insert");
  });

  test("an unbalanced journal is refused before any write, on either path", async () => {
    const { client, calls } = makeClient({ rpc: "ok" });
    const unbalanced = {
      ...journal,
      header: { ...journal.header, total_debit: 100, total_credit: 90 },
    };
    await assert.rejects(() => writeJournal(client, unbalanced), /unbalanced/);
    assert.equal(calls.rpc, 0, "the RPC must not be called for an unbalanced journal");
    assert.equal(calls.headerInsert, 0);
  });
});

describe("migration 011 defines the contract the client relies on", () => {
  const mig = read("supabase/migrations/011_atomic_journal_posting.sql");

  test("the function is named exactly as the client calls it", () => {
    assert.match(mig, /create or replace function public\.post_journal_entry\(\s*p_header jsonb,\s*p_lines\s+jsonb\s*\)/);
  });

  test("it refuses an empty line set", () => {
    assert.match(mig, /jsonb_array_length\(p_lines\) = 0/);
    assert.match(mig, /at least one line/);
  });

  test("it refuses a line with both or neither side set", () => {
    assert.match(mig, /exactly one of debit\/credit/);
  });

  test("it refuses an unbalanced journal", () => {
    assert.match(mig, /does not balance/);
  });

  test("it inserts the header and the lines in the same function body", () => {
    const headerAt = mig.indexOf("insert into public.journal_entries");
    const linesAt = mig.indexOf("insert into public.journal_lines");
    assert.ok(headerAt > 0 && linesAt > headerAt, "both inserts must be in the function, header first");
  });

  test("it is not SECURITY DEFINER (RLS still applies to a non-service caller)", () => {
    // Ignore comments: the migration explains WHY it avoids SECURITY DEFINER.
    const code = mig
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    assert.doesNotMatch(code, /security\s+definer/i);
  });

  test("it is a clean no-op when the journal tables are absent", () => {
    assert.match(mig, /journal tables absent, skipping/);
  });

  test("it only inserts columns the schema actually has", () => {
    // The live schema and the migration history disagree about optional columns;
    // naming a missing one would abort the whole insert.
    for (const column of ["entry_type", "reference_number", "status", "is_balanced", "total_debit", "total_credit"]) {
      assert.match(mig, new RegExp(`column_name='${column}'`), `011 must guard the ${column} column`);
    }
  });
});

describe("writeJournal is the only journal writer, and it is shared", () => {
  test("the sales posting service delegates to the shared writer", () => {
    const sales = read("src/lib/accounting/sales-posting.ts");
    assert.match(sales, /from "\.\/manual-posting"/, "must import the shared writer");
    assert.match(sales, /writeSharedJournal\(/);
    // It must not build its own header/lines insert.
    assert.doesNotMatch(sales, /from\("journal_entries"\)\s*\.insert/);
    assert.doesNotMatch(sales, /from\("journal_lines"\)\s*\.insert/);
  });

  test("the receipt posting service delegates to the shared writer", () => {
    const receipt = read("src/lib/accounting/receipt-posting.ts");
    assert.match(receipt, /from "\.\/manual-posting"/, "must import the shared writer");
    assert.match(receipt, /writeSharedJournal\(/);
    assert.doesNotMatch(receipt, /from\("journal_entries"\)\s*\.insert/);
    assert.doesNotMatch(receipt, /from\("journal_lines"\)\s*\.insert/);
  });

  test("no accounting module other than the shared writer inserts journal rows", () => {
    // One writer, one transaction. A per-module insert is the drift that left
    // sales/receipts non-atomic even after 011 existed.
    const dir = path.join(ROOT, "src/lib/accounting");
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".ts") || f === "manual-posting.ts") continue;
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      assert.doesNotMatch(
        src,
        /from\("journal_lines"\)\s*\.insert/,
        `${f} inserts journal_lines directly; route it through writeJournal`,
      );
    }
  });
});
