// Canonical (venue-agnostic) symbols for the composite/index feed.
//
// The online system generates signals on the composite feed: exchange slug
// `index`, canonical symbols like `BTC`. Executors translate the canonical
// symbol to the venue-native instrument of whatever venue the user trades on.
//
// Source of truth is the admin-managed `canonical_markets` table; the const
// map below survives only as seed + fallback (empty table, executor offline).
// All helpers are built from a defs snapshot via buildCanonicalHelpers so the
// synchronous call signatures stay unchanged for every consumer.

export const INDEX_EXCHANGE = 'index';

export interface CompositeConstituent {
  exchange: string;
  symbol: string;
  weight?: number;
}

export interface CompositeConfig {
  constituents: CompositeConstituent[];
  /** Venue that wins when constituents diverge beyond maxDeviationBps. */
  primary: string;
  maxDeviationBps: number;
  /** Constituent with no fresh data for this long is dropped from the mean. */
  staleAfterSec: number;
  /** Non-base venue volume is converted to base units before summing. */
  volumeSemantics: 'base-sum';
}

/** One canonical market: venue symbol map + composite feed config. */
export interface CanonicalMarketDef {
  symbol: string;
  displayName?: string | null;
  /** Treated as active when omitted. */
  isActive?: boolean;
  /**
   * venue slug -> venue-native symbol. Superset of the composite
   * constituents: also carries execution-only venues (e.g. binance).
   */
  venueSymbols: Record<string, string>;
  composite: CompositeConfig;
}

export interface CanonicalHelpers {
  /** Active defs backing this snapshot. */
  defs: CanonicalMarketDef[];
  symbols: string[];
  isCanonicalSymbol(symbol: string): boolean;
  /** Venue-native symbol for a canonical symbol, or null when unmapped. */
  toVenueSymbol(exchange: string, canonical: string): string | null;
  /** Full venue map for a canonical symbol, or null when unknown. */
  venueSymbolsOf(canonical: string): Record<string, string> | null;
  /** Constituent (exchange, symbol) pairs that compose a canonical symbol. */
  venueConstituentsOf(canonical: string): CompositeConstituent[];
  /**
   * Reverse lookup: maps any known market to its composite pair.
   * ('bybit','BTCUSDT') -> {exchange:'index', symbol:'BTC'};
   * ('index','BTC') -> itself; unknown markets -> null.
   */
  resolveComposite(exchange: string, symbol: string): { exchange: string; symbol: string } | null;
  /** True for venues mapped by some composite (their raw feeds hide in pickers). */
  isConstituentVenue(exchange: string): boolean;
  compositeConfigOf(canonical: string): CompositeConfig | null;
}

export function buildCanonicalHelpers(allDefs: CanonicalMarketDef[]): CanonicalHelpers {
  const defs = allDefs.filter((d) => d.isActive !== false);
  const bySymbol = new Map(defs.map((d) => [d.symbol, d]));
  const mappedVenues = new Set<string>();
  for (const d of defs) {
    for (const venue of Object.keys(d.venueSymbols)) mappedVenues.add(venue.toLowerCase());
  }

  return {
    defs,
    symbols: defs.map((d) => d.symbol),
    isCanonicalSymbol: (symbol) => bySymbol.has(symbol),
    toVenueSymbol: (exchange, canonical) =>
      bySymbol.get(canonical)?.venueSymbols[exchange.toLowerCase()] ?? null,
    venueSymbolsOf: (canonical) => bySymbol.get(canonical)?.venueSymbols ?? null,
    venueConstituentsOf: (canonical) =>
      bySymbol.get(canonical)?.composite.constituents.map((c) => ({ ...c })) ?? [],
    resolveComposite: (exchange, symbol) => {
      const ex = exchange.toLowerCase();
      if (ex === INDEX_EXCHANGE) {
        return bySymbol.has(symbol) ? { exchange: INDEX_EXCHANGE, symbol } : null;
      }
      for (const d of defs) {
        if (d.venueSymbols[ex] === symbol) return { exchange: INDEX_EXCHANGE, symbol: d.symbol };
      }
      return null;
    },
    isConstituentVenue: (exchange) => mappedVenues.has(exchange.toLowerCase()),
    compositeConfigOf: (canonical) => bySymbol.get(canonical)?.composite ?? null,
  };
}

export function isIndexExchange(exchange: string): boolean {
  return exchange.toLowerCase() === INDEX_EXCHANGE;
}

// --- Legacy const fallback (seed for BTC/ETH; executor offline fallback) ---

/** canonical symbol -> venue slug -> venue-native symbol (fallback/seed only). */
export const CANONICAL_SYMBOLS: Record<string, Record<string, string>> = {
  BTC: { bybit: 'BTCUSDT', deribit: 'BTC-PERPETUAL', binance: 'BTCUSDT' },
  ETH: { bybit: 'ETHUSDT', deribit: 'ETH-PERPETUAL', binance: 'ETHUSDT' },
};

/** Venues whose candles fed the composite at launch (fallback defs only). */
export const COMPOSITE_CONSTITUENT_VENUES = ['bybit', 'deribit'] as const;

export const DEFAULT_COMPOSITE_SETTINGS = {
  primary: 'bybit',
  maxDeviationBps: 50,
  staleAfterSec: 90,
  volumeSemantics: 'base-sum',
} as const satisfies Omit<CompositeConfig, 'constituents'>;

export const FALLBACK_CANONICAL_DEFS: CanonicalMarketDef[] = Object.entries(
  CANONICAL_SYMBOLS,
).map(([symbol, venueSymbols]) => ({
  symbol,
  venueSymbols,
  composite: {
    constituents: COMPOSITE_CONSTITUENT_VENUES.filter((v) => venueSymbols[v]).map((v) => ({
      exchange: v,
      symbol: venueSymbols[v]!,
    })),
    ...DEFAULT_COMPOSITE_SETTINGS,
  },
}));

const fallback = buildCanonicalHelpers(FALLBACK_CANONICAL_DEFS);

export const isCanonicalSymbol = fallback.isCanonicalSymbol;
export const toVenueSymbol = fallback.toVenueSymbol;
export const venueConstituentsOf = fallback.venueConstituentsOf;
export const resolveComposite = fallback.resolveComposite;
export const isConstituentVenue = fallback.isConstituentVenue;

export function defaultCompositeConfig(canonical: string): CompositeConfig {
  return {
    constituents: fallback.venueConstituentsOf(canonical),
    ...DEFAULT_COMPOSITE_SETTINGS,
  };
}
