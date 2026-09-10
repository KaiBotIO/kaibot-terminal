import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// Tests for the maxConcurrentTrades cap. The cap is backed by the live exchange
// position count (the local `positions` table is never written), cached briefly
// to avoid hammering the exchange API on signal bursts.

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  safetyClips: any[] = []
  queue: any[] = []
  fills: any[] = []
  executions = new Map<string, any>()
  private sub: any | null

  constructor(sub: any | null) {
    this.sub = sub
  }

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {/* no-op */}
  recordSignalQueue(entry: any) { this.queue.push(entry) }
  getBotConfigs(_onlyRunning = true) { return [] }
  getSubscriptionForBot() { return this.sub }
  updateSignalStatus(id: string, status: string, _tradeId?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  logSafetyClip(entry: any) { this.safetyClips.push(entry) }
  getAccountSize(_ex: string, _acc: string, _root: string): number | null { return null }
  updateSignalOrderIds() {/* no-op */}

  // ── execution state + fills (migration 007) ──
  getSignalExecution(id: string) { return this.executions.get(id) }
  insertSignalExecution(row: any) {
    if (this.executions.has(row.signalId)) return false
    this.executions.set(row.signalId, {
      signal_id: row.signalId,
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
    Object.assign(row, {
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.qtyOpened !== undefined ? { qty_opened: patch.qtyOpened } : {}),
      ...(patch.qtyClosed !== undefined ? { qty_closed: patch.qtyClosed } : {}),
      ...(patch.errorReason !== undefined ? { error_reason: patch.errorReason } : {}),
    })
  }
  insertSignalFill(fill: any) { this.fills.push(fill) }

  lastStatus() { return this.signalStatuses[this.signalStatuses.length - 1] }
  clipReasons() { return this.safetyClips.map((c) => c.reason) }
}

class FakeAdapter {
  name = 'deribit'
  positions: Position[]
  placed: Order[] = []
  getPositionsCalls = 0

  constructor(positions: Position[] = []) {
    this.positions = positions
  }

  async getPositions(): Promise<Position[]> {
    this.getPositionsCalls++
    return this.positions
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    this.placed.push(order)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: order.quantity }
  }

  async cancelOrder(): Promise<void> {/* no-op */}
}

class FakeExchangeManager {
  adapter: FakeAdapter
  constructor(adapter: FakeAdapter) { this.adapter = adapter }
  async getSession() {
    return { adapter: this.adapter, status: 'connected' as const, userId: 'default', exchangeName: this.adapter.name }
  }
}

function openSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol: 'BTC-PERPETUAL',
    action: 'buy',
    quantity: 10,
    metadata: { exchange: 'deribit', signalBotId: 'bot-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as Signal
}

function pos(symbol: string, size = 5): Position {
  return { id: `deribit:${symbol}`, accountId: 'btc', symbol, side: 'long', size, entryPrice: 60000 }
}

function build(sub: any | null, positions: Position[]) {
  const db = new FakeDb(sub)
  const adapter = new FakeAdapter(positions)
  const manager = new FakeExchangeManager(adapter)
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  return { db, adapter, client }
}

const baseSub = (overrides: Record<string, any> = {}) => ({
  id: 'sub-1',
  signal_bot_id: 'bot-1',
  exchange: 'deribit',
  factor: 1,
  status: 'active',
  ...overrides,
})

describe('SignalWebSocketClient maxConcurrentTrades', () => {
  it('rejects a new open when live open positions reach the cap', async () => {
    const { db, adapter, client } = build(
      baseSub({ max_concurrent_trades: 2 }),
      [pos('BTC-PERPETUAL'), pos('ETH-PERPETUAL')],
    )
    await (client as any).handleSignal(openSignal())

    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('maxConcurrentTrades reached (2)')
    expect(db.clipReasons()).toContain('max_concurrent_trades')
  })

  it('allows a new open when live positions are below the cap', async () => {
    const { adapter, client } = build(
      baseSub({ max_concurrent_trades: 2 }),
      [pos('BTC-PERPETUAL')],
    )
    await (client as any).handleSignal(openSignal())

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].side).toBe('buy')
  })

  it('ignores zero-size (flat) positions when counting', async () => {
    const { adapter, client } = build(
      baseSub({ max_concurrent_trades: 1 }),
      [pos('BTC-PERPETUAL', 0), pos('ETH-PERPETUAL', 0)],
    )
    await (client as any).handleSignal(openSignal())

    expect(adapter.placed).toHaveLength(1)
  })

  it('scopes the count to selected_markets when set', async () => {
    // Cap of 1, two open positions, but only ETH is in scope → BTC entry allowed.
    const { adapter, client } = build(
      baseSub({ max_concurrent_trades: 1, selected_markets: JSON.stringify(['BTC-PERPETUAL']) }),
      [pos('BTC-PERPETUAL'), pos('ETH-PERPETUAL'), pos('SOL-PERPETUAL')],
    )
    // One BTC position in scope already meets the cap of 1 → reject.
    await (client as any).handleSignal(openSignal())
    expect(adapter.placed).toHaveLength(0)
  })

  it('allows the in-scope market when the only open position is out of scope', async () => {
    const { adapter, client } = build(
      baseSub({ max_concurrent_trades: 1, selected_markets: JSON.stringify(['BTC-PERPETUAL']) }),
      [pos('ETH-PERPETUAL')],
    )
    await (client as any).handleSignal(openSignal())
    expect(adapter.placed).toHaveLength(1)
  })

  it('caches the position count across a burst (one getPositions call within TTL)', async () => {
    const { adapter, client } = build(
      baseSub({ max_concurrent_trades: 10 }),
      [pos('BTC-PERPETUAL')],
    )
    client.setPositionsCacheTtlMs(10_000)
    await (client as any).handleSignal(openSignal({ id: 'sig-a' }))
    await (client as any).handleSignal(openSignal({ id: 'sig-b' }))
    await (client as any).handleSignal(openSignal({ id: 'sig-c' }))

    expect(adapter.placed).toHaveLength(3)
    // First call populates the cache; the next two reuse it.
    expect(adapter.getPositionsCalls).toBe(1)
  })

  it('re-fetches positions after the cache TTL expires', async () => {
    const { adapter, client } = build(
      baseSub({ max_concurrent_trades: 10 }),
      [pos('BTC-PERPETUAL')],
    )
    client.setPositionsCacheTtlMs(0)
    await (client as any).handleSignal(openSignal({ id: 'sig-a' }))
    await (client as any).handleSignal(openSignal({ id: 'sig-b' }))

    expect(adapter.getPositionsCalls).toBe(2)
  })

  it('does not count positions when no cap is configured', async () => {
    const { adapter, client } = build(
      baseSub({ max_concurrent_trades: null }),
      [pos('BTC-PERPETUAL'), pos('ETH-PERPETUAL')],
    )
    await (client as any).handleSignal(openSignal())

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.getPositionsCalls).toBe(0)
  })
})
