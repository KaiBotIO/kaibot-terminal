import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, OrderStatus, Position } from '../services/exchanges/types.js'

// Market-closed entries are deferred, not rejected (2026-09-19).
//
// Prod case: B&C Alpha MNQ 1D fires on the 21:00 UTC daily close, inside the
// Globex maintenance pause (21:00-22:00 UTC). The market guard rejected every
// entry ('market closed / stale quote', 17/09 21:03), so the bot never got a
// live entry. Now the entry is parked in deferred_entries and resumed through
// the full entry path once the venue trades again. Covered here: defer,
// idempotency, resume at reopen (the prod regression), expiry, the weekend
// drop, cancellation by a later close / cancel, restart survival, replay and
// the basis guard on the reopen price.

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  queue: Array<{ signalId: string; reason: string; metadata?: any }> = []
  fills: any[] = []
  executions = new Map<string, any>()
  settlements: any[] = []
  bracketPairs = new Map<string, any>()
  deferred = new Map<string, any>()
  recordedSignals = new Map<string, any>()

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal(row: any) {
    if (!this.recordedSignals.has(row.id)) this.recordedSignals.set(row.id, row)
  }
  recordSignalQueue(e: { signalId: string; action: string; reason: string; metadata?: any }) {
    this.queue.push({ signalId: e.signalId, reason: e.reason, metadata: e.metadata })
  }
  getSubscriptionForBot(botId: string) {
    return botId === 'bot-1'
      ? { id: 'sub-1', factor: 1, account_id: 'ACC1', exchange: 'tradestation', status: 'active' }
      : null
  }
  getSubscription() {
    return null
  }
  getBotConfigs() {
    return []
  }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  getSignalStatus(id: string) {
    return this.signalStatuses.filter((s) => s.id === id).at(-1)?.status
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
  getSignalFills(signalId: string) {
    return this.fills.filter((f) => f.signal_id === signalId)
  }
  targetAlreadyProcessed() {
    return false
  }
  getDcaRestingRungsForSignal(): any[] {
    return []
  }
  deleteDcaRestingRung() {}
  insertOrderSettlement(row: any) {
    const id = this.settlements.length + 1
    this.settlements.push({ id, status: 'unknown', ...row })
    return id
  }
  listUnresolvedSettlements() {
    return this.settlements.filter((s) => s.status === 'unknown')
  }
  resolveOrderSettlement() {}
  upsertBracketPair(row: any) {
    this.bracketPairs.set(row.signalId, row)
  }
  listBracketPairs() {
    return [...this.bracketPairs.values()]
  }
  deleteBracketPair(id: string) {
    this.bracketPairs.delete(id)
  }
  getSignalBracket() {
    return undefined
  }
  listClosingExecutions() {
    return []
  }

  // deferred entries (mig 037), mirroring the sqlite semantics
  getDeferredEntry(id: string) {
    return this.deferred.get(id)
  }
  upsertDeferredEntry(row: any) {
    if (this.deferred.has(row.signalId)) {
      this.deferred.get(row.signalId).last_check_at = row.deferredAt
      return
    }
    this.deferred.set(row.signalId, {
      signal_id: row.signalId,
      signal_json: row.signalJson,
      canonical_symbol: row.canonicalSymbol,
      exchange: row.exchange,
      order_symbol: row.orderSymbol,
      account_id: row.accountId ?? null,
      signal_bot_id: row.signalBotId ?? null,
      subscription_id: row.subscriptionId ?? null,
      position_id: row.positionId ?? null,
      status: 'waiting',
      reason: row.reason,
      deferred_at: row.deferredAt,
      deadline_at: row.deadlineAt,
      last_check_at: null,
      resolved_at: null,
    })
  }
  listWaitingDeferredEntries() {
    return [...this.deferred.values()].filter((r) => r.status === 'waiting')
  }
  touchDeferredEntry(id: string, at: number) {
    const r = this.deferred.get(id)
    if (r) r.last_check_at = at
  }
  resolveDeferredEntry(id: string, status: string, reason: string | null, at: number) {
    const r = this.deferred.get(id)
    if (!r || r.status !== 'waiting') return false
    r.status = status
    r.reason = reason
    r.resolved_at = at
    return true
  }

  statusOf(id: string) {
    return this.getSignalStatus(id)
  }
  lastStatus() {
    return this.signalStatuses[this.signalStatuses.length - 1]
  }
}

