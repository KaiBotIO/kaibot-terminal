// Futures contract multipliers, shared by the executor backend (sizing, PnL,
// margin guards), the executor UI (notional/exposure display) and the sim.
//
// One futures contract's USD notional is price x multiplier. 1 MGC at 4.500 is
// $45.000, not $4.500. Any notional math on bare qty x price is off by 2x
// (MNQ), 5x (MES), 10x (MGC), 1000x (SIL).

/** Per-1.0-price-move USD value by futures root (micro + e-mini contracts). */
export const FUTURES_MULTIPLIERS: Record<string, number> = {
  MNQ: 2, // Micro E-mini Nasdaq-100
  MES: 5, // Micro E-mini S&P 500
  MGC: 10, // Micro Gold (10 oz)
  SIL: 1000, // Micro Silver (5000 oz, $0.001 tick handled at price level)
  NQ: 20, // E-mini Nasdaq-100
  ES: 50, // E-mini S&P 500
  GC: 100, // Gold (100 oz)
};

/** Roots the executor knows how to resolve a front month for. */
export const KNOWN_FUTURES_ROOTS = ['MES', 'MNQ', 'MGC', 'SIL', 'ES', 'NQ', 'GC'];

/**
 * True when `symbol` is a bare futures root we can resolve (no month/year
 * suffix). "MES" -> true, "MESM26" -> false, "BTC-PERPETUAL" -> false.
 */
export function isFuturesRoot(symbol: string): boolean {
  return KNOWN_FUTURES_ROOTS.includes(symbol.toUpperCase());
}

/**
 * Strip the month-letter + 2-digit-year suffix from a dated contract to get its
 * root (MESM26 -> MES). A bare root or non-future is returned unchanged.
 */
export function rootOf(symbol: string): string {
  const s = symbol.toUpperCase();
  if (isFuturesRoot(s)) return s;
  const m = s.match(/^([A-Z]+)([FGHJKMNQUVXZ])(\d{2})$/);
  return m ? m[1] : s;
}

/** Per-1.0-price-move USD multiplier for a symbol (root or dated contract). */
export function multiplierFor(symbol: string): number {
  return FUTURES_MULTIPLIERS[rootOf(symbol)] ?? 1;
}

/**
 * Contract multiplier for USD-notional math, venue-scoped. Scoped to
 * tradestation so a crypto symbol can never collide with a futures root; other
 * venues price 1.0 of the instrument directly.
 */
export function contractMultiplier(exchange: string, symbol: string): number {
  return exchange.toLowerCase() === 'tradestation' ? multiplierFor(symbol) : 1;
}

/**
 * USD notional of an open position, multiplier included. `price` is the mark
 * (falling back to entry at the call site). Returns 0 without a usable price.
 */
export function positionNotionalUsd(p: {
  exchange?: string | null;
  symbol: string;
  size: number;
  price?: number | null;
}): number {
  const price = p.price ?? 0;
  if (!price || !Number.isFinite(price)) return 0;
  return Math.abs(p.size || 0) * price * contractMultiplier(p.exchange ?? '', p.symbol);
}

/** True when `symbol` is a dated contract (MESM26) of `root` (MES). */
export function isDatedContractOf(symbol: unknown, root: string): boolean {
  if (typeof symbol !== 'string') return false;
  const s = symbol.toUpperCase();
  return /^[A-Z]+[FGHJKMNQUVXZ]\d{2}$/.test(s) && rootOf(s) === root.toUpperCase();
}

/**
 * Which dated contract an order for a futures root goes to. One rule for the
 * whole executor so the entry, its brackets and the later close agree:
 *   1. `held`   — the contract of the lineage's own open position (a close
 *                 must hit what we hold, whatever today's front is);
 *   2. `hint`   — the contract the engine's roll schedule was on when it
 *                 produced the signal (`metadata.contract`): the bars that
 *                 fired the signal came from exactly that contract, and the
 *                 schedule confirms a crossover a couple of sessions later
 *                 than live quote volume does, so the two disagree in that
 *                 window;
 *   3. `resolved` — the executor's own quote-volume pick (no hint on the wire:
 *                 older engine, manual or TradingView signals).
 * A candidate that is not a dated contract of `root` is ignored, never trusted.
 */
export function pickOrderContract(input: {
  root: string;
  held?: string | null;
  hint?: string | null;
  resolved?: string | null;
}): { symbol: string; source: 'held' | 'hint' | 'resolved' | 'root' } {
  const root = input.root.toUpperCase();
  for (const [source, candidate] of [
    ['held', input.held],
    ['hint', input.hint],
    ['resolved', input.resolved],
  ] as const) {
    if (typeof candidate === 'string' && isDatedContractOf(candidate, root)) {
      return { symbol: candidate.toUpperCase(), source };
    }
  }
  return { symbol: root, source: 'root' };
}
