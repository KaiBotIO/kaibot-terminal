import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// ── Fakes ──────────────────────────────────────────────────────────────────

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
  logs: Array<{ level: string; category: string; message: string; metadata?: any }> = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  closedEntries: Array<{ id: string; reason?: string }> = []
  safetyClips: any[] = []
  queue: any[] = []
  fills: any[] = []
  executions = new Map<string, any>()
  private entries: EntryRow[]

  constructor(entries: EntryRow[] = []) {
    this.entries = entries
  }

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }

  getOpenEntrySignals(symbol: string, subFilter?: string): EntryRow[] {
    return this.entries.filter(
      (e) =>
        e.symbol.toLowerCase() === symbol.toLowerCase() &&
        (!subFilter || (e.metadata ?? '').includes(subFilter)),
    )
  }

  markEntrySignalClosed(id: string, reason?: string) {
    this.closedEntries.push({ id, reason })
  }

  updateSignalStatus(id: string, status: string, _tradeId?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }

  logSafetyClip(entry: any) {
    this.safetyClips.push(entry)
  }

  getAccountSize(_ex: string, _acc: string, _root: string): number | null { return null }

  recordSignal() {/* not exercised here */}
  recordSignalQueue(entry: any) { this.queue.push(entry) }

  // ── execution state + fills (migration 007) ──
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

  // ── order settlements + per-target dedup (migration 011) ──
  settlements: any[] = []
  insertOrderSettlement(row: any): number {
    if (row.targetLabel != null) {
      const existing = this.getExitSettlement(row.signalId, row.kind, row.targetLabel)
      if (existing) {
        existing.order_id = row.orderId
        existing.qty = row.qty
        existing.side = row.side
        existing.status = row.status ?? 'unknown'
        existing.resolved_at = null
        return existing.id
      }
    }
    const id = this.settlements.length + 1
    this.settlements.push({
      id,
      signal_id: row.signalId,
      kind: row.kind,
      target_label: row.targetLabel ?? null,
      order_id: row.orderId,
      qty: row.qty,
      side: row.side,
      status: row.status ?? 'unknown',
      resolved_at: null,
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

  // ── resting DCA rungs (migration 026) — none in the close-path fixtures ──
  dcaRestingRungs: any[] = []
  getDcaRestingRungsForSignal(signalId: string): any[] {
    return this.dcaRestingRungs.filter((r) => r.signal_id === signalId)
  }
  deleteDcaRestingRung(orderId: string) {
    this.dcaRestingRungs = this.dcaRestingRungs.filter((r) => r.order_id !== orderId)
  }

  lastStatus() {
    return this.signalStatuses[this.signalStatuses.length - 1]
  }
}

class FakeAdapter {
  name = 'deribit'
  positions: Position[]
  placed: Order[] = []
  cancelled: string[] = []
  placeOrderImpl: ((o: Order) => OrderResult) | null = null
  getPositionsError: Error | null = null

  constructor(positions: Position[] = []) {
    this.positions = positions
  }

  async getPositions(): Promise<Position[]> {
    if (this.getPositionsError) throw this.getPositionsError
    return this.positions
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    this.placed.push(order)
    if (this.placeOrderImpl) return this.placeOrderImpl(order)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: order.quantity }
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.cancelled.push(orderId)
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

function makeCloseSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'close-1',
    strategy_id: 'strat-1',
    symbol: 'BTC-PERPETUAL',
    action: 'close',
    quantity: 1,
    metadata: { exchange: 'deribit', subscriptionId: 'sub-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as Signal
}

function entry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 'entry-1',
    symbol: 'BTC-PERPETUAL',
    action: 'buy',
    quantity: 100,
    stop_loss_order_id: 'sl-1',
    take_profit_order_id: 'tp-1',
    metadata: JSON.stringify({ subscriptionId: 'sub-1' }),
    ...overrides,
  }
}

// Invoke the private close path directly with a resolved subscription.
function runClose(client: SignalWebSocketClient, signal: Signal, sub: any = null) {
  return (client as any).executeCloseSignal(signal, sub)
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SignalWebSocketClient.executeCloseSignal', () => {
  let db: FakeDb
  let adapter: FakeAdapter
  let manager: FakeExchangeManager
  let client: SignalWebSocketClient

  const buildClient = (positions: Position[], entries: EntryRow[]) => {
    db = new FakeDb(entries)
    adapter = new FakeAdapter(positions)
    manager = new FakeExchangeManager(adapter)
    client = new SignalWebSocketClient(db as any, manager as any, null)
  }

  const longPosition = (size: number): Position => ({
    id: 'deribit:BTC-PERPETUAL',
    accountId: 'btc',
    symbol: 'BTC-PERPETUAL',
    side: 'long',
    size,
    entryPrice: 60000,
  })

  // Regression (full-review 2026-07-04, crit): a COMPOSITE close ('BTC') remaps
  // signal.symbol to the venue symbol ('BTC-PERPETUAL') before the entry lookup,
  // but entries are recorded under the canonical symbol. Querying by the venue
  // symbol found nothing → brackets never cancelled, exits never attributed. The
  // lookup must use the canonical symbol. Entry seeded as 'BTC', close as 'BTC'.
  it('matches canonical-symbol entries when closing a composite signal', async () => {
    buildClient([longPosition(100)], [entry({ symbol: 'BTC' })])
    await runClose(client, makeCloseSignal({ symbol: 'BTC' }))
    // The entry was found via its canonical symbol → its bracket legs cancelled
    // and the entry marked closed.
    expect(db.closedEntries.map((e) => e.id)).toContain('entry-1')
    expect(adapter.cancelled).toEqual(expect.arrayContaining(['sl-1', 'tp-1']))
  })

  it('full-closes a long position with a reduce-only market sell on the opposite side', async () => {
    buildClient([longPosition(100)], [entry()])
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed).toHaveLength(1)
    const order = adapter.placed[0]
    expect(order.side).toBe('sell')
    expect(order.orderType).toBe('market')
    expect(order.reduceOnly).toBe(true)
    expect(order.quantity).toBe(100)
    expect(order.label).toBe('kaibot:close-1:close')

    expect(db.lastStatus()).toEqual({ id: 'close-1', status: 'executed', error: 'position closed' })
    expect(db.closedEntries.map((e) => e.id)).toContain('entry-1')
  })

  it('treats the placeholder quantity 1 as a full flatten, not a 1-contract partial', async () => {
    buildClient([longPosition(100)], [entry()])
    // Systematic exit signals carry quantity 1 as a placeholder.
    await runClose(client, makeCloseSignal({ quantity: 1 }), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed[0].quantity).toBe(100)
    expect(db.closedEntries.map((e) => e.id)).toContain('entry-1')
  })

  it('closes a short position with a reduce-only buy', async () => {
    const short: Position = { ...longPosition(50), side: 'short' }
    buildClient([short], [entry({ action: 'sell' })])
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed[0].side).toBe('buy')
    expect(adapter.placed[0].quantity).toBe(50)
  })

  it('cancels outstanding bracket siblings before placing the close', async () => {
    buildClient([longPosition(100)], [entry({ stop_loss_order_id: 'sl-9', take_profit_order_id: 'tp-9' })])
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.cancelled.sort()).toEqual(['sl-9', 'tp-9'])
    // Brackets cancelled and only the close order placed.
    expect(adapter.placed).toHaveLength(1)
  })

  // Regression (B2, phantom-position guard): a resting DCA scale-in add left
  // over from the entry must be cancelled on close, or a same-side rung could
  // fill AFTER the position closed into a naked, bracket-less position on a
  // non-reconciled crypto venue. Red before: close ignored resting rungs.
  it('cancels orphaned resting DCA rungs for the closed entry signals', async () => {
    buildClient([longPosition(100)], [entry({ stop_loss_order_id: null, take_profit_order_id: null })])
    db.dcaRestingRungs = [
      { order_id: 'dca-r1', signal_id: 'entry-1', symbol: 'BTC-PERPETUAL', account_id: 'btc', category: null },
    ]
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    // The resting add is cancelled and forgotten (the close order is separate).
    expect(adapter.cancelled).toContain('dca-r1')
    expect(db.dcaRestingRungs).toHaveLength(0)
  })

  it('does a partial close when the signal carries an explicit closeSize', async () => {
    buildClient([longPosition(100)], [entry()])
    const sig = makeCloseSignal({ metadata: { exchange: 'deribit', subscriptionId: 'sub-1', closeSize: 30 } })
    await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed[0].quantity).toBe(30)
    // Partial close keeps the entry signal open.
    expect(db.closedEntries).toHaveLength(0)
    expect(db.lastStatus().status).toBe('executed')
    expect(db.lastStatus().error).toContain('partial close')
  })

  // C4 regression: a PARTIAL (fraction) close must NOT cancel the protective
  // SL/TP bracket legs. The remaining live position would otherwise be stranded
  // naked — the server refuses stop_update for a partial and the reconciler has
  // no bracket logic on crypto venues, so nothing re-places a stop. The legs are
  // reduce-only, so leaving them (sized for the pre-reduce position) is safe.
  // Red before the fix (brackets cancelled for every close); green after.
  it('keeps the bracket legs on a partial close (does not strand the remainder naked)', async () => {
    buildClient([longPosition(100)], [entry({ stop_loss_order_id: 'sl-keep', take_profit_order_id: 'tp-keep' })])
    const sig = makeCloseSignal({ metadata: { exchange: 'deribit', subscriptionId: 'sub-1', closeSize: 30 } })
    await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

    // Only the reduce-only close order was placed; the SL/TP legs survive.
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.cancelled).not.toContain('sl-keep')
    expect(adapter.cancelled).not.toContain('tp-keep')
    // Entry stays open (position still live).
    expect(db.closedEntries).toHaveLength(0)
  })

  // C4 regression: a partial close must leave the entry's resting DCA scale-in
  // adds in place too (same gate as the brackets) — they belong to the still-open
  // position. Only a full close tears everything down.
  it('keeps resting DCA rungs on a partial close', async () => {
    buildClient([longPosition(100)], [entry({ stop_loss_order_id: null, take_profit_order_id: null })])
    db.dcaRestingRungs = [
      { order_id: 'dca-keep', signal_id: 'entry-1', symbol: 'BTC-PERPETUAL', account_id: 'btc', category: null },
    ]
    const sig = makeCloseSignal({ metadata: { exchange: 'deribit', subscriptionId: 'sub-1', closeSize: 30 } })
    await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.cancelled).not.toContain('dca-keep')
    expect(db.dcaRestingRungs).toHaveLength(1)
  })

  // C4 companion: a FULL close still tears down BOTH brackets and DCA rungs
  // (existing safe behavior preserved by the isFullClose gate).
  it('cancels both bracket legs and resting DCA rungs on a full close', async () => {
    buildClient([longPosition(100)], [entry({ stop_loss_order_id: 'sl-full', take_profit_order_id: 'tp-full' })])
    db.dcaRestingRungs = [
      { order_id: 'dca-full', signal_id: 'entry-1', symbol: 'BTC-PERPETUAL', account_id: 'btc', category: null },
    ]
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.cancelled).toEqual(expect.arrayContaining(['sl-full', 'tp-full', 'dca-full']))
    expect(db.dcaRestingRungs).toHaveLength(0)
    expect(db.closedEntries.map((e) => e.id)).toContain('entry-1')
  })

  it('caps an explicit close size to the live position size (full close)', async () => {
    buildClient([longPosition(40)], [entry()])
    const sig = makeCloseSignal({ metadata: { exchange: 'deribit', subscriptionId: 'sub-1', closeSize: 1000 } })
    await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed[0].quantity).toBe(40)
    expect(db.closedEntries.map((e) => e.id)).toContain('entry-1')
  })

  it('rounds the close quantity to the exchange step size', async () => {
    buildClient([{ ...longPosition(0.0037), symbol: 'BTCUSDT', id: 'bybit:BTCUSDT' }], [
      entry({ symbol: 'BTCUSDT' }),
    ])
    adapter.name = 'bybit'
    const sig = makeCloseSignal({
      symbol: 'BTCUSDT',
      metadata: { exchange: 'bybit', subscriptionId: 'sub-1', closeSize: 0.0037 },
    })
    await runClose(client, sig, { id: 'sub-1', exchange: 'bybit' })

    expect(adapter.placed[0].quantity).toBe(0.003)
  })

  it('reconciles brackets and acks executed when there is no live position', async () => {
    buildClient([], [entry({ stop_loss_order_id: 'sl-x', take_profit_order_id: 'tp-x' })])
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed).toHaveLength(0)
    expect(adapter.cancelled.sort()).toEqual(['sl-x', 'tp-x'])
    expect(db.closedEntries.map((e) => e.id)).toContain('entry-1')
    expect(db.lastStatus()).toEqual({ id: 'close-1', status: 'executed', error: 'no open position' })
  })

  it('rejects the close when the exchange session is not connected', async () => {
    buildClient([longPosition(100)], [entry()])
    manager.status = 'disconnected'
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('session status disconnected')
  })

  it('rejects the close and does not place an order when position lookup fails', async () => {
    buildClient([longPosition(100)], [entry()])
    adapter.getPositionsError = new Error('rate limited')
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('rate limited')
  })

  it('marks the close rejected when the close order itself fails', async () => {
    buildClient([longPosition(100)], [entry()])
    adapter.placeOrderImpl = () => {
      throw new Error('insufficient margin')
    }
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    // Brackets still cancelled, but the entry is not retired since close failed.
    expect(db.closedEntries).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('insufficient margin')
  })

  // ── Privacy regression (size leak, Leak 2): a LIVE close ships ONLY a
  // fraction, never an absolute size. The executor converts fraction × its OWN
  // real live position size locally, so the user's real contract count never
  // has to be sent to the server. Red before the fix (resolveCloseSize ignored
  // fraction → flattened the whole position on any partial); green after.
  describe('privacy: fraction-sized live close (no server-shipped absolute size)', () => {
    it('closes fraction × the REAL live position size for a partial fraction', async () => {
      // Real live size = 80 (deribit BTC-PERPETUAL step = 10, so pick a fraction
      // that lands on the step: 0.25 × 80 = 20).
      buildClient([longPosition(80)], [entry()])
      // Server sends fraction only — NO closeSize/size absolute.
      const sig = makeCloseSignal({
        metadata: { exchange: 'deribit', subscriptionId: 'sub-1', fraction: 0.25 },
      })
      await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

      // 0.25 × 80 (the executor's real size), computed locally — NOT a flatten.
      expect(adapter.placed[0].quantity).toBe(20)
      // A partial leaves the entry open.
      expect(db.closedEntries).toHaveLength(0)
      expect(db.lastStatus().error).toContain('partial close')
    })

    it('flattens the whole real position when fraction >= 1', async () => {
      buildClient([longPosition(80)], [entry()])
      const sig = makeCloseSignal({
        metadata: { exchange: 'deribit', subscriptionId: 'sub-1', fraction: 1 },
      })
      await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

      expect(adapter.placed[0].quantity).toBe(80)
      expect(db.closedEntries.map((e) => e.id)).toContain('entry-1')
    })

    it('fraction is resolved against the live size, independent of the wire quantity', async () => {
      // The wire quantity stays the placeholder 1; only fraction drives sizing.
      buildClient([longPosition(40)], [entry()])
      const sig = makeCloseSignal({
        quantity: 1,
        metadata: { exchange: 'deribit', subscriptionId: 'sub-1', fraction: 0.5 },
      })
      await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

      // 0.5 × 40 = 20, not 1 (the wire quantity) and not 40 (a flatten).
      expect(adapter.placed[0].quantity).toBe(20)
    })

    // B3-live: a RAW strategy scale-out close carries metadata.fraction with NO
    // positionId (the multi-position routing fraction the other tests exercise
    // also has no positionId, but this documents the raw-exit shape explicitly).
    // The executor must honor it via the SAME resolveCloseSize path, end-to-end:
    // fraction × the real live size, computed locally, no server-shipped absolute.
    // ETH-PERPETUAL (step 1) so 0.4 × 80 = 32 lands on-step and the assertion is
    // exact (BTC-PERPETUAL step 10 would round it to 30).
    it('honors a raw strategy scale-out close carrying metadata.fraction with NO positionId', async () => {
      const ethPosition: Position = {
        id: 'deribit:ETH-PERPETUAL',
        accountId: 'eth',
        symbol: 'ETH-PERPETUAL',
        side: 'long',
        size: 80,
        entryPrice: 3000,
      }
      buildClient([ethPosition], [entry({ symbol: 'ETH-PERPETUAL' })])
      const sig = makeCloseSignal({
        symbol: 'ETH-PERPETUAL',
        // Raw exit: fraction only, no positionId, no absolute size.
        metadata: { exchange: 'deribit', subscriptionId: 'sub-1', fraction: 0.4 },
      })
      await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

      // 0.4 × 80 = 32, a reduce-only market close on the opposite side.
      expect(adapter.placed).toHaveLength(1)
      expect(adapter.placed[0].quantity).toBe(32)
      expect(adapter.placed[0].reduceOnly).toBe(true)
      expect(adapter.placed[0].side).toBe('sell')
      // A partial scale-out leaves the entry open.
      expect(db.closedEntries).toHaveLength(0)
      expect(db.lastStatus().error).toContain('partial close')
    })

    // B3-live back-compat: no fraction/closeSize/size → full flatten, byte-for-
    // byte the current behavior (resolveCloseSize returns the whole live size).
    it('flattens the whole live position when the raw close carries no fraction', async () => {
      buildClient([longPosition(80)], [entry()])
      const sig = makeCloseSignal({
        metadata: { exchange: 'deribit', subscriptionId: 'sub-1' },
      })
      await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

      expect(adapter.placed[0].quantity).toBe(80)
      expect(db.closedEntries.map((e) => e.id)).toContain('entry-1')
    })

    // Leak 2 (part 3): the executor must never ack the real filled SIZE back to
    // the server — only price/time/order ids. positions.size stays the factor.
    it('does not send fillSize in the ack-to-API body', () => {
      const src = readFileSync(new URL('./signal-client.ts', import.meta.url).pathname, 'utf8')
      // No `fillSize:` key on the ackToApi POST body.
      expect(/fillSize:/.test(src)).toBe(false)
    })
  })

  it('only targets entries matching the subscription filter', async () => {
    const entries = [
      entry({ id: 'entry-a', metadata: JSON.stringify({ subscriptionId: 'sub-1' }), stop_loss_order_id: 'sl-a', take_profit_order_id: null }),
      entry({ id: 'entry-b', metadata: JSON.stringify({ subscriptionId: 'sub-2' }), stop_loss_order_id: 'sl-b', take_profit_order_id: null }),
    ]
    buildClient([longPosition(100)], entries)
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    // Only the matching subscription's bracket leg is cancelled / entry closed.
    expect(adapter.cancelled).toEqual(['sl-a'])
    expect(db.closedEntries.map((e) => e.id)).toEqual(['entry-a'])
  })

  // Bot-scoped close fraction (multi-close residue): the server computes a
  // bot-scoped partial close as metadata.fraction; the executor must apply that
  // fraction to the bot's OWN tracked book (open executions net of closes),
  // never to the venue-wide net position — unrelated same-side exposure must
  // not be over-closed, and a hedged (netted-down) book must not under-close.
  describe('bot-scoped close fraction (own book, not venue-wide net)', () => {
    const seedExec = (id: string, qtyOpened: number, qtyClosed = 0) => {
      db.executions.set(id, {
        signal_id: id,
        status: 'open',
        qty_opened: qtyOpened,
        qty_closed: qtyClosed,
      })
    }

    it('sizes a fraction against the bot book, not the venue net (no over-close)', async () => {
      // Venue holds 100 long, but only 40 belongs to this bot — the other 60 is
      // unrelated same-side exposure (another bot / manual).
      buildClient([longPosition(100)], [entry()])
      seedExec('entry-1', 40)
      const sig = makeCloseSignal({
        metadata: { exchange: 'deribit', subscriptionId: 'sub-1', fraction: 0.5 },
      })
      await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

      // 0.5 × 40 (the bot's book) = 20 — NOT 0.5 × 100 = 50.
      expect(adapter.placed[0].quantity).toBe(20)
      expect(db.closedEntries).toHaveLength(0) // partial of the bot's book
    })

    it('fraction 1 closes exactly the bot book and retires it despite unrelated exposure', async () => {
      buildClient([longPosition(100)], [entry()])
      seedExec('entry-1', 40)
      const sig = makeCloseSignal({
        metadata: { exchange: 'deribit', subscriptionId: 'sub-1', fraction: 1 },
      })
      await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

      // Closes the bot's 40 — never flattens the stranger 60.
      expect(adapter.placed[0].quantity).toBe(40)
      // The bot's WHOLE book closed → its entries retire and its bracket legs
      // cancel, even though the venue position stays alive.
      expect(db.closedEntries.map((e) => e.id)).toContain('entry-1')
      expect(adapter.cancelled).toEqual(expect.arrayContaining(['sl-1', 'tp-1']))
    })

    it('a hedged (netted-down) venue position does not shrink the fraction base (no under-close)', async () => {
      // The bot tracks 10 long, but opposing exposure netted the venue down to
      // 4. fraction 0.5 targets 5 of the bot's book; the venue can only reduce
      // 4 → close 4, NOT 0.5 × 4 = 2. (ETH-PERPETUAL: step 1.)
      const ethPos: Position = {
        id: 'deribit:ETH-PERPETUAL',
        accountId: 'eth',
        symbol: 'ETH-PERPETUAL',
        side: 'long',
        size: 4,
        entryPrice: 3000,
      }
      buildClient([ethPos], [entry({ symbol: 'ETH-PERPETUAL' })])
      seedExec('entry-1', 10)
      const sig = makeCloseSignal({
        symbol: 'ETH-PERPETUAL',
        metadata: { exchange: 'deribit', subscriptionId: 'sub-1', fraction: 0.5 },
      })
      await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

      expect(adapter.placed[0].quantity).toBe(4)
    })

    it('falls back to the venue position when the bot book is untracked (legacy)', async () => {
      buildClient([longPosition(100)], [entry()]) // no execution rows seeded
      const sig = makeCloseSignal({
        metadata: { exchange: 'deribit', subscriptionId: 'sub-1', fraction: 0.5 },
      })
      await runClose(client, sig, { id: 'sub-1', exchange: 'deribit' })

      expect(adapter.placed[0].quantity).toBe(50) // 0.5 × venue 100
    })
  })
})
