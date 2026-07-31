import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, OrderStatus, Position } from '../services/exchanges/types.js'

// Item 2 end-to-end: an ENTRY whose outcome is unknown at placement time (settle
// TIMEOUT) must NOT be written off as rejected/qty0 and forgotten. It is
// persisted as an unresolved settlement and the execution stays tracked; a later
// background pass (resolveUnknownOrders) re-queries the broker — which now finds
// the fill via the historical lookup — and turns the execution into an OPEN
// position at the real fill price. No orphan.

class FakeDb {
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  closedEntries: Array<{ id: string; reason?: string }> = []
  fills: any[] = []
  executions = new Map<string, any>()
  settlements: any[] = []

  log() {}
  recordSignal() {}
  recordSignalQueue() {}
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  logSafetyClip() {}
  getAccountSize(): number | null { return null }
  getOpenEntrySignals() { return [] }
  markEntrySignalClosed(id: string, reason?: string) { this.closedEntries.push({ id, reason }) }

  getSignalExecution(id: string) { return this.executions.get(id) }
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
  insertSignalFill(fill: any) { this.fills.push(fill) }

  insertOrderSettlement(row: any) {
    const id = this.settlements.length + 1
    this.settlements.push({
      id,
      status: 'unknown',
      created_at: Date.now(),
      ...row,
      order_id: row.orderId,
      signal_id: row.signalId,
      account_id: row.accountId ?? null,
    })
    return id
  }
  listUnresolvedSettlements(exchange?: string) {
    return this.settlements.filter((s) => s.status === 'unknown' && (!exchange || s.exchange === exchange))
  }
  resolveOrderSettlement(id: number, status: string) {
    const s = this.settlements.find((x) => x.id === id)
    if (s) s.status = status
  }

  upsertBracketPair() {}
  listBracketPairs() { return [] }
  deleteBracketPair() {}
  listClosingExecutions() { return [] }

  lastStatus() { return this.signalStatuses[this.signalStatuses.length - 1] }
}

// Scripted adapter. getOrderStatus returns `currentStatus`, mutated by the test:
// at entry-settle time it stays 'working'/'unknown' (so settlement times out),
// and is flipped to the late fill before the background resolution pass — exactly
// what the historical lookup would surface once the order left the working set.
class ScriptedAdapter {
  name = 'tradestation'
  positions: Position[] = []
  placed: Order[] = []
  alwaysOpen = false
  currentStatus: OrderStatus = { orderId: 'ord-late', state: 'working' }

  async getPositions() { return this.positions }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: 'ord-late', status: 'pending' } // never an upfront fill
  }
  async cancelOrder() {}
  async getMarketStatus(symbols: string[]) {
    // Open market so the entry isn't blocked by the guard.
    return new Map(symbols.map((s) => [s, { symbol: s, last: 5000, tradeTimeMs: Date.now() }]))
  }
  async getOrderStatus(): Promise<OrderStatus> {
    return this.currentStatus
  }
}

class FakeManager {
  constructor(private adapter: ScriptedAdapter) {}
  async getSession() {
    return { adapter: this.adapter, status: 'connected', userId: 'default', exchangeName: 'tradestation' }
  }
}

function entrySignal(): Signal {
  return {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol: 'MESM26',
    action: 'buy',
    quantity: 4,
    price: 5000,
    metadata: { exchange: 'tradestation' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  } as Signal
}

describe('entry timeout → historical fill → open (no orphan)', () => {
  it('persists an unresolved settlement on timeout, then opens on the late fill', async () => {
    // Entry settle: the order never reaches a terminal status in the poll window
    // (stays 'working') → settlement times out (unknown).
    const adapter = new ScriptedAdapter()
    const db = new FakeDb()
    const manager = new FakeManager(adapter)
    const client = new SignalWebSocketClient(db as any, manager as any, null)
    client.setSettleOptions(2, 1) // tiny cadence so the timeout resolves in ms

    await (client as any).handleSignalInner(entrySignal())

    // Entry timed out: it is NOT rejected, it's tracked with an unresolved
    // settlement → no premature write-off, no orphan.
    const settle = db.settlements.find((s) => s.kind === 'entry')
    expect(settle).toBeDefined()
    expect(settle.status).toBe('unknown')
    expect(db.signalStatuses.some((s) => s.status === 'rejected')).toBe(false)
    expect(db.getSignalExecution('sig-1')?.status).toBe('open') // tracked, qty still 0
    expect(db.getSignalExecution('sig-1')?.qty_opened).toBe(0)

    // The order now surfaces as FILLED via the historical lookup.
    adapter.currentStatus = { orderId: 'ord-late', state: 'filled', filledQuantity: 4, averagePrice: 5005 }

    // Background resolution finds the fill → open position.
    const resolved = await client.resolveUnknownOrders()
    expect(resolved).toBe(1)
    expect(settle.status).toBe('filled')

    const exec = db.getSignalExecution('sig-1')
    expect(exec?.status).toBe('open')
    expect(exec?.qty_opened).toBe(4)
    expect(exec?.error_reason).toBeNull()
    // The fill was recorded at the real (historical) price.
    const fill = db.fills.find((f) => f.kind === 'entry')
    expect(fill?.qty).toBe(4)
    expect(fill?.price).toBe(5005)
  })
})
