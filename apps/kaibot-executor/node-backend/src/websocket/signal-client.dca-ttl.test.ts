import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal, DcaRestingRungRow } from '../storage/types.js'
import type { Order, OrderResult, OrderStatus, Position } from '../services/exchanges/types.js'

// ── Fakes ──────────────────────────────────────────────────────────────────
// Focused harness for the resting-DCA-rung lifecycle: placeDcaRungs (rest vs
// fill), expireDcaRungs (TTL / settle / drop) and cancelRestingDcaRungsForSignals.

class FakeDb {
  logs: Array<{ level: string; category: string; message: string; metadata?: any }> = []
  fills: any[] = []
  executions = new Map<string, any>()
  dcaRestingRungs = new Map<string, DcaRestingRungRow>()
  botConfigs: any[] = []

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }

  getBotConfigs(_onlyRunning = true): any[] {
    return this.botConfigs
  }

  getSignalExecution(id: string) {
    return this.executions.get(id)
  }
  seedExecution(id: string, qtyOpened: number) {
    this.executions.set(id, { signal_id: id, qty_opened: qtyOpened, qty_closed: 0, status: 'open' })
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

  insertDcaRestingRung(row: {
    orderId: string
    signalId: string
    exchange: string
    accountId?: string | null
    symbol: string
    category?: string | null
    side: 'buy' | 'sell'
    qty: number
    price?: number | null
    expiresAt?: number | null
  }): void {
    this.dcaRestingRungs.set(row.orderId, {
      order_id: row.orderId,
      signal_id: row.signalId,
      exchange: row.exchange,
      account_id: row.accountId ?? null,
      symbol: row.symbol,
      category: row.category ?? null,
      side: row.side,
      qty: row.qty,
      price: row.price ?? null,
      filled_qty: 0,
      expires_at: row.expiresAt ?? null,
      created_at: Date.now(),
    })
  }
  setDcaRestingRungFilledQty(orderId: string, filledQty: number): void {
    const row = this.dcaRestingRungs.get(orderId)
    if (row) row.filled_qty = filledQty
  }
  listDcaRestingRungs(exchange?: string): DcaRestingRungRow[] {
    const all = [...this.dcaRestingRungs.values()]
    return exchange ? all.filter((r) => r.exchange === exchange) : all
  }
  getDcaRestingRungsForSignal(signalId: string): DcaRestingRungRow[] {
    return [...this.dcaRestingRungs.values()].filter((r) => r.signal_id === signalId)
  }
  deleteDcaRestingRung(orderId: string): void {
    this.dcaRestingRungs.delete(orderId)
  }
}

class FakeAdapter {
  name = 'deribit'
  placed: Order[] = []
  cancelled: string[] = []
  getOrderStatusCalls: string[] = []
  placeOrderImpl: ((o: Order) => OrderResult) | null = null
  cancelImpl: ((id: string) => void) | null = null
  orderStatuses = new Map<string, OrderStatus>()

  async getPositions(): Promise<Position[]> {
    return []
  }
  async placeOrder(order: Order): Promise<OrderResult> {
    this.placed.push(order)
    if (this.placeOrderImpl) return this.placeOrderImpl(order)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: order.quantity }
  }
  async cancelOrder(orderId: string): Promise<void> {
    if (this.cancelImpl) return this.cancelImpl(orderId)
    this.cancelled.push(orderId)
  }
  async getOrderStatus(orderId: string): Promise<OrderStatus> {
    this.getOrderStatusCalls.push(orderId)
    return this.orderStatuses.get(orderId) ?? { orderId, state: 'working' }
  }
}

