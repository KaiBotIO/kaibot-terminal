import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, OrderStatus, Position } from '../services/exchanges/types.js'

// Integration tests for the order-settlement, closing-retry, bracket
// persistence and unknown-order resolution paths in the signal client. A
// hand-rolled in-memory FakeDb backs the migration-007/008 tables exercised
// here; FakeAdapter scripts placeOrder + getOrderStatus so nothing hits a venue.

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  closedEntries: Array<{ id: string; reason?: string }> = []
  fills: any[] = []
  executions = new Map<string, any>()
  settlements: any[] = []
  bracketPairs = new Map<string, any>()
  orderIdsSet: string[] = []
  private entries: any[]

  constructor(entries: any[] = []) {
    this.entries = entries
  }

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {}
  recordSignalQueue() {}
  // TradeStation entries need a routed broker account on the subscription
  // (the 'default' fallback is rejected before sizing). Only consulted when a
  // signal carries a signalBotId.
  getSubscriptionForBot() { return { id: 'sub-1', factor: 1, account_id: 'ACC1' } }
  getBotConfigs() { return [] }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  logSafetyClip() {}
  getAccountSize(_ex: string, _acc: string, _root: string): number | null { return null }

  getOpenEntrySignals(symbol: string, subFilter?: string) {
    return this.entries.filter(
      (e) =>
        e.symbol.toLowerCase() === symbol.toLowerCase() &&
        (!subFilter || (e.metadata ?? '').includes(subFilter)),
    )
  }
  markEntrySignalClosed(id: string, reason?: string) {
    this.closedEntries.push({ id, reason })
  }

  // execution state
  getSignalExecution(id: string) {
    return this.executions.get(id)
  }
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
    if (patch.qtyPendingClose !== undefined) row.qty_pending_close = patch.qtyPendingClose
    if (patch.errorReason !== undefined) row.error_reason = patch.errorReason
  }
  insertSignalFill(fill: any) {
    this.fills.push(fill)
  }
  targetAlreadyProcessed(signalId: string, kind: string, targetLabel: string): boolean {
    return this.settlements.some(
      (s) =>
        s.signal_id === signalId &&
        s.kind === kind &&
        s.target_label === targetLabel &&
        !['rejected', 'cancelled'].includes(s.status),
    )
  }
  getDcaRestingRungsForSignal(_signalId: string): any[] {
    return []
  }

  // settlements (mig 008)
  insertOrderSettlement(row: any) {
    const id = this.settlements.length + 1
    this.settlements.push({ id, status: 'unknown', created_at: Date.now(), ...row, order_id: row.orderId, signal_id: row.signalId, account_id: row.accountId ?? null, target_label: row.targetLabel ?? null })
    return id
  }
  listUnresolvedSettlements(exchange?: string) {
    return this.settlements.filter((s) => s.status === 'unknown' && (!exchange || s.exchange === exchange))
  }
  resolveOrderSettlement(id: number, status: string) {
    const s = this.settlements.find((x) => x.id === id)
    if (s) s.status = status
  }

  // bracket pairs (mig 008; tp_order_ids mig 012) — mirror the real DB: the
  // first TP leg mirrors to tp_order_id, the full ladder rides tp_order_ids.
  upsertBracketPair(row: any) {
    const tpIds: string[] | null = row.tpOrderIds && row.tpOrderIds.length > 0 ? row.tpOrderIds : null
    const firstTp = tpIds ? tpIds[0] : row.tpOrderId ?? null
    this.bracketPairs.set(row.signalId, {
      signal_id: row.signalId,
      exchange: row.exchange,
      sl_order_id: row.slOrderId ?? null,
      tp_order_id: firstTp,
      tp_order_ids: tpIds ? JSON.stringify(tpIds) : null,
    })
  }
  listBracketPairs() {
    return [...this.bracketPairs.values()]
  }
  deleteBracketPair(id: string) {
    this.bracketPairs.delete(id)
  }

  // closing-retry
  listClosingExecutions() {
    return [...this.executions.values()].filter((e) => e.status === 'closing')
  }

  lastStatus() {
    return this.signalStatuses[this.signalStatuses.length - 1]
  }
}

