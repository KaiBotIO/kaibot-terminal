import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// Regression tests for the server-driven `cancel` handler (pending-sweeper):
// when a pending entry's TTL elapses the server emits a `cancel` signal and the
// executor cancels the entry's RESTING order(s) — never a filled position.
//   (a) a resting entry order is cancelled on the exchange and the signal acks
//       executed.
//   (b) no resting order / order already gone → graceful idempotent ack (no
//       error, no throw).
//   (c) CRITICAL: an entry that actually FILLED is NOT cancelled/flattened.
// FakeDb backs the per-signal execution / fills / settlement / bracket rows the
// cancel path reads; FakeAdapter records cancelOrder so nothing hits a venue.

interface SignalRow {
  symbol: string
  action: string
  stop_loss_order_id: string | null
  take_profit_order_id: string | null
}

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  signals = new Map<string, SignalRow>()
  executions = new Map<string, any>()
  fills: any[] = []
  settlements: any[] = []
  deletedBracketPairs: string[] = []

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal(row: any) {
    if (!this.signals.has(row.id)) {
      this.signals.set(row.id, {
        symbol: row.symbol,
        action: row.action,
        stop_loss_order_id: null,
        take_profit_order_id: null,
      })
    }
  }
  recordSignalQueue() {}
  getSubscriptionForBot() {
    return null
  }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  getSignalBracket(signalId: string) {
    return this.signals.get(signalId)
  }
  logSafetyClip() {}
  getAccountSize() {
    return null
  }
  getOpenEntrySignals() {
    return []
  }

  getSignalExecution(id: string) {
    return this.executions.get(id)
  }
  updateSignalExecution(id: string, patch: any) {
    const row = this.executions.get(id)
    if (row && patch.status !== undefined) row.status = patch.status
  }
  getSignalFills(signalId: string) {
    return this.fills.filter((f) => f.signal_id === signalId)
  }
  listUnresolvedSettlements(_exchange?: string) {
    return this.settlements.filter((s) => s.status === 'unknown')
  }
  deleteBracketPair(signalId: string) {
    this.deletedBracketPairs.push(signalId)
  }
  // ── resting DCA rungs (migration 026) — none seeded in these fixtures ──
  getDcaRestingRungsForSignal(_signalId: string): any[] { return [] }
  deleteDcaRestingRung(_orderId: string) {}

  // Seed helpers (mirror what the open path would have recorded).
  seedExecution(signalId: string, row: { status: string; qty_opened: number; qty_closed: number }) {
    this.executions.set(signalId, { signal_id: signalId, ...row })
  }
  seedEntryFill(signalId: string, orderId: string) {
    this.fills.push({ signal_id: signalId, kind: 'entry', order_id: orderId })
  }
  seedEntrySettlement(signalId: string, orderId: string, status = 'unknown') {
    this.settlements.push({ signal_id: signalId, kind: 'entry', order_id: orderId, status })
  }
  seedBracket(signalId: string, slId: string | null, tpId: string | null) {
    const row = this.signals.get(signalId) ?? {
      symbol: 'BTC-PERPETUAL',
      action: 'buy',
      stop_loss_order_id: null,
      take_profit_order_id: null,
    }
    row.stop_loss_order_id = slId
    row.take_profit_order_id = tpId
    this.signals.set(signalId, row)
  }

  lastStatus() {
    return this.signalStatuses[this.signalStatuses.length - 1]
  }
}

class FakeAdapter {
  name: string
  positions: Position[] = []
  cancelled: string[] = []
  cancelImpl: ((id: string) => void) | null = null

  constructor(name = 'deribit') {
    this.name = name
  }
  async getPositions() {
    return this.positions
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    return { orderId: 'ord-x', status: 'filled', filledQuantity: o.quantity }
  }
  async cancelOrder(id: string) {
    if (this.cancelImpl) return this.cancelImpl(id)
    this.cancelled.push(id)
  }
}

class FakeManager {
  constructor(
    private adapter: FakeAdapter,
    public status: 'connected' | 'disconnected' = 'connected',
  ) {}
  async getSession() {
    return { adapter: this.adapter, status: this.status, userId: 'default', exchangeName: this.adapter.name }
  }
}