class FakeExchangeManager {
  adapter: FakeAdapter
  status: 'connected' | 'disconnected' = 'connected'
  constructor(adapter: FakeAdapter) {
    this.adapter = adapter
  }
  async getSession(_userId: string, _exchangeName: string) {
    return { adapter: this.adapter, status: this.status, userId: 'default', exchangeName: this.adapter.name }
  }
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol: 'BTC-PERPETUAL',
    action: 'buy',
    metadata: { exchange: 'deribit', signalBotId: 'bot-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as Signal
}

let db: FakeDb
let adapter: FakeAdapter
let manager: FakeExchangeManager
let client: SignalWebSocketClient

function build() {
  db = new FakeDb()
  adapter = new FakeAdapter()
  manager = new FakeExchangeManager(adapter)
  client = new SignalWebSocketClient(db as any, manager as any, null)
}

const RUNG = { price: 95, qty: 20 }

// ── placeDcaRungs: rest vs fill ──────────────────────────────────────────────

describe('placeDcaRungs resting-rung lifecycle', () => {
  it('tracks an unfilled rung instead of settling/cancelling it', async () => {
    build()
    // A limit add that rests (not immediately filled) at the venue.
    adapter.placeOrderImpl = () => ({ orderId: 'rung-1', status: 'pending' })
    db.botConfigs = [{ signalBotId: 'bot-1', timeframe: '1h' }]
    const signal = makeSignal({ order_plan: { entries: [{ size: 1 }, { price: 95, size: 1 }], ttlBars: 3 } })

    await (client as any).placeDcaRungs(adapter, signal, 'buy', 'BTC-PERPETUAL', 'deribit', 'btc', [RUNG], 50)

    // Persisted as a resting rung; NOT cancelled by any settle window.
    const row = db.dcaRestingRungs.get('rung-1')
    expect(row).toBeDefined()
    expect(row!.qty).toBe(20)
    expect(row!.signal_id).toBe('sig-1')
    expect(adapter.cancelled).toEqual([])
    // ttlBars=3 × 1h resolved from the bot config → a real wall-clock expiry.
    expect(row!.expires_at).not.toBeNull()
    expect(row!.expires_at! > Date.now()).toBe(true)
    // No fill recorded for a rung that only rested.
    expect(db.fills).toHaveLength(0)
  })

  it('stores a null expiry when ttlBars / bar duration is unresolvable (cancel-on-close only)', async () => {
    build()
    adapter.placeOrderImpl = () => ({ orderId: 'rung-2', status: 'pending' })
    // No bot config + no metadata.timeframe → bar duration unknown.
    const signal = makeSignal({ order_plan: { ttlBars: 3 } })

    await (client as any).placeDcaRungs(adapter, signal, 'buy', 'BTC-PERPETUAL', 'deribit', 'btc', [RUNG], 50)

    expect(db.dcaRestingRungs.get('rung-2')!.expires_at).toBeNull()
  })

  it('prefers metadata.timeframe over the bot-config timeframe for the expiry basis', async () => {
    build()
    adapter.placeOrderImpl = () => ({ orderId: 'rung-tf', status: 'pending' })
    const before = Date.now()
    const signal = makeSignal({
      metadata: { exchange: 'deribit', signalBotId: 'bot-1', timeframe: '1m' },
      order_plan: { ttlBars: 2 },
    })

    await (client as any).placeDcaRungs(adapter, signal, 'buy', 'BTC-PERPETUAL', 'deribit', 'btc', [RUNG], 50)

    const exp = db.dcaRestingRungs.get('rung-tf')!.expires_at!
    // 2 × 1m = 120_000 ms from placement, not the (absent) bot-config basis.
    expect(exp - before).toBeGreaterThanOrEqual(120_000)
    expect(exp - before).toBeLessThan(120_000 + 5_000)
  })

  it('records an immediately-filled rung as an entry fill and does NOT track it', async () => {
    build()
    db.seedExecution('sig-1', 50)
    adapter.placeOrderImpl = () => ({ orderId: 'rung-f', status: 'filled', filledQuantity: 20, averagePrice: 96 })
    const signal = makeSignal({ order_plan: { ttlBars: 3 } })

    await (client as any).placeDcaRungs(adapter, signal, 'buy', 'BTC-PERPETUAL', 'deribit', 'btc', [RUNG], 50)

    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ signalId: 'sig-1', kind: 'entry', qty: 20, price: 96 })
    // Accumulated onto qty_opened (50 + 20).
    expect(db.executions.get('sig-1').qty_opened).toBe(70)
    // A filled rung is never persisted as resting.
    expect(db.dcaRestingRungs.size).toBe(0)
  })
})

// ── expireDcaRungs: TTL / settle / drop ──────────────────────────────────────

