// Parity lock: the executor's tp-ladder mirror must be bit-identical to the SDK
// reference (packages/strategy-sdk/src/managers/tp-ladder.ts) — resolveTpLevels,
// init, and onTick sequences (multi-rung ticks, runner budget, skipped-init
// freeze) across a grid. If it fails, the SDK moved: re-mirror.
//
// NOTE: excluded from tsconfig (cross-package import); bun test runs it.

import { describe, expect, it } from 'bun:test'
import { tpLadderManager as mirror, resolveTpLevels as mirrorLevels } from './tp-ladder.js'
import {
  tpLadderManager as sdk,
  resolveTpLevels as sdkLevels,
} from '../../../../../../packages/strategy-sdk/src/managers/tp-ladder'

describe('tp-ladder mirror parity with the SDK reference', () => {
  it('matches resolveTpLevels + init + onTick sequences across a grid', () => {
    const directions = ['long', 'short'] as const
    const paramSets = [
      { prices: [], target: 120, levelCount: 6, fractionPerTranche: 0.25, runnerFraction: 0 },
      { prices: [], target: 80, levelCount: 3, fractionPerTranche: 0.4, runnerFraction: 0.2 },
      { prices: [104, 108, 96, 92], levelCount: 6, fractionPerTranche: 0.3, runnerFraction: 0.1 },
      { prices: [], target: 130, levelCount: 1, fractionPerTranche: 1, runnerFraction: 0 },
      { prices: [102, 103], levelCount: 6, fractionPerTranche: 0.6, runnerFraction: 0 },
    ]
    // Price paths: gradual ladder walk, one-tick jump through all rungs, chop.
    const pricePaths = [
      [101, 105, 110, 121, 121],
      [125, 125],
      [99, 118, 99, 130],
      [75, 101, 79],
    ]

    let compared = 0
    for (const direction of directions)
      for (const params of paramSets)
        for (const path of pricePaths)
          for (const useInit of [true, false]) {
            const start = {
              id: 'p',
              direction,
              avgEntryPrice: 100,
              size: 10,
              extremePriceAtEntry: 100,
              oppositePrice: 100,
              currentStopLoss: null,
              openedTs: 0,
            }
            expect(mirrorLevels(params as any, start as any)).toEqual(
              sdkLevels(params as any, start as any),
            )

            let stateA = useInit
              ? mirror.init!({ params: params as any, position: start as any })
              : { lastTs: null, position: 'none' as const, scratch: {} }
            let stateB = useInit
              ? sdk.init!({ params: params as any, position: start as any })
              : { lastTs: null, position: 'none' as const, scratch: {} }
            expect(stateA).toEqual(stateB as any)

            // Thread the shrinking size the same way the caller applies closes.
            let sizeA = start.size
            let sizeB = start.size
            for (const price of path) {
              const posA = { ...start, size: sizeA }
              const posB = { ...start, size: sizeB }
              const a = mirror.onTick({
                params: params as any, position: posA as any, price, ts: 1, state: stateA,
              })
              const b = sdk.onTick({
                params: params as any, position: posB as any, price, ts: 1, candle: undefined, state: stateB as any,
              })
              expect(a.actions).toEqual(b.actions as any)
              expect(a.state).toEqual(b.state as any)
              stateA = a.state
              stateB = b.state as any
              for (const act of a.actions) {
                if (act.type === 'close') sizeA -= act.fraction * sizeA
              }
              for (const act of b.actions as any[]) {
                if (act.type === 'close') sizeB -= act.fraction * sizeB
              }
              compared++
            }
          }
    expect(compared).toBeGreaterThan(100)
  })
})
