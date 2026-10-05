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
