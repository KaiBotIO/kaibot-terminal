import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import crypto from 'node:crypto'
import { BybitAdapter, BybitApiError, BYBIT_ACCOUNT_ID, type BybitInstrument } from './bybit.js'
import type { Order } from '../types.js'

// Unit tests for the Bybit v5 adapter. The signed transport is monkey-patched
// (or globalThis.fetch is replaced) so nothing hits the network and no real
// credentials are needed.

const SOL: BybitInstrument = {
  symbol: 'SOLUSDT',
  category: 'linear',
  qtyStep: 0.1,
  minOrderQty: 0.1,
  maxOrderQty: 100000,
  tickSize: 0.01,
  minNotionalValue: 5,
  status: 'Trading',
}

const BTC: BybitInstrument = {
  symbol: 'BTCUSDT',
  category: 'linear',
  qtyStep: 0.001,
  minOrderQty: 0.001,
  maxOrderQty: 1000,
  tickSize: 0.1,
  minNotionalValue: 5,
  status: 'Trading',
}

function offline(adapter: BybitAdapter, instrument: BybitInstrument | null = null) {
  ;(adapter as any).getInstrument = async () => {
    if (!instrument) throw new Error('offline')
    return instrument
  }
}

describe('BybitAdapter.placeOrder (conditional / stop orders)', () => {
  let adapter: BybitAdapter
  let posted: Array<{ path: string; body: Record<string, any> }>

  beforeEach(() => {
    adapter = new BybitAdapter()
    posted = []
    offline(adapter)
    ;(adapter as any).signedPost = async (path: string, body: Record<string, any>) => {
      posted.push({ path, body })
      return { orderId: `mock-${posted.length}` }
    }
  })

  it('maps a reduce-only stop-loss SELL to a conditional Market trigger order', async () => {
    const order: Order = {
      accountId: 'unified',
      symbol: 'BTCUSDT',
      side: 'sell',
      orderType: 'stop',
      quantity: 0.01,
      stopPrice: 58000,
      reduceOnly: true,
      label: 'kaibot:sig:sl',
    }
    const res = await adapter.placeOrder(order)

    expect(posted).toHaveLength(1)
    const body = posted[0].body
    expect(posted[0].path).toBe('/v5/order/create')
    expect(body.category).toBe('linear')
    expect(body.orderType).toBe('Market')
    expect(body.side).toBe('Sell')
    expect(body.triggerPrice).toBe('58000')
    // Sell stop protects a long → triggers on a fall → direction 2.
    expect(body.triggerDirection).toBe(2)
    expect(body.triggerBy).toBe('LastPrice')
    expect(body.reduceOnly).toBe(true)
    // One-way mode (the venue default when the mode lookup is unavailable).
    expect(body.positionIdx).toBe(0)
    // A conditional order is pending until its trigger fires.
    expect(res.status).toBe('pending')
  })

  it('maps a reduce-only stop BUY to triggerDirection 1 (protects a short)', async () => {
    const order: Order = {
      accountId: 'unified',
      symbol: 'ETHUSDT',
      side: 'buy',
      orderType: 'stop',
      quantity: 0.1,
      stopPrice: 4000,
      reduceOnly: true,
    }
    await adapter.placeOrder(order)
    expect(posted[0].body.triggerDirection).toBe(1)
    expect(posted[0].body.side).toBe('Buy')
  })

  it('maps a stopLimit to a conditional Limit order with price + trigger', async () => {
    const order: Order = {
      accountId: 'unified',
      symbol: 'BTCUSDT',
      side: 'sell',
      orderType: 'stopLimit',
      quantity: 0.01,
      stopPrice: 58000,
      price: 57950,
      reduceOnly: true,
      triggerType: 'mark_price',
    }
    await adapter.placeOrder(order)
    const body = posted[0].body
    expect(body.orderType).toBe('Limit')
    expect(body.price).toBe('57950')
    expect(body.triggerPrice).toBe('58000')
    expect(body.triggerBy).toBe('MarkPrice')
  })

  it('honors an explicit triggerDirection override', async () => {
    const order = {
      accountId: 'unified',
      symbol: 'BTCUSDT',
      side: 'sell',
      orderType: 'stop',
      quantity: 0.01,
      stopPrice: 58000,
      triggerDirection: 1,
    } as Order
    await adapter.placeOrder(order)
    expect(posted[0].body.triggerDirection).toBe(1)
  })

  it('rejects a stop order without a stopPrice and posts nothing', async () => {
    const order: Order = {
      accountId: 'unified',
      symbol: 'BTCUSDT',
      side: 'sell',
      orderType: 'stop',
      quantity: 0.01,
    }
    await expect(adapter.placeOrder(order)).rejects.toThrow(/stopPrice/)
    expect(posted).toHaveLength(0)
  })

  it('a spot stop is a resting conditional: orderFilter StopOrder, no derivatives fields', async () => {
    const order = {
      accountId: 'unified',
      symbol: 'BTCUSDT',
      side: 'sell',
      orderType: 'stop',
      quantity: 0.01,
      stopPrice: 58000,
      reduceOnly: true,
      category: 'spot',
    } as Order
    const res = await adapter.placeOrder(order)
    const body = posted[0].body
    expect(body.category).toBe('spot')
    expect(body.orderFilter).toBe('StopOrder')
    expect(body.orderType).toBe('Market')
    expect(body.triggerPrice).toBe('58000')
    expect(body.marketUnit).toBe('baseCoin')
    expect(body.triggerDirection).toBeUndefined()
    expect(body.triggerBy).toBeUndefined()
    expect(body.positionIdx).toBeUndefined()
    expect(body.reduceOnly).toBeUndefined()
    expect(res.status).toBe('pending')
  })

  it('a spot stop-limit is refused (market-on-trigger only) and posts nothing', async () => {
    const order = {
      accountId: 'unified',
      symbol: 'BTCUSDT',
      side: 'sell',
      orderType: 'stopLimit',
      quantity: 0.01,
      stopPrice: 58000,
      price: 57900,
      category: 'spot',
    } as Order
    await expect(adapter.placeOrder(order)).rejects.toThrow(/market-on-trigger/)
    expect(posted).toHaveLength(0)
  })

  it('still maps a plain market order (no trigger fields) as before', async () => {
    const order: Order = {
      accountId: 'unified',
      symbol: 'BTCUSDT',
      side: 'buy',
      orderType: 'market',
      quantity: 0.01,
    }
    const res = await adapter.placeOrder(order)
    const body = posted[0].body
    expect(body.orderType).toBe('Market')
    expect(body.triggerPrice).toBeUndefined()
    expect(body.triggerDirection).toBeUndefined()
    // Market orders carry no timeInForce (venue default IOC).
    expect(body.timeInForce).toBeUndefined()
    expect(res.status).toBe('filled')
  })

  it('a limit order defaults to GTC and maps DAY (unknown to Bybit) to GTC', async () => {
    await adapter.placeOrder({ accountId: 'unified', symbol: 'BTCUSDT', side: 'buy', orderType: 'limit', quantity: 0.01, price: 50000 })
    expect(posted[0].body.timeInForce).toBe('GTC')
    await adapter.placeOrder({ accountId: 'unified', symbol: 'BTCUSDT', side: 'buy', orderType: 'limit', quantity: 0.01, price: 50000, timeInForce: 'DAY' })
    expect(posted[1].body.timeInForce).toBe('GTC')
    await adapter.placeOrder({ accountId: 'unified', symbol: 'BTCUSDT', side: 'buy', orderType: 'limit', quantity: 0.01, price: 50000, timeInForce: 'IOC' })
    expect(posted[2].body.timeInForce).toBe('IOC')
  })

  it('orderLinkId is sanitised to [A-Za-z0-9_-] and cut at 36 chars (v5 limit)', async () => {
    const clientOrderId = 'kaibot:sig:0123456789abcdef0123456789abcdef:sl'
    await adapter.placeOrder({ accountId: 'unified', symbol: 'BTCUSDT', side: 'buy', orderType: 'market', quantity: 0.01, clientOrderId })
    const linkId = posted[0].body.orderLinkId as string
    expect(linkId.length).toBeLessThanOrEqual(36)
    expect(linkId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(linkId).toBe('kaibotsig0123456789abcdef0123456789a')
  })

  it('classifies inverse symbols (BTCUSD, dated BTCUSDZ26) and USDC PERP as linear', () => {
    expect(adapter.resolveCategory('BTCUSD')).toBe('inverse')
    expect(adapter.resolveCategory('BTCUSDZ26')).toBe('inverse')
    expect(adapter.resolveCategory('BTCUSDT')).toBe('linear')
    expect(adapter.resolveCategory('SOLPERP')).toBe('linear')
    expect(adapter.resolveCategory('ETHUSDC')).toBe('linear')
  })
})

describe('BybitAdapter.placeOrder precision (instruments-info)', () => {
  let adapter: BybitAdapter
  let posted: Array<{ path: string; body: Record<string, any> }>

  beforeEach(() => {
    adapter = new BybitAdapter()
    posted = []
    offline(adapter, SOL)
    ;(adapter as any).signedPost = async (path: string, body: Record<string, any>) => {
      posted.push({ path, body })
      return { orderId: `mock-${posted.length}` }
    }
  })

  it('floors qty to qtyStep and strips float noise', async () => {
    await adapter.placeOrder({ accountId: 'unified', symbol: 'SOLUSDT', side: 'buy', orderType: 'market', quantity: 0.1 + 0.2 })
    expect(posted[0].body.qty).toBe('0.3')
    await adapter.placeOrder({ accountId: 'unified', symbol: 'SOLUSDT', side: 'buy', orderType: 'market', quantity: 10.37 })
    expect(posted[1].body.qty).toBe('10.3')
  })

  it('rounds price and triggerPrice to tickSize', async () => {
    await adapter.placeOrder({ accountId: 'unified', symbol: 'SOLUSDT', side: 'buy', orderType: 'limit', quantity: 1, price: 150.123456 })
    expect(posted[0].body.price).toBe('150.12')
    await adapter.placeOrder({ accountId: 'unified', symbol: 'SOLUSDT', side: 'sell', orderType: 'stop', quantity: 1, stopPrice: 140.005, reduceOnly: true })
    expect(posted[1].body.triggerPrice).toBe('140.01')
  })

  it('refuses a qty below minOrderQty before touching the venue', async () => {
    await expect(
      adapter.placeOrder({ accountId: 'unified', symbol: 'SOLUSDT', side: 'buy', orderType: 'market', quantity: 0.05 }),
    ).rejects.toThrow(/minOrderQty/)
    expect(posted).toHaveLength(0)
  })

  it('uppercases the symbol on the wire', async () => {
    await adapter.placeOrder({ accountId: 'unified', symbol: 'solusdt', side: 'buy', orderType: 'market', quantity: 1 })
    expect(posted[0].body.symbol).toBe('SOLUSDT')
  })

  it('formatQty / formatPrice fall back to trimmed decimals without an instrument', () => {
    expect(adapter.formatQty(0.1 + 0.2, null)).toBe('0.3')
    expect(adapter.formatQty(10, null)).toBe('10')
    expect(adapter.formatPrice(58000.0, null)).toBe('58000')
    expect(adapter.formatQty(0.0123456789, null)).toBe('0.01234568')
  })
})

describe('BybitAdapter.placeOrder positionIdx (one-way vs hedge mode)', () => {
  let adapter: BybitAdapter
  let posted: Array<{ path: string; body: Record<string, any> }>
  let modeRows: any[]

  beforeEach(() => {
    adapter = new BybitAdapter()
    posted = []
    modeRows = [{ positionIdx: 0, symbol: 'BTCUSDT', size: '0' }]
    offline(adapter, BTC)
    ;(adapter as any).signedPost = async (path: string, body: Record<string, any>) => {
      posted.push({ path, body })
      return { orderId: `mock-${posted.length}` }
    }
    ;(adapter as any).signedGet = async (path: string) => {
      if (path === '/v5/position/list') return { list: modeRows }
      throw new Error(`unexpected GET ${path}`)
    }
  })

  const mkt = (side: 'buy' | 'sell', reduceOnly = false): Order => ({
    accountId: 'unified', symbol: 'BTCUSDT', side, orderType: 'market', quantity: 0.01, reduceOnly,
  })

  it('one-way mode sends positionIdx 0 for every order', async () => {
    await adapter.placeOrder(mkt('buy'))
    await adapter.placeOrder(mkt('sell', true))
    expect(posted.map((p) => p.body.positionIdx)).toEqual([0, 0])
  })

  it('hedge mode: opening Buy → 1, opening Sell → 2, reduce-only Sell → 1, reduce-only Buy → 2', async () => {
    modeRows = [
      { positionIdx: 1, symbol: 'BTCUSDT', size: '0' },
      { positionIdx: 2, symbol: 'BTCUSDT', size: '0' },
    ]
    await adapter.placeOrder(mkt('buy'))
    await adapter.placeOrder(mkt('sell'))
    await adapter.placeOrder(mkt('sell', true))
    await adapter.placeOrder(mkt('buy', true))
    expect(posted.map((p) => p.body.positionIdx)).toEqual([1, 2, 1, 2])
  })

  it('caches the mode per symbol (one lookup for many orders)', async () => {
    let lookups = 0
    ;(adapter as any).signedGet = async () => {
      lookups++
      return { list: modeRows }
    }
    await adapter.placeOrder(mkt('buy'))
    await adapter.placeOrder(mkt('buy'))
    await adapter.placeOrder(mkt('sell', true))
    expect(lookups).toBe(1)
  })

  it('an explicit positionIdx on the order wins', async () => {
    await adapter.placeOrder({ ...mkt('buy'), positionIdx: 2 } as Order)
    expect(posted[0].body.positionIdx).toBe(2)
  })

  it('a failed mode lookup falls back to one-way instead of blocking the order', async () => {
    ;(adapter as any).signedGet = async () => {
      throw new Error('rate limited')
    }
    await adapter.placeOrder(mkt('buy'))
    expect(posted[0].body.positionIdx).toBe(0)
  })

  it('spot orders carry marketUnit and no positionIdx', async () => {
    await adapter.placeOrder({ ...mkt('buy'), category: 'spot' } as Order)
    expect(posted[0].body.marketUnit).toBe('baseCoin')
    expect(posted[0].body.positionIdx).toBeUndefined()
  })
})

describe('BybitAdapter signing + transport', () => {
  const realFetch = globalThis.fetch
  let calls: Array<{ url: string; init: any }>
  let responder: (url: string, init: any) => any

  beforeEach(() => {
    calls = []
    responder = () => ({ retCode: 0, retMsg: 'OK', result: {} })
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      const body = responder(String(url), init)
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function authed(): BybitAdapter {
    const adapter = new BybitAdapter()
    ;(adapter as any).credentials = { type: 'apiKey', apiKey: 'KEY123', apiSecret: 'SECRET456', recvWindow: 7000 }
    return adapter
  }

  it('GET: signs timestamp+key+recvWindow+queryString and sends the identical query string', async () => {
    const adapter = authed()
    await (adapter as any).signedGet('/v5/order/realtime', { category: 'linear', symbol: 'BTCUSDT', limit: 10, cursor: undefined })
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    const qs = 'category=linear&symbol=BTCUSDT&limit=10'
    expect(url).toBe(`https://api.bybit.com/v5/order/realtime?${qs}`)
    const h = init.headers
    expect(h['X-BAPI-API-KEY']).toBe('KEY123')
    expect(h['X-BAPI-SIGN-TYPE']).toBe('2')
    expect(h['X-BAPI-RECV-WINDOW']).toBe('7000')
    const expected = crypto
      .createHmac('sha256', 'SECRET456')
      .update(`${h['X-BAPI-TIMESTAMP']}KEY1237000${qs}`)
      .digest('hex')
    expect(h['X-BAPI-SIGN']).toBe(expected)
  })

  it('POST: signs the exact JSON body that is sent', async () => {
    const adapter = authed()
    responder = () => ({ retCode: 0, retMsg: 'OK', result: { orderId: 'x' } })
    await (adapter as any).signedPost('/v5/order/create', { category: 'linear', symbol: 'BTCUSDT', qty: '0.01' })
    const { init } = calls[0]
    expect(init.method).toBe('POST')
    const body = init.body as string
    expect(body).toBe('{"category":"linear","symbol":"BTCUSDT","qty":"0.01"}')
    const h = init.headers
    const expected = crypto
      .createHmac('sha256', 'SECRET456')
      .update(`${h['X-BAPI-TIMESTAMP']}KEY1237000${body}`)
      .digest('hex')
    expect(h['X-BAPI-SIGN']).toBe(expected)
  })

  it('a non-zero retCode surfaces as BybitApiError with the code', async () => {
    const adapter = authed()
    responder = () => ({ retCode: 110017, retMsg: 'Reduce-only order would open a position', result: {} })
    const err = await (adapter as any).signedPost('/v5/order/create', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BybitApiError)
    expect((err as BybitApiError).retCode).toBe(110017)
    expect((err as Error).message).toContain('[110017]')
  })

  it('rate limit (10006) is named as such', async () => {
    const adapter = authed()
    responder = () => ({ retCode: 10006, retMsg: 'Too many visits!', result: {} })
    const err = await (adapter as any).signedGet('/v5/position/list', {}).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/rate limited/)
  })

  it('a non-JSON body (WAF page) fails with the HTTP status, not a parse error', async () => {
    const adapter = authed()
    globalThis.fetch = (async () => new Response('<html>403</html>', { status: 403 })) as any
    const err = await (adapter as any).signedGet('/v5/position/list', {}).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/HTTP 403/)
  })

  it('learns the venue clock offset and stamps requests with it', async () => {
    const adapter = authed()
    const ahead = 4321
    responder = (url) =>
      url.includes('/v5/market/time')
        ? { retCode: 0, retMsg: 'OK', result: { timeSecond: String(Math.floor((Date.now() + ahead) / 1000)), timeNano: String((Date.now() + ahead) * 1e6) } }
        : { retCode: 0, retMsg: 'OK', result: {} }
    const offset = await adapter.syncServerTime()
    expect(Math.abs(offset - ahead)).toBeLessThan(200)
    await (adapter as any).signedGet('/v5/account/info', {})
    const ts = Number(calls[1].init.headers['X-BAPI-TIMESTAMP'])
    expect(ts - Date.now()).toBeGreaterThan(ahead - 500)
  })

  it('REGRESSION 10002 (timestamp outside recv_window): re-syncs the clock and retries once', async () => {
    const adapter = authed()
    let orderPosts = 0
    responder = (url) => {
      if (url.includes('/v5/market/time')) {
        return { retCode: 0, retMsg: 'OK', result: { timeNano: String((Date.now() + 9000) * 1e6) } }
      }
      orderPosts++
      return orderPosts === 1
        ? { retCode: 10002, retMsg: 'invalid request, please check your server timestamp', result: {} }
        : { retCode: 0, retMsg: 'OK', result: { orderId: 'ok-after-resync' } }
    }
    const res = await (adapter as any).signedPost('/v5/order/create', { symbol: 'BTCUSDT' })
    expect(res.orderId).toBe('ok-after-resync')
    expect(orderPosts).toBe(2)
    // Second attempt carries the corrected timestamp.
    const ts = Number(calls[calls.length - 1].init.headers['X-BAPI-TIMESTAMP'])
    expect(ts - Date.now()).toBeGreaterThan(8000)
  })

  it('a second 10002 in a row is not retried again (no loop)', async () => {
    const adapter = authed()
    let posts = 0
    responder = (url) => {
      if (url.includes('/v5/market/time')) return { retCode: 0, retMsg: 'OK', result: { timeNano: String(Date.now() * 1e6) } }
      posts++
      return { retCode: 10002, retMsg: 'bad timestamp', result: {} }
    }
    await expect((adapter as any).signedPost('/v5/order/cancel', {})).rejects.toThrow(/10002/)
    expect(posts).toBe(2)
  })

  it('testnet credentials switch both REST and WS hosts', async () => {
    const adapter = new BybitAdapter()
    responder = (url) =>
      url.includes('/v5/market/time')
        ? { retCode: 0, retMsg: 'OK', result: { timeNano: String(Date.now() * 1e6) } }
        : { retCode: 0, retMsg: 'OK', result: { unifiedMarginStatus: 6, marginMode: 'REGULAR_MARGIN' } }
    ;(adapter as any).connectWebSocket = async () => {}
    await adapter.connect({ type: 'apiKey', apiKey: 'k', apiSecret: 's', testnet: true })
    expect(calls[0].url.startsWith('https://api-testnet.bybit.com/')).toBe(true)
    expect((adapter as any).wsURL).toBe('wss://stream-testnet.bybit.com/v5/private')
    expect(adapter.isUnifiedAccount).toBe(true)
    expect(adapter.accountMarginMode).toBe('REGULAR_MARGIN')
    await adapter.disconnect()
  })
})

describe('BybitAdapter accounts / balances / positions', () => {
  let adapter: BybitAdapter
  let gets: Array<{ path: string; params: Record<string, any> }>

  beforeEach(() => {
    adapter = new BybitAdapter()
    gets = []
  })

  it('UTA: one unified account, wallet read once from UNIFIED (no CONTRACT probe)', async () => {
    ;(adapter as any).unifiedAccount = true
    ;(adapter as any).signedGet = async (path: string, params: Record<string, any>) => {
      gets.push({ path, params })
      return {
        list: [
          {
            accountType: 'UNIFIED',
            totalInitialMargin: '12.5',
            totalMaintenanceMargin: '3.1',
            coin: [
              { coin: 'USDT', walletBalance: '1000', equity: '1010.5', unrealisedPnl: '10.5', cumRealisedPnl: '-2' },
              { coin: 'BTC', walletBalance: '0', equity: '0' },
            ],
          },
        ],
      }
    }
    const accounts = await adapter.getAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].accountId).toBe(BYBIT_ACCOUNT_ID)
    expect(accounts[0].accountType).toBe('unified')

    const balances = await adapter.getBalances()
    expect(gets.filter((g) => g.path === '/v5/account/wallet-balance').map((g) => g.params.accountType)).toEqual(['UNIFIED'])
    expect(balances).toHaveLength(1)
    expect(balances[0]).toMatchObject({
      accountId: 'unified',
      currency: 'USDT',
      balance: 1000,
      equity: 1010.5,
      unrealizedPnL: 10.5,
      realizedPnL: -2,
      initialMargin: 12.5,
      maintenanceMargin: 3.1,
    })
  })

  it('classic account: reads CONTRACT but still reports the same account id', async () => {
    ;(adapter as any).unifiedAccount = false
    ;(adapter as any).signedGet = async (path: string, params: Record<string, any>) => {
      gets.push({ path, params })
      return { list: [{ accountType: 'CONTRACT', coin: [{ coin: 'USDT', walletBalance: '5', equity: '5' }] }] }
    }
    const accounts = await adapter.getAccounts()
    expect(accounts[0].accountId).toBe('unified')
    expect(accounts[0].accountType).toBe('contract')
    const balances = await adapter.getBalances()
    expect(gets[0].params.accountType).toBe('CONTRACT')
    expect(balances[0].accountId).toBe('unified')
  })

  it('positions: USDT + USDC linear pools and inverse, hedge legs keep distinct ids, empty rows dropped', async () => {
    ;(adapter as any).signedGet = async (path: string, params: Record<string, any>) => {
      gets.push({ path, params })
      if (params.category === 'linear' && params.settleCoin === 'USDT') {
        return {
          list: [
            { symbol: 'SOLUSDT', side: 'Buy', size: '12.3', avgPrice: '150.2', markPrice: '151', unrealisedPnl: '9.84', tradeMode: 0, leverage: '5', positionIdx: 0 },
            { symbol: 'ETHUSDT', side: '', size: '0', positionIdx: 0 },
            { symbol: 'BTCUSDT', side: 'Buy', size: '0.01', avgPrice: '60000', positionIdx: 1, tradeMode: 1 },
            { symbol: 'BTCUSDT', side: 'Sell', size: '0.02', avgPrice: '61000', positionIdx: 2, tradeMode: 1 },
          ],
          nextPageCursor: '',
        }
      }
      if (params.category === 'inverse') {
        return { list: [{ symbol: 'BTCUSD', side: 'Sell', size: '300', avgPrice: '27464.5', positionIdx: 0, tradeMode: 0, leverage: '10' }] }
      }
      return { list: [] }
    }
    const positions = await adapter.getPositions()
    expect(positions.map((p) => p.id)).toEqual([
      'bybit:linear:SOLUSDT',
      'bybit:linear:BTCUSDT:1',
      'bybit:linear:BTCUSDT:2',
      'bybit:inverse:BTCUSD',
    ])
    expect(positions.every((p) => p.accountId === 'unified')).toBe(true)
    expect(positions[0]).toMatchObject({ side: 'long', size: 12.3, entryPrice: 150.2, markPrice: 151, unrealizedPnL: 9.84, marginType: 'cross', leverage: 5 })
    expect(positions[1].marginType).toBe('isolated')
    expect(positions[3]).toMatchObject({ side: 'short', size: 300 })
    // Every pool asks for the max page size.
    expect(gets.every((g) => g.params.limit === 200)).toBe(true)
    // The position list also seeds the position-mode cache.
    expect(await adapter.getPositionMode('BTCUSDT')).toBe('hedge')
    expect(await adapter.getPositionMode('SOLUSDT')).toBe('oneway')
  })

  it('positions: follows nextPageCursor', async () => {
    ;(adapter as any).signedGet = async (_path: string, params: Record<string, any>) => {
      gets.push({ path: _path, params })
      if (params.category !== 'linear' || params.settleCoin !== 'USDT') return { list: [] }
      if (!params.cursor) return { list: [{ symbol: 'A1USDT', side: 'Buy', size: '1', positionIdx: 0 }], nextPageCursor: 'p2' }
      return { list: [{ symbol: 'A2USDT', side: 'Buy', size: '1', positionIdx: 0 }], nextPageCursor: '' }
    }
    const positions = await adapter.getPositions()
    expect(positions.map((p) => p.symbol)).toEqual(['A1USDT', 'A2USDT'])
    expect(gets.find((g) => g.params.cursor === 'p2')).toBeDefined()
  })
})

