import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// Exit-as-signal-update (E2): `update` signals are follow-ups on an entry,
// emitted by the strategy the user deployed. The executor accepts them ONLY
// for positions whose entry carried metadata.exitAuthority:'server' (gate row
// in server_exit_state), strictly monotonically (exitSeq) and sharpen-only.
// Everything else keeps the flat refusal — the carve-out posture is the
// default, authority is the explicit exception.

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
  exitStates = new Map<string, any>()
  localTrailPatches: any[] = []

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
    this.bracketPairs.set(row.signalId, row)
  }
  listBracketPairs() {
    return [...this.bracketPairs.values()]
  }
  deleteBracketPair(id: string) {
    this.bracketPairs.delete(id)
  }

  // ── server exit state (migration 031) ──
  upsertServerExitState(row: any) {
    this.exitStates.set(row.positionId, {
      position_id: row.positionId,
      entry_signal_id: row.entrySignalId,
      exchange: row.exchange,
      symbol: row.symbol,
      direction: row.direction,
      last_exit_seq: 0,
      current_stop: row.currentStop ?? null,
      sl_order_id: row.slOrderId ?? null,
      active: 1,
    })
  }
  getServerExitState(positionId: string) {
    return this.exitStates.get(positionId) ?? null
  }
  applyServerExitUpdate(positionId: string, patch: any) {
    const row = this.exitStates.get(positionId)
    if (!row) return
    row.last_exit_seq = patch.exitSeq
    row.current_stop = patch.currentStop ?? null
    row.sl_order_id = patch.slOrderId ?? null
  }
  deactivateServerExitState(positionId: string) {
    const row = this.exitStates.get(positionId)
    if (row) row.active = 0
  }
  updateLocalTrail(signalId: string, patch: any) {
    this.localTrailPatches.push({ signalId, ...patch })
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
const POS = 'pos-abc'

function entrySignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'entry-1',
    strategy_id: 'strat-1',
    symbol: BTC,
    action: 'buy',
    quantity: 10,
    price: 60000,
    stop_loss: 55000,
    metadata: { exchange: 'deribit', exitAuthority: 'server', positionId: POS },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as Signal
}

function updateSignal(stopPrice: number, exitSeq: number, positionId = POS): Signal {
  return {
    id: `upd-${exitSeq}-${stopPrice}`,
    strategy_id: 'strat-1',
    symbol: BTC,
    action: 'update' as any,
    quantity: 0,
    price: stopPrice,
    metadata: { exchange: 'deribit', positionId, exitSeq },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  } as Signal
}

async function openAuthorizedLong(adapter: FakeAdapter, client: SignalWebSocketClient) {
  await (client as any).handleSignalInner(entrySignal())
  adapter.positions = [
    {
      id: 'p1', accountId: 'btc', symbol: BTC, side: 'long', size: 10,
      entryPrice: 60000, markPrice: 61000,
    } as Position,
  ]
}

describe('update — refused without server exit authority (gate default)', () => {
  it('rejects when the entry did not carry exitAuthority:server', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    // Entry WITHOUT authority metadata.
    await (client as any).handleSignalInner(
      entrySignal({ metadata: { exchange: 'deribit' } as any }),
    )
    adapter.positions = [
      { id: 'p1', accountId: 'btc', symbol: BTC, side: 'long', size: 10, entryPrice: 60000 } as Position,
    ]
    const placedBefore = adapter.placed.length
    adapter.cancelled = []

    await (client as any).handleSignalInner(updateSignal(57000, 1))

    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('exitAuthority')
    expect(adapter.placed.length).toBe(placedBefore)
    expect(adapter.cancelled).toHaveLength(0)
    expect(db.exitStates.size).toBe(0)
  })

  it('legacy stop_update stays refused even when authority exists', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    await openAuthorizedLong(adapter, client)
    const placedBefore = adapter.placed.length
    adapter.cancelled = []

    await (client as any).handleSignalInner({
      ...updateSignal(57000, 1),
      action: 'stop_update' as any,
    })

    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('managed locally')
    expect(adapter.placed.length).toBe(placedBefore)
    expect(adapter.cancelled).toHaveLength(0)
  })
})

