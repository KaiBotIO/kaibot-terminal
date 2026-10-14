// DeribitAdapter.getOpenOrders: plain and trigger orders are separate
// listings at Deribit; both are fetched and merged by order id.

import { describe, expect, it } from 'bun:test'
import { DeribitAdapter } from './deribit.js'

function adapterWith(rows: Record<string, any[]>) {
  const adapter = new DeribitAdapter()
  const calls: Array<{ endpoint: string; params: Record<string, any> }> = []
  ;(adapter as any).call = async (endpoint: string, params: Record<string, any>) => {
    calls.push({ endpoint, params })
    return rows[`${params.instrument_name ?? params.currency}:${params.type}`] ?? []
  }
  return { adapter, calls }
}

const trigger = {
  order_id: 'ETH-SLTS-7976385', instrument_name: 'ETH-PERPETUAL', direction: 'sell', order_type: 'stop_market',
  amount: 981, trigger_price: 4300, reduce_only: true, label: 'kaibot-sl', order_state: 'untriggered', creation_timestamp: 1758500000000,
}
const limit = {
  order_id: 'ETH-1', instrument_name: 'ETH-PERPETUAL', direction: 'sell', order_type: 'limit', amount: 100, price: 4700,
  reduce_only: true, label: '', order_state: 'open', creation_timestamp: 1758500001000,
}

describe('getOpenOrders', () => {
  it('per instrument: merges the plain and trigger listings', async () => {
    const { adapter, calls } = adapterWith({
      'ETH-PERPETUAL:all': [limit, trigger],
      'ETH-PERPETUAL:trigger_all': [trigger],
    })
    const orders = await adapter.getOpenOrders({ symbol: 'ETH-PERPETUAL' })
    expect(calls.map((c) => c.endpoint)).toEqual(['private/get_open_orders_by_instrument', 'private/get_open_orders_by_instrument'])
    expect(orders).toHaveLength(2)
    expect(orders.find((o) => o.orderId === 'ETH-SLTS-7976385')).toMatchObject({
      symbol: 'ETH-PERPETUAL', side: 'sell', type: 'stop_market', amount: 981, price: null, triggerPrice: 4300,
      reduceOnly: true, label: 'kaibot-sl', state: 'untriggered', createdAtMs: 1758500000000,
    })
    expect(orders.find((o) => o.orderId === 'ETH-1')).toMatchObject({ type: 'limit', price: 4700, triggerPrice: null, label: null })
  })

  it('without an instrument: every currency, a failing currency listing is skipped', async () => {
    const adapter = new DeribitAdapter()
    ;(adapter as any).call = async (_endpoint: string, params: Record<string, any>) => {
      if (params.currency === 'USDC') throw new Error('no usdc')
      return params.currency === 'ETH' && params.type === 'trigger_all' ? [trigger] : []
    }
    const orders = await adapter.getOpenOrders()
    expect(orders.map((o) => o.orderId)).toEqual(['ETH-SLTS-7976385'])
  })
})
