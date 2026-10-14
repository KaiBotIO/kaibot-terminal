// Deterministic broker-side client order ids for signal-originated orders.
//
// Every order leg derived from a signal gets a client order id that is a pure
// function of (signalId, leg, rung). A retry of the same leg therefore submits
// the SAME id, and venues that enforce client-id uniqueness (Binance
// newClientOrderId, Bybit orderLinkId, Deribit label-dedup in our adapter)
// reject the duplicate instead of double-placing. Matches what the manual-trade
// path already does with its idempotencyKey.
//
// The id is a hash, not the raw triple: Binance caps client ids at 36 chars
// (charset [.A-Za-z0-9_-]) and a raw "kaibot:<uuid>:<leg>" would be truncated
// into cross-leg collisions.

import crypto from 'node:crypto'

export function deriveClientOrderId(signalId: string, leg: string, rung?: number): string {
  const key = rung != null ? `${signalId}:${leg}:${rung}` : `${signalId}:${leg}`
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 27)
  // 30 chars — fits Binance (36), Bybit (45) and Deribit label (64).
  return `kb-${digest}`
}

// Marker prefix for order_settlements rows that hold a CLIENT order id instead
// of a broker order id (the placeOrder call threw before returning one).
// Adapters' getOrderStatus resolve these via their query-by-client-id endpoint.
export const CLIENT_ORDER_ID_PREFIX = 'client:'

export function toClientOrderRef(clientOrderId: string): string {
  return `${CLIENT_ORDER_ID_PREFIX}${clientOrderId}`
}

export function parseClientOrderRef(orderId: string): string | null {
  return orderId.startsWith(CLIENT_ORDER_ID_PREFIX)
    ? orderId.slice(CLIENT_ORDER_ID_PREFIX.length)
    : null
}
