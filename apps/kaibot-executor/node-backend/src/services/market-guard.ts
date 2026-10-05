// Market-open / stale-quote guard.
//
// Before a market order, check that the venue is actually trading: a front-month
// future trades every few seconds when the session is open, so a stale last-trade
// time means the market is closed/halted and a market order can't fill (or fills
// at a bad print on reopen). Crypto venues trade 24/7, so the guard is skipped
// for them entirely (adapter.alwaysOpen, or no getMarketStatus capability).
//
// Ref: kaibot-exec/src/ts-queries.ts `getMarketStatus` + quote-cache
// `cachedMarketStatus`. Scoped to TradeStation futures sessions here.

import type { ExchangeAdapter } from './exchanges/types.js'

// Quote older than this → the market is treated as closed.
const DEFAULT_STALE_MS = Number(process.env.MARKET_STALE_MS) || 3 * 60 * 1000

export interface MarketGuardOptions {
  staleMs?: number
  now?: number
}

/**
 * Decide whether `symbol` is tradable right now on `adapter`.
 *  - 24/7 venues (alwaysOpen) or adapters without a market-status endpoint →
 *    always tradable (crypto).
 *  - Otherwise the symbol's last trade must be fresher than staleMs.
 *  - A failed status fetch is treated as NOT tradable (fail-closed): we'd rather
 *    skip a market order than fire it blind into an unknown session.
 */
export async function isMarketTradable(
  adapter: ExchangeAdapter,
  symbol: string,
  options: MarketGuardOptions = {},
): Promise<boolean> {
  if (adapter.alwaysOpen) return true
  if (!adapter.getMarketStatus) return true // no way to tell → don't block

  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const now = options.now ?? Date.now()

  let statuses
  try {
    statuses = await adapter.getMarketStatus([symbol])
  } catch {
    return false // fail-closed: unknown session, hold off
  }

  const st = statuses.get(symbol)
  if (!st || !st.tradeTimeMs) return false
  return now - st.tradeTimeMs < staleMs
}
