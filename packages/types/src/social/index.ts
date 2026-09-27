export type SocialTimeframe = 'scalp' | 'swing' | 'macro';
export type SocialSentiment = 'bullish' | 'bearish' | 'neutral';
export type SocialTradeBias = 'long' | 'short' | 'flat';
export type SocialAssetClass = 'crypto' | 'tradfi';

export interface SocialSource {
  author: string;
  content: string;
  platform: 'twitter' | 'news' | 'web';
  url?: string;
  timestamp?: string;
}

export interface SocialScanResult {
  assetId: string;
  assetClass: SocialAssetClass;
  timeframe: SocialTimeframe;
  timestamp: number;
  sentiment: SocialSentiment;
  sentimentScore: number;
  tradeBias: SocialTradeBias;
  confidence: number;
  summary: string;
  sources: SocialSource[];
}

export interface SocialScanRow extends SocialScanResult {
  id: number;
  createdAt: string;
}

export interface SocialAssetConfig {
  id: string;
  name: string;
  assetClass: SocialAssetClass;
  searchTerms: string[];
  tickers: string[];
  hashtags: string[];
}

export const SOCIAL_TIMEFRAMES: readonly SocialTimeframe[] = ['scalp', 'swing', 'macro'] as const;

export const SOCIAL_TIMEFRAME_LABELS: Record<SocialTimeframe, string> = {
  scalp: 'Short Term',
  swing: 'Medium Term',
  macro: 'Long Term',
};

export const TRADITIONAL_MARKETS_ROLE = 'traditional-markets';

export type PerplexityRecency = 'hour' | 'day' | 'week' | 'month';

export interface SocialTimeframeConfig {
  name: SocialTimeframe;
  intervalMs: number;
  batchDelayMs: number;
  perplexityRecency: PerplexityRecency;
  xaiLookbackDays: number;
}

// Default seed values used by apps/api seed-social-config service.
// After seeding these become editable rows in `social_scanner_timeframes`.
export const DEFAULT_SOCIAL_TIMEFRAMES: SocialTimeframeConfig[] = [
  { name: 'scalp', intervalMs: 3 * 60_000,      batchDelayMs: 30_000, perplexityRecency: 'hour', xaiLookbackDays: 1  },
  { name: 'swing', intervalMs: 60 * 60_000,     batchDelayMs: 90_000, perplexityRecency: 'day',  xaiLookbackDays: 2  },
  { name: 'macro', intervalMs: 4 * 60 * 60_000, batchDelayMs: 90_000, perplexityRecency: 'week', xaiLookbackDays: 14 },
];

export const CRYPTO_ASSETS: SocialAssetConfig[] = [
  {
    id: 'btc',
    name: 'Bitcoin',
    assetClass: 'crypto',
    searchTerms: ['Bitcoin', 'BTC'],
    tickers: ['BTCUSDT', 'BTCUSD'],
    hashtags: ['#BTC', '#Bitcoin'],
  },
  {
    id: 'eth',
    name: 'Ethereum',
    assetClass: 'crypto',
    searchTerms: ['Ethereum', 'ETH'],
    tickers: ['ETHUSDT', 'ETHUSD'],
    hashtags: ['#ETH', '#Ethereum'],
  },
  {
    id: 'sol',
    name: 'Solana',
    assetClass: 'crypto',
    searchTerms: ['Solana', 'SOL'],
    tickers: ['SOLUSDT', 'SOLUSD'],
    hashtags: ['#SOL', '#Solana'],
  },
];

export const TRADFI_ASSETS: SocialAssetConfig[] = [
  {
    id: 'gold',
    name: 'Gold',
    assetClass: 'tradfi',
    searchTerms: ['Gold', 'XAU'],
    tickers: ['XAUUSD', 'GC=F', 'GC', 'MGC'],
    hashtags: ['#Gold', '#XAU'],
  },
  {
    id: 'silver',
    name: 'Silver',
    assetClass: 'tradfi',
    searchTerms: ['Silver', 'XAG'],
    tickers: ['XAGUSD', 'SI=F', 'SI', 'SIL'],
    hashtags: ['#Silver', '#XAG'],
  },
  {
    id: 'nasdaq',
    name: 'Nasdaq 100',
    assetClass: 'tradfi',
    searchTerms: ['Nasdaq 100', 'NDX', 'QQQ'],
    tickers: ['NQ=F', 'QQQ', 'NQ', 'MNQ'],
    hashtags: ['#Nasdaq', '#NDX', '#QQQ'],
  },
  {
    id: 'sp500',
    name: 'S&P 500',
    assetClass: 'tradfi',
    searchTerms: ['S&P 500', 'SPX', 'SPY'],
    tickers: ['ES=F', 'SPY', 'ES', 'MES'],
    hashtags: ['#SPX', '#SP500'],
  },
];

