import { describe, expect, it } from 'bun:test'
import { DeribitAdapter } from './deribit.js'
import { retireOldStop } from '../../server-exit-stop.js'

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

// 15/10/2026 ~16:03 UTC, Deribit 'eth': ETH-SLTS-8047026 fired and sold 986
// (venue -10.384 → -11.370). The trigger history named the spawned order, but
// get_order_state and get_user_trades_by_order both answered order_not_found
// for it. The adapter reported 'cancelled', the sweep dropped the stop and
// never booked the exit.
describe('DeribitAdapter.getOrderStatus on a fired trigger whose spawned order is unreadable', () => {
  const ETH_TRIGGER = 'ETH-SLTS-8047026'
  const ETH_SPAWNED = 'ETH-138800000001'
  const FIRED_AT = 1792080186000
  const firedHistory = (state = 'triggered') => ({
    entries: [
      {
        trigger_order_id: ETH_TRIGGER,
        order_id: ETH_SPAWNED,
        order_state: state,
        request: 'trigger:order',
        instrument_name: 'ETH-PERPETUAL',
        amount: 986,
        direction: 'sell',
        reduce_only: false,
        timestamp: FIRED_AT,
      },
    ],
    continuation: 'none',
  })
  // Every id lookup on the spawned order misses; only the instrument-wide
  // indexes the handler answers can find it.
  function venue(answer: (e: string, p: Record<string, any>) => any) {
    const calls: Array<{ e: string; p: Record<string, any> }> = []
    const a = adapterWith((e, p) => {
      calls.push({ e, p })
      if (e === 'private/get_trigger_order_history') return firedHistory()
      if (e === 'private/get_order_state' || e === 'private/get_user_trades_by_order') return notFound()
      return answer(e, p)
    })
    return { a, calls }
  }
  const nothing = (e: string) => (e === 'private/get_order_history_by_instrument' ? [] : { trades: [], has_more: false })

  it('reports unknown + triggered, never cancelled, after asking the historical indexes too', async () => {
    const { a, calls } = venue(nothing)
    const s = await a.getOrderStatus!(ETH_TRIGGER, { symbol: 'ETH-PERPETUAL' })
    expect(s.state).toBe('unknown')
    expect(s.triggered).toBe(true)
    expect(s.absenceConfirmed).toBe(false)
    const hist = calls.filter((c) => c.e === 'private/get_order_history_by_instrument')
    expect(hist.map((c) => c.p.historical)).toEqual([false, true])
    const byInstrument = calls.filter((c) => c.e === 'private/get_user_trades_by_instrument_and_time')
    expect(byInstrument.map((c) => c.p.historical)).toEqual([false, true])
    expect(byInstrument[0].p).toMatchObject({ instrument_name: 'ETH-PERPETUAL', start_timestamp: FIRED_AT - 60_000, count: 1000, sorting: 'asc' })
  })

  it('finds the fill in the HISTORICAL order index once the recent one forgot it', async () => {
    const { a } = venue((e, p) => {
      if (e === 'private/get_order_history_by_instrument') {
        expect(p).toMatchObject({ instrument_name: 'ETH-PERPETUAL', count: 1000, include_unfilled: true })
        if (!p.historical) return []
        return [
          { order_id: 'ETH-1', order_state: 'filled', filled_amount: 5, average_price: 2400 },
          { order_id: ETH_SPAWNED, order_state: 'filled', filled_amount: 986, average_price: 2435.5, last_update_timestamp: 1792080186584, instrument_name: 'ETH-PERPETUAL' },
        ]
      }
      return nothing(e)
    })
    const s = await a.getOrderStatus!(ETH_TRIGGER, { symbol: 'ETH-PERPETUAL' })
    expect(s).toMatchObject({ orderId: ETH_TRIGGER, state: 'filled', filledQuantity: 986, averagePrice: 2435.5, filledAtMs: 1792080186584 })
  })

  it('pages the order history while a page comes back full', async () => {
    const offsets: Array<[boolean, number]> = []
    const { a } = venue((e, p) => {
      if (e === 'private/get_order_history_by_instrument') {
        offsets.push([!!p.historical, p.offset])
        if (!p.historical) return []
        if (p.offset === 0) return Array.from({ length: 1000 }, (_, i) => ({ order_id: `ETH-x${i}`, order_state: 'filled' }))
        return [{ order_id: ETH_SPAWNED, order_state: 'filled', filled_amount: 986, average_price: 2435.5 }]
      }
      return nothing(e)
    })
    const s = await a.getOrderStatus!(ETH_TRIGGER, { symbol: 'ETH-PERPETUAL' })
    expect(s.state).toBe('filled')
    expect(offsets).toEqual([[false, 0], [true, 0], [true, 1000]])
  })

  it('finds the fill in the historical instrument trades, filtered on the spawned order id', async () => {
    const { a } = venue((e, p) => {
      if (e === 'private/get_user_trades_by_instrument_and_time') {
        if (!p.historical) return { trades: [{ trade_id: 'other', order_id: 'ETH-9', amount: 3, price: 2440, timestamp: FIRED_AT }], has_more: false }
        return {
          trades: [
            { trade_id: 't1', order_id: ETH_SPAWNED, amount: 600, price: 2435.5, timestamp: FIRED_AT + 500, instrument_name: 'ETH-PERPETUAL' },
            { trade_id: 't2', order_id: ETH_SPAWNED, amount: 386, price: 2435, timestamp: FIRED_AT + 600, instrument_name: 'ETH-PERPETUAL' },
          ],
          has_more: false,
        }
      }
      return nothing(e)
    })
    const s = await a.getOrderStatus!(ETH_TRIGGER, { symbol: 'ETH-PERPETUAL' })
    expect(s.state).toBe('filled')
    expect(s.filledQuantity).toBe(986)
    expect(s.averagePrice).toBeCloseTo((600 * 2435.5 + 386 * 2435) / 986, 9)
    expect(s.filledAtMs).toBe(FIRED_AT + 600)
    expect((await a.getOrderFills!(ETH_TRIGGER, { symbol: 'ETH-PERPETUAL' })).filledQuantity).toBe(986)
  })

  it('a history entry that itself says rejected stays rejected', async () => {
    const a = adapterWith((e) => {
      if (e === 'private/get_trigger_order_history') return firedHistory('rejected')
      if (e === 'private/get_order_state' || e === 'private/get_user_trades_by_order') return notFound()
      return nothing(e)
    })
    const s = await a.getOrderStatus!(ETH_TRIGGER, { symbol: 'ETH-PERPETUAL' })
    expect(s.state).toBe('rejected')
  })
})

