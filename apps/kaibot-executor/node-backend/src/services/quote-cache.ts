// Broker-agnostic quote/market-status cache.
//
// TradeStation's quotes/marketdata endpoints 403/throttle on bursts, and every
// consumer (market-guard, front-month resolution, PnL mark-to-market) hits them
// independently. This util funnels them through ONE upstream call per TTL window
// per key, with two extra safeguards ported from kaibot-exec/src/quote-cache.ts:
//
//   - in-flight dedup: concurrent callers for the same key share one promise, so
//     a burst of N reads becomes a single upstream fetch.
//   - stale fallback: when a refresh throttles/fails, the last good value is
//     served instead — but only while it's fresh enough (a price frozen for
//     minutes silently breaks stop checks, so beyond the stale window we surface
//     the error and let the caller fail-closed).
//
// The fetcher is injected, so nothing here is TradeStation-specific. `now()` is
// injectable for deterministic tests.

export type Clock = () => number

const realClock: Clock = () => Date.now()

export interface KeyedCacheOptions<T> {
  // Fresh window: within this, the cached promise is returned as-is.
  ttlMs: number
  // Stale window: after ttlMs but within staleMs, a FAILED refresh falls back to
  // the last good value rather than throwing. 0 disables the fallback.
  staleMs?: number
  // Treat a successful-but-"empty" result as a failure (throttle often returns an
  // empty payload with a 200). When this returns true the stale fallback kicks in
  // and the empty result is NOT cached as good.
  isEmpty?: (value: T) => boolean
  now?: Clock
}

interface InFlight<T> {
  at: number
  promise: Promise<T>
}

interface LastGood<T> {
  at: number
  value: T
}

/**
 * One cache per logical resource (e.g. "market-status"). Keyed by a string the
 * caller derives from its arguments (a sorted symbol set, an endpoint, ...).
 * Holds per-key in-flight promises + last-good snapshots.
 */
export class KeyedCache<T> {
  private readonly ttlMs: number
  private readonly staleMs: number
  private readonly isEmpty: (value: T) => boolean
  private readonly now: Clock

  private inflight = new Map<string, InFlight<T>>()
  private lastGood = new Map<string, LastGood<T>>()

  constructor(opts: KeyedCacheOptions<T>) {
    this.ttlMs = opts.ttlMs
    this.staleMs = opts.staleMs ?? 0
    this.isEmpty = opts.isEmpty ?? (() => false)
    this.now = opts.now ?? realClock
  }

  /**
   * Return a fresh-or-shared value for `key`, fetching via `fetcher` only when no
   * fresh promise exists. On a failed/empty refresh, serve the last good value if
   * it's still within the stale window; otherwise rethrow.
   */
  get(key: string, fetcher: () => Promise<T>): Promise<T> {
    const hit = this.inflight.get(key)
    if (hit && this.now() - hit.at < this.ttlMs) return hit.promise

    const startedAt = this.now()
    const promise = (async () => {
      const value = await fetcher()
      if (this.isEmpty(value)) throw new Error('quote-cache: empty response (throttled?)')
      this.lastGood.set(key, { at: this.now(), value })
      return value
    })().catch((err) => {
      // Don't cache a failure — a later caller should be free to retry.
      const cur = this.inflight.get(key)
      if (cur && cur.at === startedAt) this.inflight.delete(key)
      const good = this.lastGood.get(key)
      if (good && this.staleMs > 0 && this.now() - good.at < this.staleMs) return good.value
      throw err
    })

    this.inflight.set(key, { at: startedAt, promise })
    return promise
  }

  /** Last good value for a key, regardless of age (diagnostics/tests). */
  peekLastGood(key: string): T | undefined {
    return this.lastGood.get(key)?.value
  }

  clear(): void {
    this.inflight.clear()
    this.lastGood.clear()
  }
}

