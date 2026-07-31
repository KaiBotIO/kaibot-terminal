import { describe, expect, it } from 'bun:test';
import { fmtDate, fmtDateTime, relativeTime } from '../format';

const d = new Date(Date.UTC(2026, 0, 15, 12, 30));

describe('fmtDateTime', () => {
  it('formats UTC with an explicit tz label', () => {
    const out = fmtDateTime(d, { tz: 'utc' });
    expect(out).toContain('15 Jan 2026');
    expect(out).toContain('12:30');
    expect(out).toContain('UTC');
  });

  it('always carries a timezone label in local mode', () => {
    // en-GB short tz names: "UTC", "GMT", "GMT+2", "CET", ...
    expect(fmtDateTime(d)).toMatch(/(UTC|GMT|[A-Z]{2,5})([+-]\d{1,2}(:\d{2})?)?$/);
  });

  it('accepts epoch millis', () => {
    expect(fmtDateTime(d.getTime(), { tz: 'utc' })).toContain('15 Jan 2026');
  });

  // Regression: the marketplace track-record table bound to ClosedTrade rows
  // (no `ts` field), so it called fmtDateTime(undefined) → Invalid Date. Intl
  // .format throws RangeError on that, crashing the whole marketplace detail
  // page. A bad/missing date must degrade to a placeholder, never throw.
  it('returns a placeholder instead of throwing on invalid input', () => {
    expect(() => fmtDateTime(undefined as unknown as Date)).not.toThrow();
    expect(fmtDateTime(undefined as unknown as Date)).toBe('—');
    expect(fmtDateTime(new Date('nope'))).toBe('—');
    expect(fmtDateTime(NaN)).toBe('—');
  });
});

describe('fmtDate', () => {
  it('formats the date only', () => {
    const out = fmtDate(d, { tz: 'utc' });
    expect(out).toBe('15 Jan 2026');
  });

  it('returns a placeholder instead of throwing on invalid input', () => {
    expect(() => fmtDate(undefined as unknown as Date)).not.toThrow();
    expect(fmtDate(new Date('nope'))).toBe('—');
  });
});

describe('relativeTime', () => {
  it('returns "just now" under a minute', () => {
    expect(relativeTime(new Date(Date.now() - 10_000))).toBe('just now');
  });

  it('returns minutes under an hour', () => {
    expect(relativeTime(new Date(Date.now() - 5 * 60_000))).toBe('5m');
  });

  it('returns hours under a day', () => {
    expect(relativeTime(new Date(Date.now() - 3 * 3_600_000))).toBe('3h');
  });

  it('returns days beyond that', () => {
    expect(relativeTime(new Date(Date.now() - 2 * 86_400_000))).toBe('2d');
  });
});
