import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// TS live blockers 2026-08: maxConcurrentTrades and the guardrails counted
// positions across EVERY broker account — with 3 TradeStation accounts, bot A's
// open positions blocked bot B. A subscription that explicitly routes an
// account must only see that account's positions; subs without routing keep the
// whole-venue view (crypto behaviour unchanged).

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  safetyClips: any[] = []
  executions = new Map<string, any>()
  private sub: any
  private guardrailRow: any

  constructor(sub: any, guardrailRow: any = null) {
    this.sub = sub
    this.guardrailRow = guardrailRow
  }

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {}
  recordSignalQueue() {}
  getSubscriptionForBot() { return this.sub }
  getBotConfigs() { return [] }
  getMarginGuard(exchange: string) {
    return exchange !== '*' ? this.guardrailRow : null
  }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  logSafetyClip(entry: any) { this.safetyClips.push(entry) }
  getAccountSize(): number | null { return null }
  getOpenEntrySignals() { return [] }
  markEntrySignalClosed() {}
  getSignalExecution(id: string) { return this.executions.get(id) }
  insertSignalExecution(row: any) {
    if (this.executions.has(row.signalId)) return false
    this.executions.set(row.signalId, { signal_id: row.signalId, status: row.status, qty_opened: row.qtyOpened ?? 0, qty_closed: 0 })
    return true
  }
  updateSignalExecution(id: string, patch: any) {
    const r = this.executions.get(id)
    if (!r) return
    Object.assign(r, { status: patch.status ?? r.status, qty_opened: patch.qtyOpened ?? r.qty_opened })
  }
  insertSignalFill() {}
  upsertBracketPair() {}
  insertOrderSettlement() { return 1 }
  lastStatus() { return this.signalStatuses[this.signalStatuses.length - 1] }
}

class FakeAdapter {
  name = 'tradestation'
  positions: Position[] = []
  placed: Order[] = []
  alwaysOpen = true
  async getPositions() { return this.positions }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity, averagePrice: o.price }
  }
  async cancelOrder() {}
}

class FakeManager {
  constructor(private adapter: FakeAdapter) {}
  async getSession() {
    return { adapter: this.adapter, status: 'connected', userId: 'default', exchangeName: this.adapter.name }
  }
}

const pos = (symbol: string, accountId: string, size = 1): Position => ({
  id: `p:${accountId}:${symbol}`,
  accountId,
  symbol,
  side: 'long',
  size,
  entryPrice: 5000,
  markPrice: 5000,
  leverage: 1,
})

function signal(): Signal {
  return {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol: 'MESU26',
    action: 'buy',
    quantity: 1,
    price: 5000,
    metadata: { exchange: 'tradestation', signalBotId: 'bot-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  } as unknown as Signal
}

function build(sub: any, guardrailRow: any = null) {
  const adapter = new FakeAdapter()
  const db = new FakeDb(sub, guardrailRow)
  const client = new SignalWebSocketClient(db as any, new FakeManager(adapter) as any, null)
  client.setSettleOptions(2, 1)
  return { adapter, db, client }
}

describe('maxConcurrentTrades scoped to the routed account', () => {
  const sub = { id: 'sub-1', factor: 1, account_id: 'ACC-A', max_concurrent_trades: 1 }

  it("another account's position does not block this bot", async () => {
    const { adapter, client } = build(sub)
    adapter.positions = [pos('MNQZ26', 'ACC-B')] // other account at the cap
    await (client as any).handleSignalInner(signal())
    expect(adapter.placed).toHaveLength(1)
  })

  it("the routed account's own position still trips the cap", async () => {
    const { adapter, db, client } = build(sub)
    adapter.positions = [pos('MNQZ26', 'ACC-A')]
    await (client as any).handleSignalInner(signal())
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().error).toContain('maxConcurrentTrades')
  })

  it('positions without account attribution always count (single-account venues)', async () => {
    const { adapter, db, client } = build(sub)
    const p = pos('MNQZ26', '')
    p.accountId = undefined as any
    adapter.positions = [p]
    await (client as any).handleSignalInner(signal())
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().error).toContain('maxConcurrentTrades')
  })
})

describe('guardrails scoped to the routed account', () => {
  const rails = { max_daily_loss: 0, max_concurrent_positions: 1, max_total_notional: 0 }

  it("concurrency rail ignores another account's positions", async () => {
    const { adapter, client } = build({ id: 'sub-1', factor: 1, account_id: 'ACC-A' }, rails)
    adapter.positions = [pos('MNQZ26', 'ACC-B')]
    await (client as any).handleSignalInner(signal())
    expect(adapter.placed).toHaveLength(1)
  })

  it('concurrency rail still bites on the routed account itself', async () => {
    const { adapter, db, client } = build({ id: 'sub-1', factor: 1, account_id: 'ACC-A' }, rails)
    adapter.positions = [pos('MNQZ26', 'ACC-A')]
    await (client as any).handleSignalInner(signal())
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().error).toContain('max concurrent positions')
  })
})

