import { describe, expect, it, afterEach } from 'bun:test'
import { TradeStationOAuthAdapter } from './tradestation-oauth.js'
import {
  TS_HISTORY_MAX_DAYS,
  TradeStationHistoryCache,
  fetchTradeStationHistoricalOrders,
  lookupTradeStationOrderFee,
  tradeStationOrderFee,
} from './tradestation-orders.js'

// Commission backfill on TradeStation: the status lookup only sees recent
// orders (working set + /historicalorders/{id} over two weeks), so the 39 live
// fills older than that came back 'not-found' (25/09/2026). The account's
// paginated /historicalorders?since= window (venue cap 90 days) is the
// fallback; one fetch per account is reused across every order of the run.

const DAY = 86_400_000
const NOW = Date.parse('2026-09-25T12:00:00Z')

function filled(orderId: string, over: Record<string, any> = {}) {
  return {
    OrderID: orderId,
    Status: 'FLL',
    FilledPrice: '7700',
    CommissionFee: '0.35',
    UnbundledRouteFee: '0.05',
    Currency: 'USD',
    Legs: [{ Symbol: 'MESZ26', QuantityOrdered: '1', ExecQuantity: '1' }],
    ...over,
  }
}

const query = (endpoint: string) => new URLSearchParams(endpoint.split('?')[1] ?? '')

describe('tradeStationOrderFee', () => {
  it('adds the route fee to the commission, in USD', () => {
    expect(tradeStationOrderFee(filled('o'))).toEqual({ commission: 0.4, feeNative: 0.4, feeCurrency: 'USD' })
  })
  it('is zero when the order carries no fee fields', () => {
    expect(tradeStationOrderFee({ OrderID: 'o' }).commission).toBe(0)
  })
})

describe('fetchTradeStationHistoricalOrders', () => {
  it('pages through NextToken and keys every order by id', async () => {
    const calls: string[] = []
    const call = async (endpoint: string) => {
      calls.push(endpoint)
      const q = query(endpoint)
      if (!q.get('nextToken')) return { Orders: [filled('a'), filled('b')], NextToken: 'page-2' }
      if (q.get('nextToken') === 'page-2') return { Orders: [filled('c')], NextToken: 'page-3' }
      return { Orders: [filled('d')], NextToken: '' }
    }
    const orders = await fetchTradeStationHistoricalOrders(call, 'ACC1', NOW - 20 * DAY, { nowMs: NOW })
    expect([...orders.keys()]).toEqual(['a', 'b', 'c', 'd'])
    expect(calls).toHaveLength(3)
    expect(calls[0]).toStartWith('/v3/brokerage/accounts/ACC1/historicalorders?')
    expect(query(calls[0]!).get('since')).toBe('2026-09-05')
    expect(query(calls[0]!).get('pageSize')).toBe('600')
    expect(query(calls[1]!).get('nextToken')).toBe('page-2')
    expect(query(calls[2]!).get('nextToken')).toBe('page-3')
  })

  it('clamps since to the venue window of 90 days', async () => {
    let since = ''
    await fetchTradeStationHistoricalOrders(
      async (endpoint) => ((since = query(endpoint).get('since')!), { Orders: [] }),
      'ACC1',
      NOW - 400 * DAY,
      { nowMs: NOW },
    )
    expect(since).toBe(new Date(NOW - (TS_HISTORY_MAX_DAYS - 1) * DAY).toISOString().slice(0, 10))
  })

  it('stops after maxPages even when the venue keeps handing out tokens', async () => {
    let n = 0
    await fetchTradeStationHistoricalOrders(async () => (n++, { Orders: [], NextToken: 'again' }), 'ACC1', NOW - DAY, {
      nowMs: NOW,
      maxPages: 4,
    })
    expect(n).toBe(4)
  })
})

describe('TradeStationHistoryCache', () => {
  it('fetches an account once and reuses the window for later, narrower requests', async () => {
    let fetches = 0
    const call = async () => (fetches++, { Orders: [filled('x')] })
    const cache = new TradeStationHistoryCache()
    await cache.orders(call, 'ACC1', NOW - 40 * DAY, NOW)
    await cache.orders(call, 'ACC1', NOW - 10 * DAY, NOW)
    await cache.orders(call, 'ACC1', NOW - 40 * DAY, NOW)
    expect(fetches).toBe(1)
  })

  it('widens the window on an earlier request and keeps accounts apart', async () => {
    const sinces: string[] = []
    const call = async (endpoint: string) => (sinces.push(query(endpoint).get('since')!), { Orders: [] })
    const cache = new TradeStationHistoryCache()
    await cache.orders(call, 'ACC1', NOW - 10 * DAY, NOW)
    await cache.orders(call, 'ACC1', NOW - 40 * DAY, NOW)
    await cache.orders(call, 'ACC2', NOW - 10 * DAY, NOW)
    expect(sinces).toEqual(['2026-09-15', '2026-08-16', '2026-09-15'])
  })

  it('refetches once the window is stale', async () => {
    let fetches = 0
    const call = async () => (fetches++, { Orders: [] })
    const cache = new TradeStationHistoryCache(1000)
    await cache.orders(call, 'ACC1', NOW - DAY, NOW)
    await cache.orders(call, 'ACC1', NOW - DAY, NOW + 5000)
    expect(fetches).toBe(2)
  })
})

