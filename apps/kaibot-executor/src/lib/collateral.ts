// Pure helpers for the Collateral page and settings.
import type { CollateralAccountRef, CollateralCoinView, CoverageView, MarginState, VirtualCoverage } from './collateral-api';

export const MARGIN_STATE_LABEL: Record<MarginState, string> = {
  ok: 'ok',
  block: 'entries blocked',
  warn: 'warn',
  unknown: 'no data',
};

export const QUICK_DROPS = [10, 15, 20] as const;

// Tick-ish rounding so quick-fill triggers read like prices, not floats.
export function roundPrice(p: number): number {
  if (!Number.isFinite(p)) return 0;
  const decimals = p >= 1000 ? 0 : p >= 1 ? 2 : 4;
  const f = 10 ** decimals;
  return Math.round(p * f) / f;
}

export function triggerFromMark(mark: number | null, dropPct: number): number | null {
  if (mark == null || !(mark > 0)) return null;
  return roundPrice(mark * (1 - dropPct / 100));
}

export function plannedFloorUsd(holdingsCoin: number, triggerPrice: number): number {
  if (!(holdingsCoin > 0) || !(triggerPrice > 0)) return 0;
  return holdingsCoin * triggerPrice;
}

// Positive = mark above trigger.
export function distanceToTriggerPct(mark: number | null, triggerPrice: number): number | null {
  if (mark == null || !(mark > 0) || !(triggerPrice > 0)) return null;
  return ((mark - triggerPrice) / mark) * 100;
}

// Mirrors the backend guard: at/above blockMmrPct entries are refused, at/above
// warnMmrPct the account is in warn (optional auto-reduce).
export function marginStateFor(
  mmRate: number | null,
  blockMmrPct: number,
  warnMmrPct: number,
): MarginState {
  if (mmRate == null || !Number.isFinite(mmRate)) return 'unknown';
  const pct = mmRate * 100;
  if (pct >= warnMmrPct) return 'warn';
  if (pct >= blockMmrPct) return 'block';
  return 'ok';
}

export function thresholdError(blockMmrPct: number, warnMmrPct: number): string | null {
  const inRange = (n: number) => Number.isFinite(n) && n > 0 && n <= 100;
  if (!inRange(blockMmrPct) || !inRange(warnMmrPct)) return 'Thresholds must be between 0 and 100 %.';
  if (blockMmrPct >= warnMmrPct) return 'The block level must sit below the warn level.';
  return null;
}

// Negative USDT (or any borrowed coin) is debt against the collateral.
export function debtOf(c: CollateralCoinView): number {
  if (c.borrowAmount > 0) return c.borrowAmount;
  return c.walletBalance < 0 ? -c.walletBalance : 0;
}

export function defaultAccount(accounts: CollateralAccountRef[]): CollateralAccountRef | null {
  return (
    accounts.find((a) => a.exchange.toLowerCase() === 'bybit' && a.connected) ??
    accounts.find((a) => a.exchange.toLowerCase() === 'bybit') ??
    accounts[0] ??
    null
  );
}

export const accountKey = (a: { exchange: string; accountId: string }) => `${a.exchange}|${a.accountId}`;

// Clamp a percentage onto a 0..100 meter.
export const meterPos = (pct: number) => Math.min(100, Math.max(0, pct));

// Form (percent strings, blank = venue ratio) → fractions for the API. null = invalid.
export function ratioOverridesFromForm(form: Record<string, string>): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const [coin, raw] of Object.entries(form)) {
    if (raw.trim() === '') continue;
    const pct = Number(raw);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
    out[coin] = pct / 100;
  }
  return out;
}

// A coin's virtual pot value and implied floor, split over its lines by qty.
export function virtualLineShare(
  c: CollateralCoinView | undefined,
  quantity: number,
): { potUsd: number | null; floorUsd: number | null } {
  if (!c || !(c.virtualQty > 0)) return { potUsd: null, floorUsd: null };
  const f = quantity / c.virtualQty;
  return {
    potUsd: c.virtual ? c.virtual.usd * f : null,
    floorUsd: c.virtualImpliedFloorUsd != null ? c.virtualImpliedFloorUsd * f : null,
  };
}

const eu = (n: number, d = 0) => n.toLocaleString('nl-BE', { maximumFractionDigits: d });

export interface CoverageChoice {
  mode: VirtualCoverage | 'deposit';
  title: string;
  text: string;
}

// The three ways to cover off-exchange coins, with this account's numbers.
export function coverageChoices(c: CoverageView): CoverageChoice[] {
  const p = c.plan;
  const lev = p.leverage == null ? null : Number.isFinite(p.leverage) ? `${eu(p.leverage, 1)}x` : 'unlimited';
  let hedge: string;
  if (!(p.notionalUsd > 0)) hedge = 'Needs a sell floor on a coin with off-exchange quantity.';
  else {
    hedge = `Short $${eu(p.notionalUsd)} when the floors break: ${lev} leverage, liquidation ${eu(p.liqDistancePct ?? 0, 1)} % above the triggers.`;
    hedge += p.topUpToArmUsd > 0
      ? ` Deposit $${eu(p.topUpToArmUsd)} before it can arm (max 5x, liquidation at least 15 % away).`
      : p.topUp2xUsd > 0
        ? ` $${eu(p.topUp2xUsd)} more brings it to 2x.`
        : '';
  }
  return [
    { mode: 'hedge', title: 'Hedge on the perp', text: hedge },
    {
      mode: 'none',
      title: 'Count, don\'t protect',
      text: `Counts in the pot at the floor triggers ($${eu(c.virtualAtTriggerUsd)}). Below a trigger nothing protects it: $${eu(c.mode === 'none' ? c.unprotectedUsd : c.virtualAtTriggerUsd)} rides the market.`,
    },
    {
      mode: 'deposit',
      title: 'Move the coins to Bybit',
      text: `$${eu(c.depositCoinsUsd)} at today's mark. The sell floors then cover them and there is nothing to borrow. Remove the off-exchange lines afterwards.`,
    },
  ];
}
