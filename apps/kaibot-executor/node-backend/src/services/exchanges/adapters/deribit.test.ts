import { describe, expect, it, beforeEach } from 'bun:test'
import { DeribitAdapter } from './deribit.js'
import type { Order } from '../types.js'

// Unit tests for placeOrder → Deribit API params mapping.
// The adapter's private `call()` is monkey-patched to capture requests so we
// never hit the Deribit network, and so we don't need authenticated sessions.
describe('DeribitAdapter.placeOrder', () => {
  let adapter: DeribitAdapter
  let captured: Array<{ endpoint: string; params: Record<string, any> }> = []

  beforeEach(() => {
    adapter = new DeribitAdapter()
    captured = []
    ;(adapter as any).call = async (endpoint: string, params: Record<string, any>) => {
      captured.push({ endpoint, params })
      return {
        order: {
          order_id: `mock-${captured.length}`,
          order_state: 'filled',
          filled_amount: params.amount,
          average_price: params.price ?? params.trigger_price ?? 0,
        },
      }
    }
  })

  it('maps a market buy to private/buy with type=market', async () => {
    const order: Order = {
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      side: 'buy',
      orderType: 'market',
      quantity: 10,
    }
    const result = await adapter.placeOrder(order)
    expect(captured).toHaveLength(1)
    expect(captured[0].endpoint).toBe('private/buy')
    expect(captured[0].params.type).toBe('market')
    expect(captured[0].params.amount).toBe(10)
    expect(result.orderId).toBe('mock-1')
  })

  it('maps a stop order to type=stop_market with trigger + trigger_price + reduce_only', async () => {
    const order: Order = {
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      side: 'sell',
      orderType: 'stop',
      quantity: 10,
      stopPrice: 60000,
      reduceOnly: true,
      label: 'kaibot:test:sl',
    }
    await adapter.placeOrder(order)
    expect(captured).toHaveLength(1)
    expect(captured[0].endpoint).toBe('private/sell')
    expect(captured[0].params.type).toBe('stop_market')
    expect(captured[0].params.trigger).toBe('last_price')
    expect(captured[0].params.trigger_price).toBe(60000)
    expect(captured[0].params.reduce_only).toBe(true)
    expect(captured[0].params.label).toBe('kaibot:test:sl')
  })

  it('maps a stopLimit order to type=stop_limit with price + trigger_price', async () => {
    const order: Order = {
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      side: 'sell',
      orderType: 'stopLimit',
      quantity: 5,
      stopPrice: 59500,
      price: 59000,
      reduceOnly: true,
      triggerType: 'mark_price',
    }
    await adapter.placeOrder(order)
    expect(captured[0].params.type).toBe('stop_limit')
    expect(captured[0].params.trigger).toBe('mark_price')
    expect(captured[0].params.trigger_price).toBe(59500)
    expect(captured[0].params.price).toBe(59000)
    expect(captured[0].params.reduce_only).toBe(true)
  })

  it('maps a take-profit limit order to type=limit with price + reduce_only', async () => {
    const order: Order = {
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      side: 'sell',
      orderType: 'limit',
      quantity: 10,
      price: 75000,
      reduceOnly: true,
      label: 'kaibot:test:tp',
    }
    await adapter.placeOrder(order)
    expect(captured[0].params.type).toBe('limit')
    expect(captured[0].params.price).toBe(75000)
    expect(captured[0].params.reduce_only).toBe(true)
    expect(captured[0].params.label).toBe('kaibot:test:tp')
  })

  it('rejects a stop order without stopPrice', async () => {
    const order: Order = {
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      side: 'sell',
      orderType: 'stop',
      quantity: 10,
    }
    await expect(adapter.placeOrder(order)).rejects.toThrow(/stopPrice/)
    expect(captured).toHaveLength(0)
  })

  it('rejects a stopLimit order without price', async () => {
    const order: Order = {
      accountId: 'btc',
      symbol: 'BTC-PERPETUAL',
      side: 'sell',
      orderType: 'stopLimit',
      quantity: 10,
      stopPrice: 59500,
    }
    await expect(adapter.placeOrder(order)).rejects.toThrow(/stopPrice and price/)
    expect(captured).toHaveLength(0)
  })
})

