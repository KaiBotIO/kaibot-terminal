import crypto from 'node:crypto'
import { describe, expect, it, beforeEach } from 'bun:test'
import { BinanceAdapter } from './binance.js'
import type { Order } from '../types.js'

// Unit tests for Binance USDⓈ-M futures placeOrder → /fapi/v1/order param
// mapping (market/limit/stop/stopLimit), the HMAC sign helper, buildSignedQuery
// and getOrderStatus mapping. The signed transport is monkey-patched so we never
// hit the network and don't need real credentials.

describe('BinanceAdapter.placeOrder', () => {
  let adapter: BinanceAdapter
  let sent: Array<{ method: string; path: string; params: Record<string, any> }>

  beforeEach(() => {
    adapter = new BinanceAdapter()
    sent = []
    ;(adapter as any).signedRequest = async (
      method: string,
      path: string,
      params: Record<string, any>,
    ) => {
      sent.push({ method, path, params })
      return { orderId: 12345, symbol: params.symbol, executedQty: '0', avgPrice: '0' }
    }
  })

  it('maps a plain market BUY (no reduceOnly) to type MARKET, status filled', async () => {
    const order: Order = {
      accountId: 'usdm-futures',
      symbol: 'BTCUSDT',
      side: 'buy',
      orderType: 'market',
      quantity: 0.01,
    }
    const res = await adapter.placeOrder(order)

    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('POST')
    expect(sent[0].path).toBe('/fapi/v1/order')
    const p = sent[0].params
    expect(p.type).toBe('MARKET')
    expect(p.side).toBe('BUY')
    expect(p.quantity).toBe('0.01')
    expect(p.reduceOnly).toBeUndefined()
    expect(p.closePosition).toBeUndefined()
    expect(res.orderId).toBe('12345')
    expect(res.status).toBe('filled')
  })

  it('maps a reduce-only stop SELL to STOP_MARKET with stopPrice, reduceOnly "true", no closePosition', async () => {
    const order: Order = {
      accountId: 'usdm-futures',
      symbol: 'BTCUSDT',
      side: 'sell',
      orderType: 'stop',
      quantity: 0.01,
      stopPrice: 58000,
      reduceOnly: true,
      triggerType: 'mark_price',
    }
    const res = await adapter.placeOrder(order)

    const p = sent[0].params
    expect(p.type).toBe('STOP_MARKET')
    expect(p.side).toBe('SELL')
    expect(p.stopPrice).toBe('58000')
    expect(p.workingType).toBe('MARK_PRICE')
    expect(p.reduceOnly).toBe('true')
    expect(p.closePosition).toBeUndefined()
    expect(res.status).toBe('pending')
  })

  it('defaults stop workingType to CONTRACT_PRICE for last_price/none', async () => {
    const order: Order = {
      accountId: 'usdm-futures',
      symbol: 'ETHUSDT',
      side: 'buy',
      orderType: 'stop',
      quantity: 0.1,
      stopPrice: 4000,
    }
    await adapter.placeOrder(order)
    expect(sent[0].params.workingType).toBe('CONTRACT_PRICE')
  })

  it('maps a stopLimit to STOP with price + stopPrice + timeInForce', async () => {
    const order: Order = {
      accountId: 'usdm-futures',
      symbol: 'BTCUSDT',
      side: 'sell',
      orderType: 'stopLimit',
      quantity: 0.01,
      stopPrice: 58000,
      price: 57950,
      reduceOnly: true,
    }
    await adapter.placeOrder(order)
    const p = sent[0].params
    expect(p.type).toBe('STOP')
    expect(p.price).toBe('57950')
    expect(p.stopPrice).toBe('58000')
    expect(p.timeInForce).toBe('GTC')
    expect(p.reduceOnly).toBe('true')
  })

  it('maps a limit order to LIMIT with price + GTC', async () => {
    const order: Order = {
      accountId: 'usdm-futures',
      symbol: 'BTCUSDT',
      side: 'buy',
      orderType: 'limit',
      quantity: 0.01,
      price: 57000,
    }
    const res = await adapter.placeOrder(order)
    const p = sent[0].params
    expect(p.type).toBe('LIMIT')
    expect(p.price).toBe('57000')
    expect(p.timeInForce).toBe('GTC')
    expect(res.status).toBe('pending')
  })

  it('rejects a limit order without a price and sends nothing', async () => {
    const order: Order = {
      accountId: 'usdm-futures',
      symbol: 'BTCUSDT',
      side: 'buy',
      orderType: 'limit',
      quantity: 0.01,
    }
    await expect(adapter.placeOrder(order)).rejects.toThrow(/price/)
    expect(sent).toHaveLength(0)
  })

  it('rejects a stop order without stopPrice/price and sends nothing', async () => {
    const order: Order = {
      accountId: 'usdm-futures',
      symbol: 'BTCUSDT',
      side: 'sell',
      orderType: 'stop',
      quantity: 0.01,
    }
    await expect(adapter.placeOrder(order)).rejects.toThrow(/stopPrice/)
    expect(sent).toHaveLength(0)
  })
})

