// Shared order-size math: the single coin<->USD discriminator plus pure
// conversion helpers, used identically by the executor (live/manual sizing)
// and the sim (backtest/forward-test), so a "$X notional" intent produces the
// same coin exposure in a backtest and in a real order.
//
// A contract is INVERSE (coin-margined) when its order `amount` is denominated
// in USD rather than base coin. This is a property of the instrument, not just
// the venue — both Deribit and Bybit list inverse AND linear contracts:
//   Deribit inverse  (BTC-PERPETUAL, ETH-PERPETUAL)   -> amount is USD
//   Deribit linear   (SOL_USDC-PERP, *_USDC)          -> amount is base coin
//   Bybit  inverse   (BTCUSD, ETHUSD — quote is USD)  -> amount is USD
//   Bybit  linear    (BTCUSDT, BTCUSDC / *USDT,*USDC) -> amount is base coin
// Every other venue we trade is linear.

import { z } from 'zod';

/** Canonical schema for the size-unit discriminator — import this instead of
 * re-declaring `z.enum(['native', 'usd'])` at each router. */
export const sizeUnitSchema = z.enum(['native', 'usd']);

/** How a caller-supplied size number is denominated. */
export type SizeUnit = z.infer<typeof sizeUnitSchema>;

/**
 * True when (exchange, symbol) is an inverse (coin-margined) contract whose
 * order amount is denominated in USD. Detection is by the venue's symbol
 * convention (the pure helper has no instrument metadata); pass the symbol
 * whenever available — omitting it treats a Deribit symbol as inverse, which is
 * wrong for USDC perps, and cannot tell a Bybit inverse from a linear one.
 */
export function isInverseContract(
  exchange: string | null | undefined,
  symbol?: string | null,
): boolean {
  const ex = (exchange ?? '').toLowerCase();
  const sym = (symbol ?? '').toUpperCase();
  if (ex === 'deribit') {
    // Deribit coin derivatives are inverse; anything stablecoin-quoted
    // (USDC linear perps, USDC/USDT spot pairs) is linear.
    return !/USDC|USDT/.test(sym);
  }
  if (ex === 'bybit') {
    // Bybit inverse contracts are USD-quoted: perps end in plain 'USD'
    // (BTCUSD), dated futures in USD + quarter code (BTCUSDH25/M25/U25/Z25).
    // Linear 'USDT'/'USDC' never match. No symbol → can't tell → linear.
    return /USD$/.test(sym) || /USD[HMUZ]\d{2}$/.test(sym);
  }
  return false;
}

/** Round a quantity DOWN to the nearest step, killing binary float dust. */
export function roundToStep(qty: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return qty;
  const steps = Math.floor(qty / step + 1e-9);
  const result = steps * step;
  return Number(result.toFixed(stepDecimals(step)));
}

function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toString();
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

export interface UsdToNativeParams {
  exchange: string;
  symbol: string;
  usdNotional: number;
  /** Required for linear contracts (coin = usd / price). Ignored for inverse. */
  price?: number;
  /** Contract step in native units. 0/undefined = no rounding. */
  stepSize?: number;
  /** Minimum order size in native units, for the belowMin flag. */
  minSize?: number;
}

export interface UsdToNativeResult {
  /** Order size in venue-native units (coin for linear, USD for inverse), rounded. */
  size: number;
  /** Linear contract needed a price and none was supplied — caller must fail closed. */
  priceMissing: boolean;
  /** Rounded size fell below minSize — caller decides reject vs bump. */
  belowMin: boolean;
  /** The USD notional this size represents. */
  notionalUsd: number;
}

/** USD notional -> venue-native order size. Inverse: amount IS the USD. Linear: usd / price. */
export function usdToNativeSize(p: UsdToNativeParams): UsdToNativeResult {
  const usd = Math.max(0, p.usdNotional);
  let raw: number;
  if (isInverseContract(p.exchange, p.symbol)) {
    raw = usd;
  } else {
    if (!p.price || p.price <= 0) {
      return { size: 0, priceMissing: true, belowMin: false, notionalUsd: 0 };
    }
    raw = usd / p.price;
  }
  const size = p.stepSize && p.stepSize > 0 ? roundToStep(raw, p.stepSize) : raw;
  const belowMin = p.minSize != null && p.minSize > 0 && size < p.minSize;
  return { size, priceMissing: false, belowMin, notionalUsd: usd };
}

/**
 * Venue-native order size -> USD notional. Inverse: the amount is already USD.
 * Linear: size x price. Returns null when a linear conversion has no price.
 */
export function nativeToUsdNotional(p: {
  exchange: string;
  symbol: string;
  size: number;
  price?: number;
}): number | null {
  if (isInverseContract(p.exchange, p.symbol)) return Math.abs(p.size);
  if (!p.price || p.price <= 0) return null;
  return Math.abs(p.size) * p.price;
}
