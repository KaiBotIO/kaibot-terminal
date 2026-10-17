// C1 weekly regime per market group (lab line B, docs/sweep/bull/REPORT-B1-regime.md). One source for the
// API (label computation) and the Terminal (size multiplier per label). Same rule as
// scripts/stratlab/bull/b1-regime.ts: weeks open Monday 00:00 UTC, only CLOSED weeks count, the label of
// week w is known at its close and applies to week w+1.
//   bull       = weekly close > SMA40(weekly closes) AND SMA40 > SMA40 four weeks earlier (needs 44 weeks)
//   early bull = bull without a new closing ATH in the current bull spell; late bull = with one

import { rootOf } from './futures-multipliers.js';

export const REGIME_LABELS = ['not_bull', 'early_bull', 'late_bull', 'unknown'] as const;
export type RegimeLabel = (typeof REGIME_LABELS)[number];

export const REGIME_MARKETS = ['SPX', 'MES', 'MNQ', 'MGC', 'BTC', 'ETH', 'ALTS'] as const;
export type RegimeMarket = (typeof REGIME_MARKETS)[number];
export type RegimeSourceMarket = Exclude<RegimeMarket, 'ALTS'>;

export interface RegimeSource {
  exchange: string;
  symbol: string;
  /** Known closing ATH before the data starts (phase rule only). */
  seedAth?: number;
  /** Weeks without an own label read this market (MES/MNQ before 03/2020). */
  fallback?: RegimeSourceMarket;
}

export const REGIME_SOURCES: Record<RegimeSourceMarket, RegimeSource> = {
  SPX: { exchange: 'tradestation', symbol: '$SPX.X', seedAth: 1565.15 },
  MES: { exchange: 'tradestation', symbol: 'MES', fallback: 'SPX' },
  MNQ: { exchange: 'tradestation', symbol: 'MNQ', fallback: 'SPX' },
  MGC: { exchange: 'tradestation', symbol: 'MGC' },
  BTC: { exchange: 'index', symbol: 'BTC', seedAth: 19497 },
  ETH: { exchange: 'index', symbol: 'ETH', seedAth: 1396 },
};

/** Alts (Bybit universe) read the BTC label. */
export const REGIME_ALIASES: Record<'ALTS', RegimeSourceMarket> = { ALTS: 'BTC' };

/** TradeStation candles before this date are unusable. */
export const TRADESTATION_MIN_CANDLE_MS = Date.parse('2010-09-30T00:00:00Z');

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const ANCHOR = Date.parse('1970-01-05T00:00:00Z'); // a Monday
/** Ingest settle time after Monday 00:00 before a week counts as closed. */
export const REGIME_CLOSE_GRACE_MS = 60 * 60 * 1000;

export interface RegimeDailyBar {
  /** Bar open, ms UTC. */
  t: number;
  c: number;
}

export interface RegimeWeek {
  /** Monday of the week, YYYY-MM-DD. */
  wk: string;
  t: number;
  close: number;
  sma40: number | null;
  sma40_4ago: number | null;
  bull: boolean | null;
  label: RegimeLabel;
}

export interface RegimeState {
  label: RegimeLabel;
  /** Monday of the first week of the current bull / not-bull spell. */
  since: string | null;
  /** Monday of the first week with the current label (early -> late moves it, since stays). */
  phaseSince: string | null;
  /** Monday of the last closed week the label comes from. */
  weekClosed: string | null;
  close: number | null;
  sma40: number | null;
  sma40_4ago: number | null;
  /** Set when the label is read from another market (ALTS -> BTC, MES/MNQ fallback -> SPX). */
  source?: RegimeSourceMarket;
}

export type RegimeSnapshot = Record<RegimeMarket, RegimeState>;

/** GET /api/regime. Externals get the crypto groups only. */
export interface RegimeApiResponse {
  computedAt: string;
  markets: Partial<RegimeSnapshot>;
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const weekStart = (t: number) => ANCHOR + Math.floor((t - ANCHOR) / WEEK) * WEEK;

/** Next Monday 00:00 UTC strictly after `nowMs`. */
export function nextWeekBoundary(nowMs: number): number {
  return weekStart(nowMs) + WEEK;
}

function sma(xs: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i]!;
    if (i >= n) sum -= xs[i - n]!;
    out.push(i + 1 < n ? null : sum / n);
  }
  return out;
}

