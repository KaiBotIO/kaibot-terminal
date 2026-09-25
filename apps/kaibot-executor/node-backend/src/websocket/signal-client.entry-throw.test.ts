import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import { deriveClientOrderId, toClientOrderRef } from '../services/client-order-id.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, OrderStatus, Position } from '../services/exchanges/types.js'

// EX2 regression: a THROWN placeOrder used to book qty_opened=0 permanently
// (signal_id PK made redelivery a no-op) — a lost response after a real fill
// became an invisible unprotected position. Now the throw path persists an
// order_settlements row keyed by the deterministic client order id, and
// resolveUnknownOrders retro-applies the broker truth.
//
// EX7 regression: every signal-originated order leg carries a deterministic
// clientOrderId derived from (signalId, leg, rung).

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  fills: any[] = []
  executions = new Map<string, any>()
  settlements: any[] = []
  bracketPairs = new Map<string, any>()

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {}
  recordSignalQueue() {}
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  logSafetyClip() {}
  getAccountSize(): number | null {
    return null
  }
  getOpenEntrySignals() {
    return []
  }
  markEntrySignalClosed() {}

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
    if (patch.errorReason !== undefined) row.error_reason = patch.errorReason
  }
  insertSignalFill(fill: any) {
    this.fills.push(fill)
  }

  insertOrderSettlement(row: any) {
    const id = this.settlements.length + 1
    this.settlements.push({
      id,
      status: row.status ?? 'unknown',
      created_at: Date.now(),
      ...row,
      order_id: row.orderId,
      signal_id: row.signalId,
      account_id: row.accountId ?? null,
      target_label: row.targetLabel ?? null,
    })
    return id
  }
  listUnresolvedSettlements(exchange?: string) {
    return this.settlements.filter(
      (s) => s.status === 'unknown' && (!exchange || s.exchange === exchange),
    )
  }
  resolveOrderSettlement(id: number, status: string) {
    const s = this.settlements.find((x) => x.id === id)
    if (s) s.status = status
  }
  upsertBracketPair(row: any) {
    this.bracketPairs.set(row.signalId, row)
  }
  listBracketPairs() {
    return []
  }
  deleteBracketPair() {}
  listClosingExecutions() {
    return []
  }
  targetAlreadyProcessed() {
    return false
  }
  getSignalFills() {
    return []
  }
  getSignalBracket() {
    return undefined
  }
  getDcaRestingRungsForSignal() {
    return []
  }
  listDcaRestingRungs() {
    return []
  }
  insertDcaRestingRung() {}
  lastStatus() {
    return this.signalStatuses[this.signalStatuses.length - 1]
  }
}

class FakeAdapter {
  name = 'deribit'
  alwaysOpen = true
  positions: Position[] = []
  placed: Order[] = []
  placeImpl: ((o: Order) => OrderResult) | null = null
  statusImpl: ((orderId: string) => OrderStatus) | null = null

  async getPositions() {
    return this.positions
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    if (this.placeImpl) return this.placeImpl(o)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity }
  }
  async cancelOrder() {}
  async getOrderStatus(orderId: string): Promise<OrderStatus> {
    if (this.statusImpl) return this.statusImpl(orderId)
    return { orderId, state: 'unknown' }
  }
}

class FakeBus {
  events: any[] = []
  publish(e: any) {
    this.events.push(e)
  }
}