// A CME futures venue: not 24/7, reports the last trade time per symbol.
class FakeAdapter {
  name = 'tradestation'
  alwaysOpen = false
  lastTradeMs = 0
  lastPrice: number | null = null
  positions: Position[] = []
  placed: Order[] = []
  cancelled: string[] = []

  async getMarketStatus(symbols: string[]) {
    return new Map(symbols.map((s) => [s, { symbol: s, last: 1, tradeTimeMs: this.lastTradeMs }]))
  }
  async getLastPrice() {
    return this.lastPrice
  }
  async getPositions() {
    return this.positions
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity, averagePrice: 20_000 }
  }
  async cancelOrder(id: string) {
    this.cancelled.push(id)
  }
  async getOrderStatus(): Promise<OrderStatus> {
    return { orderId: 'x', state: 'filled' }
  }
}

class FakeManager {
  constructor(private adapter: FakeAdapter, public status: 'connected' | 'disconnected' = 'connected') {}
  async getSession() {
    return { adapter: this.adapter, status: this.status, userId: 'default', exchangeName: this.adapter.name }
  }
}

// Thursday 2026-09-17: the daily close fires at 21:00 UTC, the Globex pause
// runs 21:00-22:00 UTC.
const T_SIGNAL = Date.UTC(2026, 8, 17, 21, 3)
const T_LAST_TRADE = Date.UTC(2026, 8, 17, 20, 59, 50)
const T_REOPEN = Date.UTC(2026, 8, 17, 22, 0, 10)
const H = 3_600_000

type Acks = Array<{ signalId: string; status: string; reason?: string }>

function build(opts: { now?: () => number; db?: FakeDb } = {}) {
  const db = opts.db ?? new FakeDb()
  const adapter = new FakeAdapter()
  adapter.lastTradeMs = T_LAST_TRADE
  const manager = new FakeManager(adapter)
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  client.setSettleOptions(2, 1)
  client.setDeferConfig({ maxWaitMs: 3 * H, pollMs: 60_000, deferOverWeekend: false })
  if (opts.now) client.setClock(opts.now)
  const acks: Acks = []
  ;(client as any).ackToApi = async (signalId: string, status: string, _t: unknown, reason?: string) => {
    acks.push({ signalId, status, reason })
  }
  return { db, adapter, client, acks }
}

function entrySignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'entry-1',
    strategy_id: 'bc-alpha',
    strategy_name: 'B&C Alpha MNQ 1D',
    symbol: 'MNQ',
    action: 'buy',
    quantity: 1,
    price: 20_000,
    type: 'market',
    metadata: { exchange: 'tradestation', signalBotId: 'bot-1', contract: 'MNQZ26', positionId: 'pos-1' },
    received_at: new Date(T_SIGNAL),
    status: 'pending',
    created_at: new Date(T_SIGNAL),
    ...overrides,
  } as Signal
}

function closeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'close-1',
    strategy_id: 'bc-alpha',
    symbol: 'MNQ',
    action: 'close',
    quantity: 1,
    metadata: { exchange: 'tradestation', signalBotId: 'bot-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as Signal
}