class FakeAdapter {
  name: string
  positions: Position[] = []
  placed: Order[] = []
  cancelled: string[] = []
  placeImpl: ((o: Order) => OrderResult) | null = null
  statusScript: OrderStatus[] = []
  private statusIdx = 0
  alwaysOpen = true // crypto by default → skip market guard

  constructor(name = 'deribit') {
    this.name = name
  }

  async getPositions() {
    return this.positions
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    if (this.placeImpl) return this.placeImpl(o)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity }
  }
  async cancelOrder(id: string) {
    this.cancelled.push(id)
  }
  async getOrderStatus(): Promise<OrderStatus> {
    const s = this.statusScript[Math.min(this.statusIdx, this.statusScript.length - 1)]
    this.statusIdx++
    return s ?? { orderId: 'x', state: 'unknown' }
  }
}

class FakeManager {
  constructor(private adapter: FakeAdapter, public status: 'connected' | 'disconnected' = 'connected') {}
  async getSession() {
    return { adapter: this.adapter, status: this.status, userId: 'default', exchangeName: this.adapter.name }
  }
}

function openSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol: 'BTC-PERPETUAL',
    action: 'buy',
    quantity: 10,
    metadata: { exchange: 'deribit' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as Signal
}

function build(adapter: FakeAdapter, entries: any[] = []) {
  const db = new FakeDb(entries)
  const manager = new FakeManager(adapter)
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  // Tiny settle cadence so the unknown-outcome (timeout) path resolves in ms.
  client.setSettleOptions(2, 1)
  return { db, client }
}

// ── Settlement on open ────────────────────────────────────────────────────────

describe('open-path settlement', () => {
  it('persists an unknown settlement and keeps the execution tracked on timeout', async () => {
    const adapter = new FakeAdapter()
    // placeOrder returns pending; getOrderStatus always "working" → settle times out.
    adapter.placeImpl = () => ({ orderId: 'ord-x', status: 'pending' })
    adapter.statusScript = [{ orderId: 'ord-x', state: 'working' }]
    const { db, client } = build(adapter)

    await (client as any).handleSignalInner(openSignal())

    // An unknown-outcome settlement row was persisted for background resolution.
    expect(db.settlements).toHaveLength(1)
    expect(db.settlements[0]).toMatchObject({ kind: 'entry', order_id: 'ord-x', status: 'unknown' })
    // The execution stays tracked (not retired).
    expect(db.getSignalExecution('sig-1')?.status).toBe('open')
  })

  it('marks the execution error when settlement reports rejected', async () => {
    const adapter = new FakeAdapter()
    adapter.placeImpl = () => ({ orderId: 'ord-r', status: 'pending' })
    adapter.statusScript = [{ orderId: 'ord-r', state: 'rejected' }]
    const { db, client } = build(adapter)

    await (client as any).handleSignalInner(openSignal())

    expect(db.getSignalExecution('sig-1')?.status).toBe('error')
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.settlements).toHaveLength(0)
  })

  it('treats a clean filled placeOrder result as filled without polling', async () => {
    const adapter = new FakeAdapter()
    adapter.placeImpl = () => ({ orderId: 'ord-f', status: 'filled', filledQuantity: 10, averagePrice: 60000 })
    const { db, client } = build(adapter)

    await (client as any).handleSignalInner(openSignal())
    expect(db.getSignalExecution('sig-1')?.status).toBe('open')
    expect(db.fills.find((f) => f.kind === 'entry')?.qty).toBe(10)
  })
})

// ── Market guard on open (non-crypto) ─────────────────────────────────────────

