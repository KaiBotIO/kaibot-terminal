import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// Synthetic mode in the signal pipeline: a synthetic USD position flagged as
// the factor basis turns the signal's factor units into a percent of that
// position's target_usd for the whole (exchange, account) — any symbol. No
// flagged position → the pre-existing contract-count behaviour. All exchange
// calls are mocked — nothing reaches a venue.

type SyntheticRow = {
  exchange: string
  account_id: string
  symbol: string
  target_usd: number
  status: string
}

type Sub = {
  id: string
  factor: number
  status: string
  exchange?: string
  account_id?: string
  max_position_size?: number
  selected_markets?: string
}

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  safetyClips: any[] = []
  executions = new Map<string, any>()

  constructor(
    private sub: Sub | null,
    private syntheticRow: SyntheticRow | null = null,
    private marginRow: any = null,
  ) {}

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {}
  recordSignalQueue() {}
  getBotConfigs(_onlyRunning = true) { return [] }
  getSubscriptionForBot() { return this.sub }
  getFactorBasisSyntheticUsdPosition() { return this.syntheticRow }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  logSafetyClip(entry: any) { this.safetyClips.push(entry) }
  getAccountSize() { return null }
  getMarginGuard(exchange: string) { return this.marginRow && exchange !== '*' ? this.marginRow : null }
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
  clip(reason: string) { return this.safetyClips.find((c) => c.reason === reason) }
}

class FakeAdapter {
  placed: Order[] = []
  positionCalls = 0
  alwaysOpen = true
  constructor(
    public name = 'deribit',
    private positions: Position[] = [],
    private balances: any[] = [],
  ) {}
  async getBalances() { return this.balances }
  async getPositions() {
    this.positionCalls++
    return this.positions
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity, averagePrice: 50_000 }
  }
  async cancelOrder() {}
}

function build(sub: Sub | null, syntheticRow: SyntheticRow | null, adapter: FakeAdapter, marginRow: any = null) {
  const db = new FakeDb(sub, syntheticRow, marginRow)
  const manager = {
    async getSession() {
      return { adapter, status: 'connected', userId: 'default', exchangeName: adapter.name }
    },
  }
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  client.setSettleOptions(2, 1)
  return { db, client }
}

const flagged = (over: Partial<SyntheticRow> = {}): SyntheticRow => ({
  exchange: 'deribit',
  account_id: 'btc',
  symbol: 'BTC-PERPETUAL',
  target_usd: 100_000,
  status: 'open',
  ...over,
})

const sub = (over: Partial<Sub> = {}): Sub => ({
  id: 'sub-1',
  factor: 1,
  status: 'active',
  exchange: 'deribit',
  account_id: 'btc',
  ...over,
})

function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol: 'BTC-PERPETUAL',
    action: 'buy',
    quantity: 1,
    price: 50_000,
    metadata: { signalBotId: 'bot-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...over,
  } as Signal
}