// 06/10 regression: the daily-loss limit is set per TS account, but it was
// checked against the P&L of every venue and a trip flattened every venue and
// halted the whole executor. P&L and halts come from a real sqlite DB here.
describe('daily-loss rail scoped to the exchange+account', () => {
  const { mkdtempSync, rmSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const { tmpdir } = require('os') as typeof import('os')
  const { KaiBotDatabase } = require('../storage/database.js') as typeof import('../storage/database.js')

  const rails = { max_daily_loss: 500, max_concurrent_positions: 0, max_total_notional: 0 }

  function setup(account: string) {
    const dir = mkdtempSync(join(tmpdir(), 'kaibot-dl-scope-'))
    const real = new KaiBotDatabase(join(dir, 'test.db'))
    const db = new FakeDb({ id: `sub-${account}`, factor: 1, account_id: account }, rails) as any
    for (const m of ['all', 'getFillsForSignals', 'getHaltState', 'setHaltState', 'getAccountHalt', 'setAccountHalt', 'listAccountHalts', 'listActiveServerExitStates']) {
      db[m] = (real as any)[m].bind(real)
    }
    const ts = new FakeAdapter()
    ts.positions = [pos('MESZ26', '21084931'), pos('MGCZ26', '21084933')]
    const deribit = new FakeAdapter()
    deribit.name = 'deribit'
    deribit.positions = [{ ...pos('ETH-PERPETUAL', 'eth', 6424), entryPrice: 2718.45 }]
    const manager = {
      async getSession() {
        return { adapter: ts, status: 'connected', userId: 'default', exchangeName: 'tradestation' }
      },
      async getAllSessions() {
        return [
          { adapter: ts, status: 'connected', userId: 'default', exchangeName: 'tradestation' },
          { adapter: deribit, status: 'connected', userId: 'default', exchangeName: 'deribit' },
        ]
      },
    }
    const client = new SignalWebSocketClient(db, manager as any, null)
    client.setSettleOptions(2, 1)
    const closeTrade = (id: string, exchange: string, accountId: string, symbol: string, entry: number, exit: number, qty: number) => {
      const now = Date.now()
      real.insertSignalExecution({ signalId: id, symbol, exchange, direction: 'long', status: 'closed', qtyOpened: qty, qtyClosed: qty, accountId, createdAtMs: now })
      real.insertSignalFill({ signalId: id, kind: 'entry', symbol, side: 'buy', qty, price: entry, createdAtMs: now - 60_000 })
      real.insertSignalFill({ signalId: id, kind: 'exit', symbol, side: 'sell', qty, price: exit, createdAtMs: now })
    }
    const cleanup = () => {
      real.close()
      rmSync(dir, { recursive: true, force: true })
    }
    return { db, real, ts, deribit, client, closeTrade, cleanup }
  }

  it('a Deribit loss does not trip the TradeStation account limit', async () => {
    const t = setup('21084931')
    try {
      t.closeTrade('eth-ride', 'deribit', 'eth', 'ETH-PERPETUAL', 2718.45, 2000, 6424) // about -1.700 USD
      await (t.client as any).handleSignalInner(signal())
      expect(t.ts.placed.map((o) => o.symbol)).toEqual(['MESU26'])
      expect(t.real.listAccountHalts()).toHaveLength(0)
      expect(t.real.getHaltState().halted).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it('a TS breach closes only that account, halts only it, Deribit and the other TS account stay open', async () => {
    const t = setup('21084931')
    try {
      t.closeTrade('eth-ride', 'deribit', 'eth', 'ETH-PERPETUAL', 2718.45, 2000, 6424)
      t.closeTrade('mes', 'tradestation', '21084931', 'MESZ26', 7900, 7780, 1) // -600 at x5
      await (t.client as any).handleSignalInner(signal())
      expect(t.db.lastStatus()).toMatchObject({ status: 'rejected' })
      expect(t.db.lastStatus().error).toContain('daily loss limit hit on tradestation 21084931')
      // Only the MES close on 21084931; no new entry, nothing on 21084933 or Deribit.
      expect(t.ts.placed.map((o) => [o.symbol, o.accountId, o.reduceOnly])).toEqual([['MESZ26', '21084931', true]])
      expect(t.deribit.placed).toHaveLength(0)
      expect(t.real.getAccountHalt('tradestation', '21084931')?.reason).toBe('daily_loss')
      expect(t.real.listAccountHalts()).toHaveLength(1)
      expect(t.real.getHaltState().halted).toBe(false)
    } finally {
      t.cleanup()
    }
  })

  it('two concurrent opens that both see the breach flatten once', async () => {
    const t = setup('21084931')
    try {
      t.closeTrade('mes', 'tradestation', '21084931', 'MESZ26', 7900, 7780, 1)
      await Promise.all([
        (t.client as any).handleSignalInner({ ...signal(), id: 'sig-a' }),
        (t.client as any).handleSignalInner({ ...signal(), id: 'sig-b' }),
      ])
      expect(t.ts.placed.map((o) => o.symbol)).toEqual(['MESZ26'])
      expect(t.db.signalStatuses.filter((x: any) => x.status === 'rejected').map((x: any) => x.id).sort()).toEqual(['sig-a', 'sig-b'])
      expect(t.real.listAccountHalts()).toHaveLength(1)
    } finally {
      t.cleanup()
    }
  })

  it('a halted account refuses opens, another account on the same venue still opens', async () => {
    const t = setup('21084931')
    try {
      t.real.setAccountHalt('tradestation', '21084931', true, 'daily_loss')
      await (t.client as any).handleSignalInner(signal())
      expect(t.ts.placed).toHaveLength(0)
      expect(t.db.lastStatus().error).toContain('account tradestation 21084931 halted')

      const other = setup('21084933')
      try {
        other.real.setAccountHalt('tradestation', '21084931', true, 'daily_loss')
        await (other.client as any).handleSignalInner(signal())
        expect(other.ts.placed.map((o) => o.symbol)).toEqual(['MESU26'])
      } finally {
        other.cleanup()
      }
    } finally {
      t.cleanup()
    }
  })
})
