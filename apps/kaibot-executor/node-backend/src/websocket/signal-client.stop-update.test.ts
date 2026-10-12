import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// Regression guard (R10 / carve-out): the server-pushed stop_update handler
// (Model B trailing) was REMOVED — the server no longer authors stop moves, and
// the executor must REFUSE one outright if it ever arrives again. Exits are
// computed locally from the user's own config (local trailing), never from a
// KaiBot-pushed price. These tests assert the refusal: no order placed, no
// order cancelled, no bracket re-pointed, acked 'rejected'.

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
  alwaysOpen = true // crypto → skip market guard

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

function openSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'entry-1',
    strategy_id: 'strat-1',
    symbol: BTC,
    action: 'buy',
    quantity: 10,
    metadata: { exchange: 'deribit' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as Signal
}

function stopUpdateSignal(stopPrice: number, entrySignalId = 'entry-1'): Signal {
  return {
    id: `stopupd-${stopPrice}`,
    strategy_id: 'strat-1',
    symbol: BTC,
    action: 'stop_update' as any,
    quantity: 0,
    price: stopPrice,
    metadata: { exchange: 'deribit', entrySignalId, stopPrice },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  } as Signal
}

// Open a bracketed long so a live position + resting stop exist — the state a
// server trail would have targeted.
async function openBracketedLong(adapter: FakeAdapter, client: SignalWebSocketClient) {
  await (client as any).handleSignalInner(openSignal({ stop_loss: 55000, take_profit: 65000 }))
  adapter.positions = [
    { id: 'p1', accountId: 'btc', symbol: BTC, side: 'long', size: 10, entryPrice: 60000 },
  ]
}

describe('stop_update — refused outright (server no longer authors stop moves)', () => {
  it('acks rejected and touches no orders or brackets', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    await openBracketedLong(adapter, client)

    const oldStopId = db.getSignalBracket('entry-1')!.stop_loss_order_id!
    expect(oldStopId).toBeTruthy()
    const placedBefore = adapter.placed.length
    adapter.cancelled = [] // ignore any cancels from the open path

    await (client as any).handleSignalInner(stopUpdateSignal(57000))

    // Refused: acked rejected with the refusal reason.
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('managed locally')
    // Nothing placed, nothing cancelled — the resting stop is untouched.
    expect(adapter.placed.length).toBe(placedBefore)
    expect(adapter.cancelled).toHaveLength(0)
    // The persisted SL leg still points at the original stop.
    expect(db.getSignalBracket('entry-1')!.stop_loss_order_id).toBe(oldStopId)
    const pair = [...db.bracketPairs.values()][0]
    expect(pair.sl_order_id).toBe(oldStopId)
  })

  it('refuses even without any tracked bracket (no graceful execute)', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)

    await (client as any).handleSignalInner(stopUpdateSignal(57000, 'unknown-entry'))

    // The old handler acked 'executed' as a graceful no-op; the refusal must
    // ack 'rejected' so the sender learns stop moves are not accepted at all.
    expect(db.lastStatus().status).toBe('rejected')
    expect(adapter.placed).toHaveLength(0)
    expect(adapter.cancelled).toHaveLength(0)
  })
})
