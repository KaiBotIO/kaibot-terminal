import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// Item 1 (close idempotency) + Item 4 (reduce dedup via targetLabel), exercised
// through the real executeCloseSignal with an in-memory fake DB/adapter that
// reproduces the migration-011 dedup semantics.

interface EntryRow {
  id: string
  symbol: string
  action: 'buy' | 'sell'
  quantity: number | null
  stop_loss_order_id: string | null
  take_profit_order_id: string | null
  metadata: string | null
}

class FakeDb {
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  closedEntries: Array<{ id: string; reason?: string }> = []
  fills: any[] = []
  executions = new Map<string, any>()
  settlements: any[] = []
  private entries: EntryRow[]

  constructor(entries: EntryRow[] = []) {
    this.entries = entries
  }

  log() {}
  logSafetyClip() {}
  recordSignalQueue() {}
  getAccountSize() { return null }

  getOpenEntrySignals(symbol: string, subFilter?: string): EntryRow[] {
    return this.entries.filter(
      (e) =>
        e.symbol.toLowerCase() === symbol.toLowerCase() &&
        (!subFilter || (e.metadata ?? '').includes(subFilter)),
    )
  }
  markEntrySignalClosed(id: string, reason?: string) { this.closedEntries.push({ id, reason }) }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }

  getSignalExecution(id: string) { return this.executions.get(id) }
  insertSignalExecution(row: any) {
    if (this.executions.has(row.signalId)) return false
    this.executions.set(row.signalId, {
      signal_id: row.signalId, status: row.status,
      qty_opened: row.qtyOpened ?? 0, qty_closed: row.qtyClosed ?? 0,
      error_reason: row.errorReason ?? null,
    })
    return true
  }
  updateSignalExecution(id: string, patch: any) {
    const row = this.executions.get(id)
    if (!row) return
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'qtyOpened') row.qty_opened = v
      else if (k === 'qtyClosed') row.qty_closed = v
      else if (k === 'errorReason') row.error_reason = v
      else row[k] = v
    }
  }
  insertSignalFill(fill: any) { this.fills.push(fill) }

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
  // Per-call placeOrder result; default a clean fill.
  placeOrderImpl: ((o: Order) => OrderResult) | null = null

  constructor(positions: Position[] = []) { this.positions = positions }
  async getPositions(): Promise<Position[]> { return this.positions }
  async placeOrder(order: Order): Promise<OrderResult> {
    this.placed.push(order)
    if (this.placeOrderImpl) return this.placeOrderImpl(order)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: order.quantity }
  }
  async cancelOrder(orderId: string): Promise<void> { this.cancelled.push(orderId) }
}

class FakeExchangeManager {
  status: 'connected' | 'disconnected' = 'connected'
  constructor(public adapter: FakeAdapter) {}
  async getSession() {
    return { adapter: this.adapter, status: this.status, userId: 'default', exchangeName: this.adapter.name }
  }
}

function longPosition(size: number): Position {
  return { id: 'deribit:BTC-PERPETUAL', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size, entryPrice: 60000 }
}
function entry(o: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 'entry-1', symbol: 'BTC-PERPETUAL', action: 'buy', quantity: 100,
    stop_loss_order_id: null, take_profit_order_id: null,
    metadata: JSON.stringify({ subscriptionId: 'sub-1' }), ...o,
  }
}
function closeSignal(o: Partial<Signal> = {}): Signal {
  return {
    id: 'close-1', strategy_id: 'strat-1', symbol: 'BTC-PERPETUAL', action: 'close', quantity: 1,
    metadata: { exchange: 'deribit', subscriptionId: 'sub-1' },
    received_at: new Date(), status: 'pending', created_at: new Date(), ...o,
  } as Signal
}
const runClose = (c: SignalWebSocketClient, s: Signal, sub: any = null) =>
  (c as any).executeCloseSignal(s, sub)

describe('Item 1 — close-signal idempotency', () => {
  it('a re-delivered close (same signal id) places only one effective close order', async () => {
    const db = new FakeDb([entry()])
    db.insertSignalExecution({ signalId: 'entry-1', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 100 })
    const adapter = new FakeAdapter([longPosition(100)])
    const client = new SignalWebSocketClient(db as any, new FakeExchangeManager(adapter) as any, null)

    // First close fills and records a 'filled' settlement under target 'close'.
    await runClose(client, closeSignal(), { id: 'sub-1', exchange: 'deribit' })
    // Re-deliver the identical close signal (position still reported live).
    await runClose(client, closeSignal(), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed).toHaveLength(1) // one effective close, no reversal
    expect(db.lastStatus().error).toContain('duplicate')
  })

  it('blocks restacking while a prior close is in flight (closing + unknown settlement)', async () => {
    const db = new FakeDb([entry()])
    db.insertSignalExecution({ signalId: 'entry-1', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 100 })
    const adapter = new FakeAdapter([longPosition(100)])
    const client = new SignalWebSocketClient(db as any, new FakeExchangeManager(adapter) as any, null)
    client.setSettleOptions(1, 1)

    // First close: order never confirms → settlement 'unknown', entry → 'closing'.
    adapter.placeOrderImpl = () => ({ orderId: 'ord-1', status: 'pending' })
    ;(adapter as any).getOrderStatus = async () => ({ orderId: 'ord-1', state: 'working' })
    await runClose(client, closeSignal(), { id: 'sub-1', exchange: 'deribit' })
    expect(db.getSignalExecution('entry-1').status).toBe('closing')
    const placedAfterFirst = adapter.placed.length

    // A second close arrives (different signal id) while the first is unresolved.
    await runClose(client, closeSignal({ id: 'close-2' }), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed.length).toBe(placedAfterFirst) // no extra order placed
    expect(db.signalStatuses.find((s) => s.id === 'close-2')?.error).toContain('in flight')
  })
})

