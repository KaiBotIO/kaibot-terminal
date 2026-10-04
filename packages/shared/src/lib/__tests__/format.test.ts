import { afterEach, describe, expect, it } from 'bun:test';
import {
  fmtDate,
  fmtDateTime,
  getDisplayTimeZone,
  parseTimestamp,
  relativeTime,
  resolvedTimeZone,
  setDisplayTimeZone,
} from '../format';

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

// Regression (live-data-review 28/08): the executor's SQLite writes signal
// timestamps as naive UTC ("2026-08-28 16:31:23"). Parsed as local they landed
// an hour early on Dashboard, Activity and the subscription modal, while the
// epoch-based Analytics page showed the same event correctly.
describe('naive SQL datetimes are read as UTC', () => {
  it('parses "YYYY-MM-DD HH:MM:SS" as UTC', () => {
    expect(parseTimestamp('2026-08-28 16:31:23').toISOString()).toBe(
      '2026-08-28T16:31:23.000Z',
    );
  });

  it('parses the T-separated zoneless form as UTC too', () => {
    expect(parseTimestamp('2026-08-28T16:31:23').toISOString()).toBe(
      '2026-08-28T16:31:23.000Z',
    );
  });

  it('leaves an explicit zone alone', () => {
    expect(parseTimestamp('2026-08-28T16:31:23Z').toISOString()).toBe(
      '2026-08-28T16:31:23.000Z',
    );
    expect(parseTimestamp('2026-08-28T18:31:23+02:00').toISOString()).toBe(
      '2026-08-28T16:31:23.000Z',
    );
  });

  it('leaves epoch millis and Date objects alone', () => {
    expect(parseTimestamp(d.getTime()).getTime()).toBe(d.getTime());
    expect(parseTimestamp(d)).toBe(d);
  });

  it('formats a naive row at its UTC wall clock', () => {
    expect(fmtDateTime('2026-08-28 16:31:23', { tz: 'utc' })).toContain('16:31');
  });

  it('does not read a naive row an hour early in relative time', () => {
    const iso = new Date(Date.now() - 76 * 60_000).toISOString();
    const naive = iso.slice(0, 19).replace('T', ' ');
    expect(relativeTime(naive)).toBe('1h');
  });
});

// Kai, 2026-09-07: timestamps rendered in a zone that was not his. Formatting
// follows the browser by default and one setting moves every page at once.
describe('display timezone', () => {
  afterEach(() => setDisplayTimeZone(null));

  it('follows the browser until a zone is set', () => {
    expect(getDisplayTimeZone()).toBeNull();
    expect(resolvedTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('renders every formatter in the chosen zone', () => {
    setDisplayTimeZone('Asia/Tokyo');
    // 15 Jan 2026 12:30 UTC is 21:30 in Tokyo, same day.
    expect(fmtDateTime(d)).toContain('21:30');
    expect(fmtDate(d)).toBe('15 Jan 2026');
    expect(resolvedTimeZone()).toBe('Asia/Tokyo');
  });

  it('rolls the date over with the zone', () => {
    setDisplayTimeZone('Pacific/Auckland');
    // 12:30 UTC on the 15th is past midnight on the 16th in Auckland.
    expect(fmtDate(new Date(Date.UTC(2026, 0, 15, 12, 30)))).toBe('16 Jan 2026');
  });

  it('still honours an explicit UTC call site', () => {
    setDisplayTimeZone('Asia/Tokyo');
    expect(fmtDateTime(d, { tz: 'utc' })).toContain('12:30');
  });

  it('refuses a zone Intl does not know', () => {
    setDisplayTimeZone('Mars/Olympus');
    expect(getDisplayTimeZone()).toBeNull();
  });

  it('goes back to the browser zone on null', () => {
    setDisplayTimeZone('Asia/Tokyo');
    setDisplayTimeZone(null);
    expect(getDisplayTimeZone()).toBeNull();
  });
});
