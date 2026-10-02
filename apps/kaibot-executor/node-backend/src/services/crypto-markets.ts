// Which crypto markets the executor is actually watching, per connection.
//
// "Has an open position" was the old rule, so a flat book showed zero markets
// while three connections were live and subscribed. A market belongs on the
// list as soon as something here owns it: a subscription routed to it, a
// synthetic USD row armed or open on it, or a position holding size.

export type CryptoMarketSource = 'subscription' | 'synthetic' | 'position'

export interface CryptoConnection {
  exchangeName: string
  /** Connection label; null for the default connection. */
  accountKey: string | null
  label: string
}

export interface SubscriptionInput {
  exchange: string
  accountKey: string | null
  status: string
  /** Canonical or venue-native markets the subscription trades. */
  markets: string[]
}

export interface SyntheticInput {
  exchange: string
  accountKey: string | null
  symbol: string
  status: string
}

export interface PositionInput {
  exchange: string
  accountKey: string | null
  symbol: string
  size: number
  side: 'long' | 'short' | null
  markPrice?: number | null
}

export interface CryptoMarket {
  exchange: string
  accountKey: string | null
  /** Human connection label ('deribit' or 'deribit · acct1'). */
  connection: string
  symbol: string
  sources: CryptoMarketSource[]
  position: { size: number; side: 'long' | 'short' | null } | null
  last: number | null
  change24hPct: number | null
  fundingRate: number | null
  /** Crypto venues never close. */
  open: boolean
}

/** A subscription counts while it can still fire; a cancelled one owns nothing. */
export const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'paused'])
/** An armed synthetic has no short yet but already owns its market. */
export const LIVE_SYNTHETIC_STATUSES = new Set(['open', 'armed'])

const keyOf = (exchange: string, accountKey: string | null, symbol: string) =>
  `${exchange.toLowerCase()}::${accountKey ?? ''}::${symbol.toUpperCase()}`

export interface BuildCryptoMarketsInput {
  connections: CryptoConnection[]
  subscriptions: SubscriptionInput[]
  synthetics: SyntheticInput[]
  positions: PositionInput[]
  /** Canonical market to venue symbol ('BTC' on deribit -> 'BTC-PERPETUAL'). */
  mapSymbol: (exchange: string, market: string) => string | null
  /** Human label per connection. */
  labelOf: (exchange: string, accountKey: string | null) => string
}

/**
 * One row per (connection, symbol), with every reason it is being watched.
 * Rows are scoped to a CONNECTION, so two Deribit accounts on BTC-PERPETUAL
 * stay two rows and never merge.
 */
export function buildCryptoMarkets(input: BuildCryptoMarketsInput): CryptoMarket[] {
  const rows = new Map<string, CryptoMarket>()
  const known = new Set(
    input.connections.map((c) => `${c.exchangeName.toLowerCase()}::${c.accountKey ?? ''}`),
  )

  const add = (
    exchange: string,
    accountKey: string | null,
    symbol: string,
    source: CryptoMarketSource,
  ) => {
    if (!symbol) return
    // Only connections that are actually up: a subscription pointing at a
    // disconnected venue is configuration, not a live market.
    if (!known.has(`${exchange.toLowerCase()}::${accountKey ?? ''}`)) return
    const k = keyOf(exchange, accountKey, symbol)
    const row = rows.get(k)
    if (row) {
      if (!row.sources.includes(source)) row.sources.push(source)
      return
    }
    rows.set(k, {
      exchange,
      accountKey,
      connection: input.labelOf(exchange, accountKey),
      symbol,
      sources: [source],
      position: null,
      last: null,
      change24hPct: null,
      fundingRate: null,
      open: true,
    })
  }

  for (const s of input.subscriptions) {
    if (!LIVE_SUBSCRIPTION_STATUSES.has(s.status)) continue
    for (const market of s.markets) {
      const symbol = input.mapSymbol(s.exchange, market)
      if (symbol) add(s.exchange, s.accountKey, symbol, 'subscription')
    }
  }

  for (const s of input.synthetics) {
    if (!LIVE_SYNTHETIC_STATUSES.has(s.status)) continue
    add(s.exchange, s.accountKey, s.symbol, 'synthetic')
  }

  for (const p of input.positions) {
    if (!Number.isFinite(p.size) || Math.abs(p.size) <= 0) continue
    add(p.exchange, p.accountKey, p.symbol, 'position')
    const row = rows.get(keyOf(p.exchange, p.accountKey, p.symbol))
    if (row) {
      row.position = { size: Math.abs(p.size), side: p.side }
      if (row.last == null && p.markPrice != null) row.last = p.markPrice
    }
  }

  return [...rows.values()].sort(
    (a, b) =>
      a.connection.localeCompare(b.connection) || a.symbol.localeCompare(b.symbol),
  )
}
