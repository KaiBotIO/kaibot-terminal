// Max drawdown shown as a fraction of the account size, same definition as the
// Terminal's Analytics (maxDrawdownAbs / account equity). Peak-relative stays
// available for runs without a known account size.

export type DrawdownBasis = 'account' | 'peak';

export interface DrawdownView {
  /** <= 0, null when nothing is known */
  pct: number | null;
  basis: DrawdownBasis;
}

/** maxDrawdownAbs (account currency, either sign) over account size, no clamp, like the Terminal. Null without a positive account size. */
export function accountDrawdownPct(maxDrawdownAbs: number | null | undefined, accountSize: number | null | undefined): number | null {
  if (maxDrawdownAbs == null || !Number.isFinite(maxDrawdownAbs)) return null;
  if (accountSize == null || !(accountSize > 0)) return null;
  // sign-agnostic: backtester stores it negative, lab import a positive magnitude
  return -Math.abs(maxDrawdownAbs) / accountSize;
}

export function resolveDrawdown(input: {
  maxDrawdownAbs?: number | null;
  maxDrawdownPeakPct?: number | null;
  accountSize?: number | null;
}): DrawdownView {
  const account = accountDrawdownPct(input.maxDrawdownAbs, input.accountSize);
  if (account != null) return { pct: account, basis: 'account' };
  return { pct: input.maxDrawdownPeakPct ?? null, basis: 'peak' };
}

export function drawdownLabel(basis: DrawdownBasis): string {
  return basis === 'account' ? 'Max DD (account)' : 'Max DD (peak)';
}