describe('expireDcaRungs', () => {
  const seedRung = (over: Partial<DcaRestingRungRow> & { order_id: string }) =>
    db.insertDcaRestingRung({
      orderId: over.order_id,
      signalId: over.signal_id ?? 'sig-1',
      exchange: over.exchange ?? 'deribit',
      accountId: over.account_id ?? 'btc',
      symbol: over.symbol ?? 'BTC-PERPETUAL',
      category: over.category ?? null,
      side: (over.side as 'buy' | 'sell') ?? 'buy',
      qty: over.qty ?? 20,
      price: over.price ?? 95,
      expiresAt: over.expires_at ?? null,
    })

  it('cancels a working rung past its TTL and stops tracking it', async () => {
    build()
    seedRung({ order_id: 'r-exp', expires_at: Date.now() - 1000 })
    adapter.orderStatuses.set('r-exp', { orderId: 'r-exp', state: 'working' })

    const acted = await (client as any).expireDcaRungs()

    expect(adapter.cancelled).toContain('r-exp')
    expect(db.dcaRestingRungs.has('r-exp')).toBe(false)
    expect(acted).toBe(1)
  })

  it('leaves a working rung whose TTL has not elapsed', async () => {
    build()
    seedRung({ order_id: 'r-fut', expires_at: Date.now() + 60_000 })
    adapter.orderStatuses.set('r-fut', { orderId: 'r-fut', state: 'working' })

    await (client as any).expireDcaRungs()

    expect(adapter.cancelled).not.toContain('r-fut')
    expect(db.dcaRestingRungs.has('r-fut')).toBe(true)
  })

  it('never time-cancels a rung with a null expiry', async () => {
    build()
    seedRung({ order_id: 'r-null', expires_at: null })
    adapter.orderStatuses.set('r-null', { orderId: 'r-null', state: 'working' })

    await (client as any).expireDcaRungs()

    expect(adapter.cancelled).not.toContain('r-null')
    expect(db.dcaRestingRungs.has('r-null')).toBe(true)
  })

  it('settles a rung that filled while resting and deletes it', async () => {
    build()
    db.seedExecution('sig-x', 50)
    seedRung({ order_id: 'r-fill', signal_id: 'sig-x', expires_at: null, qty: 20 })
    adapter.orderStatuses.set('r-fill', { orderId: 'r-fill', state: 'filled', filledQuantity: 20, averagePrice: 96 })

    await (client as any).expireDcaRungs()

    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ signalId: 'sig-x', kind: 'entry', qty: 20, price: 96 })
    expect(db.executions.get('sig-x').qty_opened).toBe(70)
    expect(db.dcaRestingRungs.has('r-fill')).toBe(false)
    expect(adapter.cancelled).not.toContain('r-fill')
  })

  it('drops a definitively terminal (cancelled / rejected) rung with no fill', async () => {
    build()
    seedRung({ order_id: 'r-cancel', expires_at: null })
    seedRung({ order_id: 'r-reject', expires_at: null })
    adapter.orderStatuses.set('r-cancel', { orderId: 'r-cancel', state: 'cancelled' })
    adapter.orderStatuses.set('r-reject', { orderId: 'r-reject', state: 'rejected' })

    await (client as any).expireDcaRungs()

    expect(db.dcaRestingRungs.has('r-cancel')).toBe(false)
    expect(db.dcaRestingRungs.has('r-reject')).toBe(false)
    expect(db.fills).toHaveLength(0)
    expect(adapter.cancelled).toEqual([])
  })

  // Regression: a transient 'unknown' (exchange hiccup / propagation lag) must
  // NOT drop a still-live resting rung — it stays tracked for a retry, while a
  // genuinely terminal status in the same sweep still settles/drops.
  it('keeps tracking an unknown rung (non-terminal) but still drops a terminal one', async () => {
    build()
    // Not past TTL, so no time-based expiry can fire here.
    seedRung({ order_id: 'r-unknown', expires_at: Date.now() + 60_000 })
    seedRung({ order_id: 'r-cancel', expires_at: null })
    adapter.orderStatuses.set('r-unknown', { orderId: 'r-unknown', state: 'unknown' })
    adapter.orderStatuses.set('r-cancel', { orderId: 'r-cancel', state: 'cancelled' })

    const acted = await (client as any).expireDcaRungs()

    // Transient 'unknown' → still tracked, not cancelled, no phantom fill.
    expect(db.dcaRestingRungs.has('r-unknown')).toBe(true)
    expect(adapter.cancelled).not.toContain('r-unknown')
    // Genuinely terminal → dropped.
    expect(db.dcaRestingRungs.has('r-cancel')).toBe(false)
    expect(db.fills).toHaveLength(0)
    // Only the terminal cancel counted as acted-on; the unknown rung did not.
    expect(acted).toBe(1)
  })

  it('still TTL-expires an unknown rung once past its expiry (TTL preserved)', async () => {
    build()
    seedRung({ order_id: 'r-unknown-exp', expires_at: Date.now() - 1000 })
    adapter.orderStatuses.set('r-unknown-exp', { orderId: 'r-unknown-exp', state: 'unknown' })

    const acted = await (client as any).expireDcaRungs()

    expect(adapter.cancelled).toContain('r-unknown-exp')
    expect(db.dcaRestingRungs.has('r-unknown-exp')).toBe(false)
    expect(acted).toBe(1)
  })

  // #13 regression: a rung PARTIALLY filled while still resting (e.g. Bybit
  // 'PartiallyFilled' — a live status) was treated as terminal: the fill was
  // booked and tracking dropped while the residual still rested at the broker.
  // The partial must be booked as a delta and the row KEPT for the residual.
  it('books a partial fill of a still-resting rung and keeps tracking the residual', async () => {
    build()
    db.seedExecution('sig-p', 50)
    seedRung({ order_id: 'r-part', signal_id: 'sig-p', expires_at: Date.now() + 60_000, qty: 20 })
    adapter.orderStatuses.set('r-part', {
      orderId: 'r-part',
      state: 'partially_filled',
      filledQuantity: 8,
      averagePrice: 96,
    })

    await (client as any).expireDcaRungs()

    // Partial booked, residual STILL TRACKED, nothing cancelled.
    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ signalId: 'sig-p', kind: 'entry', qty: 8, price: 96 })
    expect(db.executions.get('sig-p').qty_opened).toBe(58)
    expect(db.dcaRestingRungs.has('r-part')).toBe(true)
    expect(db.dcaRestingRungs.get('r-part')!.filled_qty).toBe(8)
    expect(adapter.cancelled).toEqual([])

    // A second sweep with the same cumulative fill books NOTHING extra.
    await (client as any).expireDcaRungs()
    expect(db.fills).toHaveLength(1)

    // The rung later completes: only the 12 delta is booked, then dropped.
    adapter.orderStatuses.set('r-part', {
      orderId: 'r-part',
      state: 'filled',
      filledQuantity: 20,
      averagePrice: 97,
    })
    await (client as any).expireDcaRungs()
    expect(db.fills).toHaveLength(2)
    expect(db.fills[1]).toMatchObject({ signalId: 'sig-p', kind: 'entry', qty: 12, price: 97 })
    expect(db.executions.get('sig-p').qty_opened).toBe(70)
    expect(db.dcaRestingRungs.has('r-part')).toBe(false)
  })

  // #13 companion: a partially-filled rung past its TTL still cancels — but only
  // after its partial is booked, and only the residual is killed.
  it('TTL-cancels the residual of a partially-filled rung after booking the partial', async () => {
    build()
    db.seedExecution('sig-pt', 50)
    seedRung({ order_id: 'r-part-ttl', signal_id: 'sig-pt', expires_at: Date.now() - 1000, qty: 20 })
    adapter.orderStatuses.set('r-part-ttl', {
      orderId: 'r-part-ttl',
      state: 'partially_filled',
      filledQuantity: 8,
      averagePrice: 96,
    })

    await (client as any).expireDcaRungs()

    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ signalId: 'sig-pt', kind: 'entry', qty: 8 })
    expect(adapter.cancelled).toContain('r-part-ttl')
    expect(db.dcaRestingRungs.has('r-part-ttl')).toBe(false)
    // The post-cancel residual check saw the same cumulative 8 → no double-book.
    expect(db.executions.get('sig-pt').qty_opened).toBe(58)
  })

  // #37 regression: a cancelled rung may carry a partial fill (Bybit
  // 'PartiallyFilledCanceled' maps to cancelled with cumExecQty > 0). Dropping
  // the row without booking it left the live position bigger than the books.
  it('books the filled portion of a PartiallyFilledCanceled rung before dropping it', async () => {
    build()
    db.seedExecution('sig-pfc', 50)
    seedRung({ order_id: 'r-pfc', expires_at: null, signal_id: 'sig-pfc', qty: 20 })
    adapter.orderStatuses.set('r-pfc', {
      orderId: 'r-pfc',
      state: 'cancelled',
      filledQuantity: 8,
      averagePrice: 96,
    })

    const acted = await (client as any).expireDcaRungs()

    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ signalId: 'sig-pfc', kind: 'entry', qty: 8, price: 96 })
    expect(db.executions.get('sig-pfc').qty_opened).toBe(58)
    expect(db.dcaRestingRungs.has('r-pfc')).toBe(false)
    expect(acted).toBe(1)
  })

  // C3 regression: a TTL-expiry cancel that THROWS while the rung actually filled
  // (venue race) must book the fill, not silently drop the tracking row.
  it('books the fill when the TTL-expiry cancel throws but the rung had filled', async () => {
    build()
    db.seedExecution('sig-race', 50)
    // Initial sweep status is 'working' (falls through to the TTL branch); the
    // cancel then throws 'already filled' and the re-check reports it filled.
    seedRung({ order_id: 'r-race', signal_id: 'sig-race', expires_at: Date.now() - 1000, qty: 20 })
    adapter.orderStatuses.set('r-race', { orderId: 'r-race', state: 'working' })
    adapter.cancelImpl = () => {
      // Flip the venue view to filled, then reject the cancel as too-late.
      adapter.orderStatuses.set('r-race', {
        orderId: 'r-race',
        state: 'filled',
        filledQuantity: 20,
        averagePrice: 96,
      })
      throw new Error('order already filled')
    }

    const acted = await (client as any).expireDcaRungs()

    // Fill booked (not lost), tracking row dropped, execution accumulated.
    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ signalId: 'sig-race', kind: 'entry', qty: 20, price: 96 })
    expect(db.executions.get('sig-race').qty_opened).toBe(70)
    expect(db.dcaRestingRungs.has('r-race')).toBe(false)
    expect(acted).toBe(1)
  })

  // C3 regression: a TTL-expiry cancel that throws while the venue still reports
  // the order live (timeout hiccup) must KEEP the row for a later retry.
  it('keeps the row when the TTL-expiry cancel throws and the rung is still live', async () => {
    build()
    seedRung({ order_id: 'r-hiccup', expires_at: Date.now() - 1000 })
    // Both the initial sweep and the post-throw re-check see it still working.
    adapter.orderStatuses.set('r-hiccup', { orderId: 'r-hiccup', state: 'working' })
    adapter.cancelImpl = () => {
      throw new Error('cancel request timed out')
    }

    const acted = await (client as any).expireDcaRungs()

    expect(db.dcaRestingRungs.has('r-hiccup')).toBe(true)
    expect(db.fills).toHaveLength(0)
    expect(acted).toBe(0)
  })
})

