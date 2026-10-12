// Parity lock: the executor's group-risk-guard mirror must be bit-identical to
// the SDK reference manager (packages/strategy-sdk/src/managers/
// group-risk-guard.ts) across a large grid of params × group-aggregate
// sequences (loss/notional breaches, latch + re-arm, null equity, flat
// position, missing group). If it fails, the SDK moved: re-mirror.
//
// NOTE: excluded from tsconfig (cross-package import); bun test runs it.

import { describe, expect, it } from 'bun:test'
import { groupRiskGuardManager as mirror } from './group-risk-guard.js'
import { groupRiskGuardManager as sdk } from '../../../../../../packages/strategy-sdk/src/managers/group-risk-guard'
import type { GroupAggregateState } from './contract.js'

describe('group-risk-guard mirror parity with the SDK reference', () => {
  it('matches init + onTick sequences across a grid', () => {
    const directions = ['long', 'short'] as const
    const lossFractions = [undefined, 0.01, 0.05, 0.25, 1]
    const notionalCaps = [undefined, 500, 5_000, 100_000]
    const equities = [null, 0, 10_000, 50_000]
    const memberCounts = [1, 3]
    const sizes = [10, 0]
    const pnlPaths = [
      [0, -100, -300, -600, -200, 0],
      [-600, -600, -600, 0, -600, -600],
      [100, 50, -50, -5_000, -5_000, 200],
      [0, 0, 0, 0, 0, 0],
      [-499.999, -500, -500.001, -600, -601, -599],
    ]
    const notionalPaths = [
      [1_000, 2_000, 4_000, 8_000, 4_000, 2_000],
      [400, 500, 501, 6_000, 100_000, 100_001],
      [5_000, 5_000, 5_000, 5_000, 5_000, 5_000],
    ]

    let compared = 0
    for (const direction of directions)
      for (const lossFraction of lossFractions)
        for (const notionalCap of notionalCaps)
          for (const equity of equities)
            for (const memberCount of memberCounts)
              for (const size of sizes)
                for (const pnlPath of pnlPaths)
                  for (const notionalPath of notionalPaths)
                    for (const hasGroup of [true, false])
                      for (const useInit of [true, false]) {
                        const params: Record<string, number> = {}
                        if (lossFraction !== undefined) params.maxGroupLossFraction = lossFraction
                        if (notionalCap !== undefined) params.maxGroupNotional = notionalCap

                        const position = {
                          id: 'p',
                          direction,
                          avgEntryPrice: 100,
                          size,
                          extremePriceAtEntry: 100,
                          oppositePrice: 100,
                          currentStopLoss: null,
                          openedTs: 0,
                        }

                        let stateA = useInit
                          ? mirror.init!({ params: params as never, position: position as never })
                          : { lastTs: null, position: 'none' as const, scratch: {} }
                        let stateB = useInit
                          ? sdk.init!({ params: params as never, position: position as never })
                          : { lastTs: null, position: 'none' as const, scratch: {} }
                        expect(stateA).toEqual(stateB as never)

                        for (let t = 0; t < pnlPath.length; t++) {
                          const group: GroupAggregateState | undefined = hasGroup
                            ? {
                                groupId: 'g',
                                memberCount,
                                unrealizedPnl: pnlPath[t]!,
                                notional: notionalPath[t]!,
                                equity,
                              }
                            : undefined
                          const a = mirror.onTick({
                            params: params as never,
                            position: position as never,
                            price: 100,
                            ts: t,
                            group,
                            state: stateA,
                          })
                          const b = sdk.onTick({
                            params: params as never,
                            position: position as never,
                            price: 100,
                            ts: t,
                            candle: undefined,
                            group,
                            state: stateB as never,
                          })
                          expect(a.actions).toEqual(b.actions as never)
                          expect(a.state).toEqual(b.state as never)
                          stateA = a.state
                          stateB = b.state as never
                          compared++
                        }
                      }
    // 2×5×4×4×2×2×5×3×2×2 sequences × 6 ticks = 230,400 tick comparisons.
    expect(compared).toBe(230_400)
  })
})
