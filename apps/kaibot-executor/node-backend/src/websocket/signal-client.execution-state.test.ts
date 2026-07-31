import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// Tests for the idempotent per-signal execution state machine + fills capture
// ported from kaibot-exec: one open per signal id across reconnect/replay, a
// failed open marked 'error' that blocks a later close, and entry/exit fills.

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

  // ── resting DCA rungs (migration 026) — none seeded in these fixtures ──
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

describe('execution state — idempotent open', () => {
  it('records an open execution and an entry fill on a successful open', async () => {
    const { db, adapter, client } = build()
    await (client as any).handleSignal(openSignal())

    expect(adapter.placed).toHaveLength(1)
    const exec = db.getSignalExecution('sig-1')
    expect(exec.status).toBe('open')
    expect(exec.qty_opened).toBe(10)
    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ signalId: 'sig-1', kind: 'entry', side: 'buy', qty: 10, price: 60000 })
  })

  it('never opens the same signal id twice (replay/duplicate delivery)', async () => {
    const { db, adapter, client } = build()
    await (client as any).handleSignal(openSignal())
    await (client as any).handleSignal(openSignal()) // replay

    expect(adapter.placed).toHaveLength(1) // second open skipped
    expect(db.queue.some((q) => q.reason === 'duplicate_open')).toBe(true)
  })

  it('marks the execution error when the open order fails', async () => {
    const { db, adapter, client } = build()
    adapter.placeOrderImpl = () => {
      throw new Error('insufficient margin')
    }
    await (client as any).handleSignal(openSignal())

    const exec = db.getSignalExecution('sig-1')
    expect(exec.status).toBe('error')
    expect(exec.error_reason).toContain('insufficient margin')
    expect(exec.qty_opened).toBe(0)
    expect(db.lastStatus().status).toBe('rejected')
  })
})

describe('execution state — failed open blocks close', () => {
  it('does not close or retire an entry whose open failed', async () => {
    const entry = {
      id: 'entry-failed',
      symbol: 'BTC-PERPETUAL',
      action: 'buy',
      quantity: 10,
      stop_loss_order_id: 'sl-1',
      take_profit_order_id: 'tp-1',
      metadata: JSON.stringify({ subscriptionId: 'sub-1' }),
    }
    const { db, adapter, client } = build([
      { id: 'deribit:BTC-PERPETUAL', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 10, entryPrice: 60000 },
    ], null, [entry])
    // Mark the entry's execution as a failed open.
    db.insertSignalExecution({ signalId: 'entry-failed', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'error', errorReason: 'broker said no' })

    const closeSig = openSignal({ id: 'close-1', action: 'close', metadata: { exchange: 'deribit', subscriptionId: 'sub-1' } })
    await (client as any).executeCloseSignal(closeSig, { id: 'sub-1', exchange: 'deribit' })

    // The failed entry is skipped: its brackets are NOT cancelled and it is NOT retired.
    expect(adapter.cancelled).not.toContain('sl-1')
    expect(db.closedEntries.find((e) => e.id === 'entry-failed')).toBeUndefined()
    // A live position still exists, so a flatten order is still placed (exchange = truth).
    expect(adapter.placed.some((o) => o.label === 'kaibot:close-1:close')).toBe(true)
  })
})

describe('execution state — exit fills on close', () => {
  it('records an exit fill and marks the execution closed on a full close', async () => {
    const entry = {
      id: 'entry-1',
      symbol: 'BTC-PERPETUAL',
      action: 'buy',
      quantity: 10,
      stop_loss_order_id: null,
      take_profit_order_id: null,
      metadata: JSON.stringify({ subscriptionId: 'sub-1' }),
    }
    const { db, adapter, client } = build([
      { id: 'deribit:BTC-PERPETUAL', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 10, entryPrice: 60000 },
    ], null, [entry])
    db.insertSignalExecution({ signalId: 'entry-1', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 10 })
    adapter.placeOrderImpl = (o) => ({ orderId: 'close-ord', status: 'filled', filledQuantity: o.quantity, averagePrice: 61000 })

    const closeSig = openSignal({ id: 'close-1', action: 'close', metadata: { exchange: 'deribit', subscriptionId: 'sub-1' } })
    await (client as any).executeCloseSignal(closeSig, { id: 'sub-1', exchange: 'deribit' })

    const exitFills = db.fills.filter((f) => f.kind === 'exit')
    expect(exitFills).toHaveLength(1)
    expect(exitFills[0]).toMatchObject({ signalId: 'entry-1', side: 'sell', qty: 10, price: 61000 })
    expect(db.getSignalExecution('entry-1').status).toBe('closed')
  })
})