// Review round 3 repro: a transient error inside the fired-trigger walk (here
// too_many_requests on the order history) surfaced as a plain 'unknown', and
// retireOldStop read that as "gone": a plain replacement stayed up while the
// old stop may already have filled (15/10 again).
describe('a failing fired-trigger lookup is inconclusive, never gone', () => {
  const T = 'ETH-SLTS-8047026'
  const S = 'ETH-138800000001'
  function rateLimited() {
    return adapterWith((e) => {
      if (e === 'private/cancel') throw new Error('order_not_found')
      if (e === 'private/get_trigger_order_history') {
        return { entries: [{ trigger_order_id: T, order_id: S, order_state: 'triggered', instrument_name: 'ETH-PERPETUAL', amount: 986, timestamp: 1 }], continuation: 'none' }
      }
      if (e === 'private/get_order_state') throw new Error('order_not_found')
      if (e === 'private/get_order_history_by_instrument') throw new Error('too_many_requests')
      return { trades: [] }
    })
  }

  it('getOrderStatus: unknown, absence not confirmed, not marked fired', async () => {
    const st = await rateLimited().getOrderStatus!(T, { symbol: 'ETH-PERPETUAL' })
    expect(st.state).toBe('unknown')
    expect(st.absenceConfirmed).toBe(false)
    expect(st.triggered).toBeUndefined()
  })

  it('retireOldStop: unresolved, not gone', async () => {
    let resolveFiredCalled = false
    const r = await retireOldStop(rateLimited(), T, 'ETH-PERPETUAL', async () => {
      resolveFiredCalled = true
      return 'dropped' as const
    })
    expect(r.outcome).toBe('unresolved')
    expect(resolveFiredCalled).toBe(false)
  })
})
