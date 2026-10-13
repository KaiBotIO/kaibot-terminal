import { describe, expect, it } from 'bun:test'
import { BybitAdapter } from './bybit.js'

// getOpenOrders feeds the ops open-orders view (GET /api/ops/open-orders):
// plain + conditional orders, pooled over USDT/USDC linear and inverse when no
// symbol is given, one call for one symbol, cursor pages followed.

const stopRow = {
  orderId: 'stop-1',
  orderLinkId: 'kaibot-sig-sl',
  symbol: 'SOLUSDT',
  side: 'Sell',
  orderType: 'Market',
  stopOrderType: 'Stop',
  qty: '0.4',
  price: '0',
  triggerPrice: '140.5',
  triggerBy: 'LastPrice',
  reduceOnly: true,
  orderStatus: 'Untriggered',
  createdTime: '1700000000000',
}
const limitRow = {
  orderId: 'lim-1',
  orderLinkId: '',
  symbol: 'SOLUSDT',
  side: 'Buy',
  orderType: 'Limit',
  stopOrderType: '',
  qty: '1',
  price: '100.25',
  triggerPrice: '',
  reduceOnly: false,
  orderStatus: 'New',
  createdTime: '1700000001000',
}

describe('BybitAdapter.getOpenOrders', () => {
  it('one symbol → one realtime call (openOnly 0) with normalised rows', async () => {
    const adapter = new BybitAdapter()
    const gets: any[] = []
    ;(adapter as any).signedGet = async (path: string, params: Record<string, any>) => {
      gets.push({ path, params })
      return { list: [stopRow, limitRow], nextPageCursor: '' }
    }
    const rows = await adapter.getOpenOrders({ symbol: 'solusdt' })
    expect(gets).toHaveLength(1)
    expect(gets[0].path).toBe('/v5/order/realtime')
    expect(gets[0].params).toMatchObject({ category: 'linear', symbol: 'SOLUSDT', openOnly: 0, limit: 50 })
    expect(rows).toEqual([
      expect.objectContaining({
        orderId: 'stop-1',
        symbol: 'SOLUSDT',
        side: 'sell',
        type: 'stop_market',
        amount: 0.4,
        price: null,
        triggerPrice: 140.5,
        reduceOnly: true,
        label: 'kaibot-sig-sl',
        state: 'Untriggered',
        createdAtMs: 1700000000000,
      }),
      expect.objectContaining({
        orderId: 'lim-1',
        side: 'buy',
        type: 'limit',
        amount: 1,
        price: 100.25,
        triggerPrice: null,
        reduceOnly: false,
        label: null,
        state: 'New',
      }),
    ])
  })

  it('no symbol → USDT + USDC linear pools, inverse and spot conditionals, merged by id, a failing pool skipped', async () => {
    const adapter = new BybitAdapter()
    const gets: any[] = []
    ;(adapter as any).signedGet = async (path: string, params: Record<string, any>) => {
      gets.push({ path, params })
      if (params.settleCoin === 'USDT') return { list: [limitRow] }
      if (params.settleCoin === 'USDC') throw new Error('no usdc pool')
      if (params.category === 'spot') return { list: [] }
      return { list: [{ ...stopRow, orderId: 'inv-1', symbol: 'BTCUSD', orderType: 'Limit', price: '50000' }] }
    }
    const rows = await adapter.getOpenOrders()
    expect(gets.map((g) => [g.params.category, g.params.settleCoin])).toEqual([
      ['linear', 'USDT'],
      ['linear', 'USDC'],
      ['inverse', undefined],
      ['spot', undefined],
    ])
    expect(gets[3].params.orderFilter).toBe('StopOrder')
    expect(rows.map((r) => r.orderId)).toEqual(['lim-1', 'inv-1'])
    // Conditional Limit → stop_limit.
    expect(rows[1].type).toBe('stop_limit')
  })

  it('follows nextPageCursor', async () => {
    const adapter = new BybitAdapter()
    ;(adapter as any).signedGet = async (_path: string, params: Record<string, any>) => {
      if (!params.cursor) return { list: [limitRow], nextPageCursor: 'c2' }
      return { list: [{ ...limitRow, orderId: 'lim-2' }], nextPageCursor: '' }
    }
    const rows = await adapter.getOpenOrders({ symbol: 'SOLUSDT' })
    expect(rows.map((r) => r.orderId)).toEqual(['lim-1', 'lim-2'])
  })

  it('a symbol query that fails throws (the ops view must not read "no orders")', async () => {
    const adapter = new BybitAdapter()
    ;(adapter as any).signedGet = async () => {
      throw new Error('rate limited')
    }
    await expect(adapter.getOpenOrders({ symbol: 'SOLUSDT' })).rejects.toThrow(/rate limited/)
  })
})
