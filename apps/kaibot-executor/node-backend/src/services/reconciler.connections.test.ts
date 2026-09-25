import { describe, expect, it } from 'bun:test'
import { Reconciler } from './reconciler.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { Position } from './exchanges/types.js'

// Detect-and-alert pass with TWO connections on one crypto venue. Each
// connection's executions are compared with THAT connection's positions:
// acct1 holding 981 ETH-PERPETUAL for its own execution is not a mismatch on
// the default connection (which holds nothing). Regression for the 242 false
// "Position mismatch on deribit ETH-PERPETUAL" alerts of 23-25/09/2026.

interface ExecRow {
  signal_id: string
  symbol: string
  exchange: string
  direction: 'long' | 'short'
  status: string
  qty_opened: number
  qty_closed: number
  account_id: string | null
}

class FakeDb {
  logs: any[] = []
  reconciliations: any[] = []
  constructor(public execs: ExecRow[]) {}
  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  listExecutionExchanges() {
    return [...new Set(this.execs.map((e) => e.exchange))].map((exchange) => ({ exchange }))
  }
  listExecutionSymbols(exchange: string) {
    return [...new Set(this.execs.filter((e) => e.exchange === exchange).map((e) => e.symbol))].map((symbol) => ({ symbol }))
  }
  listExecutionAccountSymbols(exchange: string) {
    const seen = new Map<string, { account_id: string | null; symbol: string }>()
    for (const e of this.execs.filter((e) => e.exchange === exchange)) {
      seen.set(`${e.account_id}|${e.symbol}`, { account_id: e.account_id, symbol: e.symbol })
    }
    return [...seen.values()]
  }
  listOpenExecutionsForExchange(exchange: string) {
    return this.execs.filter((e) => e.exchange === exchange && (e.status === 'open' || e.status === 'closing'))
  }
  listKnownOrderIds() {
    return new Set<string>()
  }
  hasManualPosition() {
    return false
  }
  getManualPosition() {
    return undefined
  }
  insertReconciliation(row: any) {
    this.reconciliations.push(row)
  }
}

class FakeAdapter {
  name = 'deribit'
  alwaysOpen = true
  placed: any[] = []
  constructor(public positions: Position[] = []) {}
  async getPositions() {
    return this.positions
  }
  async placeOrder(o: any) {
    this.placed.push(o)
    return { orderId: 'x', status: 'filled' as const }
  }
  async cancelOrder() {}
}

interface FakeSession {
  adapter: FakeAdapter
  status: 'connected' | 'disconnected'
  userId: string
  exchangeName: string
  accountKey?: string
}

class FakeManager {
  constructor(private sessions: FakeSession[]) {}
  async getSession(_userId: string, exchangeName: string, accountKey?: string) {
    return this.sessions.find((s) => s.exchangeName === exchangeName && s.accountKey === (accountKey || undefined))
  }
  async getSessions(_userId: string, exchangeName: string) {
    return this.sessions.filter((s) => s.exchangeName === exchangeName)
  }
}

const pos = (symbol: string, side: 'long' | 'short', size: number, accountId: string): Position => ({
  id: `deribit:${symbol}`,
  accountId,
  symbol,
  side,
  size,
  entryPrice: 3000,
})

function build(execs: ExecRow[], defaultPositions: Position[], acct1Positions: Position[]) {
  const db = new FakeDb(execs)
  const dflt = new FakeAdapter(defaultPositions)
  const acct1 = new FakeAdapter(acct1Positions)
  const manager = new FakeManager([
    { adapter: dflt, status: 'connected', userId: 'default', exchangeName: 'deribit' },
    { adapter: acct1, status: 'connected', userId: 'default', exchangeName: 'deribit', accountKey: 'acct1' },
  ]) as unknown as ExchangeManager
  const alerts: string[] = []
  const reconciler = new Reconciler({
    db: db as any,
    exchangeManager: manager,
    notifications: { publish: (e: any) => alerts.push(e.body) } as any,
  })
  return { db, dflt, acct1, reconciler, alerts }
}

const ethOnAcct1: ExecRow = {
  signal_id: 's-eth',
  symbol: 'ETH-PERPETUAL',
  exchange: 'deribit',
  direction: 'long',
  status: 'open',
  qty_opened: 981,
  qty_closed: 0,
  account_id: 'acct1/eth',
}

describe('Reconciler observe pass per connection', () => {
  it('no mismatch when the labeled connection holds its own execution', async () => {
    const { reconciler, alerts, db } = build([ethOnAcct1], [], [pos('ETH-PERPETUAL', 'long', 981, 'acct1/eth')])
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(0)
    expect(s.pairs).toBe(1)
    expect(alerts).toHaveLength(0)
    expect(db.reconciliations).toHaveLength(0)
  })

  it('alerts on the connection that actually drifted, named in the alert', async () => {
    const { reconciler, alerts, db, dflt, acct1 } = build([ethOnAcct1], [], [])
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(1)
    expect(db.reconciliations[0]).toMatchObject({ exchange: 'deribit', accountId: 'acct1', symbol: 'ETH-PERPETUAL', expectedNet: 981, brokerNet: 0 })
    expect(alerts[0]).toContain('deribit (acct1) ETH-PERPETUAL')
    expect(dflt.placed).toHaveLength(0)
    expect(acct1.placed).toHaveLength(0)
  })

  it('a position on the default connection never counts for a labeled execution', async () => {
    // Default holds 981 ETH the books know nothing about; acct1 is flat while
    // its execution says long 981. Both are mismatches, on their own connection.
    const { reconciler, db } = build(
      [ethOnAcct1, { ...ethOnAcct1, signal_id: 's-default', qty_opened: 0, account_id: 'eth' }],
      [pos('ETH-PERPETUAL', 'long', 981, 'eth')],
      [],
    )
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(2)
    expect(db.reconciliations.map((r) => [r.accountId, r.expectedNet, r.brokerNet]).sort()).toEqual([
      ['', 0, 981],
      ['acct1', 981, 0],
    ])
  })

  it('legacy executions without an account belong to the default connection', async () => {
    const { reconciler } = build(
      [{ ...ethOnAcct1, symbol: 'BTC-PERPETUAL', qty_opened: 10, account_id: null }],
      [pos('BTC-PERPETUAL', 'long', 10, 'btc')],
      [],
    )
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(0)
  })

  it('a disconnected labeled connection is skipped, not reported flat', async () => {
    const db = new FakeDb([ethOnAcct1])
    const manager = new FakeManager([
      { adapter: new FakeAdapter([]), status: 'connected', userId: 'default', exchangeName: 'deribit' },
      { adapter: new FakeAdapter([]), status: 'disconnected', userId: 'default', exchangeName: 'deribit', accountKey: 'acct1' },
    ]) as unknown as ExchangeManager
    const reconciler = new Reconciler({ db: db as any, exchangeManager: manager })
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(0)
  })
})