describe('update — accepted with authority (sharpen-only, monotonic)', () => {
  it('entry with exitAuthority:server registers the gate row', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    await openAuthorizedLong(adapter, client)

    const state = db.getServerExitState(POS)
    expect(state).toBeTruthy()
    expect(state.entry_signal_id).toBe('entry-1')
    expect(state.direction).toBe('long')
    expect(state.current_stop).toBe(55000)
    expect(state.sl_order_id).toBeTruthy()
    expect(state.last_exit_seq).toBe(0)
  })

  it('applies a favourable stop update: cancel old, place reduce-only stop, advance seq', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    await openAuthorizedLong(adapter, client)
    const oldStopId = db.getServerExitState(POS).sl_order_id
    adapter.cancelled = []
    const placedBefore = adapter.placed.length

    await (client as any).handleSignalInner(updateSignal(57000, 1))

    expect(db.lastStatus().status).toBe('executed')
    expect(adapter.cancelled).toEqual([oldStopId])
    const newOrder = adapter.placed[adapter.placed.length - 1]
    expect(adapter.placed.length).toBe(placedBefore + 1)
    expect(newOrder.orderType).toBe('stop')
    expect(newOrder.stopPrice).toBe(57000)
    expect(newOrder.reduceOnly).toBe(true)
    expect(newOrder.side).toBe('sell')
    const state = db.getServerExitState(POS)
    expect(state.last_exit_seq).toBe(1)
    expect(state.current_stop).toBe(57000)
    expect(state.sl_order_id).toBe((newOrder as any).orderId ?? state.sl_order_id)
    // Entry bracket re-pointed at the live stop.
    expect(db.getSignalBracket('entry-1')!.stop_loss_order_id).toBe(state.sl_order_id)
  })

  it('ignores stale/duplicate exitSeq as a no-op (replay safety)', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    await openAuthorizedLong(adapter, client)

    await (client as any).handleSignalInner(updateSignal(57000, 1))
    adapter.cancelled = []
    const placedBefore = adapter.placed.length

    await (client as any).handleSignalInner(updateSignal(57000, 1))

    expect(db.lastStatus().status).toBe('executed')
    expect(adapter.placed.length).toBe(placedBefore)
    expect(adapter.cancelled).toHaveLength(0)
    expect(db.getServerExitState(POS).last_exit_seq).toBe(1)
  })

  it('refuses a loosening stop (server only sharpens)', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    await openAuthorizedLong(adapter, client)
    await (client as any).handleSignalInner(updateSignal(57000, 1))
    adapter.cancelled = []
    const placedBefore = adapter.placed.length

    await (client as any).handleSignalInner(updateSignal(54000, 2))

    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('not favourable')
    expect(adapter.placed.length).toBe(placedBefore)
    expect(adapter.cancelled).toHaveLength(0)
    // Seq untouched — the refused update never happened.
    expect(db.getServerExitState(POS).last_exit_seq).toBe(1)
  })

  it('flat position retires the gate row instead of placing orders', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    await openAuthorizedLong(adapter, client)
    adapter.positions = []
    adapter.cancelled = []
    const placedBefore = adapter.placed.length

    await (client as any).handleSignalInner(updateSignal(57000, 1))

    expect(db.lastStatus().status).toBe('executed')
    expect(adapter.placed.length).toBe(placedBefore)
    expect(db.getServerExitState(POS).active).toBe(0)
  })

  it('keeps the previous stop when the new one crossed the mark price', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter)
    await openAuthorizedLong(adapter, client)
    ;(adapter.positions[0] as any).markPrice = 56000
    adapter.cancelled = []
    const placedBefore = adapter.placed.length

    // 57000 >= mark 56000 for a long → old stop keeps guarding.
    await (client as any).handleSignalInner(updateSignal(57000, 1))

    expect(db.lastStatus().status).toBe('executed')
    expect(adapter.placed.length).toBe(placedBefore)
    expect(adapter.cancelled).toHaveLength(0)
    const state = db.getServerExitState(POS)
    expect(state.current_stop).toBe(55000)
    // Seq advanced so a fresher update is not blocked behind this one.
    expect(state.last_exit_seq).toBe(1)
  })
})
