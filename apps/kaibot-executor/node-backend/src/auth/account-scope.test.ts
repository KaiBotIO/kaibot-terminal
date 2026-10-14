import { describe, expect, it } from 'bun:test'
import {
  ALL_ACCOUNTS,
  NO_ACCOUNTS,
  canSeeAccount,
  canSeeConnection,
  canSeeExchange,
  canSeeWholeConnection,
  scopeAdapterReads,
  scopedSessions,
  type AccountScope,
} from './account-scope.js'
import { scopeSignalRow, scopeSignalRows } from './scoped-views.js'

// Kay's scope (Kai, 05/10/2026): two TradeStation accounts on the shared
// login, both Deribit connections. Not 21084931, not Bybit.
const KAY: AccountScope = {
  all: false,
  grants: [
    { exchange: 'tradestation', kind: 'account', ref: '21084933' },
    { exchange: 'tradestation', kind: 'account', ref: '21084936' },
    { exchange: 'deribit', kind: 'connection', ref: 'default' },
    { exchange: 'deribit', kind: 'connection', ref: 'acct1' },
  ],
}

describe('canSeeAccount', () => {
  it('matches account grants exactly and connection grants by label', () => {
    expect(canSeeAccount(KAY, 'tradestation', '21084933')).toBe(true)
    expect(canSeeAccount(KAY, 'tradestation', '21084936')).toBe(true)
    expect(canSeeAccount(KAY, 'tradestation', '21084931')).toBe(false)
    expect(canSeeAccount(KAY, 'deribit', 'btc')).toBe(true)
    expect(canSeeAccount(KAY, 'deribit', 'acct1/eth')).toBe(true)
    expect(canSeeAccount(KAY, 'deribit', 'acct2/btc')).toBe(false)
    expect(canSeeAccount(KAY, 'bybit', 'unified')).toBe(false)
    expect(canSeeAccount(KAY, 'Deribit', 'usdc')).toBe(true)
  })

  it('treats a row without account as the default connection, never an account grant', () => {
    expect(canSeeAccount(KAY, 'deribit', null)).toBe(true)
    expect(canSeeAccount(KAY, 'tradestation', null)).toBe(false)
    expect(canSeeAccount(KAY, null, '21084933')).toBe(false)
  })

  it('admin sees everything, an empty scope nothing', () => {
    expect(canSeeAccount(ALL_ACCOUNTS, 'bybit', 'unified')).toBe(true)
    expect(canSeeAccount(NO_ACCOUNTS, 'deribit', 'btc')).toBe(false)
    expect(canSeeExchange(NO_ACCOUNTS, 'deribit')).toBe(false)
  })
})

describe('connection visibility', () => {
  it('a connection shows when a granted account lives on it', () => {
    expect(canSeeConnection(KAY, 'tradestation', 'default')).toBe(true)
    expect(canSeeConnection(KAY, 'deribit', 'acct1')).toBe(true)
    expect(canSeeConnection(KAY, 'deribit', 'acct2')).toBe(false)
    expect(canSeeConnection(KAY, 'bybit', 'default')).toBe(false)
  })

  it('only a connection grant opens venue data without an account id', () => {
    expect(canSeeWholeConnection(KAY, 'tradestation', null)).toBe(false)
    expect(canSeeWholeConnection(KAY, 'deribit', null)).toBe(true)
    expect(canSeeWholeConnection(KAY, 'deribit', 'acct1')).toBe(true)
  })
})

function fakeAdapter(rows: string[]) {
  return {
    placed: 0,
    async getAccounts() {
      return rows.map((accountId) => ({ accountId }))
    },
    async getBalances() {
      return rows.map((accountId) => ({ accountId, equity: 1 }))
    },
    async getPositions() {
      return rows.map((accountId) => ({ accountId, symbol: 'X', size: 1 }))
    },
    async placeOrder() {
      this.placed++
      return { orderId: 'o' }
    },
    async call(method: string) {
      return { method }
    },
    async getLastPrice() {
      return 100
    },
  }
}

describe('scoped adapter + sessions', () => {
  it('filters the row reads and refuses order calls', async () => {
    const inner = fakeAdapter(['21084931', '21084933'])
    const scoped = scopeAdapterReads(KAY, 'tradestation', inner as any) as any
    expect((await scoped.getAccounts()).map((a: any) => a.accountId)).toEqual(['21084933'])
    expect((await scoped.getBalances()).map((a: any) => a.accountId)).toEqual(['21084933'])
    expect((await scoped.getPositions()).map((a: any) => a.accountId)).toEqual(['21084933'])
    expect(await scoped.getLastPrice('X')).toBe(100)
    await expect(scoped.placeOrder({})).rejects.toThrow('view-only')
    expect(inner.placed).toBe(0)
    expect(await scoped.call('public/get_index_price')).toEqual({ method: 'public/get_index_price' })
    await expect(scoped.call('private/buy')).rejects.toThrow('view-only')
  })

  it('hides connections without a grant', async () => {
    const session = (exchangeName: string, label: string, rows: string[]) => ({
      userId: 'default',
      exchangeName,
      label,
      accountKey: label === 'default' ? undefined : label,
      connectionId: `default:${exchangeName}`,
      status: 'connected' as const,
      adapter: fakeAdapter(rows) as any,
    })
    const all = [
      session('tradestation', 'default', ['21084931', '21084933']),
      session('deribit', 'default', ['btc']),
      session('bybit', 'default', ['unified']),
    ]
    const manager = {
      connected: 0,
      getAllSessions: async () => all,
      getSessions: async (_u: string, ex: string) => all.filter((s) => s.exchangeName === ex),
      getSession: async (_u: string, ex: string) => all.find((s) => s.exchangeName === ex),
      async connectExchange() {
        this.connected++
      },
    }
    const view = scopedSessions(KAY, manager as any) as any
    expect((await view.getAllSessions('default')).map((s: any) => s.exchangeName)).toEqual(['tradestation', 'deribit'])
    expect(await view.getSession('default', 'bybit')).toBeUndefined()
    const ts = await view.getSession('default', 'tradestation')
    expect((await ts.adapter.getPositions()).map((p: any) => p.accountId)).toEqual(['21084933'])
    await expect(view.connectExchange()).rejects.toThrow('view-only')
    expect(manager.connected).toBe(0)
    expect(scopedSessions(ALL_ACCOUNTS, manager as any)).toBe(manager as any)
  })
})

describe('signal rows', () => {
  const wire = {
    id: 's1',
    exchange: 'tradestation',
    account_id: '21084931',
    stop_loss_order_id: 'sl-931',
    take_profit_order_id: null,
    account_outcomes: JSON.stringify([
      { exchange: 'tradestation', accountId: '21084931', status: 'executed' },
      { exchange: 'tradestation', accountId: '21084933', status: 'executed' },
    ]),
  }

  it('keeps a fan-out signal for its visible account, other outcomes and order ids removed', () => {
    const row = scopeSignalRow(KAY, wire)!
    expect(row.account_id).toBe('21084933')
    expect(row.stop_loss_order_id).toBeNull()
    expect(JSON.parse(row.account_outcomes).map((o: any) => o.accountId)).toEqual(['21084933'])
  })

  it('drops a signal of a hidden account and leaves the admin view untouched', () => {
    const hidden = { ...wire, account_outcomes: null }
    expect(scopeSignalRows(KAY, [hidden])).toEqual([])
    expect(scopeSignalRows(NO_ACCOUNTS, [wire])).toEqual([])
    expect(scopeSignalRow(ALL_ACCOUNTS, wire)).toBe(wire)
  })
})