describe('open-path market guard', () => {
  it('rejects an open when a non-24/7 venue reports a stale market', async () => {
    const adapter = new FakeAdapter('tradestation')
    adapter.alwaysOpen = false
    ;(adapter as any).getMarketStatus = async () =>
      new Map([['BTC-PERPETUAL', { symbol: 'BTC-PERPETUAL', last: 1, tradeTimeMs: Date.now() - 60 * 60_000 }]])
    const { db, client } = build(adapter)

    await (client as any).handleSignalInner(
      openSignal({ metadata: { exchange: 'tradestation', signalBotId: 'bot-1' } }),
    )

    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('market closed')
    // No execution row burned → the signal can replay when the market reopens.
    expect(db.getSignalExecution('sig-1')).toBeUndefined()
  })
})

// ── Bracket persistence + restart ─────────────────────────────────────────────

describe('bracket persistence over restart', () => {
  it('persists the OCO pair and cancels the sibling after a simulated restart', async () => {
    const adapter = new FakeAdapter()
    adapter.placeImpl = () => ({ orderId: `ord-${adapter.placed.length + 1}`, status: 'filled', filledQuantity: 10 })
    const { db, client } = build(adapter)

    // Open with both SL and TP → a bracket pair is placed and persisted.
    await (client as any).handleSignalInner(
      openSignal({ stop_loss: 55000, take_profit: 65000 }),
    )
    expect(db.bracketPairs.size).toBe(1)
    const pair = [...db.bracketPairs.values()][0]
    const slId = pair.sl_order_id as string
    const tpId = pair.tp_order_id as string
    expect(slId).toBeTruthy()
    expect(tpId).toBeTruthy()

    // Simulate a restart: a brand-new client with an EMPTY in-memory bracket map
    // but the SAME db (persisted pair survives). Rehydrate from the table.
    const adapter2 = new FakeAdapter()
    const manager2 = new FakeManager(adapter2)
    const client2 = new SignalWebSocketClient(db as any, manager2 as any, null)
    const loaded = client2.loadPersistedBrackets()
    expect(loaded).toBe(1)

    // The SL leg fills → the fresh client must still cancel the TP sibling.
    await client2.onExchangeOrderUpdate({ orderId: slId, state: 'filled', exchangeName: 'deribit' })
    expect(adapter2.cancelled).toEqual([tpId])
    // And the persisted pair is cleaned up.
    expect(db.bracketPairs.size).toBe(0)
  })
})

// ── Closing-retry ─────────────────────────────────────────────────────────────

