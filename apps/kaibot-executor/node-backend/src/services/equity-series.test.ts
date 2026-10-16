import { describe, expect, it } from 'bun:test'
import { equitySeries } from './equity-series.js'

const pt = (over: Partial<Parameters<typeof equitySeries>[0][number]>) => ({
  ts: 0,
  equity: 0,
  unrealizedPnL: 0,
  priced: 1,
  wallets: 1,
  partial: 0,
  ...over,
})

describe('equitySeries', () => {
  it('turns partial ticks into gaps and measures pnl from the first real point', () => {
    const series = equitySeries([
      pt({ ts: 1000, equity: 54_000 }),
      pt({ ts: 2000, equity: 20, partial: 1 }),
      pt({ ts: 3000, equity: 54_500 }),
    ])
    expect(series.map((p) => p.equity)).toEqual([54_000, null, 54_500])
    expect(series.map((p) => p.pnl)).toEqual([0, null, 500])
    expect(series[1]).toMatchObject({ gap: true, unrealizedPnL: null })
  })

  it('a tick with no priced wallet is a gap, one with some unpriced is a floor', () => {
    const series = equitySeries([
      pt({ ts: 1000, equity: 0, priced: 0, wallets: 3 }),
      pt({ ts: 2000, equity: 100, priced: 2, wallets: 3 }),
    ])
    expect(series[0].gap).toBe(true)
    expect(series[1]).toMatchObject({ gap: false, incomplete: true, equity: 100, pnl: 0 })
  })

  it('leading gaps do not set the baseline', () => {
    const series = equitySeries([pt({ ts: 1000, equity: 5, partial: 1 }), pt({ ts: 2000, equity: 90 })])
    expect(series[1].pnl).toBe(0)
  })
})
