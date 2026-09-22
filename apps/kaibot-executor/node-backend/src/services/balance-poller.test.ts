import { describe, expect, it } from 'bun:test'
import { BalanceSnapshotPoller } from './balance-poller.js'
import type { Balance } from './exchanges/types.js'

class FakeDb {
  snapshots: any[] = []
  logs: any[] = []
  insertBalanceSnapshot(s: any) { this.snapshots.push(s) }
  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
}

function balance(over: Partial<Balance> = {}): Balance {
  return {
    accountId: 'A',
    balance: 9000,
    equity: 10000,
    realizedPnL: 0,
    unrealizedPnL: 150,
    currency: 'USD',
    timestamp: Date.now(),
    ...over,
  }
}

class FakeManager {
  constructor(private sessions: any[]) {}
  async getAllSessions() { return this.sessions }
}

function session(name: string, status: string, balances: Balance[], err?: Error) {
  return {
    exchangeName: name,
    status,
    adapter: {
      async getBalances() {
        if (err) throw err
        return balances
      },
    },
  }
}

describe('BalanceSnapshotPoller.tick', () => {
  it('snapshots every connected session and skips disconnected ones', async () => {
    const db = new FakeDb()
    const mgr = new FakeManager([
      session('tradestation', 'connected', [balance({ accountId: 'A', equity: 10000 })]),
      session('deribit', 'connected', [balance({ accountId: 'btc', equity: 5000, currency: 'BTC' })]),
      session('bybit', 'disconnected', [balance({ accountId: 'X', equity: 999 })]),
    ])
    const poller = new BalanceSnapshotPoller(db as any, mgr as any)
    const written = await poller.tick()

    expect(written).toBe(2)
    expect(db.snapshots.map((s) => s.exchange).sort()).toEqual(['deribit', 'tradestation'])
    // All written at the same ts so the equity curve groups them.
    expect(new Set(db.snapshots.map((s) => s.ts)).size).toBe(1)
    const ts = db.snapshots.find((s) => s.exchange === 'tradestation')
    expect(ts).toMatchObject({ accountId: 'A', equity: 10000, balance: 9000, unrealizedPnL: 150 })
  })

  it('logs and continues when one adapter throws', async () => {
    const db = new FakeDb()
    const mgr = new FakeManager([
      session('tradestation', 'connected', [], new Error('rate limited')),
      session('deribit', 'connected', [balance({ accountId: 'btc', equity: 5000 })]),
    ])
    const poller = new BalanceSnapshotPoller(db as any, mgr as any)
    const written = await poller.tick()

    expect(written).toBe(1)
    expect(db.snapshots[0].exchange).toBe('deribit')
    expect(db.logs.some((l) => l.message.includes('snapshot failed'))).toBe(true)
  })

  it('returns 0 with no connected sessions', async () => {
    const db = new FakeDb()
    const poller = new BalanceSnapshotPoller(db as any, new FakeManager([]) as any)
    expect(await poller.tick()).toBe(0)
    expect(db.snapshots).toHaveLength(0)
  })
})
