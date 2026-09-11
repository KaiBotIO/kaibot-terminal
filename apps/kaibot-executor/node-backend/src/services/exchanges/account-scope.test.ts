import { describe, expect, it } from 'bun:test'
import {
  accountKeyOf,
  connectionId,
  isValidConnectionLabel,
  normalizeConnectionLabel,
  positionsAcrossConnections,
  scopeAccountId,
  scopeAdapter,
  sessionsForExchange,
  venueAccountOf,
} from './account-scope.js'
import type { ExchangeAdapter, Order, OrderQueryContext } from './types.js'

class FakeDeribit implements ExchangeAdapter {
  name = 'deribit'
  placed: Order[] = []
  cancelled: Array<{ id: string; ctx?: OrderQueryContext }> = []
  statusCtx: OrderQueryContext | undefined
  async connect() {}
  async disconnect() {}
  async refreshSession() {}
  async getAccounts() {
    return [
      { id: 'deribit:btc', exchangeName: 'deribit', accountId: 'btc', name: 'BTC Account', currency: 'BTC' },
      { id: 'deribit:eth', exchangeName: 'deribit', accountId: 'eth', name: 'ETH Account', currency: 'ETH' },
    ]
  }
  async getBalances() {
    return [{ accountId: 'btc', balance: 1, equity: 1, realizedPnL: 0, unrealizedPnL: 0, currency: 'BTC', timestamp: 0 }]
  }
  async getPositions() {
    return [
      { id: 'deribit:BTC-PERPETUAL', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long' as const, size: 100, entryPrice: 60000 },
    ]
  }
  async placeOrder(order: Order) {
    this.placed.push(order)
    return { orderId: 'o1', status: 'filled' as const }
  }
  async cancelOrder(id: string, ctx?: OrderQueryContext) {
    this.cancelled.push({ id, ctx })
  }
  async getOrderStatus(_id: string, ctx?: OrderQueryContext) {
    this.statusCtx = ctx
    return { orderId: _id, state: 'filled' as const }
  }
  // Venue-specific extras callers probe for.
  async call(method: string) {
    return { method }
  }
  async getLastPrice() {
    return 61000
  }
  subscribeToUpdates() {}
  unsubscribeFromUpdates() {}
}

describe('connection labels and account keys', () => {
  it('validates labels as lower-case slugs, never "default"', () => {
    expect(isValidConnectionLabel('acct2')).toBe(true)
    expect(isValidConnectionLabel('kay-desk')).toBe(true)
    expect(isValidConnectionLabel('default')).toBe(false)
    expect(isValidConnectionLabel('Acct2')).toBe(false)
    expect(isValidConnectionLabel('a/b')).toBe(false)
    expect(isValidConnectionLabel('a:b')).toBe(false)
    expect(isValidConnectionLabel('')).toBe(false)
  })

  it('normalises empty/default to undefined and rejects bad labels', () => {
    expect(normalizeConnectionLabel(undefined)).toBeUndefined()
    expect(normalizeConnectionLabel('')).toBeUndefined()
    expect(normalizeConnectionLabel('default')).toBeUndefined()
    expect(normalizeConnectionLabel('acct2')).toBe('acct2')
    expect(() => normalizeConnectionLabel('Bad Label')).toThrow()
  })

  it('keeps the legacy connection id for the default connection', () => {
    expect(connectionId('default', 'tradestation')).toBe('default:tradestation')
    expect(connectionId('default', 'deribit', 'default')).toBe('default:deribit')
    expect(connectionId('default', 'deribit', 'acct2')).toBe('default:deribit:acct2')
  })

  it('namespaces and parses account ids', () => {
    expect(scopeAccountId('acct2', 'btc')).toBe('acct2/btc')
    expect(scopeAccountId(undefined, 'btc')).toBe('btc')
    expect(scopeAccountId('acct2', 'acct2/btc')).toBe('acct2/btc')
    expect(accountKeyOf('acct2/btc')).toBe('acct2')
    expect(accountKeyOf('btc')).toBeUndefined()
    expect(accountKeyOf('931')).toBeUndefined()
    expect(accountKeyOf(null)).toBeUndefined()
    expect(venueAccountOf('acct2/btc')).toBe('btc')
    expect(venueAccountOf('btc')).toBe('btc')
  })
})

describe('scopeAdapter', () => {
  it('namespaces every surfaced account id and the position row id', async () => {
    const inner = new FakeDeribit()
    const scoped = scopeAdapter(inner, 'acct2')
    expect((await scoped.getAccounts()).map((a) => a.accountId)).toEqual(['acct2/btc', 'acct2/eth'])
    expect((await scoped.getBalances())[0].accountId).toBe('acct2/btc')
    const [pos] = await scoped.getPositions()
    expect(pos.accountId).toBe('acct2/btc')
    expect(pos.id).toBe('deribit:BTC-PERPETUAL@acct2')
    expect(pos.symbol).toBe('BTC-PERPETUAL')
  })

  it('strips the namespace from orders, cancels and status lookups', async () => {
    const inner = new FakeDeribit()
    const scoped = scopeAdapter(inner, 'acct2')
    await scoped.placeOrder({ accountId: 'acct2/btc', symbol: 'BTC-PERPETUAL', side: 'buy', orderType: 'market', quantity: 10 })
    expect(inner.placed[0].accountId).toBe('btc')
    await scoped.cancelOrder('x', { accountId: 'acct2/btc', symbol: 'BTC-PERPETUAL' })
    expect(inner.cancelled[0].ctx?.accountId).toBe('btc')
    await scoped.getOrderStatus!('x', { accountId: 'acct2/eth' })
    expect(inner.statusCtx?.accountId).toBe('eth')
  })

  it('passes venue-specific members through, bound to the inner adapter', async () => {
    const inner = new FakeDeribit()
    const scoped = scopeAdapter(inner, 'acct2') as any
    expect('call' in scoped).toBe(true)
    expect('getAuthorizationUrl' in scoped).toBe(false)
    expect(await scoped.call('public/get_index_price')).toEqual({ method: 'public/get_index_price' })
    expect(await scoped.getLastPrice('BTC-PERPETUAL')).toBe(61000)
    expect(scoped.name).toBe('deribit')
    expect(scoped.accountKey).toBe('acct2')
    expect(scoped.unscoped).toBe(inner)
  })

  it('leaves getOrderStatus undefined when the inner adapter has none', () => {
    const inner = new FakeDeribit() as any
    delete inner.getOrderStatus
    Object.setPrototypeOf(inner, { ...Object.getPrototypeOf(inner), getOrderStatus: undefined })
    const scoped = scopeAdapter(inner, 'acct2')
    expect(scoped.getOrderStatus).toBeUndefined()
  })
})

describe('session lookups with bare fakes', () => {
  it('falls back to a single default session when the manager has no getSessions', async () => {
    const session = { status: 'connected', adapter: new FakeDeribit() }
    const manager = { getSession: async () => session }
    expect(await sessionsForExchange(manager as any, 'default', 'deribit')).toEqual([session])
    const positions = await positionsAcrossConnections(manager as any, 'default', 'deribit')
    expect(positions?.map((p) => p.accountId)).toEqual(['btc'])
  })

  it('merges positions across connections (account ids stay distinct)', async () => {
    const a = { status: 'connected', adapter: new FakeDeribit() }
    const b = { status: 'connected', adapter: scopeAdapter(new FakeDeribit(), 'acct2') }
    const manager = { getSession: async () => a, getSessions: async () => [a, b] }
    const positions = await positionsAcrossConnections(manager as any, 'default', 'deribit')
    expect(positions?.map((p) => p.accountId)).toEqual(['btc', 'acct2/btc'])
  })
})
