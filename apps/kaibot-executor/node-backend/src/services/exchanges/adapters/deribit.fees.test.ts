import { describe, expect, it } from 'bun:test'
import { DeribitAdapter } from './deribit.js'

// Deribit charges coin-margined contracts in the coin. Every path that
// surfaces an order (place, status, trade history) must hand back the fee in
// USD plus the native figure, so the fill ledger stores both.

function adapterWith(handler: (endpoint: string, params: Record<string, any>) => any) {
  const adapter = new DeribitAdapter()
  ;(adapter as any).call = async (endpoint: string, params: Record<string, any>) => handler(endpoint, params)
  // No public ticker in tests: a fee that needs the mark stays unpriced.
  adapter.getLastPrice = async () => null
  return adapter
}

const order = (over: Record<string, any> = {}) => ({
  order_id: 'ETH-1',
  order_state: 'filled',
  instrument_name: 'ETH-PERPETUAL',
  filled_amount: 981,
  average_price: 3000,
  commission: 0.0002, // ETH
  ...over,
})

describe('DeribitAdapter fees', () => {
  it('placeOrder converts the order commission to USD at the fill price', async () => {
    const a = adapterWith(() => ({ order: order() }))
    const res = await a.placeOrder({ accountId: 'eth', symbol: 'ETH-PERPETUAL', side: 'buy', orderType: 'market', quantity: 981 })
    expect(res.commission).toBeCloseTo(0.6, 10) // 0.0002 ETH × 3000
    expect(res.feeNative).toBe(0.0002)
    expect(res.feeCurrency).toBe('ETH')
  })

  it('getOrderStatus carries the same conversion', async () => {
    const a = adapterWith(() => order({ commission: 0.00001, instrument_name: 'BTC-PERPETUAL', average_price: 60000 }))
    const s = await a.getOrderStatus!('BTC-1')
    expect(s.state).toBe('filled')
    expect(s.commission).toBeCloseTo(0.6, 10)
    expect(s.feeCurrency).toBe('BTC')
  })

  it('getOrderStatus leaves the fee absent when the order reports none', async () => {
    const a = adapterWith(() => order({ commission: undefined }))
    const s = await a.getOrderStatus!('ETH-1')
    expect(s.commission).toBeUndefined()
  })

  it('getOrderFee sums the trades of the order and converts at their average price', async () => {
    const calls: string[] = []
    const a = adapterWith((endpoint) => {
      calls.push(endpoint)
      return {
        trades: [
          { instrument_name: 'ETH-PERPETUAL', price: 3000, amount: 500, fee: 0.0001, fee_currency: 'ETH' },
          { instrument_name: 'ETH-PERPETUAL', price: 3100, amount: 481, fee: 0.0001, fee_currency: 'ETH' },
        ],
      }
    })
    const fee = await a.getOrderFee!('ETH-1', { symbol: 'ETH-PERPETUAL' })
    const avg = (3000 * 500 + 3100 * 481) / 981
    expect(fee!.commission).toBeCloseTo(0.0002 * avg, 8)
    expect(fee!.feeNative).toBeCloseTo(0.0002, 12)
    expect(fee!.feeCurrency).toBe('ETH')
    expect(calls).toEqual(['private/get_user_trades_by_order', 'private/get_user_trades_by_order'])
  })

  it('getOrderFee retries the historical index when the recent page is empty', async () => {
    const params: any[] = []
    const a = adapterWith((_e, p) => {
      params.push(p)
      return p.historical
        ? { trades: [{ instrument_name: 'SOL_USDC-PERPETUAL', price: 150, amount: 2, fee: 0.15, fee_currency: 'USDC' }] }
        : { trades: [] }
    })
    const fee = await a.getOrderFee!('SOL-1')
    expect(fee).toEqual({ commission: 0.15, feeNative: 0.15, feeCurrency: 'USDC' })
    expect(params).toEqual([{ order_id: 'SOL-1' }, { order_id: 'SOL-1', historical: true }])
  })

  it('getOrderFee is null when the venue has no trades for the id', async () => {
    const a = adapterWith(() => ({ trades: [] }))
    expect(await a.getOrderFee!('nope')).toBeNull()
  })
})