class FakeManager {
  constructor(private adapter: FakeAdapter) {}
  async getSession() {
    return { adapter: this.adapter, status: 'connected', userId: 'default', exchangeName: 'deribit' }
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

function build(adapter: FakeAdapter) {
  const db = new FakeDb()
  const bus = new FakeBus()
  const client = new SignalWebSocketClient(db as any, new FakeManager(adapter) as any, bus as any)
  client.setSettleOptions(2, 1)
  return { db, bus, client }
}

describe('thrown placeOrder → order_settlements backstop (EX2)', () => {
  it('persists an unknown settlement keyed by the client order id', async () => {
    const adapter = new FakeAdapter()
    adapter.placeImpl = () => {
      throw new Error('socket hang up') // response lost — outcome unknown
    }
    const { db, client } = build(adapter)

    await (client as any).handleSignalInner(openSignal())

    // Books say error (blocks later closes on a phantom)…
    expect(db.getSignalExecution('sig-1')?.status).toBe('error')
    expect(db.lastStatus().status).toBe('rejected')
    // …but the attempt is tracked for background resolution, not lost.
    expect(db.settlements).toHaveLength(1)
    expect(db.settlements[0]).toMatchObject({
      kind: 'entry',
      status: 'unknown',
      target_label: 'entry-attempt',
      order_id: toClientOrderRef(deriveClientOrderId('sig-1', 'entry')),
    })
  })

  it('resolveUnknownOrders retro-applies a real fill found by client id', async () => {
    const adapter = new FakeAdapter()
    adapter.placeImpl = () => {
      throw new Error('socket hang up')
    }
    adapter.statusImpl = () => ({
      orderId: 'x',
      state: 'filled',
      filledQuantity: 10,
      averagePrice: 60000,
      raw: { order_id: 'broker-77' },
    })
    const { db, bus, client } = build(adapter)

    await (client as any).handleSignalInner(openSignal())
    const resolved = await client.resolveUnknownOrders()

    expect(resolved).toBe(1)
    const exec = db.getSignalExecution('sig-1')
    expect(exec?.status).toBe('open') // no longer a permanent qty 0 error
    expect(exec?.qty_opened).toBe(10)
    const fill = db.fills.find((f) => f.kind === 'entry')
    expect(fill?.orderId ?? fill?.order_id).toBeDefined()
    expect(fill?.orderId).toBe('broker-77') // real broker id, not the client ref
    expect(db.settlements[0].status).toBe('filled')
    // Operator attention: the books were corrected after the fact.
    expect(bus.events.some((e) => e.title === 'Recovered a lost fill')).toBe(true)
  })

  it('an attempt the broker never saw resolves quietly as rejected after the window', async () => {
    const adapter = new FakeAdapter()
    adapter.placeImpl = () => {
      throw new Error('immediate venue rejection')
    }
    // The venue ANSWERS the lookup and positively reports no such order —
    // only that confirmed absence may auto-reject.
    adapter.statusImpl = (orderId) => ({ orderId, state: 'unknown', absenceConfirmed: true })
    const { db, client } = build(adapter)

    await (client as any).handleSignalInner(openSignal())
    // Backdate the settlement past the 30-minute conclusion window.
    db.settlements[0].created_at = Date.now() - 31 * 60_000

    await client.resolveUnknownOrders()

    expect(db.settlements[0].status).toBe('rejected')
    expect(db.getSignalExecution('sig-1')?.status).toBe('error') // unchanged
  })

  // #14 regression: an 'unknown' from a FAILED/inconclusive lookup (network
  // error, venue hiccup) is NOT a venue confirmation that the order was never
  // placed. Auto-rejecting on it would write off a possibly-live fill — the row
  // must stay unknown for a later pass, however old it is.
  it('a lookup that fails (unconfirmed unknown) never auto-rejects the attempt', async () => {
    const adapter = new FakeAdapter()
    adapter.placeImpl = () => {
      throw new Error('gateway timeout')
    }
    // Lookup reaches no conclusion: unknown WITHOUT absenceConfirmed.
    adapter.statusImpl = (orderId) => ({ orderId, state: 'unknown' })
    const { db, client } = build(adapter)

    await (client as any).handleSignalInner(openSignal())
    db.settlements[0].created_at = Date.now() - 31 * 60_000

    await client.resolveUnknownOrders()

    expect(db.settlements[0].status).toBe('unknown') // kept for the reconciler
  })

  it('within the window the attempt stays tracked (still unknown)', async () => {
    const adapter = new FakeAdapter()
    adapter.placeImpl = () => {
      throw new Error('timeout')
    }
    const { db, client } = build(adapter)

    await (client as any).handleSignalInner(openSignal())
    await client.resolveUnknownOrders()

    expect(db.settlements[0].status).toBe('unknown')
  })
})

describe('deterministic clientOrderId on signal-originated orders (EX7)', () => {
  it('entry, SL and TP legs carry ids derived from (signalId, leg, rung)', async () => {
    const adapter = new FakeAdapter()
    const { client } = build(adapter)

    await (client as any).handleSignalInner(
      openSignal({ stop_loss: 55000, take_profit: 65000 }),
    )

    expect(adapter.placed).toHaveLength(3)
    const [entry, sl, tp] = adapter.placed
    expect(entry.clientOrderId).toBe(deriveClientOrderId('sig-1', 'entry'))
    expect(sl.clientOrderId).toBe(deriveClientOrderId('sig-1', 'sl'))
    expect(tp.clientOrderId).toBe(deriveClientOrderId('sig-1', 'tp', 1))
  })

  it('a redelivered close for the same target derives the same id', async () => {
    const adapter = new FakeAdapter()
    adapter.positions = [
      {
        id: 'p1',
        accountId: 'btc',
        symbol: 'BTC-PERPETUAL',
        side: 'long',
        size: 10,
        entryPrice: 60000,
      },
    ]
    const { client } = build(adapter)

    await (client as any).handleSignalInner(
      openSignal({ id: 'sig-close', action: 'close' as any }),
    )

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].clientOrderId).toBe(
      deriveClientOrderId('sig-close', 'exit:close'),
    )
  })
})