export const ALL_SOCIAL_ASSETS: SocialAssetConfig[] = [...CRYPTO_ASSETS, ...TRADFI_ASSETS];

export function getSocialAsset(id: string): SocialAssetConfig | undefined {
  return ALL_SOCIAL_ASSETS.find((a) => a.id === id);
}

// --- Coverage ---
// The sentiment layer only covers the handful of scanned markets. These helpers
// are the single source of truth for "is symbol X covered?" so badges/pages can
// decide show-vs-absent without faking sentiment for uncovered assets.

/** Asset ids the sentiment layer covers (the scanned markets). */
export const COVERED_ASSET_IDS: readonly string[] = ALL_SOCIAL_ASSETS.map((a) => a.id);

// Quote/settlement/contract suffixes stripped to reach a base symbol
// (BTCUSDT -> BTC, BTC-PERPETUAL -> BTC). Longest-first so PERPETUAL wins
// over PERP on the same symbol.
const QUOTE_SUFFIXES = ['PERPETUAL', 'USDT', 'USDC', 'BUSD', 'PERP', 'USD'] as const;

// Deribit stacks suffixes (ETH_USDC-PERPETUAL -> ETHUSDC -> ETH).
const MAX_SUFFIX_STRIPS = 3;

function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Lazily built to sidestep any module-init ordering with ALL_SOCIAL_ASSETS.
let symbolIndex: Map<string, string> | null = null;
function getSymbolIndex(): Map<string, string> {
  if (symbolIndex) return symbolIndex;
  const map = new Map<string, string>();
  for (const asset of ALL_SOCIAL_ASSETS) {
    for (const key of [asset.id, ...asset.tickers, ...asset.searchTerms]) {
      const n = normalizeSymbol(key);
      if (n && !map.has(n)) map.set(n, asset.id);
    }
  }
  symbolIndex = map;
  return map;
}

/**
 * Resolve a trading symbol or asset id to a covered sentiment asset id, handling
 * common quote suffixes (BTCUSDT / BTC-USD -> btc). Returns undefined when the
 * asset is not part of the scanned set.
 */
export function resolveCoveredAssetId(symbol: string): string | undefined {
  if (!symbol) return undefined;
  const idx = getSymbolIndex();
  let n = normalizeSymbol(symbol);
  const direct = idx.get(n);
  if (direct) return direct;
  for (let pass = 0; pass < MAX_SUFFIX_STRIPS; pass++) {
    const suffix = QUOTE_SUFFIXES.find((s) => n.length > s.length && n.endsWith(s));
    if (!suffix) return undefined;
    n = n.slice(0, -suffix.length);
    const base = idx.get(n);
    if (base) return base;
  }
  return undefined;
}

/** True if the sentiment layer covers the given symbol or asset id. */
export function isAssetCovered(symbol: string): boolean {
  return resolveCoveredAssetId(symbol) !== undefined;
}

/** The covered asset config for a symbol/id, or undefined when uncovered. */
export function getCoveredAsset(symbol: string): SocialAssetConfig | undefined {
  const id = resolveCoveredAssetId(symbol);
  return id ? getSocialAsset(id) : undefined;
}

// ── Strategy sentiment context (F2/F3) ───────────────────────────────────────
// Sentiment is a CONFLUENCE lens, never an autonomous signal (it lost money as a
// standalone oracle in the PoC). The scanner writes social_scans; the runner
// injects the latest covered-asset snapshot into a strategy's ctx.sentiment so
// the strategy can gate/confirm on it. Absent/stale → undefined, never a
// synthetic neutral (so a strategy can't mistake "no data" for "flat market").

// One timeframe's latest sentiment for an asset, as seen by a strategy.
export interface StrategySentimentSnapshot {
  score: number; // sentimentScore, -100..100
  sentiment: SocialSentiment;
  bias: SocialTradeBias;
  confidence: number; // 0..100
  timestamp: number; // scan timestamp, ms epoch
  ageMs: number; // now - timestamp at injection time
}

// The full sentiment context for the covered asset a strategy trades. Each
// timeframe is present only when a non-stale scan exists.
export interface StrategySentiment {
  assetId: string;
  scalp?: StrategySentimentSnapshot;
  swing?: StrategySentimentSnapshot;
  macro?: StrategySentimentSnapshot;
}

// Maximum age a scan may have before it is dropped from ctx.sentiment. Roughly
// one scan interval of slack per timeframe (source cadence: scalp 3m, swing 60m,
// macro 4h) so a single missed cycle still surfaces, two do not.
export const SENTIMENT_STALE_AFTER_MS: Record<SocialTimeframe, number> = {
  scalp: 15 * 60_000, // 15 min
  swing: 3 * 3_600_000, // 3 h
  macro: 12 * 3_600_000, // 12 h
};