// Regression (2026-09-04 17:54 UTC, replayed close 89ec2b65): a reconnect
// replayed an already-executed close; the dedup path caught the duplicate but
// STILL sent a fresh executed-ack, and that second ack made the server's
// close-reconcile close a one-hour-newer position row. Two executor guards:
// the replay loop skips locally-terminal signals outright, and the dedup path
// never re-acks.
describe('replayed duplicates never re-ack (2026-09-04)', () => {
  it('REGRESSION: the dedup path sends no second ack for an already-processed close', async () => {
    const db = new FakeDb([entry()])
    db.insertSignalExecution({ signalId: 'entry-1', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 100 })
    const adapter = new FakeAdapter([longPosition(100)])
    const client = new SignalWebSocketClient(db as any, new FakeExchangeManager(adapter) as any, null)
    const acks: Array<{ signalId: string; status: string }> = []
    ;(client as any).ackToApi = async (signalId: string, status: string) => {
      acks.push({ signalId, status })
    }

    await runClose(client, closeSignal(), { id: 'sub-1', exchange: 'deribit' })
    expect(acks).toHaveLength(1) // the real execution acks once

    await runClose(client, closeSignal(), { id: 'sub-1', exchange: 'deribit' }) // replayed duplicate
    expect(adapter.placed).toHaveLength(1)
    expect(acks).toHaveLength(1) // no second ack — the server already knows
  })

  it('the replay loop skips a signal that is already terminal locally (no processing, no ack)', async () => {
    const db = new FakeDb([entry()])
    ;(db as any).getSignalStatus = (id: string) => (id === 'close-1' ? 'executed' : undefined)
    const queued: any[] = []
    ;(db as any).recordSignalQueue = (e: any) => queued.push(e)
    const adapter = new FakeAdapter([longPosition(100)])
    const client = new SignalWebSocketClient(db as any, new FakeExchangeManager(adapter) as any, null)
    const acks: any[] = []
    ;(client as any).ackToApi = async (signalId: string, status: string) => {
      acks.push({ signalId, status })
    }

    await (client as any).handleMissedSignals([closeSignal()])

    expect(adapter.placed).toHaveLength(0)
    expect(acks).toHaveLength(0)
    expect(queued[0]?.reason).toBe('replay_already_terminal')
  })
})

describe('Item 4 — reduce dedup via targetLabel', () => {
  it('a re-fired partial reduce for the same target executes only once', async () => {
    const db = new FakeDb([entry()])
    db.insertSignalExecution({ signalId: 'entry-1', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 100 })
    const adapter = new FakeAdapter([longPosition(100)])
    const client = new SignalWebSocketClient(db as any, new FakeExchangeManager(adapter) as any, null)

    const tp1 = closeSignal({ id: 'tp1', metadata: { exchange: 'deribit', subscriptionId: 'sub-1', target: 'TP1', closeSize: 30 } })
    await runClose(client, tp1, { id: 'sub-1', exchange: 'deribit' })
    await runClose(client, tp1, { id: 'sub-1', exchange: 'deribit' }) // exact re-fire

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].quantity).toBe(30)
    expect(db.lastStatus().error).toContain('duplicate')
  })

  it('distinct targets (TP1 then TP2) each execute', async () => {
    const db = new FakeDb([entry()])
    db.insertSignalExecution({ signalId: 'entry-1', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 100 })
    const adapter = new FakeAdapter([longPosition(100)])
    const client = new SignalWebSocketClient(db as any, new FakeExchangeManager(adapter) as any, null)

    // Same close signal id but different targets → distinct dedup keys.
    await runClose(client, closeSignal({ metadata: { exchange: 'deribit', subscriptionId: 'sub-1', target: 'TP1', closeSize: 30 } }), { id: 'sub-1', exchange: 'deribit' })
    await runClose(client, closeSignal({ metadata: { exchange: 'deribit', subscriptionId: 'sub-1', target: 'TP2', closeSize: 20 } }), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed.map((o) => o.quantity)).toEqual([30, 20])
  })
})
