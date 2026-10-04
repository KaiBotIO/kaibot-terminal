import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, OrderStatus, Position } from '../services/exchanges/types.js'

// Venue fees on the fills the signal client books. Fixture copied from
// signal-client.execution-state.test.ts (same FakeDb/adapter surface).
//
// Three venue shapes: a Deribit-style adapter that fills inside placeOrder and
// reports the fee on the result; a TradeStation-style adapter that returns
// 'pending' and reports the fee on the settled order status; and paper, which
// reports zero. The fill row must carry the fee in every case.

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  closedEntries: Array<{ id: string; reason?: string }> = []
  safetyClips: any[] = []
  queue: any[] = []
  fills: any[] = []
  executions = new Map<string, any>()
  private sub: any | null
  private entries: any[]

  constructor(sub: any | null = null, entries: any[] = []) {
    this.sub = sub
    this.entries = entries
  }

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {/* no-op */}
  recordSignalQueue(entry: any) { this.queue.push(entry) }
  getBotConfigs(_onlyRunning = true) { return [] }
  getSubscriptionForBot() { return this.sub }
  updateSignalStatus(id: string, status: string, _tradeId?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds() {/* no-op */}
  logSafetyClip(entry: any) { this.safetyClips.push(entry) }
  getAccountSize(_ex: string, _acc: string, _root: string): number | null { return null }
  getOpenEntrySignals(symbol: string, subFilter?: string) {
    return this.entries.filter(
      (e) =>
        e.symbol.toLowerCase() === symbol.toLowerCase() &&
        (!subFilter || (e.metadata ?? '').includes(subFilter)),
    )
  }
  markEntrySignalClosed(id: string, reason?: string) { this.closedEntries.push({ id, reason }) }

  getSignalExecution(id: string) { return this.executions.get(id) }
  insertSignalExecution(row: any) {
    if (this.executions.has(row.signalId)) return false
    this.executions.set(row.signalId, {
      signal_id: row.signalId,
      symbol: row.symbol,
      exchange: row.exchange,
      direction: row.direction,
      status: row.status,
      qty_opened: row.qtyOpened ?? 0,
      qty_closed: row.qtyClosed ?? 0,
      error_reason: row.errorReason ?? null,
    })
    return true
  }
  updateSignalExecution(id: string, patch: any) {
    const row = this.executions.get(id)
    if (!row) return
    if (patch.status !== undefined) row.status = patch.status
    if (patch.qtyOpened !== undefined) row.qty_opened = patch.qtyOpened
    if (patch.qtyClosed !== undefined) row.qty_closed = patch.qtyClosed
    if (patch.errorReason !== undefined) row.error_reason = patch.errorReason
  }
  insertSignalFill(fill: any) { this.fills.push(fill) }

  // ── order settlements + per-target dedup (migration 011) ──
  settlements: any[] = []
  insertOrderSettlement(row: any): number {
    if (row.targetLabel != null) {
      const ex = this.getExitSettlement(row.signalId, row.kind, row.targetLabel)
      if (ex) {
        ex.order_id = row.orderId; ex.qty = row.qty; ex.side = row.side
        ex.status = row.status ?? 'unknown'; ex.resolved_at = null
        return ex.id
      }
    }
    const id = this.settlements.length + 1
    this.settlements.push({
      id, signal_id: row.signalId, kind: row.kind,
      target_label: row.targetLabel ?? null, order_id: row.orderId,
      qty: row.qty, side: row.side, status: row.status ?? 'unknown', resolved_at: null,
    })
    return id
  }
  getExitSettlement(signalId: string, kind: string, targetLabel: string) {
    return this.settlements.find(
      (s) => s.signal_id === signalId && s.kind === kind && s.target_label === targetLabel,
    )
  }
  targetAlreadyProcessed(signalId: string, kind: string, targetLabel: string): boolean {
    const row = this.getExitSettlement(signalId, kind, targetLabel)
    return !!row && !['rejected', 'cancelled'].includes(row.status)
  }
  hasUnresolvedSettlement(signalId: string, kind: string): boolean {
    return this.settlements.some(
      (s) => s.signal_id === signalId && s.kind === kind && s.status === 'unknown',
    )
  }

  // ── resting DCA rungs (migration 026), none seeded in these fixtures ──
  getDcaRestingRungsForSignal(_signalId: string): any[] { return [] }
  deleteDcaRestingRung(_orderId: string) {}

  lastStatus() { return this.signalStatuses[this.signalStatuses.length - 1] }
}

class FakeAdapter {
  name = 'deribit'
  positions: Position[]
  placed: Order[] = []
  cancelled: string[] = []
  placeOrderImpl: ((o: Order) => OrderResult) | null = null

  constructor(positions: Position[] = []) {
    this.positions = positions
  }
  async getPositions(): Promise<Position[]> { return this.positions }
  async placeOrder(order: Order): Promise<OrderResult> {
    this.placed.push(order)
    if (this.placeOrderImpl) return this.placeOrderImpl(order)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: order.quantity, averagePrice: 60000 }
  }
  async cancelOrder(orderId: string): Promise<void> { this.cancelled.push(orderId) }
}

