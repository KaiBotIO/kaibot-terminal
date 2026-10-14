// Parity lock: the executor's drawdown-trail mirror must be bit-identical to
// the SDK reference (packages/strategy-sdk/src/managers/drawdown-trailing-stop
// computeDrawdownTrailingStop). The executor keeps a verbatim copy on purpose
// (standalone user-shipped package, off the server's transitive graph — see
// drawdown-trail.ts header); this test is what makes that copy safe. If it
// fails, the SDK moved: re-mirror drawdown-trail.ts.
//
// NOTE: excluded from tsconfig (cross-package import, same convention as
// e2e-signal-chain.test.ts); bun test runs it regardless.

import { describe, expect, it } from 'bun:test'
import { computeDrawdownTrailingStop as mirror } from './drawdown-trail.js'
import { computeDrawdownTrailingStop as sdk } from '../../../../../packages/strategy-sdk/src/managers/drawdown-trailing-stop'

describe('drawdown-trail mirror parity with the SDK reference', () => {
  it('matches the SDK output across a parameter/state grid', () => {
    const directions = ['long', 'short'] as const
    const exchanges = ['bybit', 'tradestation', undefined]
    const locks = [false, true]
    const freezes = [false, true]
    const onlyProfits = [false, true]
    const prices = [80, 99.5, 100, 100.5, 120, 250]
    const extremes = [100, 110, 130]
    const opposites = [70, 95, 100, 115]
    const currentStops = [null, 90, 105]
    const minMax = [
      { minPct: 0, maxPct: 40, minPts: 0, maxPts: 500 },
      { minPct: 2, maxPct: 5, minPts: 5, maxPts: 50 },
      { minPct: 10, maxPct: 3, minPts: 600, maxPts: 500 }, // inverted floor > cap
    ]
    const references = [undefined, 100, 112]
    const frozenExtremes = [undefined, 108]

    let compared = 0
    for (const direction of directions)
      for (const exchange of exchanges)
        for (const trailingLock of locks)
          for (const freezeExtreme of freezes)
            for (const onlyWhenProfit of onlyProfits)
              for (const price of prices)
                for (const extreme of extremes)
                  for (const opposite of opposites)
                    for (const currentStopLoss of currentStops)
                      for (const mm of minMax)
                        for (const reference of references)
                          for (const frozenExtreme of frozenExtremes) {
                            const params = {
                              maxTrailingPercentage: mm.maxPct,
                              maxTrailingPoints: mm.maxPts,
                              minTrailingPercentage: mm.minPct,
                              minTrailingPoints: mm.minPts,
                              trailingLock,
                              onlyWhenProfit,
                              referencePrice: reference ?? 0,
                              freezeExtreme,
                            }
                            const position = {
                              id: 'p',
                              direction,
                              avgEntryPrice: 100,
                              size: 1,
                              extremePriceAtEntry: extreme,
                              oppositePrice: opposite,
                              currentStopLoss,
                              exchange,
                            }
                            const a = mirror({
                              params,
                              position: position as any,
                              price,
                              reference,
                              frozenExtreme,
                            })
                            const b = sdk({
                              params,
                              position: position as any,
                              price,
                              reference,
                              frozenExtreme,
                            })
                            expect(a).toBe(b as any)
                            compared++
                          }
    // Sanity: the grid actually ran (guards against a silently-empty loop).
    expect(compared).toBeGreaterThan(100_000)
  })
})

// The explicit pointBased param replaces the old "fake the venue as tradestation
// to force point-mode" hack. It must reproduce that behaviour without touching
// the real exchange tag, and default from the exchange when absent.
describe('drawdown-trail explicit pointBased param', () => {
  const params = {
    maxTrailingPercentage: 40,
    maxTrailingPoints: 500,
    minTrailingPercentage: 0,
    minTrailingPoints: 0,
    trailingLock: false,
    onlyWhenProfit: false,
    referencePrice: 0,
    freezeExtreme: false,
  }
  // long: priceRange = 110 - 95 = 15 → point stop 120-15=105; pct stop
  // 120*(1 - (15/110)) ≈ 103.636.
  const base = {
    id: 'p',
    direction: 'long' as const,
    avgEntryPrice: 100,
    size: 1,
    extremePriceAtEntry: 110,
    oppositePrice: 95,
    currentStopLoss: null,
  }
  const run = (exchange: string | undefined, pointBased?: boolean) =>
    mirror({ params, position: { ...base, exchange } as any, price: 120, pointBased })

  const POINT_STOP = 105
  const PCT_STOP = 120 * (1 - 15 / 110)

  it('tradestation with no flag ≡ old behaviour (point-mode from the exchange)', () => {
    expect(run('tradestation')).toBe(POINT_STOP)
  })

  it('non-tradestation with pointBased=true ≡ old faked-venue stop', () => {
    expect(run('bybit', true)).toBe(run('tradestation'))
    expect(run('bybit', true)).toBe(POINT_STOP)
  })

  it('non-tradestation with no flag stays percentage-mode', () => {
    expect(run('bybit')).toBeCloseTo(PCT_STOP, 9)
    expect(run('bybit')).not.toBe(POINT_STOP)
  })

  it('pointBased=false overrides a point-based venue back to percentage', () => {
    expect(run('tradestation', false)).toBeCloseTo(PCT_STOP, 9)
  })
})
