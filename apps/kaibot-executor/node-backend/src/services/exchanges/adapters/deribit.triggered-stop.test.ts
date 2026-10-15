import { describe, expect, it } from 'bun:test'
import { DeribitAdapter } from './deribit.js'

// 15/10/2026, Fault-Line ETH acct1: trail stop ETH-SLTS-8046827 triggered and
// filled 601 at the venue. Deribit then answers get_order_state for the
// trigger id with order_not_found, the venue-exit sweep read that as
// 'unknown' and never booked the exit. A fired trigger is resolved through
// the trigger history to the order it spawned.

const TRIGGER = 'ETH-SLTS-8046827'
const SPAWNED = 'ETH-138751234567'

function adapterWith(handler: (endpoint: string, params: Record<string, any>) => any) {
  const adapter = new DeribitAdapter()
  ;(adapter as any).call = async (endpoint: string, params: Record<string, any>) => handler(endpoint, params)
  adapter.getLastPrice = async () => null
  return adapter
}

const notFound = () => {
  throw new Error('order_not_found')
}

const history = (over: Record<string, any> = {}) => ({
  entries: [
    {
      trigger_order_id: TRIGGER,
      order_id: SPAWNED,
      order_state: 'triggered',
      instrument_name: 'ETH-PERPETUAL',
      amount: 601,
      direction: 'sell',
      reduce_only: true,
      ...over,
    },
  ],
  continuation: 'none',
})

describe('DeribitAdapter.getOrderStatus on a fired trigger order', () => {
  it('reports the spawned order fill under the trigger id', async () => {
    const a = adapterWith((e, p) => {
      if (e === 'private/get_order_state' && p.order_id === TRIGGER) return notFound()
      if (e === 'private/get_trigger_order_history') return history()
      if (e === 'private/get_order_state' && p.order_id === SPAWNED) {
        return { order_id: SPAWNED, order_state: 'filled', instrument_name: 'ETH-PERPETUAL', filled_amount: 601, average_price: 2374.9, last_update_timestamp: 1792051391000 }
      }
      throw new Error(`unexpected ${e}`)
    })
    const s = await a.getOrderStatus!(TRIGGER, { symbol: 'ETH-PERPETUAL' })
    expect(s).toMatchObject({ orderId: TRIGGER, state: 'filled', filledQuantity: 601, averagePrice: 2374.9, filledAtMs: 1792051391000 })
  })

  it('falls back to the spawned order trades once it left the order index', async () => {
    const a = adapterWith((e, p) => {
      if (e === 'private/get_order_state') return notFound()
      if (e === 'private/get_trigger_order_history') return history()
      if (e === 'private/get_user_trades_by_order' && p.order_id === SPAWNED && !p.historical) {
        return { trades: [{ trade_id: 't1', amount: 400, price: 2375, timestamp: 1792051391100 }, { trade_id: 't2', amount: 201, price: 2374, timestamp: 1792051391200 }] }
      }
      return { trades: [] }
    })
    const s = await a.getOrderStatus!(TRIGGER, { symbol: 'ETH-PERPETUAL' })
    expect(s.state).toBe('filled')
    expect(s.filledQuantity).toBe(601)
    expect(s.averagePrice).toBeCloseTo((400 * 2375 + 201 * 2374) / 601, 9)
    expect(s.filledAtMs).toBe(1792051391200)
  })

  it('a trigger the venue dropped reports cancelled, not unknown', async () => {
    const a = adapterWith((e) => {
      if (e === 'private/get_order_state') return notFound()
      if (e === 'private/get_trigger_order_history') return history({ order_id: TRIGGER, order_state: 'cancelled' })
      return { trades: [] }
    })
    const s = await a.getOrderStatus!(TRIGGER, { symbol: 'ETH-PERPETUAL' })
    expect(s.state).toBe('cancelled')
  })

  it('a trigger id the history does not know keeps the confirmed absence', async () => {
    const a = adapterWith((e) => {
      if (e === 'private/get_order_state') return notFound()
      if (e === 'private/get_trigger_order_history') return { entries: [], continuation: 'none' }
      return { trades: [] }
    })
    const s = await a.getOrderStatus!(TRIGGER, { symbol: 'ETH-PERPETUAL' })
    expect(s).toMatchObject({ state: 'unknown', absenceConfirmed: true })
  })

  it('a plain order id never consults the trigger history', async () => {
    const seen: string[] = []
    const a = adapterWith((e) => {
      seen.push(e)
      return notFound()
    })
    const s = await a.getOrderStatus!('ETH-138751234567', { symbol: 'ETH-PERPETUAL' })
    expect(s).toMatchObject({ state: 'unknown', absenceConfirmed: true })
    expect(seen).toEqual(['private/get_order_state'])
  })
})