describe('BinanceAdapter.sign + buildSignedQuery', () => {
  it('sign() produces a deterministic HMAC-SHA256 hex matching node crypto', () => {
    const adapter = new BinanceAdapter()
    ;(adapter as any).credentials = {
      type: 'apiKey',
      apiKey: 'KEY',
      apiSecret: 'SECRET',
    }
    const payload = 'symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.01&timestamp=1700000000000'
    const expected = crypto.createHmac('sha256', 'SECRET').update(payload).digest('hex')
    expect((adapter as any).sign(payload)).toBe(expected)
  })

  it('buildSignedQuery includes timestamp + signature params', () => {
    const adapter = new BinanceAdapter()
    ;(adapter as any).credentials = {
      type: 'apiKey',
      apiKey: 'KEY',
      apiSecret: 'SECRET',
    }
    const query: string = (adapter as any).buildSignedQuery({ symbol: 'BTCUSDT', side: 'BUY' })
    const parsed = new URLSearchParams(query)
    expect(parsed.get('symbol')).toBe('BTCUSDT')
    expect(parsed.get('side')).toBe('BUY')
    expect(parsed.get('recvWindow')).toBe('5000')
    expect(parsed.get('timestamp')).toBeTruthy()
    expect(parsed.get('signature')).toBeTruthy()
    // signature must validate against the rest of the query string.
    const idx = query.lastIndexOf('&signature=')
    const base = query.slice(0, idx)
    const expected = crypto.createHmac('sha256', 'SECRET').update(base).digest('hex')
    expect(parsed.get('signature')).toBe(expected)
  })
})

describe('BinanceAdapter.getOrderStatus', () => {
  let adapter: BinanceAdapter
  let gets: Array<{ method: string; path: string; params: Record<string, any> }>

  beforeEach(() => {
    adapter = new BinanceAdapter()
    gets = []
  })

  const stub = (order: any) => {
    ;(adapter as any).signedRequest = async (
      method: string,
      path: string,
      params: Record<string, any>,
    ) => {
      gets.push({ method, path, params })
      return order
    }
  }

  it('maps FILLED to filled with fill details and parses symbol from ctx', async () => {
    stub({ orderId: 7, status: 'FILLED', executedQty: '0.01', avgPrice: '58000' })
    const s = await adapter.getOrderStatus('7', { symbol: 'BTCUSDT' })
    expect(s.state).toBe('filled')
    expect(s.filledQuantity).toBe(0.01)
    expect(s.averagePrice).toBe(58000)
    expect(gets[0].params.symbol).toBe('BTCUSDT')
    expect(gets[0].params.orderId).toBe('7')
  })

  it('parses symbol from the "<symbol>:<orderId>" id form', async () => {
    stub({ orderId: 7, status: 'NEW' })
    const s = await adapter.getOrderStatus('BTCUSDT:7')
    expect(s.state).toBe('working')
    expect(gets[0].params.symbol).toBe('BTCUSDT')
    expect(gets[0].params.orderId).toBe('7')
  })

  it('maps NEW to working and CANCELED to cancelled', async () => {
    stub({ orderId: 7, status: 'NEW' })
    expect((await adapter.getOrderStatus('7', { symbol: 'BTCUSDT' })).state).toBe('working')
    stub({ orderId: 7, status: 'CANCELED' })
    expect((await adapter.getOrderStatus('7', { symbol: 'BTCUSDT' })).state).toBe('cancelled')
  })

  it('returns unknown when no symbol can be resolved', async () => {
    stub({ orderId: 7, status: 'NEW' })
    const s = await adapter.getOrderStatus('7')
    expect(s.state).toBe('unknown')
    expect(gets).toHaveLength(0)
  })

  it('returns unknown (not throwing) when the query fails', async () => {
    ;(adapter as any).signedRequest = async () => {
      throw new Error('rate limited')
    }
    expect((await adapter.getOrderStatus('7', { symbol: 'BTCUSDT' })).state).toBe('unknown')
  })
})

