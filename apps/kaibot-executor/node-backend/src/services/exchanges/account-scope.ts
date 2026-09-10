// Multiple connections per (user, exchange) — e.g. two Deribit accounts, each
// with its own API key. Every connection past the first carries a LABEL; the
// original row keeps label 'default' and its old id `<user>:<exchange>`, so
// nothing that already runs (the live TradeStation session) changes.
//
// Account identity stays (exchange, account, symbol) everywhere (executions,
// rungs, trails, groups, guards, hedges, synthetic). Instead of threading a
// fourth key through every table, a labeled connection's adapter is wrapped so
// every accountId it SURFACES is namespaced `<label>/<venueAccount>`
// ('acct2/btc') and every accountId it RECEIVES on an order is stripped back
// to the venue's own id. Two Deribit accounts holding BTC-PERPETUAL are then
// 'btc' vs 'acct2/btc' — distinct lineage for free, and the accountId itself
// says which connection to route to (accountKeyOf).
import type {
  Account,
  Balance,
  ExchangeAdapter,
  Order,
  OrderQueryContext,
  Position,
} from './types.js'

export const DEFAULT_CONNECTION_LABEL = 'default'
export const ACCOUNT_KEY_SEPARATOR = '/'

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

// A label names a non-default connection. Lower-case slug, no ':' (session
// ids) and no '/' (account namespacing); 'default' is the unlabeled row.
export function isValidConnectionLabel(label: unknown): label is string {
  return typeof label === 'string' && label !== DEFAULT_CONNECTION_LABEL && LABEL_RE.test(label)
}

// Normalises an incoming label: undefined/''/'default' → undefined (the
// default connection); anything else must be a valid label.
export function normalizeConnectionLabel(label: unknown): string | undefined {
  if (label == null || label === '' || label === DEFAULT_CONNECTION_LABEL) return undefined
  if (!isValidConnectionLabel(label)) {
    throw new Error(
      'connection label must be 1-32 lower-case letters, digits or hyphens (not "default")',
    )
  }
  return label
}

// exchange_connections.id / session key. The default connection keeps the
// legacy `<user>:<exchange>` id.
export function connectionId(userId: string, exchangeName: string, label?: string): string {
  const l = normalizeConnectionLabel(label)
  return l ? `${userId}:${exchangeName}:${l}` : `${userId}:${exchangeName}`
}

// 'acct2' + 'btc' → 'acct2/btc'; no key → the venue id unchanged.
export function scopeAccountId(accountKey: string | null | undefined, venueAccountId: string): string {
  if (!accountKey) return venueAccountId
  if (accountKeyOf(venueAccountId) === accountKey) return venueAccountId
  return `${accountKey}${ACCOUNT_KEY_SEPARATOR}${venueAccountId}`
}

// Connection label carried by a namespaced accountId; undefined for a bare
// venue account (default connection).
export function accountKeyOf(accountId: string | null | undefined): string | undefined {
  if (!accountId) return undefined
  const i = accountId.indexOf(ACCOUNT_KEY_SEPARATOR)
  return i > 0 ? accountId.slice(0, i) : undefined
}

// The venue's own account id, prefix stripped.
export function venueAccountOf(accountId: string): string {
  const i = accountId.indexOf(ACCOUNT_KEY_SEPARATOR)
  return i > 0 ? accountId.slice(i + 1) : accountId
}

// Adapter wrapped for a labeled connection (see scopeAdapter).
export interface ScopedExchangeAdapter extends ExchangeAdapter {
  readonly accountKey: string
  readonly unscoped: ExchangeAdapter
}

export function isScopedAdapter(adapter: unknown): adapter is ScopedExchangeAdapter {
  return !!adapter && typeof (adapter as any).accountKey === 'string' && !!(adapter as any).unscoped
}

// The connection label an adapter belongs to (undefined = default).
export function adapterAccountKey(adapter: unknown): string | undefined {
  return isScopedAdapter(adapter) ? adapter.accountKey : undefined
}

