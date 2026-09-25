import { describe, expect, it } from 'bun:test'
import { KeyedCache, SlotReservation, FrontMonthCache } from './quote-cache.js'

// A controllable clock so the TTL / stale-window assertions don't depend on real
// wall-clock time. Mirrors how kaibot-exec stays testable.
function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    set: (ms: number) => {
      t = ms
    },
  }
}

// A deferred so a fetch can be held open while concurrent callers pile up.
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('KeyedCache — in-flight dedup + TTL', () => {
  it('a burst of N concurrent calls within TTL triggers exactly ONE upstream fetch', async () => {
    const clock = fakeClock()
    let calls = 0
    const d = deferred<number>()
    const cache = new KeyedCache<number>({ ttlMs: 1000, now: clock.now })

    // 10 concurrent callers while the single fetch is still in flight.
    const fetcher = () => {
      calls++
      return d.promise
    }
    const all = Array.from({ length: 10 }, () => cache.get('k', fetcher))
    d.resolve(42)
    const results = await Promise.all(all)

    expect(calls).toBe(1)
    expect(results).toEqual(Array(10).fill(42))
  })

  it('serves from cache within the TTL, re-fetches once past it', async () => {
    const clock = fakeClock()
    let calls = 0
    const cache = new KeyedCache<number>({ ttlMs: 1000, now: clock.now })
    const fetcher = async () => {
      calls++
      return calls
    }

    expect(await cache.get('k', fetcher)).toBe(1)
    clock.advance(500) // within TTL
    expect(await cache.get('k', fetcher)).toBe(1)
    expect(calls).toBe(1)

    clock.advance(600) // now 1100ms > TTL
    expect(await cache.get('k', fetcher)).toBe(2)
    expect(calls).toBe(2)
  })

  it('keys are independent', async () => {
    const clock = fakeClock()
    let calls = 0
    const cache = new KeyedCache<string>({ ttlMs: 1000, now: clock.now })
    const fetcher = (label: string) => async () => {
      calls++
      return label
    }
    expect(await cache.get('a', fetcher('a'))).toBe('a')
    expect(await cache.get('b', fetcher('b'))).toBe('b')
    expect(calls).toBe(2)
  })
})

