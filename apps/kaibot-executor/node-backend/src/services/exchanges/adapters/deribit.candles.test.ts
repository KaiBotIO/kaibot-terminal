import { afterEach, describe, expect, it } from 'bun:test'
import { DeribitAdapter } from './deribit.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(body: unknown, seen: string[] = []) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    seen.push(String(url))
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
}

describe('deribit public candles', () => {
  it('maps the chart arrays to ascending bars and asks for the minute resolution', async () => {
    const seen: string[] = []
    stubFetch(
      {
        result: {
          status: 'ok',
          ticks: [7_200_000, 3_600_000],
          open: [2, 1],
          high: [3, 2],
          low: [1, 0.5],
          close: [2.5, 1.5],
        },
      },
      seen,
    )
    const bars = await new DeribitAdapter().getCandles('BTC-PERPETUAL', 60, 0, 10_000_000)
    expect(bars.map((b) => b.time)).toEqual([3_600_000, 7_200_000])
    expect(bars[0]).toEqual({ time: 3_600_000, open: 1, high: 2, low: 0.5, close: 1.5 })
    expect(seen[0]).toContain('get_tradingview_chart_data')
    expect(seen[0]).toContain('resolution=60')
  })

  it('throws on a venue error instead of returning an empty history', async () => {
    stubFetch({ error: { message: 'instrument not found' } })
    await expect(new DeribitAdapter().getCandles('NOPE', 60, 0, 1)).rejects.toThrow('instrument not found')
  })

  it('reads the tick size from the instrument', async () => {
    stubFetch({ result: { tick_size: 0.05 } })
    expect(await new DeribitAdapter().getTickSize('ETH-PERPETUAL')).toBe(0.05)
  })
})
