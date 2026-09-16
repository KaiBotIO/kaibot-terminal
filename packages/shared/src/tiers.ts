// Tier catalogue — the single source of truth for what each user type may do.
//
// The model has three orthogonal layers:
//   1. BASE PLANS (free / essential / trader / pro) — features + limits, NO AI.
//   2. AI MODULES (assist / strategist / live-intel) — stackable add-ons that
//      grant AI capability on top of ANY base plan.
//   3. USAGE (prepaid credit packs + per-tier spend caps) — see pricing.ts.
//
// A user holds one base plan and zero or more AI modules (each is its own Stripe
// product / group). resolveTier (packages/trpc lib/tier.ts) turns their held
// groups into the union of all grants — a single TierEntitlements the whole
// backend and UI check access against.
//
// Keep this dependency-free (no DB, no React, no tRPC) so the Astro site imports
// it directly. Prices live here too (single home — pricing.ts derives from it).

// --- AI model tiers ---------------------------------------------------------

// Ordered weakest -> strongest. The numeric rank lets the merge pick the best
// tier across several grants without hardcoding comparisons.
export type AiTier = 'free' | 'light' | 'supersmart' | 'top';

export const AI_TIER_RANK: Record<AiTier, number> = {
  free: 0,
  light: 1,
  supersmart: 2,
  top: 3,
};

/** Resolve which AiTier is the higher of two. */
export function maxAiTier(a: AiTier, b: AiTier): AiTier {
  return AI_TIER_RANK[a] >= AI_TIER_RANK[b] ? a : b;
}

// --- Entitlements -----------------------------------------------------------

// The resolved capability object every gate checks. Model-power flags
// (aiTier/allowOpus/allowGrok) drive model routing and stay named as before so
// existing AI gates keep working unchanged; the module + feature booleans and
// the quota/cap numbers are what the redesign adds.
export interface TierEntitlements {
  // AI model power (drives model routing + the existing AI gates).
  aiTier: AiTier;
  aiEnabled: boolean;
  /** Strongest reasoning model class available. Never expose model names. */
  allowOpus: boolean;
  allowGrok: boolean;
  // AI modules (per-surface entitlement, set by the add-on modules).
  allowAssist: boolean; // KAI chat + standard in-strategy AI
  allowStrategist: boolean; // strategy/indicator agents, advanced in-strategy AI, AI-optimize
  allowLiveIntel: boolean; // live X / sentiment research (Grok path)
  // Base-plan features.
  canUseIndicators: boolean; // indicator library + studio compute
  canRunBots: boolean; // run signal bots, forward tests, optimize, tuning, publish
  canUseExecutor: boolean; // remote executor companion control
  // Limits (null = unlimited).
  maxSubscriptions: number | null;
  backtestsPerMonth: number | null;
  // Per-tier AI spend caps in EUR micros (null = uncapped). 0 = no AI budget.
  aiDailyMicros: number | null;
  aiMonthlyMicros: number | null;
}

// Per-field merge strategy. The mapped type FORCES every TierEntitlements field
// to declare how two grants combine — add a field and this fails to compile
// until you give it a strategy, which kills the "forgot to merge a field" bug.
const or = (a: boolean, b: boolean): boolean => a || b;
const maxNullWins = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : Math.max(a, b);

const MERGE: { [K in keyof TierEntitlements]: (a: TierEntitlements[K], b: TierEntitlements[K]) => TierEntitlements[K] } = {
  aiTier: maxAiTier,
  aiEnabled: or,
  allowOpus: or,
  allowGrok: or,
  allowAssist: or,
  allowStrategist: or,
  allowLiveIntel: or,
  canUseIndicators: or,
  canRunBots: or,
  canUseExecutor: or,
  maxSubscriptions: maxNullWins,
  backtestsPerMonth: maxNullWins,
  aiDailyMicros: maxNullWins,
  aiMonthlyMicros: maxNullWins,
};