export interface SlotReservationOptions {
  // Minimum spacing between consecutive reserved slots.
  spacingMs: number
  now?: Clock
  // Sleep hook, injectable for tests (default: real setTimeout).
  sleep?: (ms: number) => Promise<void>
}

/**
 * Spaces out concurrent scans so they don't burst the (throttle-prone) quotes
 * endpoint. Each `reserve()` atomically claims a slot ≥ spacingMs after the
 * previous one and resolves once that slot's start time is reached. Concurrent
 * callers queue instead of firing together. Ported from the front-month slot
 * logic in kaibot-exec/src/quote-cache.ts.
 */
export class SlotReservation {
  private readonly spacingMs: number
  private readonly now: Clock
  private readonly sleep: (ms: number) => Promise<void>
  private nextSlot = 0

  constructor(opts: SlotReservationOptions) {
    this.spacingMs = opts.spacingMs
    this.now = opts.now ?? realClock
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async reserve(): Promise<void> {
    const myTurn = Math.max(this.now(), this.nextSlot)
    this.nextSlot = myTurn + this.spacingMs
    const wait = myTurn - this.now()
    if (wait > 0) await this.sleep(wait)
  }
}

/**
 * In-flight dedup + TTL + stale fallback wrapped around a single front-month
 * resolver, with slot reservation in front of the upstream scan. Built on
 * KeyedCache (keyed by root) + SlotReservation; behaviour mirrors
 * kaibot-exec `cachedFrontMonth`.
 */
export interface FrontMonthCacheOptions {
  ttlMs?: number // success TTL (front month rarely changes within a session)
  retryMs?: number // shorter TTL after a failed/empty scan
  spacingMs?: number // min spacing between concurrent scans
  now?: Clock
  sleep?: (ms: number) => Promise<void>
}

const FRONT_MONTH_TTL_MS = 60 * 60 * 1000
const FRONT_MONTH_RETRY_MS = 3_000
const FRONT_MONTH_SPACING_MS = 1_100

/**
 * Per-root cache for "resolve this futures root to a dated front-month symbol".
 * A successful resolution is cached for ttlMs; a failure is cached only for
 * retryMs (so a transient throttle retries quickly) and reserves a slot so
 * concurrent misses don't burst.
 */
export class FrontMonthCache {
  private readonly ttlMs: number
  private readonly retryMs: number
  private readonly now: Clock
  private readonly slots: SlotReservation
  private cache = new Map<string, { symbol: string | null; at: number }>()
  private inflight = new Map<string, Promise<string | null>>()

  constructor(opts: FrontMonthCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? FRONT_MONTH_TTL_MS
    this.retryMs = opts.retryMs ?? FRONT_MONTH_RETRY_MS
    this.now = opts.now ?? realClock
    this.slots = new SlotReservation({
      spacingMs: opts.spacingMs ?? FRONT_MONTH_SPACING_MS,
      now: opts.now,
      sleep: opts.sleep,
    })
  }

  /**
   * Resolve `root` to a dated front-month symbol via `resolver` (injected: it
   * does the actual quote scan). null is cached briefly so the next signal
   * retries instead of bursting.
   */
  resolve(root: string, resolver: (root: string) => Promise<string | null>): Promise<string | null> {
    const hit = this.cache.get(root)
    if (hit && this.now() - hit.at < (hit.symbol ? this.ttlMs : this.retryMs)) {
      return Promise.resolve(hit.symbol)
    }
    const inflight = this.inflight.get(root)
    if (inflight) return inflight

    const promise = (async () => {
      await this.slots.reserve()
      try {
        const symbol = await resolver(root)
        this.cache.set(root, { symbol, at: this.now() })
        return symbol
      } catch {
        this.cache.set(root, { symbol: null, at: this.now() })
        return null
      } finally {
        this.inflight.delete(root)
      }
    })()
    this.inflight.set(root, promise)
    return promise
  }

  clear(): void {
    this.cache.clear()
    this.inflight.clear()
  }
}