describe('lookupTradeStationOrderFee', () => {
  it('answers from the status lookup for a recent order', async () => {
    const seen: string[] = []
    const call = async (endpoint: string) => {
      seen.push(endpoint)
      return { Orders: [filled('o-1')] }
    }
    const fee = await lookupTradeStationOrderFee(call, 'ACC1', 'o-1', { sinceMs: NOW - 30 * DAY, nowMs: NOW })
    expect(fee).toEqual({ commission: 0.4, feeNative: 0.4, feeCurrency: 'USD' })
    expect(seen.every((e) => !e.includes('historicalorders?'))).toBe(true)
  })

  it('falls back to the account history window for an order the status lookup no longer sees', async () => {
    const seen: string[] = []
    const call = async (endpoint: string) => {
      seen.push(endpoint)
      if (endpoint.includes('historicalorders?')) return { Orders: [filled('old-1'), filled('old-2')] }
      return { Orders: [] }
    }
    const fee = await lookupTradeStationOrderFee(call, 'ACC1', 'old-2', { sinceMs: NOW - 30 * DAY, nowMs: NOW })
    expect(fee!.commission).toBeCloseTo(0.4, 10)
    expect(seen.filter((e) => e.includes('historicalorders?'))).toHaveLength(1)
  })

  it('shares the history fetch across orders of one account through the cache', async () => {
    let historyFetches = 0
    const call = async (endpoint: string) => {
      if (endpoint.includes('historicalorders?')) {
        historyFetches++
        return { Orders: [filled('old-1'), filled('old-2'), filled('old-3')] }
      }
      return { Orders: [] }
    }
    const history = new TradeStationHistoryCache()
    for (const id of ['old-1', 'old-2', 'old-3']) {
      const fee = await lookupTradeStationOrderFee(call, 'ACC1', id, { sinceMs: NOW - 30 * DAY, history, nowMs: NOW })
      expect(fee!.commission).toBeCloseTo(0.4, 10)
    }
    expect(historyFetches).toBe(1)
  })

  it('is null without a since hint, for an absent order, and for an order that never filled', async () => {
    const call = async (endpoint: string) =>
      endpoint.includes('historicalorders?') ? { Orders: [filled('gone', { Status: 'CAN' })] } : { Orders: [] }
    expect(await lookupTradeStationOrderFee(call, 'ACC1', 'gone', { nowMs: NOW })).toBeNull()
    expect(await lookupTradeStationOrderFee(call, 'ACC1', 'nope', { sinceMs: NOW - DAY, nowMs: NOW })).toBeNull()
    expect(await lookupTradeStationOrderFee(call, 'ACC1', 'gone', { sinceMs: NOW - DAY, nowMs: NOW })).toBeNull()
  })
})

// Adapter wiring: the OAuth adapter exposes getOrderFee over its own
// authenticated call, with the account from ctx.
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('TradeStationOAuthAdapter.getOrderFee', () => {
  function primed(): TradeStationOAuthAdapter {
    const a = new TradeStationOAuthAdapter()
    ;(a as any).session = { access_token: 'tok-1', token_type: 'Bearer', expires_in: 1200, timestamp: Date.now() }
    return a
  }
  const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  it('reads an old order from the account history window', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url
      urls.push(url)
      if (url.includes('historicalorders?')) return json({ Orders: [filled('old-9')] })
      return json({ Orders: [] })
    }) as any
    const fee = await primed().getOrderFee('old-9', { accountId: 'ACC1', sinceMs: Date.now() - 30 * DAY })
    expect(fee).toEqual({ commission: 0.4, feeNative: 0.4, feeCurrency: 'USD' })
    expect(urls.some((u) => u.includes('/accounts/ACC1/historicalorders?since='))).toBe(true)
  })

  it('is null without an account', async () => {
    expect(await primed().getOrderFee('old-9', {})).toBeNull()
  })
})