const ENTITLEMENT_KEYS = Object.keys(MERGE) as (keyof TierEntitlements)[];

/** Combine one grant into an accumulator, field by field, via MERGE. */
function mergeOne(acc: TierEntitlements, grant: TierEntitlements): TierEntitlements {
  const out = { ...acc };
  for (const key of ENTITLEMENT_KEYS) {
    // Each MERGE[key] is typed for its own field; the loop erases that to the
    // union, so one cast at the boundary keeps the call sites clean.
    (out[key] as unknown) = (MERGE[key] as (a: unknown, b: unknown) => unknown)(acc[key], grant[key]);
  }
  return out;
}

/**
 * Take the UNION of a set of grants (base plan + any modules). Highest AI tier,
 * every capability any grant enables, and the most generous cap (null wins).
 * An empty list resolves to the free entitlements.
 */
export function mergeEntitlements(grants: TierEntitlements[]): TierEntitlements {
  if (grants.length === 0) return { ...FREE_ENTITLEMENTS };
  return grants.reduce((acc, g) => mergeOne(acc, g));
}

// --- Base plans -------------------------------------------------------------

export type BasePlanKey = 'free' | 'essential' | 'trader' | 'pro';

export interface BasePlan {
  key: BasePlanKey;
  label: string;
  /** Monthly price in EUR (0 for free). */
  monthly: number;
  /** Discounted per-month price billed yearly, EUR. */
  yearlyPerMonth: number;
  /** Total annual charge, EUR. */
  yearlyTotal: number;
  entitlements: TierEntitlements;
}

// Neutral grant a module extends: base features off, numeric limits at their
// lowest non-unlocking value (0) so a module never lowers a base plan's caps.
const NEUTRAL: TierEntitlements = {
  aiTier: 'free',
  aiEnabled: false,
  allowOpus: false,
  allowGrok: false,
  allowAssist: false,
  allowStrategist: false,
  allowLiveIntel: false,
  canUseIndicators: false,
  canRunBots: false,
  canUseExecutor: false,
  maxSubscriptions: 0,
  backtestsPerMonth: 0,
  aiDailyMicros: 0,
  aiMonthlyMicros: 0,
};

export const BASE_PLANS: Record<BasePlanKey, BasePlan> = {
  free: {
    key: 'free',
    label: 'Free',
    monthly: 0,
    yearlyPerMonth: 0,
    yearlyTotal: 0,
    entitlements: {
      ...NEUTRAL,
      maxSubscriptions: 1,
      backtestsPerMonth: 20,
    },
  },
  essential: {
    key: 'essential',
    label: 'Essential',
    monthly: 9,
    yearlyPerMonth: 8,
    yearlyTotal: 90,
    entitlements: {
      ...NEUTRAL,
      canUseIndicators: true,
      maxSubscriptions: 3,
      backtestsPerMonth: 100,
    },
  },
  trader: {
    key: 'trader',
    label: 'Trader',
    monthly: 29,
    yearlyPerMonth: 24,
    yearlyTotal: 290,
    entitlements: {
      ...NEUTRAL,
      canUseIndicators: true,
      canRunBots: true,
      maxSubscriptions: 10,
      backtestsPerMonth: null,
    },
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    monthly: 59,
    yearlyPerMonth: 49,
    yearlyTotal: 590,
    entitlements: {
      ...NEUTRAL,
      canUseIndicators: true,
      canRunBots: true,
      canUseExecutor: true,
      maxSubscriptions: null,
      backtestsPerMonth: null,
    },
  },
};

// --- AI modules -------------------------------------------------------------

export type AiModuleKey = 'assist' | 'strategist' | 'live-intel';

export interface AiModule {
  key: AiModuleKey;
  label: string;
  monthly: number;
  yearlyPerMonth: number;
  yearlyTotal: number;
  /** Monthly credit budget included with the subscription, EUR micros. */
  includedCreditsMicros: number;
  entitlements: TierEntitlements;
}

