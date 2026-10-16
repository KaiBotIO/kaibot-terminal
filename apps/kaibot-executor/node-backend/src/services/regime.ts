import {
  REGIME_FACTOR_KEYS,
  REGIME_LABELS,
  isRegimeMarket,
  regimeMarketFor,
  regimeMultiplier,
  type RegimeApiResponse,
  type RegimeFactors,
  type RegimeLabel,
  type RegimeMarket,
  type RegimeState,
} from '@kaibot/types/core'
import type { KaiBotDatabase } from '../storage/database.js'

// Weekly C1 regime label from the KaiBot API (GET /api/regime) -> per-subscription size multiplier.
// The last good answer lives in SQLite: an API outage keeps the last label instead of falling back to x1.

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
// A group whose last closed week CLOSED more than 14 days ago has a stuck candle feed.
const STALE_MS = 14 * DAY

/** Groups whose `weekClosed` week closed more than 14 days before `nowMs`. */
export function staleRegimeMarkets(body: RegimeApiResponse, nowMs: number): string[] {
  return Object.entries(body.markets)
    .filter(([, s]) => s?.weekClosed && nowMs - (Date.parse(`${s.weekClosed}T00:00:00Z`) + WEEK) > STALE_MS)
    .map(([k]) => k)
}

export function parseRegimeFactors(json: string | null | undefined): RegimeFactors | null {
  if (!json) return null
  try {
    const raw = JSON.parse(json) as Record<string, unknown>
    const out: RegimeFactors = {}
    for (const k of REGIME_FACTOR_KEYS) {
      const v = raw?.[k]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

export interface SubRegime {
  market: RegimeMarket | null
  label: RegimeLabel
  since: string | null
  phaseSince: string | null
  weekClosed: string | null
  factors: RegimeFactors | null
  multiplier: number
}

type SubRegimeRow = {
  regime_factors?: string | null
  regime_market?: string | null
  exchange?: string | null
  selected_markets?: string | null
}

/** Regime group, label and multiplier for a sub; `symbol` defaults to its first selected market. */
export function subRegime(sub: SubRegimeRow, snapshot: RegimeApiResponse | null, symbol?: string | null): SubRegime {
  let sym = symbol ?? null
  if (!sym && sub.selected_markets) {
    try {
      sym = (JSON.parse(sub.selected_markets) as string[])[0] ?? null
    } catch {
      /* malformed */
    }
  }
  const market = isRegimeMarket(sub.regime_market) ? sub.regime_market : regimeMarketFor(sub.exchange, sym)
  const state: RegimeState | undefined = market ? snapshot?.markets?.[market] : undefined
  const label: RegimeLabel = state && (REGIME_LABELS as readonly string[]).includes(state.label) ? state.label : 'unknown'
  const factors = parseRegimeFactors(sub.regime_factors)
  return {
    market,
    label,
    since: state?.since ?? null,
    phaseSince: state?.phaseSince ?? null,
    weekClosed: state?.weekClosed ?? null,
    factors,
    multiplier: regimeMultiplier(factors, label),
  }
}

function isRegimeBody(v: unknown): v is RegimeApiResponse {
  if (!v || typeof v !== 'object') return false
  const markets = (v as { markets?: unknown }).markets
  if (!markets || typeof markets !== 'object') return false
  return Object.entries(markets as Record<string, unknown>).every(
    ([k, s]) =>
      isRegimeMarket(k) &&
      !!s &&
      typeof s === 'object' &&
      (REGIME_LABELS as readonly string[]).includes((s as { label?: string }).label ?? ''),
  )
}

export interface RegimeServiceDeps {
  getApiUrl: () => string | null
  getApiKey: () => string | null
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  now?: () => number
}

export function createRegimeService(db: KaiBotDatabase, deps: RegimeServiceDeps) {
  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  let lastStale = ''

  async function refresh(): Promise<boolean> {
    const apiUrl = deps.getApiUrl()
    const apiKey = deps.getApiKey()
    if (!apiUrl || !apiKey) return false
    try {
      const res = await doFetch(`${apiUrl.replace(/\/$/, '')}/api/regime`, {
        headers: { 'X-API-Key': apiKey, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as unknown
      if (!isRegimeBody(body)) throw new Error('malformed regime answer')
      const prev = db.getRegimeSnapshot()?.body
      db.saveRegimeSnapshot(body)
      for (const [k, s] of Object.entries(body.markets)) {
        const before = prev?.markets?.[k as RegimeMarket]?.label
        if (before && s && before !== s.label) {
          db.log('info', 'regime', `Regime ${k}: ${before} -> ${s.label}`, { market: k, since: s.since, weekClosed: s.weekClosed })
        }
      }
      const stale = staleRegimeMarkets(body, now())
      if (stale.length > 0 && stale.join(',') !== lastStale) {
        db.log('warn', 'regime', `Regime data stale for ${stale.join(', ')}: last closed week older than 14 days`, {
          markets: Object.fromEntries(stale.map((k) => [k, body.markets[k as RegimeMarket]?.weekClosed])),
        })
      }
      lastStale = stale.join(',')
      return true
    } catch (err) {
      db.log('warn', 'regime', 'Regime fetch failed, keeping the last label', {
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  /** Fetch now and once per hour. Returns a stop function. */
  function start(intervalMs = HOUR): () => void {
    void refresh()
    const timer = setInterval(() => void refresh(), intervalMs)
    return () => clearInterval(timer)
  }

  return { refresh, start }
}