function build(adapter: FakeAdapter) {
  const db = new FakeDb()
  const manager = new FakeManager(adapter)
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  client.setSettleOptions(2, 1)
  return { db, client }
}

const BTC = 'BTC-PERPETUAL'

function cancelSignal(entrySignalId: string): Signal {
  return {
    id: `cancel-${entrySignalId}`,
    strategy_id: 'pending-sweeper',
    strategy_name: 'Pending expiry',
    symbol: BTC,
    action: 'cancel' as any,
    quantity: 0,
    price: 0,
    metadata: { exchange: 'deribit', entrySignalId, cancel: true, positionId: 'pos-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  } as Signal
}

describe('cancel — resting entry order', () => {
  it('cancels the resting entry order on the exchange and acks executed', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    // A pending limit entry that never filled: qty_opened reset to 0, the entry
    // order id recorded on its fill, plus a resting SL bracket leg.
    db.seedExecution('entry-1', { status: 'open', qty_opened: 0, qty_closed: 0 })
    db.seedEntryFill('entry-1', 'entry-ord-1')
    db.seedBracket('entry-1', 'sl-ord-1', null)

    await (client as any).handleSignalInner(cancelSignal('entry-1'))

    expect(adapter.cancelled).toContain('entry-ord-1')
    expect(adapter.cancelled).toContain('sl-ord-1')
    expect(db.lastStatus().status).toBe('executed')
    // The dead execution + persisted bracket are retired.
    expect(db.executions.get('entry-1').status).toBe('closed')
    expect(db.deletedBracketPairs).toContain('entry-1')
  })

  it('also picks up the entry order id from an unresolved settlement', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    db.seedExecution('entry-2', { status: 'open', qty_opened: 0, qty_closed: 0 })
    db.seedEntrySettlement('entry-2', 'entry-ord-2', 'unknown')

    await (client as any).handleSignalInner(cancelSignal('entry-2'))

    expect(adapter.cancelled).toEqual(['entry-ord-2'])
    expect(db.lastStatus().status).toBe('executed')
  })
})

describe('cancel — idempotent / nothing to cancel', () => {
  it('acks executed when there is no resting order to cancel', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    // No fills, no settlement, no bracket recorded for this entry.
    db.seedExecution('entry-3', { status: 'open', qty_opened: 0, qty_closed: 0 })

    await (client as any).handleSignalInner(cancelSignal('entry-3'))

    expect(adapter.cancelled).toHaveLength(0)
    expect(db.lastStatus().status).toBe('executed')
  })

  it('acks executed when the resting order is already gone (cancelOrder throws)', async () => {
    const adapter = new FakeAdapter()
    adapter.cancelImpl = () => {
      throw new Error('order not found')
    }
    const { db, client } = build(adapter)
    db.seedExecution('entry-4', { status: 'open', qty_opened: 0, qty_closed: 0 })
    db.seedEntryFill('entry-4', 'entry-ord-4')

    // Must not throw; an already-gone order is treated as cancelled.
    await (client as any).handleSignalInner(cancelSignal('entry-4'))

    // Acked executed (not rejected) — the throw was swallowed as already-gone.
    expect(db.lastStatus().status).toBe('executed')
    expect(db.signalStatuses.some((s) => s.status === 'rejected')).toBe(false)
  })
})

describe('cancel — filled-race safety (no naked position)', () => {
  it('does NOT cancel/flatten an entry that actually filled', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    // The entry filled (a held position) before the cancel arrived.
    db.seedExecution('entry-5', { status: 'open', qty_opened: 10, qty_closed: 0 })
    db.seedEntryFill('entry-5', 'entry-ord-5')
    db.seedBracket('entry-5', 'sl-ord-5', 'tp-ord-5')
    adapter.positions = [
      { id: 'p1', accountId: 'btc', symbol: BTC, side: 'long', size: 10, entryPrice: 60000 },
    ]

    await (client as any).handleSignalInner(cancelSignal('entry-5'))

    // Nothing cancelled — the position keeps its order + brackets intact.
    expect(adapter.cancelled).toHaveLength(0)
    expect(db.deletedBracketPairs).toHaveLength(0)
    // Still acked gracefully (no error) so the server settles the signal.
    expect(db.lastStatus().status).toBe('executed')
  })
})
