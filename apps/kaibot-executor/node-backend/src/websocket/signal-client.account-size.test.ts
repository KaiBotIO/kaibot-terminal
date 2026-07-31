import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// Per-account contract sizing enforcement in the signal pipeline: a configured
// cap clips the order quantity (audited), and a configured cap of 0 kills the
// market for the account (signal rejected, no order placed). All exchange calls
// are mocked — nothing reaches a venue.

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  safetyClips: any[] = []
  fills: any[] = []
  executions = new Map<string, any>()
  bracketPairs = new Map<string, any>()
  settlements: any[] = []
  private sizes: Record<string, number>

  constructor(sizes: Record<string, number> = {}) {
    this.sizes = sizes
  }

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {}
  recordSignalQueue() {}
  getSubscriptionForBot() { return null }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  logSafetyClip(entry: any) { this.safetyClips.push(entry) }
  getAccountSize(exchange: string, account: string, root: string): number | null {
    const k = `${exchange}:${account}:${root}`
    return k in this.sizes ? this.sizes[k] : null
  }
  getOpenEntrySignals() { return [] }
  markEntrySignalClosed() {}
  getSignalExecution(id: string) { return this.executions.get(id) }
  insertSignalExecution(row: any) {
    if (this.executions.has(row.signalId)) return false
    this.executions.set(row.signalId, { signal_id: row.signalId, status: row.status, qty_opened: row.qtyOpened ?? 0, qty_closed: 0 })
    return true
  }
  updateSignalExecution(id: string, patch: any) {
    const r = this.executions.get(id)
    if (!r) return
    Object.assign(r, {
      status: patch.status ?? r.status,
      qty_opened: patch.qtyOpened ?? r.qty_opened,
    })
  }
  insertSignalFill(f: any) { this.fills.push(f) }
  upsertBracketPair(row: any) { this.bracketPairs.set(row.signalId, row) }
  insertOrderSettlement(row: any) { this.settlements.push(row); return this.settlements.length }
  lastStatus() { return this.signalStatuses[this.signalStatuses.length - 1] }
}

class FakeAdapter {
  name = 'tradestation'
  positions: Position[] = []
  placed: Order[] = []
  alwaysOpen = true // skip market guard for these tests
  async getPositions() { return this.positions }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity, averagePrice: 5000 }
  }
  async cancelOrder() {}
}

class FakeManager {
  constructor(private adapter: FakeAdapter) {}
  async getSession() {
    return { adapter: this.adapter, status: 'connected', userId: 'default', exchangeName: this.adapter.name }
  }
}

function build(adapter: FakeAdapter, sizes: Record<string, number> = {}) {
  const db = new FakeDb(sizes)
  const manager = new FakeManager(adapter)
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  client.setSettleOptions(2, 1)
  return { db, client }
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol: 'MESM26',
    action: 'buy',
    quantity: 10,
    metadata: { exchange: 'tradestation' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as Signal
}

describe('account-size enforcement', () => {
  it('clips the order quantity to the configured cap', async () => {
    const adapter = new FakeAdapter()
    // account resolves to 'default' for tradestation; MESM26 root is MES.
    const { db, client } = build(adapter, { 'tradestation:default:MES': 4 })

    await (client as any).handleSignalInner(signal({ quantity: 10 }))

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].quantity).toBe(4)
    expect(db.safetyClips.some((c) => c.reason === 'account_size_cap')).toBe(true)
  })

  it('rejects the signal and places no order when the cap is 0 (kill-switch)', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(adapter, { 'tradestation:default:MES': 0 })

    await (client as any).handleSignalInner(signal({ quantity: 3 }))

    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.safetyClips.some((c) => c.reason === 'account_size_killswitch')).toBe(true)
  })

  it('applies the built-in default cap when unconfigured', async () => {
    const adapter = new FakeAdapter()
    // MES default cap is 4 → a request of 10 clips to 4 with no explicit config.
    const { client } = build(adapter, {})

    await (client as any).handleSignalInner(signal({ quantity: 10 }))

    expect(adapter.placed[0].quantity).toBe(4)
  })
})
