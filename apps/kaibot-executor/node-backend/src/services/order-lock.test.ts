import { describe, expect, it } from 'bun:test'
import { withOrderLock, orderLockIdle } from './order-lock.js'

// The lock must serialize order ops per exchange: a second op on the SAME venue
// cannot start until the first has settled, even if the first is slow. This is
// the property that prevents two near-simultaneous signals from each placing an
// order before the other commits. Ops on DIFFERENT venues must not chain — one
// stalled venue would otherwise freeze order flow everywhere (EX1).

describe('withOrderLock', () => {
  it('runs queued ops for one exchange strictly one at a time (no overlap)', async () => {
    let active = 0
    let maxActive = 0
    const order: number[] = []

    const op = (id: number, delay: number) =>
      withOrderLock('deribit', async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, delay))
        order.push(id)
        active--
      })

    // Fire three ops "simultaneously"; the first is the slowest.
    await Promise.all([op(1, 30), op(2, 5), op(3, 5)])

    expect(maxActive).toBe(1) // never more than one in flight
    expect(order).toEqual([1, 2, 3]) // FIFO despite differing delays
  })

  // EX1 regression: a stalled op on one venue must not block another venue.
  it('does not chain ops across different exchanges', async () => {
    let releaseSlow: () => void = () => {}
    const slow = withOrderLock('tradestation', async () => {
      await new Promise<void>((r) => {
        releaseSlow = r
      })
    })

    let bybitRan = false
    const fast = withOrderLock('bybit', async () => {
      bybitRan = true
    })

    // Give the bybit op a tick to run while tradestation is still stalled.
    await Promise.race([fast, new Promise((r) => setTimeout(r, 50))])
    expect(bybitRan).toBe(true)

    releaseSlow()
    await slow
  })

  it('a thrown op does not stall the queue for the next op', async () => {
    const ran: string[] = []
    const failing = withOrderLock('deribit', async () => {
      ran.push('fail-start')
      throw new Error('boom')
    })
    await expect(failing).rejects.toThrow('boom')

    await withOrderLock('deribit', async () => {
      ran.push('next')
    })
    expect(ran).toEqual(['fail-start', 'next'])
  })

  it('returns the op result', async () => {
    const out = await withOrderLock('deribit', async () => 42)
    expect(out).toBe(42)
  })

  it('an empty exchange key still serializes on the shared fallback chain', async () => {
    const order: number[] = []
    const op = (id: number, delay: number) =>
      withOrderLock('', async () => {
        await new Promise((r) => setTimeout(r, delay))
        order.push(id)
      })
    await Promise.all([op(1, 20), op(2, 1)])
    expect(order).toEqual([1, 2])
  })

  it('orderLockIdle resolves after the queue drains', async () => {
    let done = false
    void withOrderLock('deribit', async () => {
      await new Promise((r) => setTimeout(r, 10))
      done = true
    })
    await orderLockIdle()
    expect(done).toBe(true)
  })
})
