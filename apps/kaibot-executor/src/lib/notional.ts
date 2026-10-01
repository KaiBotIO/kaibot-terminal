import { contractMultiplier, isInverseContract, positionNotionalUsd, positionPnlUsd } from "@kaibot/types/core";
import type { Position } from "@/lib/atoms";

type NotionalInput = Pick<Position, "symbol" | "size" | "entryPrice"> & {
  markPrice?: number;
  exchange?: string;
  multiplier?: number;
  notional?: number;
};

/**
 * USD notional of an open position. The v2 positions endpoint already returns
 * it; the fallback re-derives it with the shared per-contract rule (inverse
 * contracts are USD, linear qty x price, futures qty x price x multiplier) so a
 * payload from an older backend still values 981 ETH-PERPETUAL contracts as
 * $981 and 1 MGC at 4.500 as $45.000.
 */
export function notionalOf(p: NotionalInput): number {
  if (typeof p.notional === "number" && Number.isFinite(p.notional)) {
    return Math.abs(p.notional);
  }
  const price = p.markPrice || p.entryPrice || 0;
  if (p.multiplier != null && !isInverseContract(p.exchange, p.symbol)) {
    return Math.abs((p.size || 0) * price * p.multiplier);
  }
  return positionNotionalUsd({ exchange: p.exchange, symbol: p.symbol, size: p.size, price });
}

/**
 * Unrealized P&L in USD, or null when the venue reports it in coin and no mark
 * is known to value it. Prefers the backend figure; falls back to the shared
 * rule for a payload from an older backend.
 */
export function pnlUsdOf(
  p: Pick<Position, "symbol" | "unrealizedPnL"> & {
    exchange?: string;
    markPrice?: number;
    unrealizedPnLUsd?: number | null;
  },
): number | null {
  if (typeof p.unrealizedPnLUsd === "number" && Number.isFinite(p.unrealizedPnLUsd)) {
    return p.unrealizedPnLUsd;
  }
  if (p.unrealizedPnLUsd === null) return null;
  return positionPnlUsd({
    exchange: p.exchange,
    symbol: p.symbol,
    unrealizedPnL: p.unrealizedPnL,
    markPrice: p.markPrice,
  });
}

/**
 * USD notional of an order that has no position yet (manual-trade confirm),
 * `qty` in venue-native units: USD contracts on an inverse perp, coin or
 * contracts elsewhere.
 */
export function orderNotional(input: {
  exchange: string;
  symbol: string;
  qty: number;
  price: number;
}): number {
  if (isInverseContract(input.exchange, input.symbol)) return Math.abs(input.qty);
  return Math.abs(input.qty * input.price * contractMultiplier(input.exchange, input.symbol));
}
