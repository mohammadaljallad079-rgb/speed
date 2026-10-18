import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  applyAccountBalanceDelta,
  ACCOUNT_BALANCE_SIGN_CONVENTION,
  ACCOUNT_BALANCE_KNOWN_DEVIATIONS,
} from "../src/lib/accounting/account-balance.ts";

/**
 * Execution 17 - account-balance integrity.
 *
 * `accounts.balance` is a denormalised CACHE; the ledger (`journal_lines`) is
 * authoritative and every report derives from it. The `update_account_balance`
 * RPC is not defined in any migration, so its sign cannot be verified from
 * source and is NOT changed here. These tests pin the behaviour-preserving
 * single call path and the fact that no page calls the RPC directly.
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

// Exec 35: the balance-cache nudge moved from the browser pages to the server
// routes; the pages no longer touch the ledger or the balance cache at all.
const MODULES = [
  "src/app/api/accounting/bank-transfer/route.ts",
  "src/app/api/payroll/route.ts",
  "src/app/api/accounting/petty-cash/route.ts",
  "src/app/api/rentals/deposit-refund/route.ts",
];

describe("applyAccountBalanceDelta - behaviour-preserving call path", () => {
  test("forwards the signed amount to the RPC unchanged", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      rpc: async (fn: string, args: unknown) => {
        calls.push([fn, args]);
        return { error: null };
      },
    };
    const res = await applyAccountBalanceDelta(client as never, "acc-1", -125.5);
    assert.deepEqual(res, { ok: true, error: null });
    assert.deepEqual(calls, [
      ["update_account_balance", { account_id: "acc-1", amount: -125.5 }],
    ]);
  });

  test("returns ok:false with the message on a generic RPC error", async () => {
    const client = { rpc: async () => ({ error: { message: "permission denied" } }) };
    const res = await applyAccountBalanceDelta(client as never, "acc-1", 10);
    assert.equal(res.ok, false);
    assert.equal(res.error, "permission denied");
  });

  test("flags a missing function (42883) without throwing", async () => {
    const client = {
      rpc: async () => ({ error: { message: "function does not exist", code: "42883" } }),
    };
    const res = await applyAccountBalanceDelta(client as never, "acc-1", 10);
    assert.equal(res.ok, false);
    assert.match(String(res.error), /function does not exist/);
  });

  test("never throws when the client itself throws (posting must not abort)", async () => {
    const client = {
      rpc: async () => {
        throw new Error("network down");
      },
    };
    const res = await applyAccountBalanceDelta(client as never, "acc-1", 10);
    assert.equal(res.ok, false);
    assert.equal(res.error, "network down");
  });
});

describe("the balance update path is single and auditable", () => {
  for (const p of MODULES) {
    test(`${p} uses the shared balance helper, not the RPC`, () => {
      const src = read(p);
      assert.doesNotMatch(
        src,
        /supabase\.rpc\(\s*['"]update_account_balance['"]/,
        "must go through applyAccountBalanceDelta",
      );
      assert.match(src, /applyAccountBalanceDelta\(/, "must use the shared helper");
    });
  }

  test("no page calls the RPC directly anywhere", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const src = fs.readFileSync(full, "utf8");
          if (/\.rpc\(\s*['"]update_account_balance['"]/.test(src)) {
            offenders.push(path.relative(ROOT, full));
          }
        }
      }
    };
    walk(path.join(ROOT, "src"));
    assert.deepEqual(
      offenders,
      ["src/lib/accounting/account-balance.ts"],
      "only the shared helper may call update_account_balance",
    );
  });

  test("the sign convention and known deviation are documented", () => {
    assert.match(ACCOUNT_BALANCE_SIGN_CONVENTION, /debit/i);
    assert.equal(ACCOUNT_BALANCE_KNOWN_DEVIATIONS.length >= 1, true);
    assert.match(ACCOUNT_BALANCE_KNOWN_DEVIATIONS[0].file, /refund|deposit/);
  });

  test("the read-only verification query ships for the operator", () => {
    const sql = read("supabase/ACCOUNT_BALANCE_VERIFICATION.sql");
    assert.match(sql, /pg_get_functiondef/);
    assert.match(sql, /drift/);
    assert.doesNotMatch(sql, /^\s*(update|insert|delete|alter|drop)\b/im, "must be read-only");
  });
});