function stripCtx<T extends OrderQueryContext | undefined>(ctx: T): T {
  if (!ctx || !ctx.accountId) return ctx
  return { ...ctx, accountId: venueAccountOf(ctx.accountId) }
}

/**
 * Wrap a venue adapter so its account ids are namespaced with the connection
 * label. A Proxy rather than a class: adapters expose many optional/venue
 * specific members (`call`, `getLastPrice`, `listWorkingOrders`, OAuth hooks)
 * that callers probe with `in` / `typeof` — everything not listed here passes
 * straight through to the inner adapter, bound to it.
 */
export function scopeAdapter(inner: ExchangeAdapter, accountKey: string): ScopedExchangeAdapter {
  const scoped = {
    accountKey,
    unscoped: inner,
    async getAccounts(): Promise<Account[]> {
      const accounts = await inner.getAccounts()
      return accounts.map((a) => ({
        ...a,
        accountId: scopeAccountId(accountKey, a.accountId),
        name: a.name ? `${a.name} (${accountKey})` : a.name,
      }))
    },
    async getBalances(): Promise<Balance[]> {
      const balances = await inner.getBalances()
      return balances.map((b) => ({ ...b, accountId: scopeAccountId(accountKey, b.accountId) }))
    },
    async getPositions(): Promise<Position[]> {
      const positions = await inner.getPositions()
      return positions.map((p) => ({
        ...p,
        // Position.id is the UI row key ('deribit:BTC-PERPETUAL'); two
        // connections on one symbol must not collide.
        id: `${p.id}@${accountKey}`,
        accountId: scopeAccountId(accountKey, p.accountId),
      }))
    },
    placeOrder(order: Order) {
      return inner.placeOrder({ ...order, accountId: venueAccountOf(order.accountId) })
    },
    cancelOrder(orderId: string, ctx?: OrderQueryContext) {
      return inner.cancelOrder(orderId, stripCtx(ctx))
    },
  }
  const handler: ProxyHandler<ExchangeAdapter> = {
    get(target, prop, receiver) {
      if (prop in scoped) return (scoped as any)[prop]
      // getOrderStatus is optional on the contract: only wrap when present so
      // `adapter.getOrderStatus` stays undefined for adapters without it.
      if (prop === 'getOrderStatus' && typeof target.getOrderStatus === 'function') {
        return (orderId: string, ctx?: OrderQueryContext) =>
          target.getOrderStatus!(orderId, stripCtx(ctx))
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
    has(target, prop) {
      return prop in scoped || prop in target
    },
    set(target, prop, value) {
      ;(target as any)[prop] = value
      return true
    },
  }
  return new Proxy(inner, handler) as ScopedExchangeAdapter
}

// Session lookups tolerate the bare `getSession(userId, exchange)` fakes the
// test suites use: the real ExchangeManager honours the third argument and
// exposes getSessions; a fake without them behaves as one default connection.
export interface SessionLookup<S> {
  getSession(userId: string, exchangeName: string, accountKey?: string): Promise<S | undefined>
  getSessions?(userId: string, exchangeName: string): Promise<S[]>
}

export async function sessionsForExchange<S>(
  manager: SessionLookup<S>,
  userId: string,
  exchangeName: string,
): Promise<S[]> {
  if (typeof manager.getSessions === 'function') return manager.getSessions(userId, exchangeName)
  const single = await manager.getSession(userId, exchangeName)
  return single ? [single] : []
}

// Live positions over every connected connection on one exchange. Safe to
// merge: labeled connections namespace their account ids, so no two rows can
// share (exchange, account, symbol). Null when no connection is connected.
export async function positionsAcrossConnections(
  manager: SessionLookup<{ status: string; adapter: Pick<ExchangeAdapter, 'getPositions'> }>,
  userId: string,
  exchangeName: string,
): Promise<Position[] | null> {
  const sessions = (await sessionsForExchange(manager, userId, exchangeName)).filter(
    (s) => s.status === 'connected',
  )
  if (sessions.length === 0) return null
  const out: Position[] = []
  for (const session of sessions) out.push(...(await session.adapter.getPositions()))
  return out
}
