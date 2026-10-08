// Canonical -> venue-native symbol translation for composite signals.
// A composite signal carries 'BTC'; the venue order needs 'BTCUSDT' (bybit) or
// 'BTC-PERPETUAL' (deribit). Non-canonical symbols (legacy per-venue signals)
// pass through untouched. Venue-generic -> dated-contract resolution (e.g.
// TradeStation front month) stays in the adapter's own resolveSymbol and
// composes on top of this.
//
// Registry-added markets ship their venue map in the signal payload
// (metadata.venueSymbols) — that map wins. The const fallback covers BTC/ETH
// signals from servers that predate dynamic symbols.
import { isCanonicalSymbol, toVenueSymbol } from '@kaibot/types/core'

export interface SymbolMapping {
  venueSymbol: string | null
  /** Why mapping failed; null when venueSymbol is set. */
  rejectReason: string | null
}

export function mapToVenueSymbol(
  exchange: string,
  symbol: string,
  venueSymbols?: Record<string, string> | null,
): SymbolMapping {
  const ex = exchange.toLowerCase()

  if (venueSymbols && Object.keys(venueSymbols).length > 0) {
    const mapped = venueSymbols[ex]
    if (mapped) return { venueSymbol: mapped, rejectReason: null }
    // A payload map means this IS a composite signal: a venue missing from it
    // is unmapped — never pass the canonical through as an order symbol.
    const fallback = isCanonicalSymbol(symbol) ? toVenueSymbol(ex, symbol) : null
    if (fallback) return { venueSymbol: fallback, rejectReason: null }
    return {
      venueSymbol: null,
      rejectReason: `no venue symbol mapping for ${symbol} on ${exchange}`,
    }
  }

  if (!isCanonicalSymbol(symbol)) return { venueSymbol: symbol, rejectReason: null }
  const mapped = toVenueSymbol(ex, symbol)
  if (mapped) return { venueSymbol: mapped, rejectReason: null }
  return {
    venueSymbol: null,
    rejectReason: `no venue symbol mapping for ${symbol} on ${exchange}`,
  }
}
