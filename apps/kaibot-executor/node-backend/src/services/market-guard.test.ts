import { describe, expect, it } from 'bun:test'
import { isMarketTradable } from './market-guard.js'
import type { ExchangeAdapter, MarketStatus } from './exchanges/types.js'

function adapterWith(opts: {
  alwaysOpen?: boolean
  status?: Map<string, MarketStatus>
  throws?: boolean
  noStatusFn?: boolean
}): ExchangeAdapter {
  const base: any = {
    name: 'stub',
    alwaysOpen: opts.alwaysOpen,
    async connect() {},
    async disconnect() {},
    async refreshSession() {},
    async getAccounts() { return [] },
    async getBalances() { return [] },
    async getPositions() { return [] },
    async placeOrder() { return { orderId: 'x', status: 'filled' } },
    async cancelOrder() {},
    subscribeToUpdates() {},
    unsubscribeFromUpdates() {},
  }
  if (!opts.noStatusFn) {
    base.getMarketStatus = async () => {
      if (opts.throws) throw new Error('quote endpoint down')
      return opts.status ?? new Map()
    }
  }
  return base
}

describe('isMarketTradable', () => {
  const now = 1_000_000_000_000

  it('always tradable for a 24/7 (alwaysOpen) venue', async () => {
    const a = adapterWith({ alwaysOpen: true })
    expect(await isMarketTradable(a, 'BTC-PERPETUAL', { now })).toBe(true)
  })

  it('always tradable when the adapter has no getMarketStatus (no way to tell)', async () => {
    const a = adapterWith({ noStatusFn: true })
    expect(await isMarketTradable(a, 'MESM26', { now })).toBe(true)
  })

  it('tradable when the last trade is fresh', async () => {
    const status = new Map<string, MarketStatus>([
      ['MESM26', { symbol: 'MESM26', last: 5000, tradeTimeMs: now - 10_000 }],
    ])
    const a = adapterWith({ status })
    expect(await isMarketTradable(a, 'MESM26', { now, staleMs: 60_000 })).toBe(true)
  })

  it('not tradable when the last trade is stale (market closed)', async () => {
    const status = new Map<string, MarketStatus>([
      ['MESM26', { symbol: 'MESM26', last: 5000, tradeTimeMs: now - 10 * 60_000 }],
    ])
    const a = adapterWith({ status })
    expect(await isMarketTradable(a, 'MESM26', { now, staleMs: 3 * 60_000 })).toBe(false)
  })

  it('not tradable when there is no quote for the symbol', async () => {
    const a = adapterWith({ status: new Map() })
    expect(await isMarketTradable(a, 'MESM26', { now })).toBe(false)
  })

  it('fail-closed: a quote fetch error blocks the order', async () => {
    const a = adapterWith({ throws: true })
    expect(await isMarketTradable(a, 'MESM26', { now })).toBe(false)
  })

  it('not tradable when tradeTimeMs is zero (no trade time reported)', async () => {
    const status = new Map<string, MarketStatus>([
      ['MESM26', { symbol: 'MESM26', last: 5000, tradeTimeMs: 0 }],
    ])
    const a = adapterWith({ status })
    expect(await isMarketTradable(a, 'MESM26', { now })).toBe(false)
  })
})