describe('deferred entry — market closed', () => {
  it('parks a market entry on a closed venue instead of rejecting it', async () => {
    const { db, adapter, client, acks } = build({ now: () => T_SIGNAL })

    await (client as any).handleSignalInner(entrySignal())
    client.stopDeferredEntryPoller()

    expect(adapter.placed).toHaveLength(0)
    expect(db.statusOf('entry-1')).toBe('deferred')
    expect(db.lastStatus().error).toContain('market closed')
    const row = db.deferred.get('entry-1')
    expect(row.status).toBe('waiting')
    expect(row.order_symbol).toBe('MNQZ26')
    expect(row.canonical_symbol).toBe('MNQ')
    expect(row.signal_bot_id).toBe('bot-1')
    expect(row.position_id).toBe('pos-1')
    expect(row.deadline_at).toBe(T_SIGNAL + 3 * H)
    // The persisted wire copy keeps the canonical symbol, not the venue remap.
    expect(JSON.parse(row.signal_json).symbol).toBe('MNQ')
    expect(acks).toEqual([{ signalId: 'entry-1', status: 'deferred', reason: expect.stringContaining('market closed') }])
    expect(db.queue.map((q) => q.reason)).toContain('deferred_market_closed')
    // No execution row burned: the resume runs the full entry path.
    expect(db.getSignalExecution('entry-1')).toBeUndefined()
  })

  it('is idempotent per signal id: a duplicate delivery keeps the one row and acks once', async () => {
    const { db, client, acks } = build({ now: () => T_SIGNAL })

    await (client as any).handleSignalInner(entrySignal())
    await (client as any).handleSignalInner(entrySignal())
    client.stopDeferredEntryPoller()

    expect(db.deferred.size).toBe(1)
    expect(acks.filter((a) => a.status === 'deferred')).toHaveLength(1)
    expect(db.deferred.get('entry-1').status).toBe('waiting')
  })

  // Regression for the prod case: the 1D entry at 21:03 UTC on the closed CME
  // market runs at 22:00 when the venue trades again.
  it('runs the entry through the normal path once the venue trades again', async () => {
    let now = T_SIGNAL
    const { db, adapter, client, acks } = build({ now: () => now })

    await (client as any).handleSignalInner(entrySignal())
    expect(db.statusOf('entry-1')).toBe('deferred')

    // 21:30: still inside the pause, nothing happens.
    now = T_SIGNAL + 27 * 60_000
    let tick = await client.checkDeferredEntries()
    expect(tick.resumed).toEqual([])
    expect(adapter.placed).toHaveLength(0)
    expect(db.deferred.get('entry-1').last_check_at).toBe(now)

    // 22:00:30: the venue printed a trade at 22:00:10 → the entry runs.
    now = T_REOPEN + 20_000
    adapter.lastTradeMs = T_REOPEN
    tick = await client.checkDeferredEntries()
    client.stopDeferredEntryPoller()

    expect(tick.resumed).toEqual(['entry-1'])
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0]).toMatchObject({ symbol: 'MNQZ26', side: 'buy', quantity: 1, orderType: 'market' })
    expect(db.statusOf('entry-1')).toBe('executed')
    expect(db.getSignalExecution('entry-1')?.status).toBe('open')
    expect(db.deferred.get('entry-1').status).toBe('executed')
    expect(acks.map((a) => a.status)).toEqual(['deferred', 'executed'])
    expect(db.queue.map((q) => q.reason)).toContain('deferred_resumed')
    // Resume never re-records / re-notifies the wire receipt.
    expect(db.recordedSignals.size).toBe(1)
  })

  it('drops the entry with a clear reason once the wait limit passes', async () => {
    let now = T_SIGNAL
    const { db, adapter, client, acks } = build({ now: () => now })

    await (client as any).handleSignalInner(entrySignal())
    now = T_SIGNAL + 3 * H + 1
    const tick = await client.checkDeferredEntries()

    expect(tick.expired).toEqual(['entry-1'])
    expect(adapter.placed).toHaveLength(0)
    expect(db.deferred.get('entry-1').status).toBe('expired')
    expect(db.statusOf('entry-1')).toBe('expired')
    expect(db.lastStatus().error).toContain('wait limit')
    expect(acks.at(-1)).toMatchObject({ signalId: 'entry-1', status: 'rejected' })
    expect(db.queue.map((q) => q.reason)).toContain('deferred_expired')
    // Nothing left to poll → the timer stops itself on the next pass.
    await client.checkDeferredEntries()
    expect((client as any).deferredTimer).toBeNull()
  })

  it('a second tick past the deadline is a no-op (no double ack)', async () => {
    let now = T_SIGNAL
    const { client, acks } = build({ now: () => now })
    await (client as any).handleSignalInner(entrySignal())
    now = T_SIGNAL + 4 * H
    await client.checkDeferredEntries()
    await client.checkDeferredEntries()
    expect(acks.filter((a) => a.status === 'rejected')).toHaveLength(1)
  })
})

