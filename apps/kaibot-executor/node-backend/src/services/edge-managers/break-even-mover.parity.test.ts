// Parity lock: the executor's break-even-mover mirror must be bit-identical to
// the SDK reference (packages/strategy-sdk/src/managers/break-even-mover.ts) —
// init AND onTick (actions + threaded state) across a parameter/state grid and
// across multi-tick sequences. If it fails, the SDK moved: re-mirror.
//
// NOTE: excluded from tsconfig (cross-package import, same convention as
// drawdown-trail.parity.test.ts); bun test runs it regardless.

import { describe, expect, it } from 'bun:test'
import { breakEvenMoverManager as mirror, computeBreakeven as mirrorBreakeven } from './break-even-mover.js'
import {
  breakEvenMoverManager as sdk,
  computeBreakeven as sdkBreakeven,
} from '../../../../../../packages/strategy-sdk/src/managers/break-even-mover'

describe('break-even-mover mirror parity with the SDK reference', () => {
  it('matches init + onTick sequences across a parameter/state grid', () => {
    const directions = ['long', 'short'] as const
    const exchanges = ['bybit', 'tradestation', undefined]
    const fees = [0, 0.0015, 0.01]
    const triggers = [0, 1.5]
    const useEntryRefs = [false, true]
    const paramRefs = [0, 98]
    const positionRefs = [undefined, 97]
    const currentStops = [null, 96, 103]
    // Price paths crossing the trigger in different orders (arm-once matters).
    const pricePaths = [
      [99, 100.5, 104],
      [104, 99, 104],
      [100, 100, 100],
    ]

    let compared = 0
    for (const direction of directions)
      for (const exchange of exchanges)
        for (const feePercentage of fees)
          for (const triggerPercentage of triggers)
            for (const useEntryReference of useEntryRefs)
              for (const referencePrice of paramRefs)
                for (const posRef of positionRefs)
                  for (const currentStopLoss of currentStops)
                    for (const path of pricePaths)
                      for (const useInit of [true, false]) {
                        const params = { feePercentage, triggerPercentage, useEntryReference, referencePrice }
                        const mkPos = (price: number) => ({
                          id: 'p',
                          direction,
                          avgEntryPrice: 100,
                          size: 2,
                          extremePriceAtEntry: Math.max(100, price),
                          oppositePrice: Math.min(100, price),
                          currentStopLoss,
                          openedTs: 0,
                          exchange,
                          ...(posRef !== undefined ? { referencePrice: posRef } : {}),
                        })

                        const seedPos = mkPos(path[0]!)
                        let stateA = useInit
                          ? mirror.init!({ params, position: seedPos as any })
                          : { lastTs: null, position: 'none' as const, scratch: {} }
                        let stateB = useInit
                          ? sdk.init!({ params, position: seedPos as any })
                          : { lastTs: null, position: 'none' as const, scratch: {} }
                        expect(stateA).toEqual(stateB as any)

                        expect(mirrorBreakeven({ params, position: seedPos as any })).toBe(
                          sdkBreakeven({ params, position: seedPos as any }),
                        )

                        for (const price of path) {
                          const position = mkPos(price)
                          const a = mirror.onTick({
                            params, position: position as any, price, ts: 1, state: stateA,
                          })
                          const b = sdk.onTick({
                            params, position: position as any, price, ts: 1, candle: undefined, state: stateB as any,
                          })
                          expect(a.actions).toEqual(b.actions as any)
                          expect(a.state).toEqual(b.state as any)
                          stateA = a.state
                          stateB = b.state as any
                          compared++
                        }
                      }
    expect(compared).toBeGreaterThan(10_000)
  })
})