// ── cancelRestingDcaRungsForSignals (the cancel-on-close guard) ──────────────

describe('cancelRestingDcaRungsForSignals', () => {
  it('cancels + forgets every resting rung for the given signal ids', async () => {
    build()
    db.insertDcaRestingRung({
      orderId: 'r1', signalId: 'entry-1', exchange: 'deribit', accountId: 'btc',
      symbol: 'BTC-PERPETUAL', side: 'buy', qty: 20, price: 95, expiresAt: null,
    })
    db.insertDcaRestingRung({
      orderId: 'r2', signalId: 'entry-1', exchange: 'deribit', accountId: 'btc',
      symbol: 'BTC-PERPETUAL', side: 'buy', qty: 20, price: 90, expiresAt: null,
    })
    // A rung on an UNRELATED signal must be left untouched.
    db.insertDcaRestingRung({
      orderId: 'r3', signalId: 'entry-2', exchange: 'deribit', accountId: 'btc',
      symbol: 'BTC-PERPETUAL', side: 'buy', qty: 20, price: 95, expiresAt: null,
    })

    await (client as any).cancelRestingDcaRungsForSignals('deribit', ['entry-1'])

    expect(adapter.cancelled.sort()).toEqual(['r1', 'r2'])
    expect(db.dcaRestingRungs.has('r1')).toBe(false)
    expect(db.dcaRestingRungs.has('r2')).toBe(false)
    // Untouched signal keeps its rung.
    expect(db.dcaRestingRungs.has('r3')).toBe(true)
  })

  const seedRung = (orderId: string, signalId = 'entry-1') =>
    db.insertDcaRestingRung({
      orderId, signalId, exchange: 'deribit', accountId: 'btc',
      symbol: 'BTC-PERPETUAL', side: 'buy', qty: 20, price: 95, expiresAt: null,
    })

  // C3 regression: the close-path cancel used to delete the rung row
  // UNCONDITIONALLY, even after a cancel throw. A rung that filled in the race
  // (price hit the level as the close fired) would be dropped with the fill never
  // booked → phantom live position, books flat. The fill must be booked instead.
  it('books the fill when the cancel throws because the rung already filled', async () => {
    build()
    db.seedExecution('entry-1', 50)
    seedRung('r-filled')
    adapter.orderStatuses.set('r-filled', {
      orderId: 'r-filled', state: 'filled', filledQuantity: 20, averagePrice: 96,
    })
    adapter.cancelImpl = () => {
      throw new Error('order already filled')
    }

    await (client as any).cancelRestingDcaRungsForSignals('deribit', ['entry-1'])

    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ signalId: 'entry-1', kind: 'entry', qty: 20, price: 96 })
    expect(db.executions.get('entry-1').qty_opened).toBe(70)
    expect(db.dcaRestingRungs.has('r-filled')).toBe(false)
  })

  // C3 regression: cancel throws while the venue still reports the order live
  // (timeout hiccup). The row MUST be kept so a later tick/expire pass retries —
  // an unconditional delete would leave a live limit add untracked.
  it('keeps the row when the cancel throws and the rung is still live', async () => {
    build()
    seedRung('r-live')
    adapter.orderStatuses.set('r-live', { orderId: 'r-live', state: 'working' })
    adapter.cancelImpl = () => {
      throw new Error('cancel timed out')
    }

    await (client as any).cancelRestingDcaRungsForSignals('deribit', ['entry-1'])

    expect(db.dcaRestingRungs.has('r-live')).toBe(true)
    expect(db.fills).toHaveLength(0)
  })

  // C3 regression: cancel throws and the venue reports the order transiently
  // 'unknown' (propagation lag). Not terminal → keep the row, no phantom fill.
  it('keeps the row when the cancel throws and the venue reports unknown', async () => {
    build()
    seedRung('r-unknown')
    adapter.orderStatuses.set('r-unknown', { orderId: 'r-unknown', state: 'unknown' })
    adapter.cancelImpl = () => {
      throw new Error('cancel rejected')
    }

    await (client as any).cancelRestingDcaRungsForSignals('deribit', ['entry-1'])

    expect(db.dcaRestingRungs.has('r-unknown')).toBe(true)
    expect(db.fills).toHaveLength(0)
  })

  // C3 regression: cancel throws and the venue confirms the order is genuinely
  // gone (cancelled/rejected). No fill to book → drop the row.
  it('drops the row when the cancel throws and the venue confirms it cancelled', async () => {
    build()
    seedRung('r-gone')
    adapter.orderStatuses.set('r-gone', { orderId: 'r-gone', state: 'cancelled' })
    adapter.cancelImpl = () => {
      throw new Error('cancel failed')
    }

    await (client as any).cancelRestingDcaRungsForSignals('deribit', ['entry-1'])

    expect(db.dcaRestingRungs.has('r-gone')).toBe(false)
    expect(db.fills).toHaveLength(0)
  })

  // C3 regression: session disconnected mid-close → adapter is null, no cancel is
  // even attempted. The old code still deleted the row; it MUST be kept.
  it('keeps the row when the session is disconnected (no adapter to cancel)', async () => {
    build()
    seedRung('r-nosession')
    manager.status = 'disconnected'

    await (client as any).cancelRestingDcaRungsForSignals('deribit', ['entry-1'])

    expect(db.dcaRestingRungs.has('r-nosession')).toBe(true)
    expect(adapter.cancelled).toEqual([])
    expect(db.fills).toHaveLength(0)
  })
})