export const AI_MODULES: Record<AiModuleKey, AiModule> = {
  assist: {
    key: 'assist',
    label: 'AI Assist',
    monthly: 9,
    yearlyPerMonth: 8,
    yearlyTotal: 90,
    includedCreditsMicros: 3_000_000, // €3
    entitlements: {
      ...NEUTRAL,
      aiTier: 'light',
      aiEnabled: true,
      allowAssist: true,
      aiDailyMicros: 2_000_000,
      aiMonthlyMicros: 15_000_000,
    },
  },
  strategist: {
    key: 'strategist',
    label: 'AI Strategist',
    monthly: 19,
    yearlyPerMonth: 16,
    yearlyTotal: 190,
    includedCreditsMicros: 8_000_000, // €8
    entitlements: {
      ...NEUTRAL,
      aiTier: 'supersmart',
      aiEnabled: true,
      allowOpus: true,
      allowAssist: true,
      allowStrategist: true,
      aiDailyMicros: 5_000_000,
      aiMonthlyMicros: 50_000_000,
    },
  },
  'live-intel': {
    key: 'live-intel',
    label: 'AI Live Intel',
    monthly: 29,
    yearlyPerMonth: 24,
    yearlyTotal: 290,
    includedCreditsMicros: 12_000_000, // €12
    entitlements: {
      ...NEUTRAL,
      aiTier: 'top',
      aiEnabled: true,
      allowGrok: true,
      allowAssist: true,
      allowLiveIntel: true,
      aiDailyMicros: 8_000_000,
      aiMonthlyMicros: 80_000_000,
    },
  },
};

/** The entitlements a user with no paid plan gets. */
export const FREE_ENTITLEMENTS: TierEntitlements = BASE_PLANS.free.entitlements;

/** Everything unlocked (top base plan + every module) — used for the dev-open path. */
export const FULL_ENTITLEMENTS: TierEntitlements = mergeEntitlements([
  BASE_PLANS.pro.entitlements,
  ...Object.values(AI_MODULES).map((m) => m.entitlements),
]);

// --- Groups: the Stripe-sync + gating slugs ---------------------------------

// Feature groups the backend gates on (assertEntitlement). Base plans grant the
// set matching their feature flags; keeping these slugs stable means the ~11
// existing group gates need no change.
export type EntitlementGroup = 'platform' | 'indicator-access' | 'pro';

// Group slugs each base plan grants. The identity slug (essential/trader/pro)
// lets resolveTier map back to the plan; the feature slugs (indicator-access /
// platform) drive the existing gates. A consistency test asserts these stay in
// lockstep with the entitlement flags.
export const BASE_PLAN_GROUPS: Record<BasePlanKey, string[]> = {
  free: [],
  essential: ['essential', 'indicator-access'],
  trader: ['trader', 'indicator-access', 'platform'],
  pro: ['pro', 'indicator-access', 'platform'],
};

// Group slug each AI module grants.
export const AI_MODULE_GROUP: Record<AiModuleKey, string> = {
  assist: 'ai-assist',
  strategist: 'ai-strategist',
  'live-intel': 'ai-live-intel',
};

// Inverse maps used by resolveTier: identity/module slug -> key.
export const GROUP_BASE_PLAN: Record<string, BasePlanKey> = {
  essential: 'essential',
  trader: 'trader',
  pro: 'pro',
};

export const GROUP_AI_MODULE: Record<string, AiModuleKey> = {
  'ai-assist': 'assist',
  'ai-strategist': 'strategist',
  'ai-live-intel': 'live-intel',
};

// --- Products: the purchasable Stripe items ---------------------------------

// One product per paid base plan + one per AI module. Kept in lockstep (by
// value) with BillingProductKey in db-postgres schema.ts. 'free' has no product.
export type ProductKey =
  | 'essential'
  | 'trader'
  | 'pro'
  | 'ai-assist'
  | 'ai-strategist'
  | 'ai-live-intel';

