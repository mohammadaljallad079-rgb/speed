/**
 * Subscription packages and their capabilities (pure).
 *
 * SPEED ERP has no billing system, so a package is a *capability set*, not an
 * invoice. This module is the single source of truth for what a package grants,
 * and the AI layer asks it whether a tenant may use the AI agent and whether it
 * may perform financial writes.
 *
 * The package is stored per tenant in the existing `settings` store (key
 * `tenant_plan`), so assigning a package needs no new table. A missing row is
 * the free package, which is what a brand-new signup gets.
 */

export type PlanId = "free" | "standard" | "premium" | "enterprise";

export interface PlanCapabilities {
  /** The AI assistant answers questions (read-only, grounded in real data). */
  aiAssistant: boolean;
  /** The AI agent may run repair/diagnostic actions. */
  aiAgent: boolean;
  /**
   * The AI agent may perform FINANCIAL writes (issue/reverse an invoice, extend
   * a contract) through the guarded services. Deliberately separate from
   * `aiAgent`: a package can allow diagnosis without allowing postings.
   */
  aiFinancialWrites: boolean;
  /** Excel/CSV export. */
  exports: boolean;
  /** Excel/CSV import. */
  imports: boolean;
}

export interface PlanDefinition {
  id: PlanId;
  nameAr: string;
  nameEn: string;
  capabilities: PlanCapabilities;
}

const NONE: PlanCapabilities = {
  aiAssistant: false,
  aiAgent: false,
  aiFinancialWrites: false,
  exports: false,
  imports: false,
};

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    nameAr: "مجاني",
    nameEn: "Free",
    capabilities: { ...NONE, exports: true },
  },
  standard: {
    id: "standard",
    nameAr: "قياسي",
    nameEn: "Standard",
    capabilities: { ...NONE, exports: true, imports: true, aiAssistant: true },
  },
  premium: {
    id: "premium",
    nameAr: "متقدم",
    nameEn: "Premium",
    capabilities: { ...NONE, exports: true, imports: true, aiAssistant: true, aiAgent: true },
  },
  enterprise: {
    id: "enterprise",
    nameAr: "مؤسسي",
    nameEn: "Enterprise",
    capabilities: {
      exports: true,
      imports: true,
      aiAssistant: true,
      aiAgent: true,
      aiFinancialWrites: true,
    },
  },
};

export const PLAN_IDS: PlanId[] = ["free", "standard", "premium", "enterprise"];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as string[]).includes(value);
}

/** The capabilities for a plan id; an unknown/missing id is the free plan. */
export function capabilitiesFor(plan: unknown): PlanCapabilities {
  return PLANS[isPlanId(plan) ? plan : "free"].capabilities;
}

/**
 * Whether a package grants a capability. Fails closed: an unknown capability or
 * an unknown plan grants nothing.
 */
export function planGrants(plan: unknown, capability: keyof PlanCapabilities): boolean {
  return capabilitiesFor(plan)[capability] === true;
}

/**
 * Whether a repair action's effect is permitted by the package.
 *
 * `read` actions need the agent; `settings` and `financial` both persist a
 * change, so they need the corresponding capability. This is the bridge between
 * the package model and the AI repair catalogue's `effect`.
 */
export function planAllowsEffect(plan: unknown, effect: "read" | "settings" | "financial"): boolean {
  const caps = capabilitiesFor(plan);
  if (effect === "financial") return caps.aiFinancialWrites === true;
  if (effect === "settings") return caps.aiAgent === true;
  return caps.aiAgent === true || caps.aiAssistant === true;
}