export interface WeeklyRegimeOptions {
  nowMs: number;
  seedAth?: number;
  exchange?: string;
}

/**
 * 1D bars -> closed weekly C1 labels with phase. A week counts once its Monday close plus the ingest grace has
 * passed AND a bar reaches its close (b1 rule). TS 1D bars are stamped one day back (Monday session on Sunday
 * ~21:00 UTC), so a TS week closes when the Monday session bar lands, Monday evening UTC.
 */
export function weeklyRegime(daily: RegimeDailyBar[], opts: WeeklyRegimeOptions): RegimeWeek[] {
  const minT = opts.exchange === 'tradestation' ? TRADESTATION_MIN_CANDLE_MS : -Infinity;
  const bars = daily.filter((b) => b.t >= minT && Number.isFinite(b.c)).sort((a, b) => a.t - b.t);
  if (bars.length === 0) return [];
  const lastT = bars[bars.length - 1]!.t;
  const buckets: { t: number; close: number }[] = [];
  for (const b of bars) {
    const k = weekStart(b.t);
    const cur = buckets[buckets.length - 1];
    if (cur && cur.t === k) cur.close = b.c;
    else buckets.push({ t: k, close: b.c });
  }
  const closed = buckets.filter((w) => w.t + WEEK + REGIME_CLOSE_GRACE_MS <= opts.nowMs && lastT + DAY >= w.t + WEEK);
  const closes = closed.map((w) => w.close);
  const s40 = sma(closes, 40);
  let ath = opts.seedAth ?? 0;
  let inSpell = false;
  let newAth = false;
  return closed.map((w, i) => {
    const isAth = w.close > ath;
    ath = Math.max(ath, w.close);
    const s = s40[i] ?? null;
    const s4 = i >= 4 ? (s40[i - 4] ?? null) : null;
    const bull = s != null && s4 != null && i >= 44 ? w.close > s && s > s4 : null;
    let label: RegimeLabel;
    if (bull === null) label = 'unknown';
    else if (!bull) {
      inSpell = false;
      newAth = false;
      label = 'not_bull';
    } else {
      if (!inSpell) {
        inSpell = true;
        newAth = false;
      }
      if (isAth) newAth = true;
      label = newAth ? 'late_bull' : 'early_bull';
    }
    return { wk: ymd(w.t), t: w.t, close: w.close, sma40: s, sma40_4ago: s4, bull, label };
  });
}

/** Fill weeks without an own label from the fallback series (same Monday). */
export function withFallback(own: RegimeWeek[], fallback: RegimeWeek[]): (RegimeWeek & { fromFallback: boolean })[] {
  const byT = new Map(fallback.map((w) => [w.t, w]));
  return own.map((w) => {
    if (w.label !== 'unknown') return { ...w, fromFallback: false };
    const f = byT.get(w.t);
    return f && f.label !== 'unknown' ? { ...w, bull: f.bull, label: f.label, fromFallback: true } : { ...w, fromFallback: false };
  });
}

/** Label of the last closed week plus when its spell and phase started. */
export function currentRegime(weeks: (RegimeWeek & { fromFallback?: boolean })[]): RegimeState {
  const last = weeks[weeks.length - 1];
  if (!last) return { label: 'unknown', since: null, phaseSince: null, weekClosed: null, close: null, sma40: null, sma40_4ago: null };
  const isBull = (l: RegimeLabel) => l === 'early_bull' || l === 'late_bull';
  let i = weeks.length - 1;
  while (i > 0 && weeks[i - 1]!.label === last.label) i--;
  let j = weeks.length - 1;
  if (last.label !== 'unknown') while (j > 0 && weeks[j - 1]!.label !== 'unknown' && isBull(weeks[j - 1]!.label) === isBull(last.label)) j--;
  else j = i;
  return {
    label: last.label,
    since: weeks[j]!.wk,
    phaseSince: weeks[i]!.wk,
    weekClosed: last.wk,
    close: last.close,
    sma40: last.sma40,
    sma40_4ago: last.sma40_4ago,
  };
}

