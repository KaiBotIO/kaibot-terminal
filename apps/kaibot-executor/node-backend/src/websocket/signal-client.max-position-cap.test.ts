import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// #19 regression: maxPositionSize is the subscription's TOTAL exposure safety
// cap ("total notional safety cap" in the UI), but it used to be enforced only
// per order — DCA adds and multi-position entries for the same bot compounded
// past it without bound. The cap must clip each order to the headroom left
// after the exposure the bot already holds (open executions net of closes,
// plus still-resting DCA rungs).

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
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  safetyClips: any[] = []
  executions = new Map<string, any>()
  entries: EntryRow[] = []
  restingRungs: any[] = []

  constructor(private sub: any) {}

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {}
  recordSignalQueue() {}
  getBotConfigs(_onlyRunning = true) { return [] }
  getSubscriptionForBot() {
    return this.sub
  }
  getFactorBasisSyntheticUsdPosition() {
    return null
  }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  logSafetyClip(entry: any) {
    this.safetyClips.push(entry)
  }
  getAccountSize() {
    return null
  }
  getMarginGuard() {
    return null
  }
  getOpenEntrySignals(symbol: string, subFilter?: string): EntryRow[] {
    return this.entries.filter(
      (e) =>
        e.symbol.toLowerCase() === symbol.toLowerCase() &&
        (!subFilter || (e.metadata ?? '').includes(subFilter)),
    )
  }
  getDcaRestingRungsForSignal(signalId: string) {
    return this.restingRungs.filter((r) => r.signal_id === signalId)
  }
  markEntrySignalClosed() {}
  getSignalExecution(id: string) {
    return this.executions.get(id)
  }
  insertSignalExecution(row: any) {
    if (this.executions.has(row.signalId)) return false
    this.executions.set(row.signalId, {
      signal_id: row.signalId,
      status: row.status,
      qty_opened: row.qtyOpened ?? 0,
      qty_closed: row.qtyClosed ?? 0,
    })
    return true
  }
  updateSignalExecution(id: string, patch: any) {
    const r = this.executions.get(id)
    if (!r) return
    if (patch.status !== undefined) r.status = patch.status
    if (patch.qtyOpened !== undefined) r.qty_opened = patch.qtyOpened
    if (patch.qtyClosed !== undefined) r.qty_closed = patch.qtyClosed
  }
  insertSignalFill() {}
  upsertBracketPair() {}
  insertOrderSettlement() {
    return 1
  }
  lastStatus() {
    return this.signalStatuses[this.signalStatuses.length - 1]
  }
  clip(reason: string) {
    return this.safetyClips.find((c) => c.reason === reason)
  }

  // Seed an already-open position held by this bot on this market.
  seedOpen(id: string, qtyOpened: number, qtyClosed = 0, action: 'buy' | 'sell' = 'buy') {
    this.entries.push({
      id,
      symbol: 'ETH-PERPETUAL',
      action,
      quantity: qtyOpened,
      stop_loss_order_id: null,
      take_profit_order_id: null,
      metadata: JSON.stringify({ signalBotId: 'bot-1' }),
    })
    this.executions.set(id, {
      signal_id: id,
      status: 'open',
      qty_opened: qtyOpened,
      qty_closed: qtyClosed,
    })
  }
}

class FakeAdapter {
  name = 'deribit'
  placed: Order[] = []
  alwaysOpen = true
  async getBalances() {
    return []
  }
  async getPositions(): Promise<Position[]> {
    return []
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity }
  }
  async cancelOrder() {}
}

function build(maxPositionSize: number) {
  const sub = {
    id: 'sub-1',
    factor: 1,
    status: 'active',
    exchange: 'deribit',
    account_id: 'eth',
    max_position_size: maxPositionSize,
  }
  const db = new FakeDb(sub)
  const adapter = new FakeAdapter()
  const manager = {
    async getSession() {
      return { adapter, status: 'connected', userId: 'default', exchangeName: adapter.name }
    },
  }
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  client.setSettleOptions(2, 1)
  return { db, adapter, client }
}

// ETH-PERPETUAL: step 1, min 1 → quantities land on-step.
function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: `sig-${Math.random().toString(36).slice(2, 8)}`,
    strategy_id: 'strat-1',
    symbol: 'ETH-PERPETUAL',
    action: 'buy',
    quantity: 8,
    price: 3000,
    metadata: { exchange: 'deribit', signalBotId: 'bot-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...over,
  } as Signal
}

describe('maxPositionSize cumulative exposure cap (#19)', () => {
  it('still clips a single oversized order (per-order behavior preserved)', async () => {
    const { db, adapter, client } = build(10)
    await (client as any).handleSignalInner(signal({ quantity: 25 }))
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].quantity).toBe(10)
    expect(db.clip('max_position_size')).toMatchObject({ originalQuantity: 25, adjustedQuantity: 10 })
  })

  it('clips a DCA add to the headroom left by the exposure already open', async () => {
    const { db, adapter, client } = build(10)
    db.seedOpen('prev-1', 8) // the bot already holds 8 of the 10 cap
    await (client as any).handleSignalInner(signal({ quantity: 8, metadata: { exchange: 'deribit', signalBotId: 'bot-1', add: true } }))
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].quantity).toBe(2) // 10 − 8, not another 8
    expect(db.clip('max_position_size')).toMatchObject({ originalQuantity: 8, adjustedQuantity: 2 })
  })

  it('rejects the open when the cap is already fully used', async () => {
    const { db, adapter, client } = build(10)
    db.seedOpen('prev-1', 6)
    db.seedOpen('prev-2', 4) // multi-position entries summing to the cap
    await (client as any).handleSignalInner(signal({ quantity: 5 }))
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('maxPositionSize')
    expect(db.clip('max_position_size')).toMatchObject({ adjustedQuantity: 0 })
  })

  it('counts closed qty back as headroom (partially scaled-out position)', async () => {
    const { db, adapter, client } = build(10)
    db.seedOpen('prev-1', 8, 4) // 8 opened, 4 closed → 4 live
    await (client as any).handleSignalInner(signal({ quantity: 8 }))
    expect(adapter.placed[0].quantity).toBe(6) // 10 − 4
  })

  it('ignores exposure on the opposite side', async () => {
    const { db, adapter, client } = build(10)
    db.seedOpen('prev-short', 8, 0, 'sell') // short exposure — not this cap's scope
    await (client as any).handleSignalInner(signal({ quantity: 8 }))
    expect(adapter.placed[0].quantity).toBe(8) // full size allowed
  })

  it('counts still-resting DCA rungs toward the cap (they fill later)', async () => {
    const { db, adapter, client } = build(10)
    db.seedOpen('prev-1', 4)
    db.restingRungs = [
      { order_id: 'rung-1', signal_id: 'prev-1', qty: 4, filled_qty: 0 }, // 4 more can still fill
    ]
    await (client as any).handleSignalInner(signal({ quantity: 8 }))
    expect(adapter.placed[0].quantity).toBe(2) // 10 − 4 open − 4 resting
  })
})
