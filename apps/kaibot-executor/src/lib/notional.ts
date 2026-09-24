import { contractMultiplier } from "@kaibot/types/core";
import type { Position } from "@/lib/atoms";

/**
 * USD notional of an open position. The v2 positions endpoint already returns
 * it; the fallback re-derives it from the contract multiplier so a payload from
 * an older backend still values 1 MGC at 4.500 as $45.000 rather than $4.500.
 */
export function notionalOf(p: Pick<Position, "symbol" | "size" | "entryPrice"> & {
  markPrice?: number;
  exchange?: string;
  multiplier?: number;
  notional?: number;
}): number {
  if (typeof p.notional === "number" && Number.isFinite(p.notional)) {
    return Math.abs(p.notional);
  }
  const price = p.markPrice || p.entryPrice || 0;
  const mult = p.multiplier ?? contractMultiplier(p.exchange ?? "", p.symbol);
  return Math.abs((p.size || 0) * price * mult);
}

/** USD notional of an order that has no position yet (manual-trade confirm). */
export function orderNotional(input: {
  exchange: string;
  symbol: string;
  qty: number;
  price: number;
}): number {
  return Math.abs(input.qty * input.price * contractMultiplier(input.exchange, input.symbol));
}