describe('retryPendingCloses', () => {
  const closingExec = (db: FakeDb, symbol = 'BTC-PERPETUAL') => {
    db.insertSignalExecution({ signalId: 'sig-1', symbol, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 10 })
    db.updateSignalExecution('sig-1', { status: 'closing' })
  }

  it('marks the execution closed when the position is already flat', async () => {
    const adapter = new FakeAdapter()
    adapter.positions = [] // flat
    const { db, client } = build(adapter)
    closingExec(db)

    const n = await client.retryPendingCloses()
    expect(n).toBe(0) // no re-issue needed
    expect(db.getSignalExecution('sig-1')?.status).toBe('closed')
    expect(db.closedEntries.map((e) => e.id)).toContain('sig-1')
  })

  it('re-issues a reduce-only close and retires on a confirmed fill', async () => {
    const adapter = new FakeAdapter()
    adapter.positions = [{ id: 'p', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 10, entryPrice: 60000 }]
    adapter.placeImpl = () => ({ orderId: 'close-retry-1', status: 'filled' })
    const { db, client } = build(adapter)
    closingExec(db)

    const n = await client.retryPendingCloses()
    expect(n).toBe(1)
    const order = adapter.placed[0]
    expect(order.side).toBe('sell')
    expect(order.reduceOnly).toBe(true)
    expect(order.quantity).toBe(10)
    expect(db.getSignalExecution('sig-1')?.status).toBe('closed')
  })

  it('keeps the execution closing when the re-issued close still does not confirm', async () => {
    const adapter = new FakeAdapter()
    adapter.positions = [{ id: 'p', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 10, entryPrice: 60000 }]
    adapter.placeImpl = () => ({ orderId: 'close-retry-2', status: 'pending' })
    adapter.statusScript = [{ orderId: 'close-retry-2', state: 'working' }] // never settles
    const { db, client } = build(adapter)
    closingExec(db)

    await client.retryPendingCloses()
    expect(db.getSignalExecution('sig-1')?.status).toBe('closing')
    // An exit settlement was persisted for background resolution.
    expect(db.settlements.some((s) => s.kind === 'exit')).toBe(true)
  })

  // #16 regression: a fractional scale-out whose close never confirmed must be
  // retried at the REMEMBERED fraction — the old retry flattened the whole live
  // position (quantity = |live.size|), turning a 40% scale-out into a full exit.
  it('re-issues only the remembered fraction of a pending fractional close', async () => {
    const adapter = new FakeAdapter()
    adapter.positions = [{ id: 'p', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 10, entryPrice: 60000 }]
    adapter.placeImpl = (o) => ({ orderId: 'close-retry-f', status: 'filled', filledQuantity: o.quantity, averagePrice: 61000 })
    const { db, client } = build(adapter)
    db.insertSignalExecution({ signalId: 'sig-1', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 10 })
    db.updateSignalExecution('sig-1', { status: 'closing', qtyPendingClose: 4 })

    const n = await client.retryPendingCloses()
    expect(n).toBe(1)
    expect(adapter.placed[0].quantity).toBe(4) // the fraction — NOT the full 10
    expect(adapter.placed[0].reduceOnly).toBe(true)
    const exec = db.getSignalExecution('sig-1')
    // Fraction closed → the remainder legitimately stays open, not retired.
    expect(exec?.status).toBe('open')
    expect(exec?.qty_closed).toBe(4)
    expect(exec?.qty_pending_close).toBeNull()
    expect(db.closedEntries).toHaveLength(0)
    expect(db.fills.filter((f) => f.kind === 'exit')).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ kind: 'exit', qty: 4, price: 61000 })
  })

  // #16 end-to-end: the fraction is stamped when the close times out, then honored.
  it('a fractional close that times out is retried at the fraction, never a flatten', async () => {
    const adapter = new FakeAdapter()
    adapter.positions = [{ id: 'p', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 80, entryPrice: 60000 }]
    adapter.placeImpl = () => ({ orderId: 'c-frac', status: 'pending' })
    adapter.statusScript = [{ orderId: 'c-frac', state: 'working' }] // never settles
    const entries = [{ id: 'sig-1', symbol: 'BTC-PERPETUAL', action: 'buy', quantity: 80, stop_loss_order_id: null, take_profit_order_id: null, metadata: null }]
    const { db, client } = build(adapter, entries)
    db.insertSignalExecution({ signalId: 'sig-1', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 80 })

    // 0.25 × 80 = 20 (deribit BTC step 10 → lands on-step).
    await (client as any).executeCloseSignal(
      openSignal({ id: 'close-1', action: 'close', quantity: 1, metadata: { exchange: 'deribit', fraction: 0.25 } }),
      null,
    )
    expect(adapter.placed[0].quantity).toBe(20)
    const pending = db.getSignalExecution('sig-1')
    expect(pending?.status).toBe('closing')
    expect(pending?.qty_pending_close).toBe(20) // the fraction, remembered

    // Retry: the re-issued close is the remembered 20, not the live 80.
    adapter.placeImpl = (o) => ({ orderId: 'c-frac-retry', status: 'filled', filledQuantity: o.quantity, averagePrice: 61000 })
    await client.retryPendingCloses()
    expect(adapter.placed[1].quantity).toBe(20)
    expect(db.getSignalExecution('sig-1')?.status).toBe('open')
    expect(db.closedEntries).toHaveLength(0)
  })

  it('skips the retry while a non-24/7 market is closed', async () => {
    const adapter = new FakeAdapter('tradestation')
    adapter.alwaysOpen = false
    ;(adapter as any).getMarketStatus = async () =>
      new Map([['MESM26', { symbol: 'MESM26', last: 1, tradeTimeMs: Date.now() - 60 * 60_000 }]])
    adapter.positions = [{ id: 'p', accountId: 'ACC1', symbol: 'MESM26', side: 'long', size: 4, entryPrice: 5000 }]
    const { db, client } = build(adapter)
    db.insertSignalExecution({ signalId: 'sig-1', symbol: 'MESM26', exchange: 'tradestation', direction: 'long', status: 'open', qtyOpened: 4 })
    db.updateSignalExecution('sig-1', { status: 'closing' })

    await client.retryPendingCloses()
    expect(adapter.placed).toHaveLength(0)
    expect(db.getSignalExecution('sig-1')?.status).toBe('closing')
  })
})

