import { describe, expect, it } from 'bun:test';
import {
  COVERED_ASSET_IDS,
  resolveCoveredAssetId,
  isAssetCovered,
  getCoveredAsset,
} from '../index';

describe('COVERED_ASSET_IDS', () => {
  it('is exactly the seven scanned markets', () => {
    expect([...COVERED_ASSET_IDS].sort()).toEqual(
      ['btc', 'eth', 'sol', 'gold', 'silver', 'nasdaq', 'sp500'].sort(),
    );
  });
});

describe('resolveCoveredAssetId', () => {
  it('resolves bare asset ids', () => {
    expect(resolveCoveredAssetId('btc')).toBe('btc');
    expect(resolveCoveredAssetId('gold')).toBe('gold');
  });

  it('resolves tickers and search terms', () => {
    expect(resolveCoveredAssetId('BTCUSDT')).toBe('btc');
    expect(resolveCoveredAssetId('XAUUSD')).toBe('gold');
    expect(resolveCoveredAssetId('QQQ')).toBe('nasdaq');
    expect(resolveCoveredAssetId('SPY')).toBe('sp500');
    expect(resolveCoveredAssetId('Ethereum')).toBe('eth');
  });

  it('strips common quote suffixes', () => {
    expect(resolveCoveredAssetId('BTC-USD')).toBe('btc');
    expect(resolveCoveredAssetId('ETH/USDT')).toBe('eth');
    expect(resolveCoveredAssetId('SOLUSDC')).toBe('sol');
    expect(resolveCoveredAssetId('BTCPERP')).toBe('btc');
  });

  it('is case and separator insensitive', () => {
    expect(resolveCoveredAssetId('btcusdt')).toBe('btc');
    expect(resolveCoveredAssetId(' Sol ')).toBe('sol');
  });

  // Regression: deribit perpetuals and TradFi micro futures resolved to
  // undefined, killing the sentiment layer on those markets.
  it('resolves deribit perpetual symbols (iterative suffix strip)', () => {
    expect(resolveCoveredAssetId('BTC-PERPETUAL')).toBe('btc');
    expect(resolveCoveredAssetId('ETH-PERPETUAL')).toBe('eth');
    expect(resolveCoveredAssetId('ETH_USDC-PERPETUAL')).toBe('eth');
    expect(resolveCoveredAssetId('SOL_USDC-PERPETUAL')).toBe('sol');
  });

  it('resolves TradFi futures and micro-futures tickers', () => {
    expect(resolveCoveredAssetId('MES')).toBe('sp500');
    expect(resolveCoveredAssetId('ES')).toBe('sp500');
    expect(resolveCoveredAssetId('MNQ')).toBe('nasdaq');
    expect(resolveCoveredAssetId('NQ')).toBe('nasdaq');
    expect(resolveCoveredAssetId('MGC')).toBe('gold');
    expect(resolveCoveredAssetId('GC')).toBe('gold');
    expect(resolveCoveredAssetId('SIL')).toBe('silver');
    expect(resolveCoveredAssetId('SI')).toBe('silver');
  });

  it('keeps resolving plain quoted tickers', () => {
    expect(resolveCoveredAssetId('SOLUSDT')).toBe('sol');
    expect(resolveCoveredAssetId('BTCUSDT')).toBe('btc');
  });

  it('returns undefined for uncovered assets', () => {
    expect(resolveCoveredAssetId('ADAUSDT')).toBeUndefined();
    expect(resolveCoveredAssetId('DOGE')).toBeUndefined();
    expect(resolveCoveredAssetId('ADA-PERPETUAL')).toBeUndefined();
    expect(resolveCoveredAssetId('XYZUSDTUSDTUSDT')).toBeUndefined();
    expect(resolveCoveredAssetId('')).toBeUndefined();
  });
});

describe('isAssetCovered / getCoveredAsset', () => {
  it('isAssetCovered mirrors resolution', () => {
    expect(isAssetCovered('BTCUSDT')).toBe(true);
    expect(isAssetCovered('ADAUSDT')).toBe(false);
  });

  it('getCoveredAsset returns the config', () => {
    expect(getCoveredAsset('XAUUSD')?.name).toBe('Gold');
    expect(getCoveredAsset('ADAUSDT')).toBeUndefined();
  });
});
