// Last mark seen per (exchange, account, symbol), fed by the position fetches the
// executor already does (positions route, group overview, local position
// manager). Read-only consumers (execution detail) take it from here so they
// never call the venue themselves.

export interface CachedMark {
  markPrice: number
  markAt: number
}

// Older than this is no longer a mark worth showing.
export const MARK_MAX_AGE_MS = 10 * 60_000

const byAccount = new Map<string, CachedMark>()
const bySymbol = new Map<string, CachedMark>()

const symbolKey = (exchange: string, symbol: string) => `${exchange.toLowerCase()}|${symbol.toLowerCase()}`
const accountKey = (exchange: string, accountId: string | null | undefined, symbol: string) =>
  `${symbolKey(exchange, symbol)}|${accountId ?? ''}`

export function recordMarks(
  exchange: string,
  positions: Array<{ symbol: string; accountId?: string | null; markPrice?: number | null }>,
  now = Date.now(),
): void {
  for (const p of positions) {
    if (!p.symbol || p.markPrice == null || !(p.markPrice > 0)) continue
    const mark = { markPrice: p.markPrice, markAt: now }
    byAccount.set(accountKey(exchange, p.accountId, p.symbol), mark)
    bySymbol.set(symbolKey(exchange, p.symbol), mark)
  }
}

/** The account's own mark when known, else the latest on that market; null when none is recent. */
export function lastMark(
  exchange: string,
  symbol: string,
  accountId?: string | null,
  now = Date.now(),
): CachedMark | null {
  const hit =
    (accountId != null ? byAccount.get(accountKey(exchange, accountId, symbol)) : undefined) ??
    bySymbol.get(symbolKey(exchange, symbol))
  return hit && now - hit.markAt <= MARK_MAX_AGE_MS ? hit : null
}

export function clearMarks(): void {
  byAccount.clear()
  bySymbol.clear()
}