export interface ProductInfo {
  key: ProductKey;
  name: string;
  kind: 'base' | 'module';
  monthly: number;
  yearlyPerMonth: number;
  yearlyTotal: number;
  /** Group slugs this product grants on an active subscription. */
  groups: string[];
}

export const PRODUCT_CATALOGUE: Record<ProductKey, ProductInfo> = {
  essential: {
    key: 'essential',
    name: BASE_PLANS.essential.label,
    kind: 'base',
    monthly: BASE_PLANS.essential.monthly,
    yearlyPerMonth: BASE_PLANS.essential.yearlyPerMonth,
    yearlyTotal: BASE_PLANS.essential.yearlyTotal,
    groups: BASE_PLAN_GROUPS.essential,
  },
  trader: {
    key: 'trader',
    name: BASE_PLANS.trader.label,
    kind: 'base',
    monthly: BASE_PLANS.trader.monthly,
    yearlyPerMonth: BASE_PLANS.trader.yearlyPerMonth,
    yearlyTotal: BASE_PLANS.trader.yearlyTotal,
    groups: BASE_PLAN_GROUPS.trader,
  },
  pro: {
    key: 'pro',
    name: BASE_PLANS.pro.label,
    kind: 'base',
    monthly: BASE_PLANS.pro.monthly,
    yearlyPerMonth: BASE_PLANS.pro.yearlyPerMonth,
    yearlyTotal: BASE_PLANS.pro.yearlyTotal,
    groups: BASE_PLAN_GROUPS.pro,
  },
  'ai-assist': {
    key: 'ai-assist',
    name: AI_MODULES.assist.label,
    kind: 'module',
    monthly: AI_MODULES.assist.monthly,
    yearlyPerMonth: AI_MODULES.assist.yearlyPerMonth,
    yearlyTotal: AI_MODULES.assist.yearlyTotal,
    groups: [AI_MODULE_GROUP.assist],
  },
  'ai-strategist': {
    key: 'ai-strategist',
    name: AI_MODULES.strategist.label,
    kind: 'module',
    monthly: AI_MODULES.strategist.monthly,
    yearlyPerMonth: AI_MODULES.strategist.yearlyPerMonth,
    yearlyTotal: AI_MODULES.strategist.yearlyTotal,
    groups: [AI_MODULE_GROUP.strategist],
  },
  'ai-live-intel': {
    key: 'ai-live-intel',
    name: AI_MODULES['live-intel'].label,
    kind: 'module',
    monthly: AI_MODULES['live-intel'].monthly,
    yearlyPerMonth: AI_MODULES['live-intel'].yearlyPerMonth,
    yearlyTotal: AI_MODULES['live-intel'].yearlyTotal,
    groups: [AI_MODULE_GROUP['live-intel']],
  },
};

/** Group slugs a product grants (used by the Stripe entitlement sync). */
export function groupsForProduct(product: ProductKey): string[] {
  // Runtime values can bypass the ProductKey type (legacy DB rows on an
  // unmigrated deployment, unexpected webhook payloads). A throw here would
  // take down the whole entitlement sync — degrade to "grants nothing" loudly.
  const info = (PRODUCT_CATALOGUE as Record<string, ProductInfo | undefined>)[product];
  if (!info) {
    console.error(`[tiers] unknown product '${product}' — granting no groups`);
    return [];
  }
  return info.groups;
}

/** All distinct group slugs the catalogue can grant (for seeding / audits). */
export function allEntitlementGroups(): string[] {
  const slugs = new Set<string>();
  for (const groups of Object.values(BASE_PLAN_GROUPS)) groups.forEach((g) => slugs.add(g));
  for (const slug of Object.values(AI_MODULE_GROUP)) slugs.add(slug);
  return [...slugs];
}
