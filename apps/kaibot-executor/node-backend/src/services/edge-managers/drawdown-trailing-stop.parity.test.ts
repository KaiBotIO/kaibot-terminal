// Parity lock: the executor's drawdown-trailing-stop MANAGER mirror (onTick +
// init wrapper around the F1 compute mirror) must be bit-identical to the SDK
// reference manager (packages/strategy-sdk/src/managers/drawdown-trailing-stop).
// The pure compute already has its own grid (drawdown-trail.parity.test.ts);
// this locks the reducer shell (reference seeding, freezeExtreme first-tick
// anchor, action emission). If it fails, the SDK moved: re-mirror.
//
// NOTE: excluded from tsconfig (cross-package import); bun test runs it.

import { describe, expect, it } from 'bun:test'
import { drawdownTrailingStopManager as mirror } from './drawdown-trailing-stop.js'
import { drawdownTrailingStopManager as sdk } from '../../../../../../packages/strategy-sdk/src/managers/drawdown-trailing-stop'

describe('drawdown-trailing-stop manager mirror parity with the SDK reference', () => {
  it('matches init + onTick sequences across a grid', () => {
    const directions = ['long', 'short'] as const
    const exchanges = ['bybit', 'tradestation', undefined]
    const paramSets = [
      { maxTrailingPercentage: 40, maxTrailingPoints: 500, minTrailingPercentage: 0, minTrailingPoints: 0, trailingLock: false, onlyWhenProfit: false, referencePrice: 0, freezeExtreme: false },
      { maxTrailingPercentage: 5, maxTrailingPoints: 50, minTrailingPercentage: 2, minTrailingPoints: 5, trailingLock: false, onlyWhenProfit: true, referencePrice: 0, freezeExtreme: false },
      { maxTrailingPercentage: 40, maxTrailingPoints: 500, minTrailingPercentage: 1, minTrailingPoints: 2, trailingLock: false, onlyWhenProfit: false, referencePrice: 105, freezeExtreme: true },
      { maxTrailingPercentage: 40, maxTrailingPoints: 500, minTrailingPercentage: 0, minTrailingPoints: 0, trailingLock: true, onlyWhenProfit: false, referencePrice: 0, freezeExtreme: false },
      { maxTrailingPercentage: 40, maxTrailingPoints: 500, minTrailingPercentage: 3, minTrailingPoints: 10, trailingLock: false, onlyWhenProfit: true, referencePrice: 0, freezeExtreme: true },
    ]
    const positionRefs = [undefined, 112]
    const pricePaths = [
      [101, 106, 103, 111],
      [95, 99, 108],
      [120, 118, 130],
    ]

    let compared = 0
    for (const direction of directions)
      for (const exchange of exchanges)
        for (const params of paramSets)
          for (const posRef of positionRefs)
            for (const path of pricePaths)
              for (const useInit of [true, false]) {
                const mkPos = (extreme: number, opposite: number, stop: number | null) => ({
                  id: 'p',
                  direction,
                  avgEntryPrice: 100,
                  size: 1,
                  extremePriceAtEntry: extreme,
                  oppositePrice: opposite,
                  currentStopLoss: stop,
                  openedTs: 0,
                  exchange,
                  ...(posRef !== undefined ? { referencePrice: posRef } : {}),
                })

                const seed = mkPos(100, 100, null)
                let stateA = useInit
                  ? mirror.init!({ params: params as any, position: seed as any })
                  : { lastTs: null, position: 'none' as const, scratch: {} }
                let stateB = useInit
                  ? sdk.init!({ params: params as any, position: seed as any })
                  : { lastTs: null, position: 'none' as const, scratch: {} }
                expect(stateA).toEqual(stateB as any)

                // Thread marks + stop the way the runtime advances them.
                let extreme = 100
                let opposite = 100
                let stopA: number | null = null
                let stopB: number | null = null
                for (const price of path) {
                  extreme = direction === 'long' ? Math.max(extreme, price) : Math.min(extreme, price)
                  opposite = direction === 'long' ? Math.min(opposite, price) : Math.max(opposite, price)
                  const posA = mkPos(extreme, opposite, stopA)
                  const posB = mkPos(extreme, opposite, stopB)
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
                  for (const act of a.actions) if (act.type === 'set_stop_loss') stopA = act.price
                  for (const act of b.actions as any[]) if (act.type === 'set_stop_loss') stopB = act.price
                  compared++
                }
              }
    expect(compared).toBeGreaterThan(1000)
  })
})
