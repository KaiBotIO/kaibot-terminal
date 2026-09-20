import { describe, expect, it } from 'bun:test';
import {
  buildCanonicalHelpers,
  FALLBACK_CANONICAL_DEFS,
  isCanonicalSymbol,
  toVenueSymbol,
  venueConstituentsOf,
  resolveComposite,
  isConstituentVenue,
  defaultCompositeConfig,
  INDEX_EXCHANGE,
  type CanonicalMarketDef,
} from '../canonical-symbols';

// Locks the legacy const behavior: the fallback-built helpers must answer
// exactly like the pre-registry hardcoded implementation for BTC/ETH.
describe('fallback parity with legacy const helpers', () => {
  it('isCanonicalSymbol', () => {
    expect(isCanonicalSymbol('BTC')).toBe(true);
    expect(isCanonicalSymbol('ETH')).toBe(true);
    expect(isCanonicalSymbol('SOL')).toBe(false);
    expect(isCanonicalSymbol('BTCUSDT')).toBe(false);
  });

  it('toVenueSymbol', () => {
    expect(toVenueSymbol('bybit', 'BTC')).toBe('BTCUSDT');
    expect(toVenueSymbol('deribit', 'BTC')).toBe('BTC-PERPETUAL');
    expect(toVenueSymbol('binance', 'ETH')).toBe('ETHUSDT');
    expect(toVenueSymbol('Bybit', 'ETH')).toBe('ETHUSDT');
    expect(toVenueSymbol('kraken', 'BTC')).toBeNull();
    expect(toVenueSymbol('bybit', 'SOL')).toBeNull();
  });

  it('venueConstituentsOf keeps launch venues and order', () => {
    expect(venueConstituentsOf('BTC')).toEqual([
      { exchange: 'bybit', symbol: 'BTCUSDT' },
      { exchange: 'deribit', symbol: 'BTC-PERPETUAL' },
    ]);
    expect(venueConstituentsOf('SOL')).toEqual([]);
  });

  it('resolveComposite', () => {
    expect(resolveComposite('bybit', 'BTCUSDT')).toEqual({ exchange: INDEX_EXCHANGE, symbol: 'BTC' });
    expect(resolveComposite('deribit', 'ETH-PERPETUAL')).toEqual({ exchange: INDEX_EXCHANGE, symbol: 'ETH' });
    expect(resolveComposite('index', 'BTC')).toEqual({ exchange: INDEX_EXCHANGE, symbol: 'BTC' });
    expect(resolveComposite('index', 'SOL')).toBeNull();
    expect(resolveComposite('bybit', 'SOLUSDT')).toBeNull();
  });

  it('isConstituentVenue includes every mapped venue (binance too, as before)', () => {
    expect(isConstituentVenue('bybit')).toBe(true);
    expect(isConstituentVenue('deribit')).toBe(true);
    expect(isConstituentVenue('binance')).toBe(true);
    expect(isConstituentVenue('index')).toBe(false);
    expect(isConstituentVenue('tradestation')).toBe(false);
  });

  it('defaultCompositeConfig', () => {
    expect(defaultCompositeConfig('BTC')).toEqual({
      constituents: [
        { exchange: 'bybit', symbol: 'BTCUSDT' },
        { exchange: 'deribit', symbol: 'BTC-PERPETUAL' },
      ],
      primary: 'bybit',
      maxDeviationBps: 50,
      staleAfterSec: 90,
      volumeSemantics: 'base-sum',
    });
  });
});

describe('buildCanonicalHelpers with dynamic defs', () => {
  const sol: CanonicalMarketDef = {
    symbol: 'SOL',
    displayName: 'Solana',
    venueSymbols: { bybit: 'SOLUSDT', deribit: 'SOL_USDC-PERPETUAL' },
    composite: {
      constituents: [{ exchange: 'bybit', symbol: 'SOLUSDT' }],
      primary: 'bybit',
      maxDeviationBps: 50,
      staleAfterSec: 90,
      volumeSemantics: 'base-sum',
    },
  };

  it('adds new markets without touching fallback behavior', () => {
    const h = buildCanonicalHelpers([...FALLBACK_CANONICAL_DEFS, sol]);
    expect(h.isCanonicalSymbol('SOL')).toBe(true);
    expect(h.toVenueSymbol('deribit', 'SOL')).toBe('SOL_USDC-PERPETUAL');
    expect(h.resolveComposite('bybit', 'SOLUSDT')).toEqual({ exchange: INDEX_EXCHANGE, symbol: 'SOL' });
    // single-constituent market: only the constituent feeds the composite
    expect(h.venueConstituentsOf('SOL')).toEqual([{ exchange: 'bybit', symbol: 'SOLUSDT' }]);
    expect(h.compositeConfigOf('SOL')?.primary).toBe('bybit');
    expect(h.toVenueSymbol('bybit', 'BTC')).toBe('BTCUSDT');
  });

  it('filters inactive markets everywhere', () => {
    const h = buildCanonicalHelpers([...FALLBACK_CANONICAL_DEFS, { ...sol, isActive: false }]);
    expect(h.isCanonicalSymbol('SOL')).toBe(false);
    expect(h.resolveComposite('bybit', 'SOLUSDT')).toBeNull();
    expect(h.compositeConfigOf('SOL')).toBeNull();
    expect(h.symbols).toEqual(['BTC', 'ETH']);
  });

  it('venueSymbolsOf exposes the full map for signal enrichment', () => {
    const h = buildCanonicalHelpers([sol]);
    expect(h.venueSymbolsOf('SOL')).toEqual({ bybit: 'SOLUSDT', deribit: 'SOL_USDC-PERPETUAL' });
    expect(h.venueSymbolsOf('BTC')).toBeNull();
  });
});
