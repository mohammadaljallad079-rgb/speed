import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  PLANS,
  PLAN_IDS,
  capabilitiesFor,
  isPlanId,
  planAllowsEffect,
  planGrants,
} from "../src/lib/saas/entitlements.ts";
import { loadTenantPlan, saveTenantPlan, TENANT_PLAN_KEY } from "../src/lib/saas/tenant-plan.ts";
import { REPAIR_ACTIONS } from "../src/lib/ai/repair-catalog.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("Exec 59 — subscription packages gate AI capability", () => {
  test("the free plan grants no AI capability", () => {
    const caps = capabilitiesFor("free");
    assert.equal(caps.aiAssistant, false);
    assert.equal(caps.aiAgent, false);
    assert.equal(caps.aiFinancialWrites, false);
  });

  test("capability is monotonic: a higher package never grants less", () => {
    const order = ["free", "standard", "premium", "enterprise"] as const;
    const keys = ["aiAssistant", "aiAgent", "aiFinancialWrites", "exports", "imports"] as const;
    for (let i = 1; i < order.length; i++) {
      for (const k of keys) {
        if (capabilitiesFor(order[i - 1])[k]) {
          assert.equal(capabilitiesFor(order[i])[k], true, `${order[i]} must keep ${k} from ${order[i - 1]}`);
        }
      }
    }
  });

  test("only the enterprise package allows financial writes", () => {
    assert.equal(planAllowsEffect("premium", "financial"), false);
    assert.equal(planAllowsEffect("enterprise", "financial"), true);
    assert.equal(planAllowsEffect("free", "financial"), false);
  });

  test("an unknown plan fails closed", () => {
    assert.equal(planGrants("nonsense", "aiAgent"), false);
    assert.equal(planGrants(undefined, "aiFinancialWrites"), false);
    assert.equal(capabilitiesFor("nonsense").aiAssistant, false);
  });

  test("every plan id is well formed and complete", () => {
    for (const id of PLAN_IDS) {
      assert.ok(isPlanId(id));
      const p = PLANS[id];
      assert.ok(p.nameAr && p.nameEn, `${id} must be named in both languages`);
      assert.equal(Object.keys(p.capabilities).length, 5);
    }
  });
});

describe("Exec 59 — the tenant plan store", () => {
  function stubDb(seed: Record<string, unknown> | null) {
    const writes: Array<{ table: string; row: Record<string, unknown> }> = [];
    return {
      writes,
      db: {
        from(table: string) {
          return {
            select: () => {
              const q: any = {
                eq: () => q,
                maybeSingle: async () => ({ data: seed, error: null }),
              };
              return q;
            },
            upsert: async (row: Record<string, unknown>) => {
              writes.push({ table, row });
              return { error: null };
            },
          };
        },
      } as never,
    };
  }

  test("an absent row is the free plan", async () => {
    const { db } = stubDb(null);
    assert.equal(await loadTenantPlan(db, "t1"), "free");
  });

  test("a stored plan is read back", async () => {
    const { db } = stubDb({ value: { plan: "premium" } });
    assert.equal(await loadTenantPlan(db, "t1"), "premium");
  });

  test("a corrupt stored value fails closed to free", async () => {
    const { db } = stubDb({ value: { plan: "godmode" } });
    assert.equal(await loadTenantPlan(db, "t1"), "free");
  });

  test("an unreadable store fails closed to free", async () => {
    const db = {
      from: () => ({
        select: () => {
          const q: any = { eq: () => q, maybeSingle: async () => ({ data: null, error: { message: "boom" } }) };
          return q;
        },
        upsert: async () => ({ error: null }),
      }),
    } as never;
    assert.equal(await loadTenantPlan(db, "t1"), "free");
  });

  test("saving writes the canonical key with the tenant conflict target", async () => {
    const { db, writes } = stubDb(null);
    const res = await saveTenantPlan(db, "t1", "enterprise");
    assert.equal(res.ok, true);
    assert.equal(writes[0].table, "settings");
    assert.equal(writes[0].row.key, TENANT_PLAN_KEY);
    assert.equal(writes[0].row.tenant_id, "t1");
  });

  test("saving an unknown plan is refused", async () => {
    const { db, writes } = stubDb(null);
    const res = await saveTenantPlan(db, "t1", "godmode" as never);
    assert.equal(res.ok, false);
    assert.equal(writes.length, 0);
  });
});

