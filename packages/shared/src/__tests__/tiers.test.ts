import { describe, expect, it } from 'bun:test';
import {
  BASE_PLANS,
  AI_MODULES,
  BASE_PLAN_GROUPS,
  AI_MODULE_GROUP,
  GROUP_BASE_PLAN,
  GROUP_AI_MODULE,
  PRODUCT_CATALOGUE,
  AI_TIER_RANK,
  FREE_ENTITLEMENTS,
  FULL_ENTITLEMENTS,
  maxAiTier,
  mergeEntitlements,
  groupsForProduct,
  allEntitlementGroups,
  type TierEntitlements,
} from '../tiers';

describe('base plans', () => {
  it('free is the no-AI, single-subscription, metered-backtest tier', () => {
    expect(BASE_PLANS.free.entitlements).toMatchObject({
      aiEnabled: false,
      canUseIndicators: false,
      canRunBots: false,
      canUseExecutor: false,
      maxSubscriptions: 1,
      backtestsPerMonth: 20,
    });
    expect(BASE_PLANS.free.monthly).toBe(0);
  });

  it('base plans carry NO AI capability (AI is modules-only)', () => {
    for (const plan of Object.values(BASE_PLANS)) {
      expect(plan.entitlements.aiEnabled).toBe(false);
      expect(plan.entitlements.allowOpus).toBe(false);
      expect(plan.entitlements.allowGrok).toBe(false);
      expect(plan.entitlements.aiTier).toBe('free');
      expect(plan.entitlements.aiDailyMicros).toBe(0);
    }
  });

  it('features unlock monotonically free < essential < trader < pro', () => {
    expect(BASE_PLANS.essential.entitlements.canUseIndicators).toBe(true);
    expect(BASE_PLANS.trader.entitlements.canRunBots).toBe(true);
    expect(BASE_PLANS.pro.entitlements.canUseExecutor).toBe(true);
    expect(BASE_PLANS.trader.entitlements.backtestsPerMonth).toBeNull();
    expect(BASE_PLANS.pro.entitlements.maxSubscriptions).toBeNull();
  });
});

describe('ai modules', () => {
  it('assist / strategist / live-intel each enable AI and their own module flag', () => {
    expect(AI_MODULES.assist.entitlements).toMatchObject({
      aiEnabled: true,
      aiTier: 'light',
      allowAssist: true,
      allowStrategist: false,
      allowGrok: false,
    });
    expect(AI_MODULES.strategist.entitlements).toMatchObject({
      aiEnabled: true,
      aiTier: 'supersmart',
      allowOpus: true,
      allowStrategist: true,
    });
    expect(AI_MODULES['live-intel'].entitlements).toMatchObject({
      aiEnabled: true,
      aiTier: 'top',
      allowGrok: true,
      allowLiveIntel: true,
    });
  });

  it('modules never raise a base plan cap (neutral numeric fields)', () => {
    for (const m of Object.values(AI_MODULES)) {
      expect(m.entitlements.maxSubscriptions).toBe(0);
      expect(m.entitlements.backtestsPerMonth).toBe(0);
      expect(m.entitlements.canRunBots).toBe(false);
    }
  });
});

