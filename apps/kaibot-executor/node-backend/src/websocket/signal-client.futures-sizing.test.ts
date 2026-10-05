import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult } from '../services/exchanges/types.js'

// TS live blockers 2026-08: USD-mode sizing divided by the bare index price,
// ignoring the futures contract multiplier — 5× oversize on MES, 2× MNQ,
// 10× MGC, 1000× SIL. One contract's notional is price × multiplier; these
// scenarios pin the conversion per root. All exchange calls are mocked.

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  safetyClips: any[] = []
  executions = new Map<string, any>()
  private sub: any

  constructor(sub: any) {
    this.sub = sub
  }

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {}
  recordSignalQueue() {}
  getSubscriptionForBot() { return this.sub }
  getBotConfigs() { return [] }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  logSafetyClip(entry: any) { this.safetyClips.push(entry) }
  getAccountSize(): number | null { return null }
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
    Object.assign(r, { status: patch.status ?? r.status, qty_opened: patch.qtyOpened ?? r.qty_opened })
  }
  insertSignalFill() {}
  upsertBracketPair() {}
  insertOrderSettlement() { return 1 }
  lastStatus() { return this.signalStatuses[this.signalStatuses.length - 1] }
}

class FakeAdapter {
  name = 'tradestation'
  placed: Order[] = []
  alwaysOpen = true // skip market guard here
  async getPositions() { return [] }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity, averagePrice: o.price }
  }
  async cancelOrder() {}
}

class FakeManager {
  constructor(private adapter: FakeAdapter) {}
  async getSession() {
    return { adapter: this.adapter, status: 'connected', userId: 'default', exchangeName: this.adapter.name }
  }
}

// One signal of qty 1 with a USD factor: sized quantity = factor USD → contracts.
async function placeUsd(symbol: string, price: number, usd: number) {
  const adapter = new FakeAdapter()
  const db = new FakeDb({ id: 'sub-1', factor: usd, size_unit: 'usd', account_id: 'ACC1' })
  const client = new SignalWebSocketClient(db as any, new FakeManager(adapter) as any, null)
  client.setSettleOptions(2, 1)
  const signal = {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol,
    action: 'buy',
    quantity: 1,
    price,
    metadata: { exchange: 'tradestation', signalBotId: 'bot-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  } as unknown as Signal
  await (client as any).handleSignalInner(signal)
  return { adapter, db }
}

describe('USD sizing uses the futures contract multiplier', () => {
  it('MES (×5): $50k at 5000 → 2 contracts, not 10', async () => {
    const { adapter } = await placeUsd('MESU26', 5000, 50_000)
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].quantity).toBe(2)
  })

  it('MNQ (×2): $80k at 20000 → 2 contracts, not 4', async () => {
    const { adapter } = await placeUsd('MNQZ26', 20_000, 80_000)
    expect(adapter.placed[0].quantity).toBe(2)
  })

  it('MGC (×10): $40k at 4000 → 1 contract, not 10', async () => {
    const { adapter } = await placeUsd('MGCZ26', 4000, 40_000)
    expect(adapter.placed[0].quantity).toBe(1)
  })

  it('SIL (×1000): $60k at 60 → 1 contract, not 1000', async () => {
    const { adapter } = await placeUsd('SILZ26', 60, 60_000)
    expect(adapter.placed[0].quantity).toBe(1)
  })

  it('a USD amount below one contract notional is rejected, never dust-ordered', async () => {
    // $10k vs a $25k per-contract notional (MES at 5000) → 0 contracts → reject.
    const { adapter, db } = await placeUsd('MESU26', 5000, 10_000)
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('below the tradable minimum')
  })
})