describe("Exec 59 — the route enforces the package", () => {
  const route = read("src/app/api/ai/repairs/route.ts");

  test("the catalogue, propose and execute are all plan-filtered", () => {
    assert.match(route, /planAllowsEffect\(plan, a\.effect\)/, "catalogue filtered by package");
    assert.match(route, /planAllowsEffect\(plan, chosenSpec\.effect\)/, "a chosen action is refused by package");
    assert.match(route, /planAllowsEffect\(execPlan, execSpec\.effect\)/, "execute re-checks the package");
  });

  test("a downgraded package blocks an already-approved write", () => {
    assert.match(route, /plan_upgrade_required/);
  });

  test("a super admin is the platform operator, not gated by a company package", () => {
    // The exemption now lives in the shared resolver, which receives the flag
    // from the session context rather than being special-cased in the route.
    assert.match(route, /resolveEntitlements\(/);
    assert.match(route, /isSuperAdmin: context\.isSuperAdmin/);
  });

  test("the plan is read from the session tenant, never the request body", () => {
    assert.match(route, /resolveEntitlements\(supabaseAdmin as never, context\.tenantId/);
    assert.doesNotMatch(route, /resolveEntitlements\([^)]*body\.tenantId/);
    assert.doesNotMatch(route, /body\.tenantId/);
  });

  test("the plan route is super-admin only and audit-logs the change", () => {
    const planRoute = read("src/app/api/super-admin/tenants/[id]/plan/route.ts");
    assert.match(planRoute, /requireSuperAdmin: true/);
    assert.match(planRoute, /assertSuperAdmin\(context\)/);
    assert.match(planRoute, /logAudit\(/);
    assert.match(planRoute, /entity: "tenant_plan"/);
  });

  test("every catalogue effect maps onto a package capability", () => {
    for (const a of REPAIR_ACTIONS) {
      const grantedBySomething = PLAN_IDS.some((p) => planAllowsEffect(p, a.effect));
      assert.equal(grantedBySomething, true, `${a.id} (${a.effect}) must be grantable by some package`);
    }
  });
});

describe("Exec 59 — the package console and the shared AI panel", () => {
  const consolePage = read("src/app/super-admin/page.tsx");
  const panel = read("src/components/ai/AiAssistantPanel.tsx");

  test("the subscriptions tab reads each company's package from the guarded API", () => {
    assert.match(consolePage, /\/api\/super-admin\/tenants\/\$\{x\.id\}\/plan/);
    assert.match(consolePage, /method: "PUT"/);
  });

  test("the subscriptions tab no longer claims paid plans are unimplemented", () => {
    assert.doesNotMatch(consolePage, /Paid plans are not implemented/);
    assert.doesNotMatch(consolePage, /الخطط المدفوعة غير مفعّلة/);
  });

  test("the console assigns packages and never lets a company grant itself one", () => {
    // The write goes through the super-admin route only.
    assert.match(consolePage, /body: JSON\.stringify\(\{ plan \}\)/);
    assert.doesNotMatch(consolePage, /\.from\(['"]settings['"]\)/);
  });

  test("the console renders the same AI engine as a company dashboard", () => {
    assert.match(consolePage, /<AiAssistantPanel screen="super-admin" variant="super-admin" \/>/);
    const dashboard = read("src/app/dashboard/page.tsx");
    assert.match(dashboard, /<AiAssistantPanel screen="dashboard" \/>/);
  });

  test("the panel exposes the financial write commands and forwards typed params", () => {
    assert.match(panel, /runCommand/);
    assert.match(panel, /c\.propose\(text, undefined, params\)/);
    assert.match(panel, /Issue invoice|أصدر الفاتورة/);
    assert.match(panel, /Reverse/);
    assert.match(panel, /Extend/);
  });

  test("the panel never posts to the AI endpoints itself outside the controller", () => {
    // All repair traffic goes through the controller (repair-client), which is
    // the only place that decides success.
    assert.doesNotMatch(panel, /fetch\("\/api\/ai\/repairs/);
  });
});
