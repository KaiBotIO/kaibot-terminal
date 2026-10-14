import type { Context } from 'hono'
import type { KaiBotDatabase } from '../storage/database.js'
import type { AccountGrant, UserRole } from '../storage/types.js'
import {
  DEFAULT_CONNECTION_LABEL,
  accountKeyOf,
} from '../services/exchanges/account-scope.js'
import type {
  ExchangeAdapter,
  ExchangeSession,
} from '../services/exchanges/types.js'

// Which accounts a session may read. Admin = everything; a viewer sees only the
// accounts the admin granted (user_account_scopes). Anything that cannot be
// tied to a granted account stays hidden from a viewer.
export type AccountScope =
  | { readonly all: true }
  | { readonly all: false; readonly grants: readonly AccountGrant[] }

export const ALL_ACCOUNTS: AccountScope = { all: true }
export const NO_ACCOUNTS: AccountScope = { all: false, grants: [] }

declare module 'hono' {
  interface ContextVariableMap {
    accountScope: AccountScope
  }
}

export function scopeForUser(db: KaiBotDatabase, userId: number, role: UserRole): AccountScope {
  if (role === 'admin') return ALL_ACCOUNTS
  return { all: false, grants: db.listAccountGrants(userId) }
}

// Set by the auth middleware. A viewer without one (should not happen) gets
// nothing; a context without a role (route unit tests) is the admin.
export function scopeOf(c: Context): AccountScope {
  const scope = c.get('accountScope')
  if (scope) return scope
  return c.get('role') === 'viewer' ? NO_ACCOUNTS : ALL_ACCOUNTS
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase()

// Connection label an account id lives on: 'acct1/btc' → 'acct1', '21084933' →
// 'default'. A row without an account is a legacy default-connection row.
export function connectionOfAccount(accountId: string | null | undefined): string {
  return accountKeyOf(accountId) ?? DEFAULT_CONNECTION_LABEL
}

function labelOf(label: string | null | undefined): string {
  return label ? label : DEFAULT_CONNECTION_LABEL
}

export function canSeeAccount(
  scope: AccountScope,
  exchange: string | null | undefined,
  accountId: string | null | undefined,
): boolean {
  if (scope.all) return true
  if (!exchange) return false
  const ex = norm(exchange)
  return scope.grants.some((g) => {
    if (norm(g.exchange) !== ex) return false
    if (g.kind === 'connection') return g.ref === connectionOfAccount(accountId)
    return accountId != null && g.ref === accountId
  })
}

// The connection itself is visible when any granted account lives on it.
export function canSeeConnection(
  scope: AccountScope,
  exchange: string,
  label: string | null | undefined,
): boolean {
  if (scope.all) return true
  const ex = norm(exchange)
  const l = labelOf(label)
  return scope.grants.some(
    (g) =>
      norm(g.exchange) === ex &&
      (g.kind === 'connection' ? g.ref === l : connectionOfAccount(g.ref) === l),
  )
}

// Granted as a whole, so venue data without an account id (open orders) may show.
export function canSeeWholeConnection(
  scope: AccountScope,
  exchange: string,
  label: string | null | undefined,
): boolean {
  if (scope.all) return true
  const ex = norm(exchange)
  const l = labelOf(label)
  return scope.grants.some((g) => norm(g.exchange) === ex && g.kind === 'connection' && g.ref === l)
}

export function canSeeExchange(scope: AccountScope, exchange: string | null | undefined): boolean {
  if (scope.all) return true
  const ex = norm(exchange)
  return !!ex && scope.grants.some((g) => norm(g.exchange) === ex)
}

export function filterByAccount<T>(
  scope: AccountScope,
  rows: readonly T[],
  pick: (row: T) => { exchange: string | null | undefined; accountId: string | null | undefined },
): T[] {
  if (scope.all) return [...rows]
  return rows.filter((r) => {
    const { exchange, accountId } = pick(r)
    return canSeeAccount(scope, exchange, accountId)
  })
}

// ── Scoped view of the exchange manager ─────────────────────────────────────
// Routes read sessions through this for a viewer: hidden connections vanish,
// and a visible connection's adapter only returns granted accounts. Order
// methods refuse outright; a viewer never reaches them through the role gate,
// this is the second lock.

const ADAPTER_ROW_READS = new Set(['getAccounts', 'getBalances', 'getPositions'])
const ADAPTER_REFUSED = /^(place|cancel|close|amend|edit|modify|replace|transfer|withdraw|connect|disconnect|refresh|subscribe)/

export function scopeAdapterReads(
  scope: AccountScope,
  exchange: string,
  adapter: ExchangeAdapter,
): ExchangeAdapter {
  if (scope.all) return adapter
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof prop !== 'string' || typeof value !== 'function') return value
      if (ADAPTER_ROW_READS.has(prop)) {
        return async (...args: unknown[]) => {
          const rows = (await value.apply(target, args)) as Array<{ accountId?: string | null }>
          return Array.isArray(rows) ? rows.filter((r) => canSeeAccount(scope, exchange, r?.accountId)) : rows
        }
      }
      if (prop === 'call') {
        // Deribit JSON-RPC: public market data only.
        return (method: string, ...rest: unknown[]) => {
          if (typeof method !== 'string' || !method.startsWith('public/')) {
            return Promise.reject(new Error('view-only session'))
          }
          return value.call(target, method, ...rest)
        }
      }
      if (ADAPTER_REFUSED.test(prop)) {
        return () => Promise.reject(new Error('view-only session'))
      }
      return value.bind(target)
    },
  })
}

export interface SessionSource {
  getAllSessions(userId: string): Promise<ExchangeSession[]>
  getSessions(userId: string, exchangeName: string): Promise<ExchangeSession[]>
  getSession(userId: string, exchangeName: string, accountKey?: string): Promise<ExchangeSession | undefined>
  sessionForAccount?(userId: string, exchangeName: string, accountId?: string | null): Promise<ExchangeSession | undefined>
}

function scopeSession(scope: AccountScope, session: ExchangeSession | undefined): ExchangeSession | undefined {
  if (!session) return undefined
  if (scope.all) return session
  if (!canSeeConnection(scope, session.exchangeName, session.label)) return undefined
  return { ...session, adapter: scopeAdapterReads(scope, session.exchangeName, session.adapter) }
}

export function scopedSessions<M extends SessionSource>(scope: AccountScope, manager: M): M {
  if (scope.all) return manager
  const keep = (list: ExchangeSession[]) =>
    list.map((s) => scopeSession(scope, s)).filter((s): s is ExchangeSession => !!s)
  return new Proxy(manager, {
    get(target, prop, receiver) {
      switch (prop) {
        case 'getAllSessions':
          return async (userId: string) => keep(await target.getAllSessions(userId))
        case 'getSessions':
          return async (userId: string, exchangeName: string) => keep(await target.getSessions(userId, exchangeName))
        case 'getSession':
          return async (userId: string, exchangeName: string, accountKey?: string) =>
            scopeSession(scope, await target.getSession(userId, exchangeName, accountKey))
        case 'sessionForAccount':
          return async (userId: string, exchangeName: string, accountId?: string | null) =>
            canSeeAccount(scope, exchangeName, accountId)
              ? scopeSession(scope, await target.sessionForAccount?.(userId, exchangeName, accountId))
              : undefined
      }
      const value = Reflect.get(target, prop, receiver)
      // Anything else on the manager (connect, disconnect, events) is not a
      // viewer's business.
      return typeof value === 'function' ? () => Promise.reject(new Error('view-only session')) : value
    },
  })
}
