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
    expect(calls).toEqual(['private/get_user_trades_by_order'])
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