describe('deferred entry — weekend gap', () => {
  const SAT = Date.UTC(2026, 8, 19, 12, 0)

  it('rejects an entry inside the weekend close by default', async () => {
    const { db, adapter, client, acks } = build({ now: () => SAT })
    await (client as any).handleSignalInner(entrySignal())

    expect(adapter.placed).toHaveLength(0)
    expect(db.deferred.size).toBe(0)
    expect(db.statusOf('entry-1')).toBe('rejected')
    expect(db.lastStatus().error).toContain('weekend')
    expect(acks).toEqual([{ signalId: 'entry-1', status: 'rejected', reason: expect.stringContaining('weekend') }])
    expect(db.queue.map((q) => q.reason)).toContain('deferred_weekend_drop')
  })

  it('holds the entry until Sunday open + max wait with DEFER_OVER_WEEKEND', async () => {
    const { db, client } = build({ now: () => SAT })
    client.setDeferConfig({ deferOverWeekend: true })
    await (client as any).handleSignalInner(entrySignal())
    client.stopDeferredEntryPoller()

    expect(db.statusOf('entry-1')).toBe('deferred')
    expect(db.deferred.get('entry-1').deadline_at).toBe(Date.UTC(2026, 8, 20, 22, 0) + 3 * H)
  })
})

describe('deferred entry — cancelled by a later signal', () => {
  it('a close for the same bot/market retires the waiting entry and acks as a no-op', async () => {
    const { db, adapter, client, acks } = build({ now: () => T_SIGNAL + 10 * 60_000 })
    await (client as any).handleSignalInner(entrySignal())
    expect(db.deferred.get('entry-1').status).toBe('waiting')

    await (client as any).handleSignalInner(closeSignal())
    client.stopDeferredEntryPoller()

    expect(db.deferred.get('entry-1').status).toBe('cancelled')
    expect(db.statusOf('entry-1')).toBe('expired')
    expect(acks.find((a) => a.signalId === 'entry-1' && a.status === 'rejected')?.reason).toContain(
      'cancelled before fill',
    )
    // The close itself: nothing on the venue, no order, executed no-op ack.
    expect(adapter.placed).toHaveLength(0)
    expect(db.statusOf('close-1')).toBe('executed')
    expect(acks.find((a) => a.signalId === 'close-1')?.status).toBe('executed')
    expect(db.queue.map((q) => q.reason)).toContain('deferred_cancelled')
    // Nothing waits any more → a later reopen places nothing.
    adapter.lastTradeMs = T_REOPEN
    await client.checkDeferredEntries()
    expect(adapter.placed).toHaveLength(0)
  })

  it('a close for another bot on the same market leaves the entry waiting', async () => {
    const { db, client } = build({ now: () => T_SIGNAL + 10 * 60_000 })
    await (client as any).handleSignalInner(entrySignal())
    await (client as any).handleSignalInner(
      closeSignal({ id: 'close-2', metadata: { exchange: 'tradestation', signalBotId: 'bot-2' } }),
    )
    client.stopDeferredEntryPoller()
    expect(db.deferred.get('entry-1').status).toBe('waiting')
  })

  it('a cancel keyed by entrySignalId retires the waiting entry', async () => {
    const { db, adapter, client, acks } = build({ now: () => T_SIGNAL + 10 * 60_000 })
    await (client as any).handleSignalInner(entrySignal())

    await (client as any).handleSignalInner(
      entrySignal({
        id: 'cancel-1',
        action: 'cancel' as any,
        quantity: 0,
        metadata: { exchange: 'tradestation', signalBotId: 'bot-1', entrySignalId: 'entry-1', cancel: true },
      }),
    )
    client.stopDeferredEntryPoller()

    expect(db.deferred.get('entry-1').status).toBe('cancelled')
    expect(acks.find((a) => a.signalId === 'entry-1' && a.status === 'rejected')).toBeTruthy()
    expect(db.statusOf('cancel-1')).toBe('executed')
    expect(adapter.placed).toHaveLength(0)
    expect(adapter.cancelled).toHaveLength(0)
  })
})

