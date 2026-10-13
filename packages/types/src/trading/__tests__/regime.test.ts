import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REGIME_SOURCES,
  currentRegime,
  nextWeekBoundary,
  regimeMarketFor,
  regimeMultiplier,
  resolveRegimes,
  weeklyRegime,
  type RegimeDailyBar,
  type RegimeSourceMarket,
} from '../regime';

// Weekly closes + C1ph per week from docs/sweep/bull/b1/labels.json. One synthetic 1D bar per week (its Sunday)
// carries the weekly close: C1 and the phase only read weekly closes, so this reproduces b1 exactly.
const fx = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/b1-weekly.json'), 'utf8')) as {
  markets: Record<RegimeSourceMarket, { start: string; closes: number[]; ph: string; now: { wk: string } }>;
};
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const PH: Record<string, string> = { not_bull: 'n', early_bull: 'e', late_bull: 'l', unknown: '-' };

function dailyFor(key: RegimeSourceMarket): RegimeDailyBar[] {
  const t0 = Date.parse(`${fx.markets[key].start}T00:00:00Z`);
  return fx.markets[key].closes.map((c, i) => ({ t: t0 + i * WEEK + 6 * DAY, c }));
}
// Tuesday after the last fixture week closed.
const nowFor = (key: RegimeSourceMarket) => Date.parse(`${fx.markets[key].now.wk}T00:00:00Z`) + WEEK + DAY;
const weeksFor = (key: RegimeSourceMarket) => {
  const src = REGIME_SOURCES[key];
  return weeklyRegime(dailyFor(key), { nowMs: nowFor(key), seedAth: src.seedAth, exchange: src.exchange });
};
const labelAt = (key: RegimeSourceMarket, wk: string) => weeksFor(key).find((w) => w.wk === wk)?.label;

describe('weeklyRegime reproduces b1 labels.json', () => {
  for (const key of Object.keys(fx.markets) as RegimeSourceMarket[]) {
    it(`${key}: every week's C1 phase matches`, () => {
      const got = weeksFor(key).map((w) => PH[w.label]).join('');
      expect(got).toBe(fx.markets[key].ph);
    });
  }

  it('dated labels from B1/B3', () => {
    expect(labelAt('MNQ', '2026-09-28')).toBe('late_bull');
    expect(labelAt('MNQ', '2026-04-06')).toBe('early_bull');
    expect(labelAt('MNQ', '2026-04-13')).toBe('late_bull');
    expect(labelAt('MGC', '2026-05-18')).toBe('late_bull');
    expect(labelAt('MGC', '2026-05-25')).toBe('not_bull');
    expect(labelAt('MGC', '2026-08-17')).toBe('early_bull'); // one-week blip
    expect(labelAt('MGC', '2026-09-28')).toBe('not_bull');
    expect(labelAt('BTC', '2026-10-05')).toBe('not_bull');
    expect(labelAt('ETH', '2026-10-05')).toBe('not_bull');
    expect(labelAt('MES', '2020-02-24')).toBe('unknown'); // < 44 weeks of own data
  });
});

describe('currentRegime', () => {
  it('MNQ: late bull, spell since 06/04, phase since 13/04', () => {
    const s = currentRegime(weeksFor('MNQ'));
    expect(s).toMatchObject({ label: 'late_bull', since: '2026-04-06', phaseSince: '2026-04-13', weekClosed: '2026-09-28' });
    expect(s.close).toBe(31317.75);
    expect(s.sma40).toBeCloseTo(28286.84, 1);
    expect(s.sma40_4ago).toBeCloseTo(27875.29, 1);
  });

  it('MGC: not bull since the week after the 17/08 blip', () => {
    expect(currentRegime(weeksFor('MGC'))).toMatchObject({ label: 'not_bull', since: '2026-08-24' });
  });

  it('BTC: not bull since 10/11/2025', () => {
    expect(currentRegime(weeksFor('BTC'))).toMatchObject({ label: 'not_bull', since: '2025-11-10', weekClosed: '2026-10-05' });
  });

  it('empty series is unknown', () => {
    expect(currentRegime([]).label).toBe('unknown');
  });
});