describe('BybitAdapter.getOrderStatus', () => {
  let adapter: BybitAdapter
  let gets: Array<{ path: string; params: Record<string, any> }>

  beforeEach(() => {
    adapter = new BybitAdapter()
    gets = []
  })

  const stubGet = (byPath: Record<string, any[] | Error>) => {
    ;(adapter as any).signedGet = async (path: string, params: Record<string, any>) => {
      gets.push({ path, params })
      const v = byPath[path] ?? []
      if (v instanceof Error) throw v
      return { list: v }
    }
  }

  it('maps a filled order to state filled with fill details, fee and fill time', async () => {
    stubGet({
      '/v5/order/realtime': [
        { orderId: 'o1', orderStatus: 'Filled', cumExecQty: '0.01', avgPrice: '58000', cumExecFee: '0.02', updatedTime: '1700000000123' },
      ],
    })
    const s = await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT', category: 'linear' })
    expect(s.state).toBe('filled')
    expect(s.filledQuantity).toBe(0.01)
    expect(s.averagePrice).toBe(58000)
    expect(s.commission).toBe(0.02)
    expect(s.filledAtMs).toBe(1700000000123)
    expect(gets[0].params.orderId).toBe('o1')
    expect(gets[0].params.symbol).toBe('BTCUSDT')
  })

  it('UTA linear: fee comes from cumFeeDetail when cumExecFee is empty', async () => {
    stubGet({
      '/v5/order/realtime': [{ orderId: 'o1', orderStatus: 'Filled', cumExecQty: '1', avgPrice: '150', cumExecFee: '', cumFeeDetail: { USDT: '0.0825' } }],
    })
    const s = await adapter.getOrderStatus('o1', { symbol: 'SOLUSDT' })
    expect(s.commission).toBeCloseTo(0.0825, 6)
  })

  it('maps New/Untriggered to working', async () => {
    stubGet({ '/v5/order/realtime': [{ orderId: 'o1', orderStatus: 'Untriggered' }] })
    expect((await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT' })).state).toBe('working')
  })

  it('maps Rejected and Cancelled', async () => {
    stubGet({ '/v5/order/realtime': [{ orderId: 'o1', orderStatus: 'Rejected' }] })
    expect((await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT' })).state).toBe('rejected')
    stubGet({ '/v5/order/realtime': [{ orderId: 'o1', orderStatus: 'Cancelled' }] })
    expect((await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT' })).state).toBe('cancelled')
  })

  it('falls back to /v5/order/history when realtime no longer lists the id (older fills)', async () => {
    stubGet({
      '/v5/order/realtime': [],
      '/v5/order/history': [{ orderId: 'old', orderStatus: 'Filled', cumExecQty: '1', avgPrice: '100', updatedTime: '1690000000000' }],
    })
    const s = await adapter.getOrderStatus('old', { symbol: 'SOLUSDT' })
    expect(s.state).toBe('filled')
    expect(s.filledAtMs).toBe(1690000000000)
    expect(gets.map((g) => g.path)).toEqual(['/v5/order/realtime', '/v5/order/history'])
  })

  it('returns unknown + absenceConfirmed only when realtime AND history answered', async () => {
    stubGet({ '/v5/order/realtime': [], '/v5/order/history': [] })
    const s = await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT' })
    expect(s.state).toBe('unknown')
    expect(s.absenceConfirmed).toBe(true)
  })

  it('returns unknown (not throwing, not confirmed) when a lookup fails', async () => {
    stubGet({ '/v5/order/realtime': new Error('rate limited'), '/v5/order/history': [] })
    const s = await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT' })
    expect(s.state).toBe('unknown')
    expect(s.absenceConfirmed).toBe(false)
  })

  it('falls back to settleCoin pools when no symbol is given for linear', async () => {
    stubGet({ '/v5/order/realtime': [{ orderId: 'o1', orderStatus: 'New' }] })
    await adapter.getOrderStatus('o1', { category: 'linear' })
    expect(gets[0].params.settleCoin).toBe('USDT')
  })

  it('a client:<id> ref queries by (sanitised) orderLinkId', async () => {
    stubGet({ '/v5/order/realtime': [{ orderId: 'v1', orderLinkId: 'kaibotsigabc', orderStatus: 'Filled', cumExecQty: '1', avgPrice: '1' }] })
    const s = await adapter.getOrderStatus('client:kaibot:sig:abc', { symbol: 'SOLUSDT' })
    expect(gets[0].params.orderLinkId).toBe('kaibotsigabc')
    expect(gets[0].params.orderId).toBeUndefined()
    expect(s.state).toBe('filled')
  })
})

// Regression (full-review 2026-07-04, crit): cancelOrder fell back to symbol '',
// but Bybit v5 /order/cancel REQUIRES symbol, so every cancel of a bare
// placeOrder id was rejected. It must send a real symbol — from ctx or resolved
// from the live order.
describe('BybitAdapter.cancelOrder / amendOrder', () => {
  let adapter: BybitAdapter
  let posted: Array<{ path: string; body: Record<string, any> }>
  let gets: Array<{ path: string; params: Record<string, any> }>

  beforeEach(() => {
    adapter = new BybitAdapter()
    posted = []
    gets = []
    offline(adapter, BTC)
    ;(adapter as any).signedPost = async (path: string, body: Record<string, any>) => {
      posted.push({ path, body })
      return { orderId: body.orderId }
    }
    ;(adapter as any).signedGet = async (path: string, params: Record<string, any>) => {
      gets.push({ path, params })
      return { list: [{ orderId: params.orderId, symbol: 'BTCUSDT', orderStatus: 'New', category: 'linear' }] }
    }
  })

  it('cancels a bare id with the ctx symbol (never empty)', async () => {
    await adapter.cancelOrder('12345', { symbol: 'BTCUSDT' })
    const cancel = posted.find((p) => p.path === '/v5/order/cancel')!
    expect(cancel.body.symbol).toBe('BTCUSDT')
    expect(String(cancel.body.orderId)).toBe('12345')
    expect(gets).toHaveLength(0)
  })

  it('resolves the symbol from the live order when no ctx is given', async () => {
    await adapter.cancelOrder('12345')
    const cancel = posted.find((p) => p.path === '/v5/order/cancel')!
    expect(cancel.body.symbol).toBe('BTCUSDT')
    expect(cancel.body.symbol).not.toBe('')
  })

  it('accepts a "<category>:<symbol>:<id>" composite id', async () => {
    await adapter.cancelOrder('inverse:BTCUSD:abc-1')
    const cancel = posted[0]
    expect(cancel.body).toMatchObject({ category: 'inverse', symbol: 'BTCUSD', orderId: 'abc-1' })
  })

  it('amend sends only the changed fields, formatted to the instrument', async () => {
    const res = await adapter.amendOrder('o-9', { symbol: 'BTCUSDT' }, { price: 50000.04, quantity: 0.0123 })
    const amend = posted.find((p) => p.path === '/v5/order/amend')!
    expect(amend.body).toEqual({ category: 'linear', symbol: 'BTCUSDT', orderId: 'o-9', qty: '0.012', price: '50000.0' })
    expect(res.orderId).toBe('o-9')
    await adapter.amendOrder('o-9', { symbol: 'BTCUSDT' }, { triggerPrice: 49000 })
    expect(posted[1].body).toEqual({ category: 'linear', symbol: 'BTCUSDT', orderId: 'o-9', triggerPrice: '49000.0' })
  })

  it('amend with an empty patch never hits the venue', async () => {
    await expect(adapter.amendOrder('o-9', { symbol: 'BTCUSDT' }, {})).rejects.toThrow(/nothing to amend/)
    expect(posted).toHaveLength(0)
  })
})

describe('BybitAdapter.getExecutions / getMarketTicker / getFeeRate', () => {
  it('maps execution rows (fills + funding) and paginates up to the limit', async () => {
    const adapter = new BybitAdapter()
    const gets: any[] = []
    ;(adapter as any).signedGet = async (path: string, params: Record<string, any>) => {
      gets.push({ path, params })
      if (!params.cursor) {
        return {
          list: [
            { execId: 'e2', orderId: 'o1', orderLinkId: 'lnk', symbol: 'SOLUSDT', side: 'Sell', execPrice: '151.5', execQty: '0.1', execFee: '0.0083', feeCurrency: 'USDT', execType: 'Trade', isMaker: false, execTime: '1700000002000' },
            { execId: 'e1', orderId: '', orderLinkId: '', symbol: 'SOLUSDT', side: 'Buy', execPrice: '150', execQty: '0.1', execFee: '0.001', execType: 'Funding', isMaker: false, execTime: '1700000001000' },
          ],
          nextPageCursor: 'next',
        }
      }
      return { list: [{ execId: 'e0', orderId: 'o0', symbol: 'SOLUSDT', side: 'Buy', execPrice: '149', execQty: '0.1', execFee: '0.008', execType: 'Trade', execTime: '1700000000000' }], nextPageCursor: '' }
    }
    const rows = await adapter.getExecutions({ symbol: 'SOLUSDT', startTimeMs: 1699999999000, limit: 3 })
    expect(gets[0].path).toBe('/v5/execution/list')
    expect(gets[0].params).toMatchObject({ category: 'linear', symbol: 'SOLUSDT', startTime: 1699999999000, limit: 3 })
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ execId: 'e2', orderId: 'o1', orderLinkId: 'lnk', side: 'sell', price: 151.5, qty: 0.1, fee: 0.0083, feeCurrency: 'USDT', execType: 'Trade', isMaker: false, timeMs: 1700000002000 })
    expect(rows[1]).toMatchObject({ execType: 'Funding', orderLinkId: null, feeCurrency: null })
    expect(rows[2].execId).toBe('e0')
  })

  it('maps the public ticker to mark / 24h % / funding', async () => {
    const adapter = new BybitAdapter()
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: any) => {
      expect(String(url)).toContain('/v5/market/tickers?category=linear&symbol=SOLUSDT')
      return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [{ markPrice: '150.5', lastPrice: '150.4', price24hPcnt: '-0.0123', fundingRate: '0.0001' }] } }))
    }) as any
    try {
      const t = await adapter.getMarketTicker('SOLUSDT')
      expect(t).toEqual({ mark: 150.5, change24hPct: -1.23, fundingRate: 0.0001 })
      expect(await adapter.getLastPrice('SOLUSDT')).toBe(150.5)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('reads taker/maker fee rates', async () => {
    const adapter = new BybitAdapter()
    ;(adapter as any).signedGet = async (path: string, params: Record<string, any>) => {
      expect(path).toBe('/v5/account/fee-rate')
      expect(params).toEqual({ category: 'linear', symbol: 'SOLUSDT' })
      return { list: [{ symbol: 'SOLUSDT', takerFeeRate: '0.00055', makerFeeRate: '0.0002' }] }
    }
    expect(await adapter.getFeeRate('SOLUSDT')).toEqual({ taker: 0.00055, maker: 0.0002 })
  })

  it('getInstrument parses lot/price filters from the public endpoint and caches', async () => {
    const adapter = new BybitAdapter()
    const realFetch = globalThis.fetch
    let hits = 0
    globalThis.fetch = (async () => {
      hits++
      return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [{ symbol: 'SOLUSDT', status: 'Trading', lotSizeFilter: { qtyStep: '0.1', minOrderQty: '0.1', maxOrderQty: '79770', minNotionalValue: '5' }, priceFilter: { tickSize: '0.01' } }] } }))
    }) as any
    try {
      const inst = await adapter.getInstrument('solusdt')
      expect(inst).toMatchObject({ symbol: 'SOLUSDT', category: 'linear', qtyStep: 0.1, minOrderQty: 0.1, maxOrderQty: 79770, tickSize: 0.01, minNotionalValue: 5 })
      await adapter.getInstrument('SOLUSDT')
      expect(hits).toBe(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('getInstrument throws for an unlisted symbol', async () => {
    const adapter = new BybitAdapter()
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [] } }))) as any
    try {
      await expect(adapter.getInstrument('NOPEUSDT')).rejects.toThrow(/does not list/)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
