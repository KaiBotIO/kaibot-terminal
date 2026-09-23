// Per-exchange serial order lock.
//
// Every operation that places or mutates a broker order — signal opens, closes,
// the reconciler's corrections — runs through a FIFO queue scoped to its
// exchange. Two near-simultaneous signals could otherwise each pass their own
// guard and place an order before the first's state update committed, producing
// a duplicate fill (an unintended position). Serializing order ops per exchange
// eliminates that race class and keeps the reconciler from colliding with an
// in-flight order — while one venue's stalled REST call can no longer freeze
// order flow on every other venue (the old single global chain did exactly that).
//
// Ported from kaibot-exec/src/exec-service.ts `withOrderLock`, scoped per venue.

const opChains = new Map<string, Promise<unknown>>()

const FALLBACK_KEY = 'global'

/**
 * Run `fn` after every previously queued order op FOR THE SAME EXCHANGE has
 * settled (resolved OR rejected). Ops on different exchanges run independently.
 * The returned promise mirrors `fn`'s outcome; a thrown error never stalls the
 * chain for the next caller. An empty/unknown exchange key falls back to a
 * shared 'global' chain (still serialized, never unlocked).
 */
export function withOrderLock<T>(exchange: string, fn: () => Promise<T>): Promise<T> {
  const key = exchange && exchange.trim() ? exchange.trim().toLowerCase() : FALLBACK_KEY
  const prev = opChains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn) as Promise<T>
  opChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/**
 * Test-only: wait for the queue(s) to drain. With an exchange, waits for that
 * chain only; without, waits for every chain.
 */
export function orderLockIdle(exchange?: string): Promise<void> {
  const chains = exchange
    ? [opChains.get(exchange.trim().toLowerCase())].filter((c): c is Promise<unknown> => !!c)
    : [...opChains.values()]
  return Promise.all(
    chains.map((c) =>
      c.then(
        () => undefined,
        () => undefined,
      ),
    ),
  ).then(() => undefined)
}