describe('closed weeks only', () => {
  const btc = dailyFor('BTC');
  const lastWeekT = Date.parse(`${fx.markets.BTC.now.wk}T00:00:00Z`);
  const src = REGIME_SOURCES.BTC;
  const run = (bars: RegimeDailyBar[], nowMs: number) => weeklyRegime(bars, { nowMs, seedAth: src.seedAth });

  it('the forming week is left out until its close plus one hour', () => {
    const forming = [...btc, { t: lastWeekT + WEEK + 2 * DAY, c: 1 }];
    expect(run(forming, lastWeekT + WEEK + 3 * DAY).at(-1)!.wk).toBe(fx.markets.BTC.now.wk);
    expect(run(btc, lastWeekT + WEEK + 30 * 60_000).at(-1)!.wk).not.toBe(fx.markets.BTC.now.wk);
  });

  it('a crypto week without its Sunday bar is not closed yet', () => {
    const noSunday = btc.slice(0, -1).concat({ t: lastWeekT + 5 * DAY, c: btc.at(-1)!.c });
    expect(run(noSunday, lastWeekT + WEEK + 2 * 3_600_000).at(-1)!.wk).not.toBe(fx.markets.BTC.now.wk);
  });

  it('a TradeStation week closes on the Monday session bar (stamped Sunday ~21:00 UTC), not on Friday', () => {
    // Adapter stamps 1D bars one day back: Tue..Fri sessions on Mon..Thu 21:00, the Monday session on Sunday 21:00.
    const t0 = Date.parse(`${fx.markets.MGC.start}T00:00:00Z`);
    const H21 = 21 * 3_600_000;
    const closes = fx.markets.MGC.closes;
    const upToFriday = closes.flatMap((c, i) => [0, 1, 2, 3].map((d) => ({ t: t0 + i * WEEK + d * DAY + H21, c })));
    const lastEnd = t0 + closes.length * WEEK;
    const opts = { seedAth: undefined, exchange: 'tradestation' as const };
    const monNoon = lastEnd + 12 * 3_600_000;
    expect(weeklyRegime(upToFriday, { ...opts, nowMs: monNoon }).at(-1)!.wk).not.toBe(fx.markets.MGC.now.wk);
    const withMonday = [...upToFriday, { t: lastEnd - DAY + H21, c: closes.at(-1)! }];
    expect(weeklyRegime(withMonday, { ...opts, nowMs: lastEnd + 22 * 3_600_000 }).at(-1)!.wk).toBe(fx.markets.MGC.now.wk);
  });

  it('drops TradeStation candles before 2010-09-30', () => {
    const early = [{ t: Date.parse('2010-09-20T00:00:00Z'), c: 99_999 }, ...dailyFor('MGC')];
    const w = weeklyRegime(early, { nowMs: nowFor('MGC'), exchange: 'tradestation' });
    expect(w[0]!.wk).toBe('2010-09-27');
  });
});

describe('resolveRegimes', () => {
  const series = Object.fromEntries((Object.keys(fx.markets) as RegimeSourceMarket[]).map((k) => [k, dailyFor(k)]));
  const now = Date.parse('2026-10-13T00:00:00Z');
  const snap = resolveRegimes(series, now);

  it('labels per group, ALTS reads BTC', () => {
    expect(snap.MNQ.label).toBe('late_bull');
    expect(snap.MES.label).toBe('late_bull');
    expect(snap.SPX.label).toBe('late_bull');
    expect(snap.MGC.label).toBe('not_bull');
    expect(snap.BTC.label).toBe('not_bull');
    expect(snap.ALTS).toMatchObject({ label: 'not_bull', since: snap.BTC.since, source: 'BTC' });
  });

  it('MES/MNQ before 03/2020 fall back to SPX', () => {
    const cut = Date.parse('2020-01-20T00:00:00Z');
    const early = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, v.filter((b) => b.t < cut)]));
    const s = resolveRegimes(early, cut + DAY);
    expect(s.MNQ.source).toBe('SPX');
    expect(s.MNQ.label).toBe(s.SPX.label);
    expect(s.MNQ.label).not.toBe('unknown');
  });

  it('missing series is unknown', () => {
    expect(resolveRegimes({}, now).MGC.label).toBe('unknown');
  });
});

describe('regimeMarketFor', () => {
  it.each([
    ['tradestation', 'MNQZ26', 'MNQ'],
    ['tradestation', 'MNQ', 'MNQ'],
    ['tradestation', '@MES', 'MES'],
    ['tradestation', 'MGCZ26', 'MGC'],
    ['tradestation', 'NQZ26', 'MNQ'],
    ['tradestation', '$SPX.X', 'SPX'],
    ['tradestation', 'SILZ26', null],
    ['deribit', 'BTC-PERPETUAL', 'BTC'],
    ['deribit', 'ETH', 'ETH'],
    ['deribit', 'SOL_USDC-PERPETUAL', 'ALTS'],
    ['bybit', 'BTCUSDT', 'BTC'],
    ['bybit', 'ETHUSDT', 'ETH'],
    ['bybit', 'ETHUSD', 'ETH'],
    ['bybit', 'SUIUSDT', 'ALTS'],
    ['paper', 'MNQZ26', 'MNQ'],
    ['paper', 'MGC', 'MGC'],
    ['paper', 'BTC-PERPETUAL', 'BTC'],
    ['paper', 'SUIUSDT', null],
    ['kraken', 'XBT', null],
  ] as const)('%s %s -> %s', (ex, sym, want) => {
    expect(regimeMarketFor(ex, sym)).toBe(want);
  });
});

describe('regimeMultiplier', () => {
  it('factor per label, 1 when absent or unknown', () => {
    const f = { notBull: 0.5, lateBull: 1.5 };
    expect(regimeMultiplier(f, 'late_bull')).toBe(1.5);
    expect(regimeMultiplier(f, 'not_bull')).toBe(0.5);
    expect(regimeMultiplier(f, 'early_bull')).toBe(1);
    expect(regimeMultiplier(f, 'unknown')).toBe(1);
    expect(regimeMultiplier(null, 'late_bull')).toBe(1);
    expect(regimeMultiplier(f, null)).toBe(1);
    expect(regimeMultiplier({ notBull: 0 }, 'not_bull')).toBe(0);
  });
});

it('nextWeekBoundary is the next Monday 00:00 UTC', () => {
  expect(new Date(nextWeekBoundary(Date.parse('2026-10-12T13:00:00Z'))).toISOString()).toBe('2026-10-19T00:00:00.000Z');
  expect(new Date(nextWeekBoundary(Date.parse('2026-10-19T00:00:00Z'))).toISOString()).toBe('2026-10-26T00:00:00.000Z');
});
