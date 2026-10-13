import { isCanonicalSymbol, rootOf, toVenueSymbol } from "@kaibot/types/core";

// Studio's instrument registry lists tradfi futures by root (MGC), not by
// dated contract (MGCZ26): the root resolves with the right tick size and
// sits in the chart's pair picker.
const ROOT_CHARTED_VENUES = new Set(["tradestation", "interactive-brokers", "interactivebrokers", "paper"]);

// Deribit options and dated futures (BTC-27DEC26, BTC-27DEC26-90000-C) and
// Bybit dated futures (BTCUSDT-01MAY26): Studio has no chart for them.
const DATED_RE = /-\d{1,2}[A-Z]{3}\d{2}(?:-|$)/i;

export interface ChartTarget {
  exchange: string;
  symbol: string;
}

export function chartTargetFor(
  exchange: string | null | undefined,
  symbol: string | null | undefined,
): ChartTarget | null {
  const ex = exchange?.trim().toLowerCase();
  const sym = symbol?.trim();
  if (!ex || !sym || DATED_RE.test(sym)) return null;
  return { exchange: ex, symbol: ROOT_CHARTED_VENUES.has(ex) ? rootOf(sym) : sym };
}

/** Executor route that opens the embedded Studio chart on this market, or null when it can't be charted. */
export function chartPathFor(
  exchange: string | null | undefined,
  symbol: string | null | undefined,
): string | null {
  const t = chartTargetFor(exchange, symbol);
  if (!t) return null;
  return `/terminal?symbol=${encodeURIComponent(t.symbol)}&exchange=${encodeURIComponent(t.exchange)}`;
}

/**
 * A subscription market is a venue symbol, a canonical market of a composite
 * bot (BTC → the sub venue's BTC-PERPETUAL), or a legacy
 * "exchange:symbol[:timeframe]" string.
 */
export function chartPathForMarket(market: string, fallbackExchange: string | null | undefined): string | null {
  const parts = market.split(":");
  if (parts.length >= 2) return chartPathFor(parts[0], parts[1]);
  const ex = fallbackExchange?.trim();
  if (!ex) return null;
  const symbol = isCanonicalSymbol(market) ? (toVenueSymbol(ex, market) ?? market) : market;
  return chartPathFor(ex, symbol);
}
