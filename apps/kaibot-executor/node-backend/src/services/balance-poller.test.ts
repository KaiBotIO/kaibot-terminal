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

function session(
  name: string,
  status: string,
  balances: Balance[],
  err?: Error,
  prices: Record<string, number> = {},
) {
  return {
    exchangeName: name,
    status,
    adapter: {
      async getBalances() {
        if (err) throw err
        return balances
      },
      async getLastPrice(symbol: string) {
        return prices[symbol] ?? null
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

  // Regression (portfolio review 27/09): the TradeStation token outage of
  // 19-20/09 left Deribit-only ticks that summed to ~$20 and drew the curve to
  // zero. A tick with a failed session is written as partial (a gap), never as
  // a smaller total, and no zero row is invented for the failed session.
  it('flags the tick partial when one adapter throws, without a zero row', async () => {
    const db = new FakeDb()
    const mgr = new FakeManager([
      session('tradestation', 'connected', [], new Error('401 unauthorized')),
      session('deribit', 'connected', [balance({ accountId: 'btc', equity: 5000 })]),
    ])
    const poller = new BalanceSnapshotPoller(db as any, mgr as any)
    const result = await poller.tickDetailed()

    expect(result.written).toBe(1)
    expect(result.partial).toBe(true)
    expect(result.failed).toEqual([{ exchange: 'tradestation', accountKey: null, reason: '401 unauthorized' }])
    expect(db.snapshots).toHaveLength(1)
    expect(db.snapshots[0]).toMatchObject({ exchange: 'deribit', partial: true })
    expect(db.snapshots.some((s) => s.exchange === 'tradestation')).toBe(false)
    expect(db.logs.some((l) => l.message.includes('snapshot failed'))).toBe(true)
  })

  it('treats an empty balance list as no valid balance (partial tick)', async () => {
    const db = new FakeDb()
    const mgr = new FakeManager([
      session('tradestation', 'connected', []),
      session('deribit', 'connected', [balance({ accountId: 'btc', equity: 5000 })]),
    ])
    const result = await new BalanceSnapshotPoller(db as any, mgr as any).tickDetailed()
    expect(result.partial).toBe(true)
    expect(result.failed[0]).toMatchObject({ exchange: 'tradestation', reason: 'no balances returned' })
    expect(db.snapshots.every((s) => s.partial === true)).toBe(true)
  })

  it('writes a complete tick unflagged', async () => {
    const db = new FakeDb()
    const mgr = new FakeManager([
      session('tradestation', 'connected', [balance({ accountId: 'A', equity: 10000 })]),
    ])
    const result = await new BalanceSnapshotPoller(db as any, mgr as any).tickDetailed()
    expect(result.partial).toBe(false)
    expect(db.snapshots[0]).toMatchObject({ partial: false, usdEquity: 10000, usdUnrealizedPnL: 150 })
  })

  it('stores coin wallets in USD at the venue mark, null when unpriced', async () => {
    const db = new FakeDb()
    const mgr = new FakeManager([
      session(
        'deribit',
        'connected',
        [
          balance({ accountId: 'btc', equity: 0.1, balance: 0.1, unrealizedPnL: 0, currency: 'BTC' }),
          balance({ accountId: 'eth', equity: 5.01, balance: 5.01, unrealizedPnL: -0.001, currency: 'ETH' }),
          balance({ accountId: 'usdc', equity: 9.39, balance: 9.39, unrealizedPnL: 0, currency: 'USDC' }),
          balance({ accountId: 'sol', equity: 2, balance: 2, unrealizedPnL: 0, currency: 'SOL' }),
        ],
        undefined,
        { 'BTC-PERPETUAL': 84_070, 'ETH-PERPETUAL': 2702 },
      ),
    ])
    await new BalanceSnapshotPoller(db as any, mgr as any).tick()
    const by = Object.fromEntries(db.snapshots.map((s) => [s.accountId, s]))
    expect(by.btc.equity).toBe(0.1)
    expect(by.btc.usdEquity).toBeCloseTo(8407, 6)
    expect(by.eth.usdEquity).toBeCloseTo(13_537.02, 6)
    expect(by.eth.usdUnrealizedPnL).toBeCloseTo(-2.702, 6)
    expect(by.usdc.usdEquity).toBe(9.39)
    expect(by.sol.usdEquity).toBeNull()
    expect(by.sol.usdUnrealizedPnL).toBeNull()
  })

  it('returns 0 with no connected sessions', async () => {
    const db = new FakeDb()
    const poller = new BalanceSnapshotPoller(db as any, new FakeManager([]) as any)
    expect(await poller.tick()).toBe(0)
    expect(db.snapshots).toHaveLength(0)
  })
})