// ── close settlement: terminal partial fill (#15) ────────────────────────────

describe('close settlement partial fill', () => {
  // #15 regression: a close that settles terminally with a PARTIAL fill (e.g. a
  // TradeStation done-for-day kill after a partial) used to book a phantom FULL
  // close and retire the position. Only the actual filled qty may be booked;
  // the remainder stays pending for the retry loop.
  it('books only the actual filled qty and keeps the remainder pending', async () => {
    const adapter = new FakeAdapter()
    adapter.positions = [{ id: 'p', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 10, entryPrice: 60000 }]
    adapter.placeImpl = () => ({ orderId: 'c-don', status: 'pending' })
    adapter.statusScript = [
      { orderId: 'c-don', state: 'partially_filled', filledQuantity: 4, averagePrice: 61000 },
    ]
    const entries = [{ id: 'sig-1', symbol: 'BTC-PERPETUAL', action: 'buy', quantity: 10, stop_loss_order_id: null, take_profit_order_id: null, metadata: null }]
    const { db, client } = build(adapter, entries)
    db.insertSignalExecution({ signalId: 'sig-1', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 10 })

    await (client as any).executeCloseSignal(
      openSignal({ id: 'close-1', action: 'close', quantity: 1, metadata: { exchange: 'deribit' } }),
      null,
    )

    // Exactly the filled 4 booked — not the requested 10.
    const exits = db.fills.filter((f) => f.kind === 'exit')
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatchObject({ qty: 4, price: 61000 })
    const exec = db.getSignalExecution('sig-1')
    expect(exec?.qty_closed).toBe(4)
    expect(exec?.status).toBe('closing')
    expect(exec?.qty_pending_close).toBe(6) // remainder owed
    // Position NOT retired, close signal NOT acked executed.
    expect(db.closedEntries).toHaveLength(0)
    expect(db.lastStatus().status).toBe('pending')
  })

  it('still books a fully-filled close as before (no behavior change)', async () => {
    const adapter = new FakeAdapter()
    adapter.positions = [{ id: 'p', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 10, entryPrice: 60000 }]
    adapter.placeImpl = () => ({ orderId: 'c-full', status: 'pending' })
    adapter.statusScript = [
      { orderId: 'c-full', state: 'filled', filledQuantity: 10, averagePrice: 61000 },
    ]
    const entries = [{ id: 'sig-1', symbol: 'BTC-PERPETUAL', action: 'buy', quantity: 10, stop_loss_order_id: null, take_profit_order_id: null, metadata: null }]
    const { db, client } = build(adapter, entries)
    db.insertSignalExecution({ signalId: 'sig-1', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 10 })

    await (client as any).executeCloseSignal(
      openSignal({ id: 'close-1', action: 'close', quantity: 1, metadata: { exchange: 'deribit' } }),
      null,
    )

    expect(db.fills.filter((f) => f.kind === 'exit')).toHaveLength(1)
    expect(db.getSignalExecution('sig-1')?.status).toBe('closed')
    expect(db.closedEntries.map((e) => e.id)).toContain('sig-1')
    expect(db.lastStatus().status).toBe('executed')
  })
})

// ── resolveUnknownOrders ──────────────────────────────────────────────────────