describe('mergeEntitlements (stacking)', () => {
  it('empty list resolves to free entitlements', () => {
    expect(mergeEntitlements([])).toEqual(FREE_ENTITLEMENTS);
  });

  it('base + module unions capabilities without lowering base limits', () => {
    const merged = mergeEntitlements([
      BASE_PLANS.trader.entitlements,
      AI_MODULES.strategist.entitlements,
    ]);
    // trader features preserved
    expect(merged.canRunBots).toBe(true);
    expect(merged.maxSubscriptions).toBe(10);
    expect(merged.backtestsPerMonth).toBeNull();
    // strategist AI added
    expect(merged.aiEnabled).toBe(true);
    expect(merged.allowOpus).toBe(true);
    expect(merged.allowStrategist).toBe(true);
    expect(merged.aiTier).toBe('supersmart');
    expect(merged.aiDailyMicros).toBe(5_000_000);
  });

  it('two modules stack to the union (opus AND grok, top tier)', () => {
    const merged = mergeEntitlements([
      BASE_PLANS.essential.entitlements,
      AI_MODULES.strategist.entitlements,
      AI_MODULES['live-intel'].entitlements,
    ]);
    expect(merged.allowOpus).toBe(true);
    expect(merged.allowGrok).toBe(true);
    expect(merged.aiTier).toBe('top');
    expect(merged.canUseIndicators).toBe(true); // from essential
    expect(merged.aiMonthlyMicros).toBe(80_000_000); // most generous cap wins
  });

  it('null (unlimited) cap wins over a finite one', () => {
    const merged = mergeEntitlements([
      BASE_PLANS.pro.entitlements,
      AI_MODULES.assist.entitlements,
    ]);
    expect(merged.maxSubscriptions).toBeNull();
    expect(merged.backtestsPerMonth).toBeNull();
  });

  it('does not mutate its inputs', () => {
    const before = { ...BASE_PLANS.free.entitlements };
    mergeEntitlements([BASE_PLANS.free.entitlements, AI_MODULES.strategist.entitlements]);
    expect(BASE_PLANS.free.entitlements).toEqual(before);
  });

  it('produces every TierEntitlements field (no field silently dropped)', () => {
    const merged = mergeEntitlements([BASE_PLANS.pro.entitlements]);
    const keys = Object.keys(merged) as (keyof TierEntitlements)[];
    for (const k of Object.keys(BASE_PLANS.pro.entitlements)) {
      expect(keys).toContain(k as keyof TierEntitlements);
    }
  });
});

describe('FULL_ENTITLEMENTS (dev-open grant)', () => {
  it('unlocks every feature, module and unlimited caps', () => {
    expect(FULL_ENTITLEMENTS).toMatchObject({
      aiEnabled: true,
      allowOpus: true,
      allowGrok: true,
      allowAssist: true,
      allowStrategist: true,
      allowLiveIntel: true,
      canUseIndicators: true,
      canRunBots: true,
      canUseExecutor: true,
      maxSubscriptions: null,
      backtestsPerMonth: null,
      aiTier: 'top',
    });
  });
});

describe('groups', () => {
  it('base-plan group grants stay in lockstep with the feature flags', () => {
    for (const plan of Object.values(BASE_PLANS)) {
      const groups = BASE_PLAN_GROUPS[plan.key];
      const e = plan.entitlements;
      expect(groups.includes('indicator-access')).toBe(e.canUseIndicators);
      expect(groups.includes('platform')).toBe(e.canRunBots);
      expect(groups.includes('pro')).toBe(e.canUseExecutor);
    }
  });

  it('identity/module slugs invert cleanly for the resolver', () => {
    for (const key of ['essential', 'trader', 'pro'] as const) {
      expect(GROUP_BASE_PLAN[key]).toBe(key);
    }
    for (const [moduleKey, slug] of Object.entries(AI_MODULE_GROUP)) {
      expect(GROUP_AI_MODULE[slug]).toBe(moduleKey as (typeof GROUP_AI_MODULE)[string]);
    }
  });

  it('a product grants the groups its catalogue entry declares', () => {
    expect(groupsForProduct('trader')).toEqual(['trader', 'indicator-access', 'platform']);
    expect(groupsForProduct('ai-strategist')).toEqual(['ai-strategist']);
  });

  it('allEntitlementGroups covers every slug the catalogue can grant', () => {
    const all = allEntitlementGroups();
    expect(all).toEqual(expect.arrayContaining(['indicator-access', 'platform', 'pro', 'ai-assist', 'ai-strategist', 'ai-live-intel', 'essential', 'trader']));
  });
});

describe('product catalogue', () => {
  it('has one entry per paid base plan + each module, and no free product', () => {
    expect(Object.keys(PRODUCT_CATALOGUE).sort()).toEqual(
      ['ai-assist', 'ai-live-intel', 'ai-strategist', 'essential', 'pro', 'trader'],
    );
  });
});

describe('ai tier ordering', () => {
  it('is strict free < light < supersmart < top', () => {
    expect(AI_TIER_RANK.free).toBeLessThan(AI_TIER_RANK.light);
    expect(AI_TIER_RANK.light).toBeLessThan(AI_TIER_RANK.supersmart);
    expect(AI_TIER_RANK.supersmart).toBeLessThan(AI_TIER_RANK.top);
  });

  it('maxAiTier picks the stronger regardless of order', () => {
    expect(maxAiTier('free', 'top')).toBe('top');
    expect(maxAiTier('supersmart', 'light')).toBe('supersmart');
  });
});
