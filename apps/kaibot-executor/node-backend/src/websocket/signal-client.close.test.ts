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
      account_id: row.accountId ?? null,
    })
    return true
  }
  // Whole-book listing for the lineage-scoped close (R1, 2026-09-05).
  // Live synthetic USD row on (exchange, account, symbol); null = none.
  syntheticRow: { status: string; short_size: number } | null = null
  getLiveSyntheticUsdPosition() {
    return this.syntheticRow
  }
  listOpenExecutionsForExchange(exchange: string) {
    return [...this.executions.values()].filter(
      (e) => e.exchange === exchange && (e.status === 'open' || e.status === 'closing'),
    )
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

  // ── handleSignalInner surface (virtual-close routing test, 2026-09-03) ──
  subForBot: any = null
  getSubscriptionForBot(_botId: string) {
    return this.subForBot
  }
  getSubscription(_id: string) {
    return this.subForBot
  }
  getBotConfigs() {
    return []
  }

  // ── server exit state (migration 031) — retired on close (2026-09-02) ──
  serverExitStates: Array<{ position_id: string; entry_signal_id: string; active: number }> = []
  listActiveServerExitStates() {
    return this.serverExitStates.filter((s) => s.active === 1)
  }
  deactivateServerExitState(positionId: string) {
    for (const s of this.serverExitStates) if (s.position_id === positionId) s.active = 0
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

  // Regression (2026-08-26 Volcap cross-account close, order 1301467781): a
  // close routed via a sub on account A matched ANOTHER account's position on
  // the same contract (symbol-only lookup) and sold on account A — TradeStation
  // has no reduce-only, so it OPENED a short. A sub-scoped close must no-op
  // when its own account is flat, even if a sibling account holds the symbol.
  it('never closes another account\'s position on the same contract (no-op when own account is flat)', async () => {
    buildClient(
      [{ ...longPosition(1), accountId: 'acct-other' }],
      [],
    )
    const sig = makeCloseSignal({ metadata: { exchange: 'deribit' } as any })
    await runClose(client, sig, { id: 'sub-1', account_id: 'acct-own' })
    // No order anywhere; the desired end state (flat on OUR account) holds.
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus()).toMatchObject({ id: 'close-1', status: 'executed' })
  })

  // Regression (2026-08-26 phantom rebuy): live entries carry only signalBotId
  // in their metadata (the server's owner-sub has no subscription row, and the
  // executor-local `local-…` sub id never reaches signal metadata). Filtering on
  // the resolved sub.id alone matched NOTHING → the close booked no qty_closed
  // and the reconciler re-opened the just-closed position 4s later. The close
  // must fall back through the identities it carries until one matches.
  it('falls back to signalBotId when the resolved sub id matches no entry (live metadata shape)', async () => {
    buildClient(
      [longPosition(1)],
      [
        entry({
          id: 'entry-bot',
          metadata: JSON.stringify({ signalBotId: 'bot-42', side: 'long' }),
          stop_loss_order_id: null,
          take_profit_order_id: null,
        }),
      ],
    )
    db.insertSignalExecution({
      signalId: 'entry-bot', symbol: 'BTC-PERPETUAL', exchange: 'deribit',
      direction: 'long', status: 'open', qtyOpened: 1,
    })
    const sig = makeCloseSignal({ metadata: { exchange: 'deribit', signalBotId: 'bot-42' } as any })
    await runClose(client, sig, { id: 'local-123', account_id: 'btc' })
    expect(db.closedEntries.map((e) => e.id)).toContain('entry-bot')
    const exec = db.getSignalExecution('entry-bot')
    expect(exec.qty_closed).toBe(1)
    expect(exec.status).toBe('closed')
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

  // Regression (2026-09-03 12:00 UTC, MNQ lead-trail exit, signal e9aba6ba):
  // the server wired a mixed-book close as a plain BUY with metadata
  // {virtualClose:true, positionId}. The executor ran it through the ENTRY
  // path: a phantom long execution, the real +$67 exit unbooked, and the
  // short's GTC buy-stop (order 1304545343) left resting on a flat account.
  // A virtualClose order must route through the close path instead.
  it('REGRESSION: a virtualClose buy on an open short books the exit — no new execution, no bracket', async () => {
    buildClient(
      [{ ...longPosition(1), side: 'short' }],
      [entry({ id: 'entry-short', action: 'sell', metadata: JSON.stringify({ signalBotId: 'bot-asc' }), stop_loss_order_id: 'buy-stop-1', take_profit_order_id: null })],
    )
    db.insertSignalExecution({
      signalId: 'entry-short',
      symbol: 'BTC-PERPETUAL',
      exchange: 'deribit',
      direction: 'short',
      status: 'open',
      qtyOpened: 1,
    })
    db.serverExitStates.push({ position_id: 'pos-86531dd0', entry_signal_id: 'entry-short', active: 1 })
    db.subForBot = { id: 'sub-asc', signal_bot_id: 'bot-asc', factor: 1, status: 'active', exchange: 'deribit' }

    const virtualCloseSignal = {
      id: 'vc-1',
      strategy_id: 'strat-1',
      symbol: 'BTC-PERPETUAL',
      action: 'buy',
      quantity: 1,
      price: 29108.5,
      metadata: {
        exchange: 'deribit',
        signalBotId: 'bot-asc',
        side: 'short',
        positionId: 'pos-86531dd0',
        add: true,
        virtualClose: true,
      },
      received_at: new Date(),
      status: 'pending',
      created_at: new Date(),
    } as unknown as Signal
    await (client as any).handleSignalInner(virtualCloseSignal)

    // One reduce-only flatten, booked as the SHORT's exit.
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0]!.side).toBe('buy')
    expect(adapter.placed[0]!.reduceOnly).toBe(true)
    expect(db.fills).toHaveLength(1)
    expect(db.fills[0]).toMatchObject({ signalId: 'entry-short', kind: 'exit', side: 'buy', qty: 1 })
    expect(db.executions.get('entry-short')).toMatchObject({ status: 'closed', qty_closed: 1 })
    // No phantom entry: no execution for the wire signal, no entry fill.
    expect(db.executions.has('vc-1')).toBe(false)
    expect(db.fills.some((f) => f.kind === 'entry')).toBe(false)
    // The lineage's resting stop is cancelled, its exit state retired.
    expect(adapter.cancelled).toContain('buy-stop-1')
    expect(db.serverExitStates[0]!.active).toBe(0)
    expect(db.lastStatus()).toMatchObject({ id: 'vc-1', status: 'executed' })
  })

  // R1 (docs/reviews/2026-09-04-crypto-top2.md §4.4): two bots on ONE Deribit
  // account trade the same instrument — a bc-short next to a fault-line-long
  // on BTC_USDC-PERPETUAL nets the venue to flat. The old close took its side
  // from the venue net (nothing / the other bot's side) and capped its size at
  // the venue net: closing the short did nothing, or bought the wrong way.
  // A close now sizes and directs itself from its OWN lineage only.
  describe('R1 — lineage-scoped close side + size (two bots, one instrument)', () => {
    const SYM = 'BTC_USDC-PERPETUAL'
    const bcEntry = () =>
      entry({
        id: 'entry-bc',
        symbol: SYM,
        action: 'sell',
        stop_loss_order_id: 'sl-bc',
        take_profit_order_id: null,
        metadata: JSON.stringify({ signalBotId: 'bot-bc' }),
      })
    const flEntry = () =>
      entry({
        id: 'entry-fl',
        symbol: SYM,
        action: 'buy',
        stop_loss_order_id: 'sl-fl',
        take_profit_order_id: null,
        metadata: JSON.stringify({ signalBotId: 'bot-fl' }),
      })
    const seed = (id: string, direction: 'long' | 'short', qty: number) =>
      db.insertSignalExecution({
        signalId: id,
        symbol: SYM,
        exchange: 'deribit',
        direction,
        status: 'open',
        qtyOpened: qty,
        accountId: 'usdc',
      })
    const closeFor = (botId: string) =>
      makeCloseSignal({
        id: `close-${botId}`,
        symbol: SYM,
        metadata: { exchange: 'deribit', signalBotId: botId },
      })
    const venue = (side: 'long' | 'short', size: number): Position => ({
      id: `deribit:${SYM}`,
      accountId: 'usdc',
      symbol: SYM,
      side,
      size,
      entryPrice: 60000,
    })

    it('REGRESSION: closing the bc-short next to a fault-line-long (venue flat) BUYS its own qty', async () => {
      buildClient([], [bcEntry(), flEntry()]) // venue nets to flat
      seed('entry-bc', 'short', 1)
      seed('entry-fl', 'long', 1)
      await runClose(client, closeFor('bot-bc'), { id: 'sub-bc', account_id: 'usdc' })

      // Pre-fix: no venue position → "nothing to close", entries marked closed, NO order.
      expect(adapter.placed).toHaveLength(1)
      expect(adapter.placed[0]).toMatchObject({ side: 'buy', quantity: 1, reduceOnly: false })
      expect(db.fills).toEqual([expect.objectContaining({ signalId: 'entry-bc', kind: 'exit', side: 'buy', qty: 1 })])
      expect(db.executions.get('entry-bc')).toMatchObject({ status: 'closed', qty_closed: 1 })
      // The other lineage is untouched: execution open, its stop still resting.
      expect(db.executions.get('entry-fl')).toMatchObject({ status: 'open', qty_closed: 0 })
      expect(adapter.cancelled).toEqual(['sl-bc'])
      expect(db.closedEntries.map((e) => e.id)).toEqual(['entry-bc'])
      expect(db.lastStatus()).toMatchObject({ id: 'close-bot-bc', status: 'executed' })
    })

    it('closing the fault-line-long next to the bc-short (venue flat) SELLS its own qty', async () => {
      buildClient([], [bcEntry(), flEntry()])
      seed('entry-bc', 'short', 1)
      seed('entry-fl', 'long', 1)
      await runClose(client, closeFor('bot-fl'), { id: 'sub-fl', account_id: 'usdc' })

      expect(adapter.placed).toHaveLength(1)
      expect(adapter.placed[0]).toMatchObject({ side: 'sell', quantity: 1, reduceOnly: false })
      expect(db.executions.get('entry-fl')).toMatchObject({ status: 'closed', qty_closed: 1 })
      expect(db.executions.get('entry-bc')).toMatchObject({ status: 'open' })
      expect(adapter.cancelled).toEqual(['sl-fl'])
    })

    // Inverse switch (2026-09-08): the armed synthetic's minted short sits on
    // the same instrument as the bot long and nets it to flat at the venue.
    it('closing the bot long next to the OPEN synthetic short (venue flat) SELLS its own qty', async () => {
      buildClient([], [flEntry()]) // venue flat: long 1 vs synthetic short 1
      seed('entry-fl', 'long', 1)
      db.syntheticRow = { status: 'open', short_size: 1 }
      await runClose(client, closeFor('bot-fl'), { id: 'sub-fl', account_id: 'usdc' })

      expect(adapter.placed).toHaveLength(1)
      expect(adapter.placed[0]).toMatchObject({ side: 'sell', quantity: 1, reduceOnly: false })
      expect(db.executions.get('entry-fl')).toMatchObject({ status: 'closed', qty_closed: 1 })
      expect(db.lastStatus()).toMatchObject({ id: 'close-bot-fl', status: 'executed' })
    })

    it('an ARMED (unminted) synthetic row does not count as venue exposure', async () => {
      buildClient([venue('long', 1)], [flEntry()])
      seed('entry-fl', 'long', 1)
      db.syntheticRow = { status: 'armed', short_size: 0 }
      await runClose(client, closeFor('bot-fl'), { id: 'sub-fl', account_id: 'usdc' })
      expect(adapter.placed[0]).toMatchObject({ side: 'sell', quantity: 1, reduceOnly: true })
    })

    it('REGRESSION: venue net on the OTHER side never flips the close side (bc 2 short, fl 1 long)', async () => {
      buildClient([venue('short', 1)], [bcEntry(), flEntry()])
      seed('entry-bc', 'short', 2)
      seed('entry-fl', 'long', 1)
      await runClose(client, closeFor('bot-fl'), { id: 'sub-fl', account_id: 'usdc' })

      // Pre-fix: venue short → close BUYS (adds long delta). Closing a long is a SELL.
      expect(adapter.placed[0]).toMatchObject({ side: 'sell', quantity: 1, reduceOnly: false })
      expect(db.executions.get('entry-fl')).toMatchObject({ status: 'closed' })
      expect(db.executions.get('entry-bc')).toMatchObject({ status: 'open', qty_closed: 0 })
      expect(adapter.cancelled).toEqual(['sl-fl'])
    })

    it('REGRESSION: the venue net is never a cap for a lineage close (bc 2 short vs venue short 1)', async () => {
      buildClient([venue('short', 1)], [bcEntry(), flEntry()])
      seed('entry-bc', 'short', 2)
      seed('entry-fl', 'long', 1)
      await runClose(client, closeFor('bot-bc'), { id: 'sub-bc', account_id: 'usdc' })

      // Pre-fix: capped at the venue's 1. The lineage holds 2 → buy 2, the net
      // moves from short 1 to long 1 (= exactly the fault-line's book).
      expect(adapter.placed[0]).toMatchObject({ side: 'buy', quantity: 2, reduceOnly: false })
      expect(db.executions.get('entry-bc')).toMatchObject({ status: 'closed', qty_closed: 2 })
      expect(db.executions.get('entry-fl')).toMatchObject({ status: 'open' })
    })

    it('venue covering the lineage on its own side stays a plain reduce-only close', async () => {
      buildClient([venue('short', 3)], [bcEntry(), flEntry()])
      seed('entry-bc', 'short', 2)
      seed('entry-fl', 'long', 1) // plus untracked short 2 elsewhere → venue short 3
      await runClose(client, closeFor('bot-bc'), { id: 'sub-bc', account_id: 'usdc' })

      expect(adapter.placed[0]).toMatchObject({ side: 'buy', quantity: 2, reduceOnly: true })
      expect(db.executions.get('entry-bc')).toMatchObject({ status: 'closed' })
    })

    it('a drifted book (venue flat, no other lineage explains it) keeps venue-truth: no order', async () => {
      buildClient([], [bcEntry()])
      seed('entry-bc', 'short', 1) // book says short 1, venue flat, nobody nets it → stop filled elsewhere
      await runClose(client, closeFor('bot-bc'), { id: 'sub-bc', account_id: 'usdc' })

      expect(adapter.placed).toHaveLength(0)
      expect(db.lastStatus()).toMatchObject({ status: 'executed' })
      expect(db.closedEntries.map((e) => e.id)).toEqual(['entry-bc'])
    })
  })

  // 2026-09-02 (MNQU26 L1 time-stop): the close cancelled the bracket leg but
  // left server_exit_state active=1 — the venue-exit sweep then polled the
  // cancelled stop order forever. A full close must retire the exit state.
  it('a full close retires the server exit state of the closed entries', async () => {
    buildClient([longPosition(1)], [entry()])
    db.serverExitStates.push({ position_id: 'pos-1', entry_signal_id: 'entry-1', active: 1 })
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed).toHaveLength(1)
    expect(db.serverExitStates[0]!.active).toBe(0)
  })

  it('the no-live-position branch also retires the server exit state', async () => {
    buildClient([], [entry()])
    db.serverExitStates.push({ position_id: 'pos-1', entry_signal_id: 'entry-1', active: 1 })
    await runClose(client, makeCloseSignal(), { id: 'sub-1', exchange: 'deribit' })

    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus()).toMatchObject({ status: 'executed' })
    expect(db.serverExitStates[0]!.active).toBe(0)
  })

  // Regression (2026-09-01 21:28 UTC, B&C zombie close, orders 1303995938 /
  // 1303996257): B&C Alpha emitted a close for its internal zombie long, but
  // its entry was guardrail-rejected — no open entries for its identity. The
  // account-scoped position lookup still found the ASCENDER's long on the same
  // (account, symbol) and the close SOLD it; only the Globex maintenance pause
  // cancelled the order. An identity-carrying close with no open entries must
  // be a no-op with an executed ack, never an order on another lineage.
  it('REGRESSION: an identity-scoped close with no open entries never flattens another bot\'s position', async () => {
    buildClient(
      [longPosition(1)], // the OTHER bot's live position, same account+symbol
      [entry({ id: 'entry-asc', metadata: JSON.stringify({ signalBotId: 'bot-ascender' }) })],
    )
    const sig = makeCloseSignal({
      metadata: { exchange: 'deribit', signalBotId: 'bot-bc' } as any,
    })
    await runClose(client, sig, { id: 'sub-bc' })

    expect(adapter.placed).toHaveLength(0)
    expect(adapter.cancelled).toHaveLength(0) // the other lineage's brackets stand
    expect(db.closedEntries).toHaveLength(0)
    expect(db.lastStatus()).toMatchObject({ id: 'close-1', status: 'executed' })
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

// ── Futures contract after an engine roll (2026-09-04) ─────────────────────
// The engine rolls the root on its daily-volume schedule; the executor used to
// re-resolve a close to today's quote-volume front, so a position opened on
// U26 was looked up (and missed) on Z26 once the front moved. A close must hit
// the contract the lineage's own entry was filled on.
describe('SignalWebSocketClient.executeCloseSignal > futures contract after a roll', () => {
  it('closes the contract the entry was filled on, not the current front', async () => {
    const db = new FakeDb([entry({ id: 'entry-u26', symbol: 'MNQ', quantity: 2 })])
    db.insertSignalExecution({
      signalId: 'entry-u26', symbol: 'MNQU26', exchange: 'tradestation', direction: 'long',
      status: 'open', qtyOpened: 2,
    })
    const adapter = new FakeAdapter([
      { id: 'tradestation:MNQU26', accountId: 'acct-1', symbol: 'MNQU26', side: 'long', size: 2, entryPrice: 25000 },
      { id: 'tradestation:MNQZ26', accountId: 'acct-1', symbol: 'MNQZ26', side: 'long', size: 5, entryPrice: 25300 },
    ])
    adapter.name = 'tradestation'
    // Quote volume already favours the next contract.
    ;(adapter as any).resolveSymbol = async (_symbol: string) => 'MNQZ26'
    const client = new SignalWebSocketClient(db as any, new FakeExchangeManager(adapter) as any, null)

    await runClose(
      client,
      makeCloseSignal({ symbol: 'MNQ', metadata: { exchange: 'tradestation', subscriptionId: 'sub-1', contract: 'MNQZ26' } }),
      { id: 'sub-1', exchange: 'tradestation', account_id: 'acct-1' },
    )

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].symbol).toBe('MNQU26')
    expect(adapter.placed[0].side).toBe('sell')
    expect(adapter.placed[0].quantity).toBe(2)
    expect(db.closedEntries.map((e) => e.id)).toContain('entry-u26')
  })
})
