import { describe, expect, it } from 'bun:test';
import { accountDrawdownPct, drawdownLabel, resolveDrawdown } from '../drawdown';

describe('accountDrawdownPct', () => {
  it('divides by account size', () => {
    expect(accountDrawdownPct(-700, 10_000)).toBeCloseTo(-0.07, 10);
  });
  it('does not clamp, like the Terminal', () => {
    expect(accountDrawdownPct(-25_000, 10_000)).toBe(-2.5);
  });
  it('is sign-agnostic (lab import stores a positive magnitude)', () => {
    expect(accountDrawdownPct(700, 10_000)).toBeCloseTo(-0.07, 10);
  });
  it('is null without a positive account size or drawdown', () => {
    expect(accountDrawdownPct(-700, null)).toBeNull();
    expect(accountDrawdownPct(-700, 0)).toBeNull();
    expect(accountDrawdownPct(null, 10_000)).toBeNull();
  });
});

describe('resolveDrawdown', () => {
  it('uses the account basis when the size is known', () => {
    expect(resolveDrawdown({ maxDrawdownAbs: -500, maxDrawdownPeakPct: -0.9, accountSize: 10_000 })).toEqual({ pct: -0.05, basis: 'account' });
  });
  it('falls back to peak and says so', () => {
    const v = resolveDrawdown({ maxDrawdownAbs: -500, maxDrawdownPeakPct: -0.9, accountSize: null });
    expect(v).toEqual({ pct: -0.9, basis: 'peak' });
    expect(drawdownLabel(v.basis)).toBe('Max DD (peak)');
    expect(drawdownLabel('account')).toBe('Max DD (account)');
  });
});
