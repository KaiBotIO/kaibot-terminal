import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// Regression guard (carve-out / IP boundary): an inbound signal's
// order_plan.trail must NEVER be consumed. Trail distance, caps and break-even
// fee come exclusively from the user's own executor settings
// (settings.localTrailing); a server-sent trail on the wire is proprietary
// strategy output and has to stay dead on arrival. The executor OrderPlan type
// no longer declares `trail` — these tests pin the runtime behaviour so a
// future server change that fills the field cannot silently regress.

interface SignalRow {
  symbol: string
  action: string
  stop_loss_order_id: string | null
  take_profit_order_id: string | null
}

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  bracketPairs = new Map<string, any>()
  signals = new Map<string, SignalRow>()
  trailStates: any[] = []
  adminSettings: string | null = null

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
  getAdminUser() {
    return this.adminSettings == null ? null : { settings: this.adminSettings }
  }
  upsertLocalTrailState(row: any) {
    this.trailStates.push(row)
  }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds(signalId: string, slId?: string, tpId?: string) {
    const row = this.signals.get(signalId) ?? {
      symbol: '',
      action: 'buy',
      stop_loss_order_id: null,
      take_profit_order_id: null,
    }
    row.stop_loss_order_id = slId ?? null
    row.take_profit_order_id = tpId ?? null
    this.signals.set(signalId, row)
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

  executions = new Map<string, any>()
  fills: any[] = []
  getSignalExecution(id: string) {
    return this.executions.get(id)
  }
  insertSignalExecution(row: any) {
    if (this.executions.has(row.signalId)) return false
    this.executions.set(row.signalId, { signal_id: row.signalId, status: row.status })
    return true
  }
  updateSignalExecution(id: string, patch: any) {
    const row = this.executions.get(id)
    if (row && patch.status !== undefined) row.status = patch.status
  }
  insertSignalFill(fill: any) {
    this.fills.push(fill)
  }
  insertOrderSettlement() {
    return 1
  }
  listUnresolvedSettlements() {
    return []
  }

  upsertBracketPair(row: any) {
    this.bracketPairs.set(row.signalId, row)
  }
  listBracketPairs() {
    return [...this.bracketPairs.values()]
  }
  deleteBracketPair(id: string) {
    this.bracketPairs.delete(id)
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
  alwaysOpen = true

  constructor(name = 'deribit') {
    this.name = name
  }
  async getPositions() {
    return this.positions
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity }
  }
  async cancelOrder(id: string) {
    this.cancelled.push(id)
  }
}

class FakeManager {
  constructor(private adapter: FakeAdapter, public status: 'connected' | 'disconnected' = 'connected') {}
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

// The hostile wire payload: a server-authored trail rides on order_plan. The
// executor type doesn't declare the field, so it is attached untyped — exactly
// how it would arrive over JSON.
function entryWithWireTrail(): Signal {
  const plan: any = {
    stopLoss: 55000,
    trail: { percentage: 1.5, points: 250, maxPercentage: 3, breakevenFee: 0.0015 },
  }
  return {
    id: 'entry-trail-1',
    strategy_id: 'strat-1',
    symbol: BTC,
    action: 'buy',
    quantity: 10,
    price: 60000,
    stop_loss: 55000,
    order_plan: plan,
    metadata: { exchange: 'deribit' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  } as Signal
}

describe('order_plan.trail — never consumed (server IP stays dead on the wire)', () => {
  it('registers no local trail from a wire trail when the user configured none', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)

    await (client as any).handleSignalInner(entryWithWireTrail())

    expect(db.lastStatus().status).toBe('executed')
    // No user localTrailing settings → nothing registered, wire trail ignored.
    expect(db.trailStates).toHaveLength(0)
  })

  it('trail params come from the user settings, never from the wire plan', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    db.adminSettings = JSON.stringify({
      localTrailing: { enabled: true, trailPercentage: 4, maxPoints: 900 },
    })

    await (client as any).handleSignalInner(entryWithWireTrail())

    expect(db.trailStates).toHaveLength(1)
    const state = db.trailStates[0]
    // User's own values...
    expect(state.trailPercentage).toBe(4)
    expect(state.maxPoints).toBe(900)
    // ...and none of the wire plan's values (1.5% / 250pts / 3% cap / fee).
    expect(state.trailPoints).toBeNull()
    expect(state.maxPercentage).toBeNull()
    expect(state.breakevenFee).toBeNull()
  })
})
