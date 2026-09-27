import { describe, expect, it } from 'bun:test'
import { settleAdapterOrder, isTerminalState } from './order-settlement.js'
import type { ExchangeAdapter, OrderStatus } from './exchanges/types.js'

// A minimal adapter stub: scripted getOrderStatus responses (one per poll), and
// a record of cancel calls. No real network, no real timers (sleep is a no-op).
function stubAdapter(statuses: OrderStatus[]): ExchangeAdapter & { cancelled: string[] } {
  let i = 0
  const cancelled: string[] = []
  return {
    name: 'stub',
    cancelled,
    async connect() {},
    async disconnect() {},
    async refreshSession() {},
    async getAccounts() { return [] },
    async getBalances() { return [] },
    async getPositions() { return [] },
    async placeOrder() { return { orderId: 'x', status: 'pending' as const } },
    async cancelOrder(id: string) { cancelled.push(id) },
    subscribeToUpdates() {},
    unsubscribeFromUpdates() {},
    async getOrderStatus() {
      const s = statuses[Math.min(i, statuses.length - 1)]
      i++
      return s
    },
  } as any
}

const noSleep = async () => {}

describe('settleAdapterOrder', () => {
  it('returns filled when the order fills within the poll window', async () => {
    const adapter = stubAdapter([
      { orderId: 'o1', state: 'working' },
      { orderId: 'o1', state: 'filled', filledQuantity: 4, averagePrice: 5000 },
    ])
    const r = await settleAdapterOrder(adapter, 'o1', {}, { attempts: 5, intervalMs: 1, sleep: noSleep })
    expect(r.status).toBe('filled')
    expect(r.filledQuantity).toBe(4)
    expect(r.averagePrice).toBe(5000)
    expect(adapter.cancelled).toHaveLength(0)
  })

  it('returns rejected immediately on a rejected status', async () => {
    const adapter = stubAdapter([{ orderId: 'o1', state: 'rejected' }])
    const r = await settleAdapterOrder(adapter, 'o1', {}, { attempts: 5, intervalMs: 1, sleep: noSleep })
    expect(r.status).toBe('rejected')
    expect(adapter.cancelled).toHaveLength(0)
  })

  it('cancels after the poll window, then reports the post-cancel outcome', async () => {
    // Stays working through the first window, then a cancel lands and the
    // follow-up poll sees it cancelled.
    const adapter = stubAdapter([
      { orderId: 'o1', state: 'working' },
      { orderId: 'o1', state: 'working' },
      { orderId: 'o1', state: 'cancelled' },
    ])
    const r = await settleAdapterOrder(adapter, 'o1', {}, { attempts: 2, intervalMs: 1, sleep: noSleep })
    expect(adapter.cancelled).toEqual(['o1'])
    expect(r.status).toBe('cancelled')
  })

  it('returns timeout when the outcome is unknown even after cancel', async () => {
    // Always working → first window times out, cancel fires, second window also
    // times out. The caller must persist this as unresolved.
    const adapter = stubAdapter([{ orderId: 'o1', state: 'working' }])
    const r = await settleAdapterOrder(adapter, 'o1', {}, { attempts: 2, intervalMs: 1, sleep: noSleep })
    expect(adapter.cancelled).toEqual(['o1'])
    expect(r.status).toBe('timeout')
  })

  it('keeps the fill even if the cancel call throws', async () => {
    // Race: still working at window end → cancel throws (already filled), the
    // post-cancel poll sees the fill.
    let i = 0
    const adapter = {
      ...stubAdapter([]),
      async cancelOrder() { throw new Error('order already filled') },
      async getOrderStatus(): Promise<OrderStatus> {
        i++
        // first attempt: working; after the (throwing) cancel: filled
        return i <= 1 ? { orderId: 'o1', state: 'working' } : { orderId: 'o1', state: 'filled', filledQuantity: 1 }
      },
    } as any
    const r = await settleAdapterOrder(adapter, 'o1', {}, { attempts: 1, intervalMs: 1, sleep: noSleep })
    expect(r.status).toBe('filled')
  })

  it('returns timeout for an adapter without getOrderStatus', async () => {
    const adapter = { ...stubAdapter([]), getOrderStatus: undefined } as any
    const r = await settleAdapterOrder(adapter, 'o1', {}, { attempts: 1, intervalMs: 1, sleep: noSleep })
    expect(r.status).toBe('timeout')
  })

  it('isTerminalState classifies states correctly', () => {
    expect(isTerminalState('filled')).toBe(true)
    expect(isTerminalState('rejected')).toBe(true)
    expect(isTerminalState('cancelled')).toBe(true)
    expect(isTerminalState('working')).toBe(false)
    expect(isTerminalState('unknown')).toBe(false)
  })
})