describe('deferred entry — restart and replay', () => {
  it('survives an executor restart: a fresh client resumes the persisted row', async () => {
    let now = T_SIGNAL
    const first = build({ now: () => now })
    await (first.client as any).handleSignalInner(entrySignal())
    first.client.stopDeferredEntryPoller()
    expect(first.db.deferred.get('entry-1').status).toBe('waiting')

    // Restart: a brand-new client on the SAME db, in-memory state gone.
    now = T_REOPEN + 20_000
    const second = build({ now: () => now, db: first.db })
    second.adapter.lastTradeMs = T_REOPEN
    second.client.startDeferredEntryPoller()
    const tick = await second.client.checkDeferredEntries()
    second.client.stopDeferredEntryPoller()

    expect(tick.resumed).toEqual(['entry-1'])
    expect(second.adapter.placed).toHaveLength(1)
    expect(second.adapter.placed[0].symbol).toBe('MNQZ26')
    expect(first.db.deferred.get('entry-1').status).toBe('executed')
    expect(second.acks.map((a) => a.status)).toEqual(['executed'])
  })

  it('a replayed copy of a waiting entry is skipped, never stale-dropped', async () => {
    const { db, adapter, client, acks } = build({ now: () => T_SIGNAL })
    await (client as any).handleSignalInner(entrySignal())
    client.stopDeferredEntryPoller()

    // Reconnect replay well past the 60 s stale window.
    await (client as any).handleMissedSignals([entrySignal()])

    expect(db.statusOf('entry-1')).toBe('deferred')
    expect(db.deferred.get('entry-1').status).toBe('waiting')
    expect(acks.filter((a) => a.status === 'rejected')).toHaveLength(0)
    expect(adapter.placed).toHaveLength(0)
    expect(db.queue.map((q) => q.reason)).toContain('replay_deferred')
  })

  it('a session that is not connected at poll time keeps the row waiting', async () => {
    let now = T_SIGNAL
    const { db, adapter, client } = build({ now: () => now })
    await (client as any).handleSignalInner(entrySignal())
    ;(client as any).exchangeManager = new FakeManager(adapter, 'disconnected')
    now = T_REOPEN + 20_000
    adapter.lastTradeMs = T_REOPEN
    const tick = await client.checkDeferredEntries()
    client.stopDeferredEntryPoller()
    expect(tick.resumed).toEqual([])
    expect(db.deferred.get('entry-1').status).toBe('waiting')
    expect(adapter.placed).toHaveLength(0)
  })
})

describe('deferred entry — guards run on the reopen price', () => {
  it('the basis guard rejects a resumed entry when the venue gapped past the threshold', async () => {
    let now = T_SIGNAL
    const { db, adapter, client, acks } = build({ now: () => now })
    await (client as any).handleSignalInner(entrySignal())

    // Reopen 10% away from the 20 000 signal price.
    now = T_REOPEN + 20_000
    adapter.lastTradeMs = T_REOPEN
    adapter.lastPrice = 22_000
    const tick = await client.checkDeferredEntries()
    client.stopDeferredEntryPoller()

    expect(tick.resumed).toEqual(['entry-1'])
    expect(adapter.placed).toHaveLength(0)
    expect(db.statusOf('entry-1')).toBe('rejected')
    expect(db.lastStatus().error).toContain('basis guard')
    expect(db.deferred.get('entry-1').status).toBe('rejected')
    expect(acks.at(-1)).toMatchObject({ signalId: 'entry-1', status: 'rejected' })
  })
})
