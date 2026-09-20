import { describe, expect, it } from 'bun:test';
import {
  isInverseContract,
  roundToStep,
  usdToNativeSize,
  nativeToUsdNotional,
} from '../sizing';
import { isInverseAccountingVenue } from '../accounting';

describe('isInverseContract', () => {
  it('deribit coin perps are inverse; USDC perps are linear', () => {
    expect(isInverseContract('deribit', 'BTC-PERPETUAL')).toBe(true);
    expect(isInverseContract('deribit', 'ETH-PERPETUAL')).toBe(true);
    expect(isInverseContract('deribit', 'SOL_USDC-PERPETUAL')).toBe(false);
    expect(isInverseContract('deribit', 'BTC_USDC-PERPETUAL')).toBe(false);
  });

  it('bybit inverse perps (USD-quoted) are inverse; USDT/USDC linear are not', () => {
    expect(isInverseContract('bybit', 'BTCUSD')).toBe(true);
    expect(isInverseContract('bybit', 'ETHUSD')).toBe(true);
    expect(isInverseContract('bybit', 'BTCUSDT')).toBe(false);
    expect(isInverseContract('bybit', 'BTCUSDC')).toBe(false);
    expect(isInverseContract('bybit', 'BTCPERP')).toBe(false);
    expect(isInverseContract('bybit')).toBe(false); // no symbol → can't tell → linear
  });

  it('other venues are never inverse', () => {
    expect(isInverseContract('binance', 'ETHUSDT')).toBe(false);
    expect(isInverseContract('binance', 'BTCUSD')).toBe(false);
  });

  it('case-insensitive on exchange and symbol', () => {
    expect(isInverseContract('Deribit', 'btc-perpetual')).toBe(true);
    expect(isInverseContract('DERIBIT', 'sol_usdc-perpetual')).toBe(false);
  });

  it('deribit without a symbol defaults to inverse (legacy behaviour)', () => {
    expect(isInverseContract('deribit')).toBe(true);
  });

  it('bybit inverse dated futures (USD + quarter code) are inverse', () => {
    expect(isInverseContract('bybit', 'BTCUSDH25')).toBe(true);
    expect(isInverseContract('bybit', 'BTCUSDM25')).toBe(true);
    expect(isInverseContract('bybit', 'BTCUSDU25')).toBe(true);
    expect(isInverseContract('bybit', 'BTCUSDZ25')).toBe(true);
    expect(isInverseContract('bybit', 'ETHUSDH26')).toBe(true);
  });

  it('deribit USDT spot pairs are linear, not inverse', () => {
    expect(isInverseContract('deribit', 'BTC_USDT')).toBe(false);
    expect(isInverseContract('deribit', 'ETH_USDT')).toBe(false);
  });
});

describe('isInverseAccountingVenue delegates to isInverseContract (bug fix)', () => {
  it('is symbol-aware: a USDC-linear perp is not inverse', () => {
    expect(isInverseAccountingVenue('deribit', 'BTC-PERPETUAL')).toBe(true);
    expect(isInverseAccountingVenue('deribit', 'SOL_USDC-PERPETUAL')).toBe(false);
    expect(isInverseAccountingVenue('bybit', 'BTCUSDT')).toBe(false);
  });
});

describe('roundToStep', () => {
  it('rounds down to the nearest step and kills float dust', () => {
    expect(roundToStep(3.77, 0.1)).toBeCloseTo(3.7, 10);
    expect(roundToStep(0.0035, 0.001)).toBe(0.003);
    expect(roundToStep(27, 10)).toBe(20);
  });
  it('is identity for a non-positive step', () => {
    expect(roundToStep(1.2345, 0)).toBe(1.2345);
  });
});

describe('usdToNativeSize', () => {
  it('linear: coin = usd / price, rounded to step', () => {
    // $500 of SOL at $150, step 0.1 => 3.333.. -> 3.3
    const r = usdToNativeSize({
      exchange: 'deribit',
      symbol: 'SOL_USDC-PERPETUAL',
      usdNotional: 500,
      price: 150,
      stepSize: 0.1,
    });
    expect(r.priceMissing).toBe(false);
    expect(r.size).toBeCloseTo(3.3, 10);
    expect(r.notionalUsd).toBe(500);
  });

  it('inverse: the native amount IS the USD notional (no price needed)', () => {
    const r = usdToNativeSize({
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      usdNotional: 250,
      stepSize: 10,
    });
    expect(r.priceMissing).toBe(false);
    expect(r.size).toBe(250);
  });

  it('linear without a price fails closed', () => {
    const r = usdToNativeSize({
      exchange: 'bybit',
      symbol: 'SOLUSDT',
      usdNotional: 100,
      stepSize: 0.1,
    });
    expect(r.priceMissing).toBe(true);
    expect(r.size).toBe(0);
  });

  it('flags a rounded size below the min', () => {
    // $5 of BTC_USDC at $60k, step/min 0.0001 => 0.00008 -> rounds to 0
    const r = usdToNativeSize({
      exchange: 'deribit',
      symbol: 'BTC_USDC-PERPETUAL',
      usdNotional: 5,
      price: 60_000,
      stepSize: 0.0001,
      minSize: 0.0001,
    });
    expect(r.size).toBe(0);
    expect(r.belowMin).toBe(true);
  });
});

describe('nativeToUsdNotional', () => {
  it('linear: size x price', () => {
    expect(
      nativeToUsdNotional({ exchange: 'bybit', symbol: 'SOLUSDT', size: 3.3, price: 150 }),
    ).toBeCloseTo(495, 10);
  });
  it('inverse: the size is already USD', () => {
    expect(
      nativeToUsdNotional({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', size: 250, price: 60_000 }),
    ).toBe(250);
  });
  it('linear without a price returns null', () => {
    expect(nativeToUsdNotional({ exchange: 'bybit', symbol: 'SOLUSDT', size: 3.3 })).toBeNull();
  });
});
