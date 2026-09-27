// Shared TradeStation quote/market-status caching used by both TradeStation
// adapters (oauth + couchdb). They differ only in how they authenticate; the
// marketdata API surface is identical, so the throttle-proofing lives here once
// (mirrors tradestation-orders.ts for order status).
//
// Replaces the ad-hoc per-adapter ~2.5s cache with the broker-agnostic
// quote-cache primitives: TTL + stale-fallback + in-flight dedup for market
// status, and a slot-reserved front-month cache so concurrent scans of the
// throttle-prone /quotes endpoint don't burst.

import type { MarketStatus } from '../types.js'
import {
  FrontMonthResolver,
  isFuturesRoot,
  type QuoteLike,
} from '../futures-contracts.js'
import { KeyedCache, FrontMonthCache } from '../../quote-cache.js'

// Market status served from cache within this window without an upstream call.
const MARKET_STATUS_TTL_MS = Number(process.env.QUOTE_CACHE_TTL_MS) || 2_500
// Serve the previous good snapshot when a refresh throttles — but never older
// than this. A throttle with a fresh-enough stale snapshot is served (the order
// still sees a recent trade time); beyond it the fetch error surfaces so the
// market-guard fails closed. Mirrors kaibot-exec QUOTE_STALE_MAX_MS.
const MARKET_STATUS_STALE_MS = Number(process.env.QUOTE_STALE_MAX_MS) || 60_000

/** Quote fetcher injected per adapter (its authenticated /quotes call). */
export type QuoteFetcher = (symbols: string[]) => Promise<QuoteLike[]>

function num(v: unknown): number {
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

/**
 * Per-adapter quote service. Owns the front-month resolution and the cache
 * instances; both adapters construct one with their own quote fetcher so the
 * caching is shared in code but the upstream session stays per-adapter.
 */
export class TradeStationQuoteService {
  private readonly quoteFn: QuoteFetcher
  private readonly frontMonthResolver = new FrontMonthResolver()
  private readonly frontMonthCache = new FrontMonthCache()
  private readonly statusCache = new KeyedCache<Map<string, MarketStatus>>({
    ttlMs: MARKET_STATUS_TTL_MS,
    staleMs: MARKET_STATUS_STALE_MS,
    // A throttled /quotes call often 200s with no Quotes — treat that as a miss
    // so the stale fallback kicks in rather than caching an empty map.
    isEmpty: (m: Map<string, MarketStatus>) => m.size === 0,
  })

  constructor(quoteFn: QuoteFetcher) {
    this.quoteFn = quoteFn
  }

  /**
   * Resolve a futures ROOT to its dated front-month contract. Non-futures and
   * already-dated symbols pass through unchanged. Concurrent root scans are
   * slot-spaced + in-flight deduped so they don't burst /quotes.
   */
  async resolveSymbol(symbol: string): Promise<string> {
    if (!isFuturesRoot(symbol)) return symbol
    const resolved = await this.frontMonthCache.resolve(symbol, async (root) => {
      const front = await this.frontMonthResolver.resolve(root, this.quoteFn)
      return front.symbol
    })
    // null = scan failed/empty; keep the caller's symbol so it can still try.
    return resolved ?? symbol
  }

  /**
   * Per-symbol last price + last trade time for the market-open guard. Resolves
   * bare roots to their dated front-month first, then serves the quote through
   * the shared TTL + stale-fallback + in-flight-dedup cache.
   */
  async getMarketStatus(symbols: string[]): Promise<Map<string, MarketStatus>> {
    if (symbols.length === 0) return new Map()

    // Resolve any bare roots to their dated front-month so the quote key matches
    // the symbol an order actually trades.
    const resolved = await Promise.all(
      symbols.map((s) => this.resolveSymbol(s).catch(() => s)),
    )
    const dated = [...new Set(resolved)].sort()
    const key = dated.join(',')

    const datedStatus = await this.statusCache.get(key, async () => {
      const quotes = await this.quoteFn(dated)
      const out = new Map<string, MarketStatus>()
      for (const q of quotes) {
        const sym = String(q.Symbol)
        out.set(sym, {
          symbol: sym,
          last: num(q.Last ?? q.Close ?? q.Ask),
          tradeTimeMs: (q as any).TradeTime ? Date.parse((q as any).TradeTime) : 0,
        })
      }
      return out
    })

    // Re-key by the requested (possibly bare) symbols so callers that passed a
    // root can read it back. Copy so the cached map stays immutable.
    const out = new Map(datedStatus)
    for (let i = 0; i < symbols.length; i++) {
      const st = out.get(resolved[i])
      if (st && !out.has(symbols[i])) out.set(symbols[i], st)
    }
    return out
  }

  clear(): void {
    this.frontMonthResolver.clear()
    this.frontMonthCache.clear()
    this.statusCache.clear()
  }
}
