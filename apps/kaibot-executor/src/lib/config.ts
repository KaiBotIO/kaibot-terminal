// API Configuration
// The UI is always served by the daemon — the Tauri webview navigates to the
// daemon's `http://localhost:<port>`, and browser users hit the same origin.
// So relative URLs work everywhere (Tauri, browser, LAN IP, Vite dev proxy);
// there is no hardcoded port. An explicit override stays available for edge
// setups that host the UI off-origin.
export const API_BASE_URL = import.meta.env.VITE_EXECUTOR_BACKEND_URL || '';

export const getApiUrl = (path: string) => {
  return `${API_BASE_URL}${path}`;
};

// Canonical KaiBot origins. Prod is a SPLIT deployment: app.kaibot.io serves
// static web assets only, api.kaibot.io is the API the executor authenticates
// against. Release builds inject both via VITE_* (see the release workflows);
// these defaults keep a bare build pointing at the right prod hosts.
const DEFAULT_APP_URL = 'https://app.kaibot.io';
const DEFAULT_API_URL = 'https://api.kaibot.io';

export const KAIBOT_APP_URL = import.meta.env.VITE_KAIBOT_APP_URL || DEFAULT_APP_URL;

// API origin. Explicit VITE_KAIBOT_API_URL wins. An explicit app override
// cascades (single-host dev setups keep working with one var). A bare build
// falls back to the API host — never silently to the app host, which serves
// no API in prod.
export const KAIBOT_API_URL =
  import.meta.env.VITE_KAIBOT_API_URL ||
  (import.meta.env.VITE_KAIBOT_APP_URL ? KAIBOT_APP_URL : DEFAULT_API_URL);

// Legal pages live on the APP origin (apps/frontend router: /terms, /risk).
export const TERMS_URL = `${KAIBOT_APP_URL}/terms`;
export const RISK_URL = `${KAIBOT_APP_URL}/risk`;

// Origin of the ONLINE terminal (apps/frontend) embedded in the executor shell.
// The TV Charting Library is licence-bound and stays served from this origin —
// it is NEVER bundled into the executor dist. The shell only frames it.
// Defaults to the canonical app origin; override per environment.
export const ONLINE_TERMINAL_URL =
  import.meta.env.VITE_ONLINE_TERMINAL_URL ||
  `${KAIBOT_APP_URL.replace(/\/$/, '')}/chart`;

// Query param that asks Studio to drop its own sidebar/topbar (it is framed
// here and the Terminal already draws both). Mirrored in
// apps/frontend/src/lib/embed-mode.ts.
export const EMBED_QUERY_PARAM = 'embed';

export interface TerminalSrcParams {
  symbol?: string | null;
  exchange?: string | null;
  /** Chromeless render for the iframe; leave off for "Open in Studio". */
  embed?: boolean;
}

// Studio deep-links a market via ?symbol=EXCHANGE:SYMBOL.
export function buildTerminalSrc(
  params: TerminalSrcParams = {},
  base: string = ONLINE_TERMINAL_URL,
): string {
  const symbol = params.symbol?.trim();
  const exchange = params.exchange?.trim();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return params.embed ? `${base}${base.includes('?') ? '&' : '?'}${EMBED_QUERY_PARAM}=1` : base;
  }
  if (params.embed) url.searchParams.set(EMBED_QUERY_PARAM, '1');
  if (symbol) {
    url.searchParams.set(
      'symbol',
      symbol.includes(':') || !exchange ? symbol : `${exchange.toUpperCase()}:${symbol}`,
    );
  }
  return url.toString();
}

// Derive the bare origin (scheme://host[:port]) for postMessage targetOrigin /
// origin-allowlist. Falls back to the raw value if it is not a full URL.
export const ONLINE_TERMINAL_ORIGIN = (() => {
  try {
    return new URL(ONLINE_TERMINAL_URL).origin;
  } catch {
    return ONLINE_TERMINAL_URL;
  }
})();

// TradeStation auth mode. The backend resolves it at runtime and serves it on
// /api/config (see useTradestationAuthMode); OAuth is the default. This
// build-time var only overrides it for local dev.
export type TradestationAuthMode = 'oauth' | 'couchdb';

export const TRADESTATION_AUTH_MODE_OVERRIDE: TradestationAuthMode | null = (() => {
  const raw = String(import.meta.env.VITE_TRADESTATION_USE_OAUTH ?? '').trim().toLowerCase();
  if (raw === 'true') return 'oauth';
  if (raw === 'false') return 'couchdb';
  return null;
})();