// EX5 regression: clientOrderId must reach Deribit as the order label, and a
// retry with the same clientOrderId must dedupe against the already-placed
// order (Deribit does not reject duplicate labels itself).
describe('DeribitAdapter clientOrderId idempotency (EX5)', () => {
  let adapter: DeribitAdapter
  let calls: Array<{ endpoint: string; params: Record<string, any> }> = []
  let byLabelResult: any[] = []

  beforeEach(() => {
    adapter = new DeribitAdapter()
    calls = []
    byLabelResult = []
    ;(adapter as any).call = async (endpoint: string, params: Record<string, any>) => {
      calls.push({ endpoint, params })
      if (endpoint === 'private/get_order_state_by_label') return byLabelResult
      return {
        order: {
          order_id: `mock-${calls.length}`,
          order_state: 'open',
          filled_amount: 0,
          average_price: 0,
        },
      }
    }
  })

  const order: Order = {
    accountId: 'btc',
    symbol: 'BTC-PERPETUAL',
    side: 'buy',
    orderType: 'limit',
    quantity: 10,
    price: 50000,
    clientOrderId: 'kb-abc123',
    label: 'kaibot:sig:main',
  }

  it('sends the clientOrderId as the Deribit label', async () => {
    await adapter.placeOrder(order)
    const buy = calls.find((c) => c.endpoint === 'private/buy')
    expect(buy).toBeDefined()
    expect(buy!.params.label).toBe('kb-abc123')
  })

  it('checks for an existing order by label before placing', async () => {
    await adapter.placeOrder(order)
    expect(calls[0].endpoint).toBe('private/get_order_state_by_label')
    expect(calls[0].params.label).toBe('kb-abc123')
    expect(calls[0].params.currency).toBe('BTC')
  })

  it('a retry with the same clientOrderId returns the existing order instead of doubling', async () => {
    byLabelResult = [
      {
        order_id: 'existing-1',
        order_state: 'open',
        instrument_name: 'BTC-PERPETUAL',
        filled_amount: 0,
        average_price: 0,
        creation_timestamp: 1,
      },
    ]
    const result = await adapter.placeOrder(order)
    expect(result.orderId).toBe('existing-1')
    // No private/buy was issued.
    expect(calls.filter((c) => c.endpoint === 'private/buy')).toHaveLength(0)
  })

  it('a cancelled prior order with the same label does not block a fresh placement', async () => {
    byLabelResult = [
      {
        order_id: 'old-cancelled',
        order_state: 'cancelled',
        instrument_name: 'BTC-PERPETUAL',
        creation_timestamp: 1,
      },
    ]
    const result = await adapter.placeOrder(order)
    expect(calls.filter((c) => c.endpoint === 'private/buy')).toHaveLength(1)
    expect(result.orderId).not.toBe('old-cancelled')
  })

  it('USDC-linear symbols query the USDC settlement pool', async () => {
    await adapter.placeOrder({ ...order, symbol: 'SOL_USDC-PERPETUAL' })
    expect(calls[0].params.currency).toBe('USDC')
  })

  it('orders without clientOrderId skip the dedup roundtrip (no extra latency)', async () => {
    const { clientOrderId: _drop, ...rest } = order
    await adapter.placeOrder(rest as Order)
    expect(calls[0].endpoint).toBe('private/buy')
  })
})

// EX6 regression: a failed token refresh must never rethrow out of a timer (the
// old code crashed the whole executor via an unhandled rejection). It schedules
// a capped-backoff re-auth instead, and disconnect() clears it.
describe('DeribitAdapter refresh-failure recovery (EX6)', () => {
  it('refreshSession resolves on failure and schedules a re-auth timer', async () => {
    const adapter = new DeribitAdapter()
    ;(adapter as any).session = { refresh_token: 'rt', access_token: 'at', expires_in: 900 }
    ;(adapter as any).credentials = { type: 'apiKey', apiKey: 'k', apiSecret: 's' }
    ;(adapter as any).call = async () => {
      throw new Error('refresh endpoint down')
    }

    // Must not reject.
    await adapter.refreshSession()

    expect((adapter as any).reauthTimer).toBeDefined()
    expect((adapter as any).lock).toBe(false) // lock released for other calls

    await adapter.disconnect()
    expect((adapter as any).reauthTimer).toBeUndefined()
  })
})

// Regression (2026-09-04 crypto-couple probe, order USDC-185412177437): a
// 0.0001 BTC long on BTC_USDC-PERPETUAL came back as size 7.98 (the USDC
// notional), so the manual close sent 7.98 as a BTC amount and Deribit
// rejected it ("Invalid params"). Linear positions must surface the base
// amount; inverse positions keep their USD contract size.
describe('DeribitAdapter.getPositions size units', () => {
  const withPositions = (rows: any[]) => {
    const adapter = new DeribitAdapter()
    ;(adapter as any).call = async () => rows
    return adapter
  }

  it('reports a USDC-linear position in base coin (size_currency), not USDC notional', async () => {
    const adapter = withPositions([
      { instrument_name: 'BTC_USDC-PERPETUAL', direction: 'buy', size: 7.984843, size_currency: 0.0001, average_price: 79830.8, mark_price: 79848.43, floating_profit_loss: 0.0018 },
      { instrument_name: 'ETH_USDC-PERPETUAL', direction: 'buy', size: 2.4557, size_currency: 0.001, average_price: 2455.67, mark_price: 2455.7 },
    ])
    const [btc, eth] = await adapter.getPositions()
    expect(btc.size).toBeCloseTo(0.0001, 10)
    expect(btc.accountId).toBe('usdc')
    expect(eth.size).toBeCloseTo(0.001, 10)
  })

  it('falls back to notional / mark when size_currency is absent', async () => {
    const adapter = withPositions([
      { instrument_name: 'BTC_USDC-PERPETUAL', direction: 'sell', size: 7.98, average_price: 79800, mark_price: 79800 },
    ])
    const [btc] = await adapter.getPositions()
    expect(btc.side).toBe('short')
    expect(btc.size).toBeCloseTo(0.0001, 6)
  })

  it('keeps inverse perp sizes in USD contracts', async () => {
    const adapter = withPositions([
      { instrument_name: 'BTC-PERPETUAL', direction: 'buy', size: 100, size_currency: 0.00125, average_price: 80000, mark_price: 80000 },
    ])
    const [btc] = await adapter.getPositions()
    expect(btc.size).toBe(100)
    expect(btc.accountId).toBe('btc')
  })
})
