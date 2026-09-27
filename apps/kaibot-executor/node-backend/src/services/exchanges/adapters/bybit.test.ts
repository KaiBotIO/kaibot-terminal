import { describe, expect, it, beforeEach } from 'bun:test'
import { BybitAdapter } from './bybit.js'
import type { Order } from '../types.js'

// Unit tests for Bybit placeOrder → v5 /order/create body mapping (stop/trigger
// support) and getOrderStatus. The signed transport is monkey-patched so we
// never hit the network and don't need real credentials.

describe('BybitAdapter.placeOrder (conditional / stop orders)', () => {
  let adapter: BybitAdapter
  let posted: Array<{ path: string; body: Record<string, any> }>

  beforeEach(() => {
    adapter = new BybitAdapter()
    posted = []
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

  it('rejects a stop on the spot category', async () => {
    const order = {
      accountId: 'unified',
      symbol: 'BTCUSDT',
      side: 'sell',
      orderType: 'stop',
      quantity: 0.01,
      stopPrice: 58000,
      category: 'spot',
    } as Order
    await expect(adapter.placeOrder(order)).rejects.toThrow(/linear\/inverse/)
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
    expect(res.status).toBe('filled')
  })
})

describe('BybitAdapter.getOrderStatus', () => {
  let adapter: BybitAdapter
  let gets: Array<{ path: string; params: Record<string, any> }>

  beforeEach(() => {
    adapter = new BybitAdapter()
    gets = []
  })

  const stubGet = (list: any[]) => {
    ;(adapter as any).signedGet = async (path: string, params: Record<string, any>) => {
      gets.push({ path, params })
      return { list }
    }
  }

  it('maps a filled order to state filled with fill details', async () => {
    stubGet([
      { orderId: 'o1', orderStatus: 'Filled', cumExecQty: '0.01', avgPrice: '58000', cumExecFee: '0.02' },
    ])
    const s = await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT', category: 'linear' })
    expect(s.state).toBe('filled')
    expect(s.filledQuantity).toBe(0.01)
    expect(s.averagePrice).toBe(58000)
    expect(s.commission).toBe(0.02)
    expect(gets[0].params.orderId).toBe('o1')
    expect(gets[0].params.symbol).toBe('BTCUSDT')
  })

  it('maps New/Untriggered to working', async () => {
    stubGet([{ orderId: 'o1', orderStatus: 'Untriggered' }])
    expect((await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT' })).state).toBe('working')
  })

  it('maps Rejected and Cancelled', async () => {
    stubGet([{ orderId: 'o1', orderStatus: 'Rejected' }])
    expect((await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT' })).state).toBe('rejected')
    stubGet([{ orderId: 'o1', orderStatus: 'Cancelled' }])
    expect((await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT' })).state).toBe('cancelled')
  })

  it('returns unknown when the broker does not report the id', async () => {
    stubGet([])
    expect((await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT' })).state).toBe('unknown')
  })

  it('returns unknown (not throwing) when the query fails', async () => {
    ;(adapter as any).signedGet = async () => {
      throw new Error('rate limited')
    }
    expect((await adapter.getOrderStatus('o1', { symbol: 'BTCUSDT' })).state).toBe('unknown')
  })

  it('falls back to settleCoin when no symbol is given for linear', async () => {
    stubGet([{ orderId: 'o1', orderStatus: 'New' }])
    await adapter.getOrderStatus('o1', { category: 'linear' })
    expect(gets[0].params.settleCoin).toBe('USDT')
  })
})

// Regression (full-review 2026-07-04, crit): cancelOrder fell back to symbol '',
// but Bybit v5 /order/cancel REQUIRES symbol, so every cancel of a bare
// placeOrder id was rejected. It must send a real symbol — from ctx or resolved
// from the live order.
describe('BybitAdapter.cancelOrder (bare placeOrder id)', () => {
  let adapter: BybitAdapter
  let posted: Array<{ path: string; body: Record<string, any> }>
  let gets: Array<{ path: string; params: Record<string, any> }>

  beforeEach(() => {
    adapter = new BybitAdapter()
    posted = []
    gets = []
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
  })

  it('resolves the symbol from the live order when no ctx is given', async () => {
    await adapter.cancelOrder('12345')
    const cancel = posted.find((p) => p.path === '/v5/order/cancel')!
    expect(cancel.body.symbol).toBe('BTCUSDT')
    expect(cancel.body.symbol).not.toBe('')
  })
})
