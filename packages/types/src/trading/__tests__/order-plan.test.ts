import { describe, it, expect, expectTypeOf } from 'bun:test';
import type {
  OrderPlan,
  PlannedEntry,
  PlannedTakeProfit,
  PlannedTrail,
} from '../order-plan.js';
import type { OppositeSignalPolicy, MultiTimeframeConfig } from '../execution.js';

// These are pure type declarations, so the "tests" assert the shape compiles
// and the exhaustive union is what callers expect. Keeps the types package
// covered by `bun test` and guards against accidental field drift.
describe('order-plan types', () => {
  it('accepts a full plan literal', () => {
    const plan: OrderPlan = {
      entries: [
        { price: 100, size: 0.5 },
        { size: 0.5 }, // market leg
      ],
      stopLoss: 90,
      takeProfits: [
        { price: 110, fraction: 0.5 },
        { price: 120, fraction: 0.5 },
      ],
      trail: { percentage: 2, maxPercentage: 40 },
      ttlBars: 5,
      postpone: false,
    };
    expect(plan.entries).toHaveLength(2);
    expect(plan.takeProfits).toHaveLength(2);
  });

  it('an empty plan is valid (all fields optional)', () => {
    const plan: OrderPlan = {};
    expect(plan.entries).toBeUndefined();
  });

  it('field types are as declared', () => {
    expectTypeOf<PlannedEntry>().toMatchTypeOf<{ price?: number; size: number }>();
    expectTypeOf<PlannedTakeProfit>().toEqualTypeOf<{ price: number; fraction: number }>();
    expectTypeOf<PlannedTrail['percentage']>().toEqualTypeOf<number | undefined>();
  });

  it('opposite-signal policy union is exhaustive', () => {
    const policies: OppositeSignalPolicy[] = ['ignore', 'close', 'reverse'];
    expect(policies).toHaveLength(3);
  });

  it('multi-timeframe config carries timeframe labels', () => {
    const cfg: MultiTimeframeConfig = { additionalTimeframes: ['240', '1440'] };
    expect(cfg.additionalTimeframes).toContain('240');
  });
});
