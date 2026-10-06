// Aggregations behind the Exchanges page. Pure so the numbers on the strip can
// be tested without a broker.

/** Currencies already worth about a dollar; no conversion, no second figure. */
const USD_LIKE = new Set(["USD", "USDC", "USDT", "USDD", "DAI"]);

export function isUsdLike(currency: string | null | undefined): boolean {
  return USD_LIKE.has((currency ?? "").toUpperCase());
}

export interface BalanceRow {
  accountId: string;
  currency?: string | null;
  balance: number;
  equity: number;
  initialMargin?: number | null;
  maintenanceMargin?: number | null;
  /** USD value from the backend; null when the coin had no usable mark. */
  usdEquity?: number | null;
  usdBalance?: number | null;
  usdRate?: number | null;
}

export interface UsdTotals {
  equity: number;
  balance: number;
  /** False when at least one wallet could not be valued, so the total is a floor. */
  complete: boolean;
}

/**
 * Account value in USD. A coin wallet counts at its venue mark; a wallet the
 * backend could not price is left out and flips `complete`, so the strip can
 * say the total is short rather than quietly under-reporting.
 */
export function usdTotals(rows: BalanceRow[]): UsdTotals {
  let equity = 0;
  let balance = 0;
  let complete = true;
  for (const r of rows) {
    if (typeof r.usdEquity === "number" && Number.isFinite(r.usdEquity)) equity += r.usdEquity;
    else if (r.equity !== 0) complete = false;
    if (typeof r.usdBalance === "number" && Number.isFinite(r.usdBalance)) balance += r.usdBalance;
    else if (r.balance !== 0) complete = false;
  }
  return { equity, balance, complete };
}

export function isOpenPosition(p: { size?: number | null }): boolean {
  return typeof p.size === "number" && Number.isFinite(p.size) && Math.abs(p.size) > 0;
}

export function countOpenPositions(rows: Array<{ size?: number | null }>): number {
  return rows.filter(isOpenPosition).length;
}

// ── Margin health ───────────────────────────────────────────────────────────
//
// Mirrors the breathing-room guard (services/margin-guard.ts): free margin is
// equity minus initial margin, and the floor it must clear is bufferMult times
// the maintenance margin. Reporting the same two numbers the guard uses beats
// an unexplained "Check margin".

export type MarginState = "healthy" | "tight" | "unknown";

export interface AccountMargin {
  accountId: string;
  currency: string;
  state: MarginState;
  /** equity - initialMargin, in the wallet's own currency. */
  free: number | null;
  /** bufferMult x maintenance margin: what `free` has to clear. */
  floor: number | null;
  used: number | null;
  equity: number;
}

/** A venue that reports no margin at all (weekend, cash account) tells us nothing. */
function hasMarginData(r: BalanceRow): boolean {
  return typeof r.initialMargin === "number" && typeof r.maintenanceMargin === "number";
}

export function accountMargin(r: BalanceRow, bufferMult = 1): AccountMargin {
  const base = {
    accountId: r.accountId,
    currency: (r.currency ?? "USD").toUpperCase(),
    equity: r.equity,
  };
  if (!hasMarginData(r)) {
    return { ...base, state: "unknown", free: null, floor: null, used: null };
  }
  const used = r.initialMargin ?? 0;
  const free = r.equity - used;
  const floor = bufferMult * Math.max(0, r.maintenanceMargin ?? 0);
  return { ...base, state: free >= floor ? "healthy" : "tight", free, floor, used };
}

/**
 * One state for a whole venue or the whole portfolio. Tight beats unknown beats
 * healthy: a single account under its floor is the headline, and "unknown" must
 * never read as "all healthy".
 */
export function worstMarginState(states: MarginState[]): MarginState {
  if (states.some((s) => s === "tight")) return "tight";
  if (states.some((s) => s === "unknown")) return "unknown";
  return "healthy";
}

export const MARGIN_LABEL: Record<MarginState, string> = {
  healthy: "All healthy",
  tight: "Below floor",
  unknown: "No margin data",
};