describe('resolveUnknownOrders', () => {
  it('resolves an unknown entry as filled and opens the execution', async () => {
    const adapter = new FakeAdapter()
    adapter.statusScript = [{ orderId: 'ord-x', state: 'filled', filledQuantity: 4, averagePrice: 5000 }]
    const { db, client } = build(adapter)
    db.insertSignalExecution({ signalId: 'sig-1', symbol: 'MESM26', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 0 })
    db.insertOrderSettlement({ signalId: 'sig-1', exchange: 'deribit', symbol: 'MESM26', kind: 'entry', side: 'buy', qty: 4, orderId: 'ord-x' })

    const resolved = await client.resolveUnknownOrders()
    expect(resolved).toBe(1)
    expect(db.settlements[0].status).toBe('filled')
    expect(db.getSignalExecution('sig-1')?.qty_opened).toBe(4)
    expect(db.fills.some((f) => f.kind === 'entry')).toBe(true)
  })

  it('resolves an unknown entry as cancelled → execution error', async () => {
    const adapter = new FakeAdapter()
    adapter.statusScript = [{ orderId: 'ord-x', state: 'cancelled' }]
    const { db, client } = build(adapter)
    db.insertSignalExecution({ signalId: 'sig-1', symbol: 'MESM26', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 0 })
    db.insertOrderSettlement({ signalId: 'sig-1', exchange: 'deribit', symbol: 'MESM26', kind: 'entry', side: 'buy', qty: 4, orderId: 'ord-x' })

    await client.resolveUnknownOrders()
    expect(db.getSignalExecution('sig-1')?.status).toBe('error')
    expect(db.settlements[0].status).toBe('cancelled')
  })

  it('leaves a still-working unknown order untouched', async () => {
    const adapter = new FakeAdapter()
    adapter.statusScript = [{ orderId: 'ord-x', state: 'working' }]
    const { db, client } = build(adapter)
    db.insertSignalExecution({ signalId: 'sig-1', symbol: 'MESM26', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 0 })
    db.insertOrderSettlement({ signalId: 'sig-1', exchange: 'deribit', symbol: 'MESM26', kind: 'entry', side: 'buy', qty: 4, orderId: 'ord-x' })

    const resolved = await client.resolveUnknownOrders()
    expect(resolved).toBe(0)
    expect(db.settlements[0].status).toBe('unknown')
  })

  it('resolves an unknown close as filled → execution closed', async () => {
    const adapter = new FakeAdapter()
    adapter.statusScript = [{ orderId: 'ord-c', state: 'filled', filledQuantity: 4, averagePrice: 5010 }]
    const { db, client } = build(adapter)
    db.insertSignalExecution({ signalId: 'sig-1', symbol: 'MESM26', exchange: 'deribit', direction: 'long', status: 'closing', qtyOpened: 4 })
    db.insertOrderSettlement({ signalId: 'sig-1', exchange: 'deribit', symbol: 'MESM26', kind: 'exit', side: 'sell', qty: 4, orderId: 'ord-c' })

    await client.resolveUnknownOrders()
    expect(db.getSignalExecution('sig-1')?.status).toBe('closed')
    expect(db.closedEntries.map((e) => e.id)).toContain('sig-1')
  })

  // #16 companion: an unknown FRACTIONAL close that resolves as filled must not
  // flatten the books — only the filled qty counts, the execution goes back to
  // 'open' with the remainder still held.
  it('resolves an unknown fractional close without retiring the whole position', async () => {
    const adapter = new FakeAdapter()
    adapter.statusScript = [{ orderId: 'ord-c', state: 'filled', filledQuantity: 4, averagePrice: 5010 }]
    const { db, client } = build(adapter)
    db.insertSignalExecution({ signalId: 'sig-1', symbol: 'MESM26', exchange: 'deribit', direction: 'long', status: 'closing', qtyOpened: 10 })
    db.updateSignalExecution('sig-1', { qtyPendingClose: 4 })
    db.insertOrderSettlement({ signalId: 'sig-1', exchange: 'deribit', symbol: 'MESM26', kind: 'exit', side: 'sell', qty: 4, orderId: 'ord-c' })

    await client.resolveUnknownOrders()
    const exec = db.getSignalExecution('sig-1')
    expect(exec?.status).toBe('open') // 4 of 10 closed → still live
    expect(exec?.qty_closed).toBe(4)
    expect(exec?.qty_pending_close).toBeNull()
    expect(db.closedEntries).toHaveLength(0)
  })
})