describe('DeribitAdapter getOrderFills', () => {
  it('reads the fill of an order get_order_state has forgotten from the historical trades', async () => {
    const params: any[] = []
    const a = adapterWith((_e, p) => {
      params.push(p)
      return p.historical
        ? { trades: [{ instrument_name: 'ETH-PERPETUAL', price: 2465.3, amount: 100 }, { instrument_name: 'ETH-PERPETUAL', price: 2465.3, amount: 27 }] }
        : { trades: [] }
    })
    expect(await a.getOrderFills!('ETH-138426068827')).toEqual({ filledQuantity: 127 })
    expect(params).toEqual([{ order_id: 'ETH-138426068827' }, { order_id: 'ETH-138426068827', historical: true }])
  })

  it('merges an order whose trades straddle the recent and historical index', async () => {
    const a = adapterWith((_e, p) =>
      p.historical
        ? { trades: [{ trade_id: 'ETH-1', amount: 100 }, { trade_id: 'ETH-2', amount: 20 }] }
        : { trades: [{ trade_id: 'ETH-2', amount: 20 }, { trade_id: 'ETH-3', amount: 7 }] },
    )
    expect(await a.getOrderFills!('ETH-138426068827')).toEqual({ filledQuantity: 127 })
  })

  // Live 14/10: rungs cancelled unfilled on 12/10 made both lookups throw
  // order_not_found, so the floor settle stayed pending forever.
  it('reads order_not_found from the trade lookup as no trades', async () => {
    const a = adapterWith(() => {
      throw new Error('order_not_found')
    })
    expect(await a.getOrderFills!('ETH-138426069001')).toEqual({ filledQuantity: 0 })
    const partly = adapterWith((_e, p) => {
      if (!p.historical) throw new Error('order_not_found')
      return { trades: [{ trade_id: 'ETH-1', amount: 127 }] }
    })
    expect(await partly.getOrderFills!('ETH-138426068827')).toEqual({ filledQuantity: 127 })
  })

  it('keeps any other trade lookup error a failure', async () => {
    const a = adapterWith((e) => {
      throw new Error(`Deribit ${e} HTTP 500: Internal Server Error`)
    })
    await expect(a.getOrderFills!('ETH-138426069001')).rejects.toThrow(/HTTP 500/)
  })

  it('reports 0 filled when neither index has trades, and throws when the lookup fails', async () => {
    expect(await adapterWith(() => ({ trades: [] })).getOrderFills!('x')).toEqual({ filledQuantity: 0 })
    const down = adapterWith(() => {
      throw new Error('network down')
    })
    await expect(down.getOrderFills!('x')).rejects.toThrow(/network down/)
  })

  // A floor stop fills through the market order Deribit spawns when it fires;
  // the trades carry that order's id, never the SLTS id.
  it('reads a triggered stop through the order it spawned', async () => {
    const calls: Array<{ e: string; p: any }> = []
    const a = adapterWith((e, p) => {
      calls.push({ e, p })
      if (e === 'private/get_trigger_order_history') {
        return {
          entries: [
            { trigger_order_id: 'ETH-SLTS-9', order_id: 'ETH-SLTS-9', order_state: 'untriggered' },
            { trigger_order_id: 'ETH-SLTS-7', order_id: 'ETH-555', order_state: 'triggered' },
            { trigger_order_id: 'ETH-SLTS-9', order_id: 'ETH-777', order_state: 'triggered' },
          ],
          continuation: 'none',
        }
      }
      return p.order_id === 'ETH-777' && p.historical ? { trades: [{ instrument_name: 'ETH-PERPETUAL', price: 2400, amount: 381 }] } : { trades: [] }
    })
    expect(await a.getOrderFills!('ETH-SLTS-9', { symbol: 'ETH-PERPETUAL' })).toEqual({ filledQuantity: 381 })
    const hist = calls.find((c) => c.e === 'private/get_trigger_order_history')!
    expect(hist.p).toMatchObject({ currency: 'ETH', instrument_name: 'ETH-PERPETUAL' })
  })

  it('reports 0 for a trigger order that never fired', async () => {
    const a = adapterWith((e) => (e === 'private/get_trigger_order_history' ? { entries: [], continuation: 'none' } : { trades: [] }))
    expect(await a.getOrderFills!('ETH-SLTS-9', { symbol: 'ETH-PERPETUAL' })).toEqual({ filledQuantity: 0 })
  })

  // The spec knows currency, instrument_name, count and continuation only.
  const TRIGGER_PARAMS = new Set(['currency', 'instrument_name', 'count', 'continuation'])
  const strictTriggerHistory = (pages: Record<string, any>) => (e: string, p: any) => {
    if (e !== 'private/get_trigger_order_history') return p.order_id === 'ETH-42' ? { trades: [{ amount: 10 }] } : { trades: [] }
    const bad = Object.keys(p).filter((k) => !TRIGGER_PARAMS.has(k))
    if (bad.length > 0) throw new Error(`Invalid params: ${bad.join(', ')}`)
    return pages[p.continuation ?? '']
  }

  it('pages the trigger history through its continuation, known params only', async () => {
    const seen: any[] = []
    const fake = strictTriggerHistory({
      '': { entries: [{ trigger_order_id: 'x', order_id: 'y' }], continuation: 'c1' },
      c1: { entries: [{ trigger_order_id: 'ETH-SLTS-3', order_id: 'ETH-42' }], continuation: 'none' },
    })
    const a = adapterWith((e, p) => {
      if (e === 'private/get_trigger_order_history') seen.push(p)
      return fake(e, p)
    })
    expect(await a.getOrderFills!('ETH-SLTS-3', { symbol: 'ETH-PERPETUAL' })).toEqual({ filledQuantity: 10 })
    expect(seen).toEqual([
      { currency: 'ETH', instrument_name: 'ETH-PERPETUAL', count: 1000 },
      { currency: 'ETH', instrument_name: 'ETH-PERPETUAL', count: 1000, continuation: 'c1' },
    ])
  })

  // A floor stop that never fired, read after a restart: 0, not a failed lookup.
  it('reports 0 for a stop missing from the whole trigger history, known params only', async () => {
    const a = adapterWith(strictTriggerHistory({ '': { entries: [{ trigger_order_id: 'x', order_id: 'y' }], continuation: 'none' } }))
    expect(await a.getOrderFills!('ETH-SLTS-3', { symbol: 'ETH-PERPETUAL' })).toEqual({ filledQuantity: 0 })
  })

  it('a trigger history longer than the page limit is a failed lookup, not "never fired"', async () => {
    let calls = 0
    const a = adapterWith((e) => {
      if (e !== 'private/get_trigger_order_history') return { trades: [] }
      calls++
      return { entries: [{ trigger_order_id: 'x', order_id: 'y' }], continuation: `c${calls}` }
    })
    await expect(a.getOrderFills!('ETH-SLTS-3', { symbol: 'ETH-PERPETUAL' })).rejects.toThrow(/not exhausted/)
    expect(calls).toBe(5)
  })

  it('getOrderFee prices a triggered stop from the spawned order trades', async () => {
    const a = adapterWith((e, p) =>
      e === 'private/get_trigger_order_history'
        ? { entries: [{ trigger_order_id: 'ETH-SLTS-9', order_id: 'ETH-777' }] }
        : p.order_id === 'ETH-777'
          ? { trades: [{ instrument_name: 'ETH-PERPETUAL', price: 3000, amount: 100, fee: 0.0001, fee_currency: 'ETH' }] }
          : { trades: [] },
    )
    const fee = await a.getOrderFee!('ETH-SLTS-9', { symbol: 'ETH-PERPETUAL' })
    expect(fee?.commission).toBeCloseTo(0.3, 10)
  })
})