describe('KeyedCache — stale fallback on throttle/failure', () => {
  it('serves the last good value when a refresh fails within the stale window', async () => {
    const clock = fakeClock()
    const cache = new KeyedCache<string>({ ttlMs: 1000, staleMs: 10_000, now: clock.now })

    expect(await cache.get('k', async () => 'good')).toBe('good')

    // TTL expired → next call refreshes, but the refresh throttles.
    clock.advance(2000)
    const served = await cache.get('k', async () => {
      throw new Error('429 throttled')
    })
    expect(served).toBe('good') // stale fallback
  })

  it('does NOT serve stale once beyond the stale window — the error surfaces', async () => {
    const clock = fakeClock()
    const cache = new KeyedCache<string>({ ttlMs: 1000, staleMs: 5000, now: clock.now })

    expect(await cache.get('k', async () => 'good')).toBe('good')

    clock.advance(6000) // good is now older than staleMs
    await expect(
      cache.get('k', async () => {
        throw new Error('429 throttled')
      }),
    ).rejects.toThrow(/throttled/)
  })

  it('treats an "empty" response as a failure and falls back to last good', async () => {
    const clock = fakeClock()
    const cache = new KeyedCache<Map<string, number>>({
      ttlMs: 1000,
      staleMs: 10_000,
      isEmpty: (m) => m.size === 0,
      now: clock.now,
    })

    const good = new Map([['MES', 5000]])
    expect(await cache.get('k', async () => good)).toBe(good)

    clock.advance(2000)
    // Refresh returns an empty map (a throttle that 200s with no quotes).
    const served = await cache.get('k', async () => new Map<string, number>())
    expect(served).toBe(good)
  })

  it('does not cache a failure: a later caller is free to retry', async () => {
    const clock = fakeClock()
    let calls = 0
    const cache = new KeyedCache<string>({ ttlMs: 1000, staleMs: 0, now: clock.now })

    await expect(
      cache.get('k', async () => {
        calls++
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // Same instant, no stale value → the next call retries instead of replaying
    // the cached rejection.
    const ok = await cache.get('k', async () => {
      calls++
      return 'recovered'
    })
    expect(ok).toBe('recovered')
    expect(calls).toBe(2)
  })
})

describe('SlotReservation — spacing concurrent scans', () => {
  it('spaces consecutive reservations by spacingMs (no real timers)', async () => {
    const clock = fakeClock()
    const waits: number[] = []
    const slots = new SlotReservation({
      spacingMs: 1100,
      now: clock.now,
      // Record the requested wait and advance the fake clock by it.
      sleep: async (ms) => {
        waits.push(ms)
        clock.advance(ms)
      },
    })

    // Three concurrent misses all reserve at t=0.
    await Promise.all([slots.reserve(), slots.reserve(), slots.reserve()])

    // First fires immediately (no sleep recorded); each subsequent scan waits one
    // full spacing before running — the fake sleep advances the clock as it goes,
    // so the recorded waits are spacing-sized, not cumulative.
    expect(waits).toEqual([1100, 1100])
  })

  it('no wait when enough real time has already passed', async () => {
    const clock = fakeClock()
    const waits: number[] = []
    const slots = new SlotReservation({
      spacingMs: 1000,
      now: clock.now,
      sleep: async (ms) => {
        waits.push(ms)
        clock.advance(ms)
      },
    })
    await slots.reserve() // t=0, no wait
    clock.advance(5000) // plenty of real time passed
    await slots.reserve() // slot was 1000, but now=5000 → no wait
    expect(waits).toEqual([]) // neither reservation needed to sleep
  })
})

describe('FrontMonthCache — slot-reserved + TTL + dedup', () => {
  function makeCache(clock: ReturnType<typeof fakeClock>) {
    return new FrontMonthCache({
      ttlMs: 60_000,
      retryMs: 3000,
      spacingMs: 1100,
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
    })
  }

  it('caches a successful resolution for ttlMs', async () => {
    const clock = fakeClock()
    const cache = makeCache(clock)
    let calls = 0
    const resolver = async () => {
      calls++
      return 'MESU26'
    }

    expect(await cache.resolve('MES', resolver)).toBe('MESU26')
    clock.advance(30_000) // within TTL
    expect(await cache.resolve('MES', resolver)).toBe('MESU26')
    expect(calls).toBe(1)

    clock.advance(40_000) // total 70_000 > ttl → re-scan
    expect(await cache.resolve('MES', resolver)).toBe('MESU26')
    expect(calls).toBe(2)
  })

  it('caches a failed/null scan only for retryMs', async () => {
    const clock = fakeClock()
    const cache = makeCache(clock)
    let calls = 0
    const failing = async (): Promise<string | null> => {
      calls++
      throw new Error('throttled')
    }

    expect(await cache.resolve('MES', failing)).toBeNull()
    clock.advance(1000) // within retryMs → still cached null
    expect(await cache.resolve('MES', failing)).toBeNull()
    expect(calls).toBe(1)

    clock.advance(3000) // past retryMs → retries
    expect(await cache.resolve('MES', failing)).toBeNull()
    expect(calls).toBe(2)
  })

  it('dedups concurrent misses into one scan', async () => {
    const clock = fakeClock()
    const cache = makeCache(clock)
    let calls = 0
    const d = deferred<string | null>()
    const resolver = () => {
      calls++
      return d.promise
    }
    const all = Array.from({ length: 5 }, () => cache.resolve('MES', resolver))
    d.resolve('MESU26')
    const results = await Promise.all(all)
    expect(calls).toBe(1)
    expect(results).toEqual(Array(5).fill('MESU26'))
  })
})