class FakeExchangeManager {
  adapter: FakeAdapter
  constructor(adapter: FakeAdapter) { this.adapter = adapter }
  async getSession() {
    return { adapter: this.adapter, status: 'connected' as const, userId: 'default', exchangeName: this.adapter.name }
  }
}

function openSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol: 'BTC-PERPETUAL',
    action: 'buy',
    quantity: 10,
    metadata: { exchange: 'deribit', signalBotId: 'bot-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as Signal
}

function build(positions: Position[] = [], sub: any | null = null, entries: any[] = []) {
  const db = new FakeDb(sub, entries)
  const adapter = new FakeAdapter(positions)
  const manager = new FakeExchangeManager(adapter)
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  return { db, adapter, client }
}


// Same venue name as the base fixture (no futures symbol mapping in the
// way); what matters is the 'pending' result + fee on the status.
class StatusAdapter extends FakeAdapter {
  statusImpl: (orderId: string) => OrderStatus = (orderId) => ({ orderId, state: 'filled' })
  async getOrderStatus(orderId: string): Promise<OrderStatus> {
    return this.statusImpl(orderId)
  }
}

function buildWithStatus(entries: any[] = [], positions: Position[] = []) {
  const db = new FakeDb(null, entries)
  const adapter = new StatusAdapter(positions)
  const manager = new FakeExchangeManager(adapter)
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  ;(client as any).settleIntervalMs = 1
  ;(client as any).settleAttempts = 3
  return { db, adapter, client }
}

describe('fills carry the venue fee', () => {
  it('Deribit-style: the fee on the placeOrder result lands on the entry fill', async () => {
    const { db, adapter, client } = build()
    adapter.placeOrderImpl = (o) => ({
      orderId: 'ETH-1',
      status: 'filled',
      filledQuantity: o.quantity,
      averagePrice: 3000,
      commission: 0.6,
      feeNative: 0.0002,
      feeCurrency: 'ETH',
    })
    await (client as any).handleSignal(openSignal({ symbol: 'ETH-PERPETUAL', quantity: 981 }))
    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ kind: 'entry', qty: 981, commission: 0.6, feeNative: 0.0002, feeCurrency: 'ETH', orderId: 'ETH-1' })
  })

  it('TradeStation-style: the fee on the settled order status lands on the entry fill', async () => {
    const { db, adapter, client } = buildWithStatus()
    adapter.placeOrderImpl = () => ({ orderId: 'ts-1', status: 'pending' })
    adapter.statusImpl = (orderId) => ({ orderId, state: 'filled', filledQuantity: 10, averagePrice: 60000, commission: 0.62 })
    await (client as any).handleSignal(openSignal())
    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ kind: 'entry', commission: 0.62, feeNative: null, feeCurrency: null, orderId: 'ts-1' })
  })

  it('paper-style: a result without a fee books commission 0, not undefined', async () => {
    const { db, adapter, client } = build()
    adapter.placeOrderImpl = (o) => ({ orderId: 'p-1', status: 'filled', filledQuantity: o.quantity, averagePrice: 60000, commission: 0 })
    await (client as any).handleSignal(openSignal())
    expect(db.fills[0].commission).toBe(0)
    expect(db.fills[0].feeNative).toBeNull()
  })

  it('a close spreads the venue fee over the entries it lands on', async () => {
    const entries = [
      { id: 'old', symbol: 'BTC-PERPETUAL', action: 'buy', quantity: 10, stop_loss_order_id: null, take_profit_order_id: null, metadata: JSON.stringify({ subscriptionId: 'sub-1' }), created_at: new Date(1) },
      { id: 'new', symbol: 'BTC-PERPETUAL', action: 'buy', quantity: 30, stop_loss_order_id: null, take_profit_order_id: null, metadata: JSON.stringify({ subscriptionId: 'sub-1' }), created_at: new Date(2) },
    ]
    const { db, adapter, client } = build(
      [{ id: 'deribit:BTC-PERPETUAL', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 40, entryPrice: 60000 }],
      null,
      entries,
    )
    db.insertSignalExecution({ signalId: 'old', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 10 })
    db.insertSignalExecution({ signalId: 'new', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 30 })
    adapter.placeOrderImpl = (o) => ({
      orderId: 'close-1',
      status: 'filled',
      filledQuantity: o.quantity,
      averagePrice: 61000,
      commission: 2.44, // 40 × 0.061
      feeNative: 0.00004,
      feeCurrency: 'BTC',
    })
    const closeSig = openSignal({ id: 'close-1', action: 'close', metadata: { exchange: 'deribit', subscriptionId: 'sub-1' } })
    await (client as any).executeCloseSignal(closeSig, { id: 'sub-1', exchange: 'deribit' })

    const exits = db.fills.filter((f) => f.kind === 'exit')
    expect(exits).toHaveLength(2)
    const total = exits.reduce((s, f) => s + f.commission, 0)
    expect(total).toBeCloseTo(2.44, 10)
    for (const f of exits) {
      // Each entry pays its share: fee × qty / 40.
      expect(f.commission).toBeCloseTo(2.44 * (f.qty / 40), 10)
      expect(f.feeCurrency).toBe('BTC')
    }
  })
})