describe('BinanceAdapter.getBalances (margin fields)', () => {
  // Must read /fapi/v2/account (per-asset initial/maint margin in assets[]), not
  // /fapi/v2/balance (no margin). Regression: the margin fields were undefined,
  // so the breathing-room maintenance floor was a no-op on Binance.
  it('maps /fapi/v2/account assets[] to per-asset balances with initial/maintenance margin', async () => {
    const adapter = new BinanceAdapter()
    let calledPath = ''
    ;(adapter as any).signedRequest = async (method: string, path: string) => {
      calledPath = `${method} ${path}`
      return {
        totalWalletBalance: '1050',
        assets: [
          { asset: 'USDT', walletBalance: '1000', crossUnPnl: '50', marginBalance: '1050', initialMargin: '200', maintMargin: '80' },
          { asset: 'BNB', walletBalance: '0', crossUnPnl: '0', marginBalance: '0', initialMargin: '0', maintMargin: '0' },
        ],
      }
    }

    const balances = await adapter.getBalances()

    expect(calledPath).toBe('GET /fapi/v2/account')
    expect(balances).toHaveLength(1) // the all-zero BNB asset is skipped
    const usdt = balances[0]
    expect(usdt.currency).toBe('USDT')
    expect(usdt.balance).toBe(1000)
    expect(usdt.equity).toBe(1050)
    expect(usdt.unrealizedPnL).toBe(50)
    expect(usdt.initialMargin).toBe(200)
    expect(usdt.maintenanceMargin).toBe(80) // regression: was undefined → floor stayed dead
  })

  it('keeps an asset that carries margin even with zero wallet balance', async () => {
    const adapter = new BinanceAdapter()
    ;(adapter as any).signedRequest = async () => ({
      assets: [{ asset: 'USDT', walletBalance: '0', crossUnPnl: '0', marginBalance: '0', initialMargin: '0', maintMargin: '5' }],
    })
    const balances = await adapter.getBalances()
    expect(balances).toHaveLength(1)
    expect(balances[0].maintenanceMargin).toBe(5)
  })
})

// Regression (full-review 2026-07-04, crit): cancelOrder threw on a bare id, but
// placeOrder returns exactly that bare id, so EVERY cancel failed (brackets never
// retired, settle-timeout cancel never landed). cancelOrder must succeed on an id
// returned by placeOrder — via ctx.symbol or by resolving it from open orders.
describe('BinanceAdapter.cancelOrder (bare placeOrder id)', () => {
  let adapter: BinanceAdapter
  let sent: Array<{ method: string; path: string; params: Record<string, any> }>

  beforeEach(() => {
    adapter = new BinanceAdapter()
    sent = []
    ;(adapter as any).signedRequest = async (method: string, path: string, params: Record<string, any>) => {
      sent.push({ method, path, params })
      if (path === '/fapi/v1/openOrders') return [{ orderId: 12345, symbol: 'BTCUSDT' }]
      return {}
    }
  })

  it('cancels a bare id using ctx.symbol', async () => {
    await adapter.cancelOrder('12345', { symbol: 'BTCUSDT' })
    const del = sent.find((s) => s.method === 'DELETE')!
    expect(del.params.symbol).toBe('BTCUSDT')
    expect(String(del.params.orderId)).toBe('12345')
  })

  it('resolves the symbol from open orders when no ctx is given', async () => {
    await adapter.cancelOrder('12345')
    const del = sent.find((s) => s.method === 'DELETE')!
    expect(del.params.symbol).toBe('BTCUSDT')
  })
})