describe('synthetic mode sizing', () => {
  it('without a flagged position, quantity stays originalQty × factor (contracts)', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(sub({ factor: 2 }), null, adapter)

    await (client as any).handleSignalInner(signal({ quantity: 10 }))

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].quantity).toBe(20)
    expect(db.clip('synthetic_sizing_applied')).toBeUndefined()
  })

  it('sizes the percent against target_usd on an inverse venue, no positions lookup', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(sub(), flagged(), adapter)

    // 1 factor unit × factor 1 = 1% of 100k → 1000 USD contracts
    await (client as any).handleSignalInner(signal({ quantity: 1 }))

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].quantity).toBe(1000)
    expect(db.clip('synthetic_sizing_applied')).toMatchObject({ originalQuantity: 1, adjustedQuantity: 1000 })
    expect(adapter.positionCalls).toBe(0)
  })

  it('applies account-wide: a basis flagged on another symbol still sizes this signal', async () => {
    const adapter = new FakeAdapter()
    // Flagged on BTC-PERPETUAL, signal on ETH-PERPETUAL, same (deribit, btc).
    const { db, client } = build(sub(), flagged(), adapter)

    // 2% of 100k = 2000 USD contracts on ETH-PERPETUAL (step 1)
    await (client as any).handleSignalInner(signal({ symbol: 'ETH-PERPETUAL', quantity: 2 }))

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].quantity).toBe(2000)
    expect(db.clip('synthetic_sizing_applied')).toBeDefined()
  })

  it('ignores a basis on a different account — normal contract sizing applies', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(
      sub({ account_id: 'eth', factor: 2 }),
      flagged({ account_id: 'btc' }),
      adapter,
    )

    await (client as any).handleSignalInner(signal({ symbol: 'ETH-PERPETUAL', quantity: 5 }))

    expect(adapter.placed[0].quantity).toBe(10)
    expect(db.clip('synthetic_sizing_applied')).toBeUndefined()
  })

  it('converts via signal.price on a linear venue', async () => {
    const adapter = new FakeAdapter('bybit')
    const { client } = build(
      sub({ exchange: 'bybit', account_id: 'default' }),
      flagged({ exchange: 'bybit', account_id: 'default', symbol: 'BTCUSDT', target_usd: 50_000 }),
      adapter,
    )

    // 10% of 50k = 5000 USD at 100k → 0.05 BTC
    await (client as any).handleSignalInner(signal({ symbol: 'BTCUSDT', quantity: 10, price: 100_000 }))

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].quantity).toBe(0.05)
  })

  it('falls back to the mark price of a live position on a linear venue', async () => {
    const adapter = new FakeAdapter('bybit', [
      { id: 'p1', accountId: 'default', symbol: 'BTCUSDT', side: 'long', size: 1, entryPrice: 40_000, markPrice: 50_000 } as Position,
    ])
    const { client } = build(
      sub({ exchange: 'bybit', account_id: 'default' }),
      flagged({ exchange: 'bybit', account_id: 'default', symbol: 'BTCUSDT', target_usd: 50_000 }),
      adapter,
    )

    // 10% of 50k = 5000 USD at mark 50k → 0.1 BTC
    await (client as any).handleSignalInner(signal({ symbol: 'BTCUSDT', quantity: 10, price: undefined }))

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].quantity).toBe(0.1)
    expect(adapter.positionCalls).toBeGreaterThan(0)
  })

  it('fails closed on a linear venue with no usable price', async () => {
    const adapter = new FakeAdapter('bybit')
    const { db, client } = build(
      sub({ exchange: 'bybit', account_id: 'default' }),
      flagged({ exchange: 'bybit', account_id: 'default', symbol: 'BTCUSDT', target_usd: 50_000 }),
      adapter,
    )

    await (client as any).handleSignalInner(signal({ symbol: 'BTCUSDT', quantity: 10, price: undefined }))

    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('synthetic sizing')
    expect(db.clip('synthetic_sizing_no_price')).toBeDefined()
  })

  it('caps a percent above 100 at exactly the synthetic value', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(sub({ factor: 2 }), flagged({ target_usd: 20_000 }), adapter)

    // 80 × 2 = 160% → capped at 20k USD contracts
    await (client as any).handleSignalInner(signal({ quantity: 80 }))

    expect(adapter.placed[0].quantity).toBe(20_000)
    expect(db.clip('synthetic_notional_cap')).toMatchObject({ originalQuantity: 160, adjustedQuantity: 20_000 })
  })

  it('clips max_position_size on the post-conversion quantity (unit regression)', async () => {
    const adapter = new FakeAdapter()
    // Percent (1) is far below the cap; the converted 1000 contracts are above
    // it. The cap must bite the converted number, not the raw percent.
    const { db, client } = build(sub({ max_position_size: 500 }), flagged(), adapter)

    await (client as any).handleSignalInner(signal({ quantity: 1 }))

    expect(adapter.placed[0].quantity).toBe(500)
    expect(db.clip('max_position_size')).toMatchObject({ originalQuantity: 1000, adjustedQuantity: 500 })
  })

  it('sizes a DCA add exactly like a fresh open', async () => {
    const adapter = new FakeAdapter()
    const { db, client } = build(sub(), flagged(), adapter)

    await (client as any).handleSignalInner(signal({ quantity: 1, metadata: { signalBotId: 'bot-1', add: true } }))

    expect(adapter.placed[0].quantity).toBe(1000)
    expect(db.clip('synthetic_sizing_applied')).toBeDefined()
  })

  it('rejects when the USD-mode maxPositionSize rounds below one contract (regression)', async () => {
    // Bybit BTCUSDT: step 0.001. size_unit='usd', no synthetic basis. The signal
    // sizes to a real order (5000 USD → 0.05 BTC), but max_position_size = $50
    // → 0.0005 BTC → rounds to 0. The cap must REJECT, never fall through to the
    // raw USD number and let an uncapped order through.
    const adapter = new FakeAdapter('bybit')
    const { db, client } = build(
      sub({ exchange: 'bybit', account_id: 'default', max_position_size: 50 }),
      null, // no synthetic basis → USD-mode path
      adapter,
    )

    await (client as any).handleSignalInner(
      signal({
        symbol: 'BTCUSDT',
        quantity: 5000,
        price: 100_000,
        metadata: { signalBotId: 'bot-1', sizeUnit: 'usd' },
      }),
    )

    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('maxPositionSize')
    expect(db.clip('max_position_size')).toMatchObject({ adjustedQuantity: 0 })
  })

  it('applies the USD-mode maxPositionSize cap when it converts to a real size', async () => {
    // Same setup but a $10k cap → 0.1 BTC. A 20k-USD signal (0.2 BTC) is clipped
    // to 0.1 BTC, not rejected.
    const adapter = new FakeAdapter('bybit')
    const { db, client } = build(
      sub({ exchange: 'bybit', account_id: 'default', max_position_size: 10_000 }),
      null,
      adapter,
    )

    await (client as any).handleSignalInner(
      signal({
        symbol: 'BTCUSDT',
        quantity: 20_000,
        price: 100_000,
        metadata: { signalBotId: 'bot-1', sizeUnit: 'usd' },
      }),
    )

    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].quantity).toBeCloseTo(0.1, 6)
    expect(db.clip('max_position_size')).toMatchObject({ adjustedQuantity: 0.1 })
  })

  it('breathing room still vetoes a synthetic-sized open', async () => {
    const adapter = new FakeAdapter('deribit', [], [
      { accountId: 'btc', currency: 'BTC', balance: 0.15, equity: 0.15, realizedPnL: 0, unrealizedPnL: 0, initialMargin: 0.1, maintenanceMargin: 0.04, timestamp: 0 },
    ])
    const marginRow = { exchange: 'deribit', account: 'btc', enabled: 1, buffer_mult: 1.5, floor_mode: 'maintenance', equity_pct: 0.2 }
    const { db, client } = build(sub(), flagged(), adapter, marginRow)

    // 10% of 100k = 10000 USD contracts → 0.2 BTC order margin at 50k, only
    // 0.05 BTC available above the floor → reject, no order.
    await (client as any).handleSignalInner(signal({ quantity: 10 }))

    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.clip('breathing_room')).toBeDefined()
  })
})