/** Per-market current state from each source's 1D bars. Missing series -> unknown. */
export function resolveRegimes(
  series: Partial<Record<RegimeSourceMarket, RegimeDailyBar[]>>,
  nowMs: number,
): RegimeSnapshot {
  const weeks = {} as Record<RegimeSourceMarket, RegimeWeek[]>;
  for (const key of Object.keys(REGIME_SOURCES) as RegimeSourceMarket[]) {
    const src = REGIME_SOURCES[key];
    weeks[key] = weeklyRegime(series[key] ?? [], { nowMs, seedAth: src.seedAth, exchange: src.exchange });
  }
  const out = {} as RegimeSnapshot;
  for (const key of Object.keys(REGIME_SOURCES) as RegimeSourceMarket[]) {
    const fb = REGIME_SOURCES[key].fallback;
    const merged = fb ? withFallback(weeks[key], weeks[fb]) : weeks[key];
    let state = currentRegime(merged);
    // No own series at all: read the fallback market entirely.
    if (fb && merged.length === 0) state = { ...currentRegime(weeks[fb]), source: fb };
    else if (fb && (merged[merged.length - 1] as { fromFallback?: boolean } | undefined)?.fromFallback) state = { ...state, source: fb };
    out[key] = state;
  }
  for (const [alias, src] of Object.entries(REGIME_ALIASES) as ['ALTS', RegimeSourceMarket][]) {
    out[alias] = { ...out[src], source: src };
  }
  return out;
}

const TS_ROOT_MARKET: Record<string, RegimeMarket> = {
  MNQ: 'MNQ',
  NQ: 'MNQ',
  MES: 'MES',
  ES: 'MES',
  MGC: 'MGC',
  GC: 'MGC',
  SPX: 'SPX',
};

/**
 * Default regime group for an execution venue + symbol (canonical or venue-native):
 * TradeStation by futures root; crypto venues BTC/ETH by base coin, other coins ALTS; paper by futures root, then
 * BTC/ETH. null = no regime.
 */
export function regimeMarketFor(exchange: string | null | undefined, symbol: string | null | undefined): RegimeMarket | null {
  const ex = (exchange ?? '').toLowerCase();
  const sym = (symbol ?? '').toUpperCase().replace(/^@/, '');
  if (!sym) return null;
  const tsRoot = TS_ROOT_MARKET[rootOf(sym.replace(/^\$/, '').replace(/\.X$/, ''))] ?? null;
  const base = sym.split(/[-_/]/)[0]!.replace(/(USDT|USDC|USD|PERP)$/, '');
  const coin: RegimeMarket | null = base === 'BTC' ? 'BTC' : base === 'ETH' ? 'ETH' : null;
  if (ex === 'tradestation') return tsRoot;
  if (ex === 'paper') return tsRoot ?? coin;
  if (ex === 'deribit' || ex === 'bybit' || ex === 'index' || ex === 'binance') return coin ?? 'ALTS';
  return null;
}

export function isRegimeMarket(v: unknown): v is RegimeMarket {
  return typeof v === 'string' && (REGIME_MARKETS as readonly string[]).includes(v);
}

export interface RegimeFactors {
  notBull?: number;
  earlyBull?: number;
  lateBull?: number;
}

export const REGIME_FACTOR_KEYS = ['notBull', 'earlyBull', 'lateBull'] as const;

const LABEL_KEY: Record<RegimeLabel, keyof RegimeFactors | null> = {
  not_bull: 'notBull',
  early_bull: 'earlyBull',
  late_bull: 'lateBull',
  unknown: null,
};

/** Size multiplier for a label; absent factor or unknown label = 1. */
export function regimeMultiplier(factors: RegimeFactors | null | undefined, label: RegimeLabel | null | undefined): number {
  const key = label ? LABEL_KEY[label] : null;
  const v = key && factors ? factors[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 1;
}

export const REGIME_LABEL_TEXT: Record<RegimeLabel, string> = {
  not_bull: 'not bull',
  early_bull: 'early bull',
  late_bull: 'late bull',
  unknown: 'unknown',
};
