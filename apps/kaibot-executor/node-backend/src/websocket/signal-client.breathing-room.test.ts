import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Balance, Order, OrderResult, Position } from '../services/exchanges/types.js'

// Breathing-room margin-guard enforcement in the signal pipeline: with the guard
// enabled, an open that would breach the free-margin floor is rejected and no
// order is placed; otherwise the order goes through. The guard is opt-in (no
// config row → skipped) and fail-open (a balance-lookup error → proceed). All
// exchange calls are mocked — nothing reaches a venue.

type MarginRow = {
  exchange: string
  account: string
  enabled: number
  buffer_mult: number
  floor_mode: string
  equity_pct: number
}

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  safetyClips: any[] = []
  executions = new Map<string, any>()
  private marginRow: MarginRow | null

  constructor(marginRow: MarginRow | null = null) {
    this.marginRow = marginRow
  }

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {}
  recordSignalQueue() {}
  // TradeStation entries need a routed broker account on the subscription
  // (the 'default' fallback is rejected before sizing).
  getSubscriptionForBot() { return { id: 'sub-1', factor: 1, account_id: 'ACC1' } }
  getBotConfigs() { return [] }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  logSafetyClip(entry: any) { this.safetyClips.push(entry) }
  getAccountSize() { return null }
  getMarginGuard(exchange: string, _account: string): MarginRow | null {
    // Per-account lookup returns the configured row; the ('*','*') global
    // fallback returns null so tests exercise the row (or built-in defaults).
    return this.marginRow && exchange !== '*' ? this.marginRow : null
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
    Object.assign(r, { status: patch.status ?? r.status, qty_opened: patch.qtyOpened ?? r.qty_opened })
  }
  insertSignalFill() {}
  upsertBracketPair() {}
  insertOrderSettlement() { return 1 }
  lastStatus() { return this.signalStatuses[this.signalStatuses.length - 1] }
}

class FakeAdapter {
  name: string
  positions: Position[]
  placed: Order[] = []
  alwaysOpen = true
  constructor(
    private balances: Balance[],
    private balancesThrow = false,
    name = 'tradestation',
    positions: Position[] = [],
  ) {
    this.name = name
    this.positions = positions
  }
  async getBalances(): Promise<Balance[]> {
    if (this.balancesThrow) throw new Error('balance lookup failed')
    return this.balances
  }
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

const bal = (over: Partial<Balance> = {}): Balance => ({
  accountId: 'default',
  balance: 0,
  equity: 0,
  realizedPnL: 0,
  unrealizedPnL: 0,
  initialMargin: 0,
  maintenanceMargin: 0,
  currency: 'USD',
  timestamp: 0,
  ...over,
})

const row = (over: Partial<MarginRow> = {}): MarginRow => ({
  exchange: 'tradestation',
  account: 'default',
  enabled: 1,
  buffer_mult: 1.5,
  floor_mode: 'maintenance',
  equity_pct: 0.2,
  ...over,
})

function build(adapter: FakeAdapter, marginRow: MarginRow | null) {
  const db = new FakeDb(marginRow)
  const client = new SignalWebSocketClient(db as any, new FakeManager(adapter) as any, null)
  client.setSettleOptions(2, 1)
  return { db, client }
}

function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol: 'MESM26',
    action: 'buy',
    quantity: 1,
    price: 5000,
    metadata: { exchange: 'tradestation', signalBotId: 'bot-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...over,
  } as Signal
}

describe('breathing-room enforcement', () => {
  it('rejects the open and places no order when the floor is breached', async () => {
    // available = 15000, required = 1.5 × 10000 maintenance = 15000, order margin
    // 5000 (notional 5000 / lev 1) → after 10000 < 15000 → reject.
    const adapter = new FakeAdapter([bal({ equity: 20_000, initialMargin: 5_000, maintenanceMargin: 10_000 })])
    const { db, client } = build(adapter, row())

    await (client as any).handleSignalInner(signal())

    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('breathing room')
    expect(db.safetyClips.some((c) => c.reason === 'breathing_room')).toBe(true)
  })

  it('allows the open when enough free margin remains', async () => {
    const adapter = new FakeAdapter([bal({ equity: 100_000, initialMargin: 5_000, maintenanceMargin: 10_000 })])
    const { db, client } = build(adapter, row())

    await (client as any).handleSignalInner(signal())

    expect(adapter.placed).toHaveLength(1)
    expect(db.safetyClips.some((c) => c.reason === 'breathing_room')).toBe(false)
  })

  it('is opt-in: with no config row the guard is skipped (order placed)', async () => {
    // Tiny equity that WOULD breach if enabled, but no row → built-in default is
    // disabled → guard skipped → order placed.
    const adapter = new FakeAdapter([bal({ equity: 1, initialMargin: 0, maintenanceMargin: 0 })])
    const { client } = build(adapter, null)

    await (client as any).handleSignalInner(signal())

    expect(adapter.placed).toHaveLength(1)
  })

  it('fails open: a balance-lookup error lets the open proceed', async () => {
    const adapter = new FakeAdapter([], true) // getBalances throws
    const { db, client } = build(adapter, row())

    await (client as any).handleSignalInner(signal())

    expect(adapter.placed).toHaveLength(1)
    expect(db.logs.some((l) => l.message === 'Breathing room check failed, proceeding')).toBe(true)
  })
})

describe('breathing-room refinements', () => {
  // Deribit is inverse: equity/margins are in the settlement coin (BTC) while the
  // order quantity is a USD notional. Correct coin order margin = qty / price /
  // leverage. The OLD qty×price path gave orderMargin ≈ 5e8 and falsely rejected.
  it('deribit inverse: sizes order margin in the settlement coin (allowed)', async () => {
    const adapter = new FakeAdapter(
      [bal({ accountId: 'btc', currency: 'BTC', equity: 1.0, initialMargin: 0.1, maintenanceMargin: 0.05 })],
      false,
      'deribit',
    )
    const { client } = build(adapter, row({ exchange: 'deribit', account: 'btc', buffer_mult: 1.5 }))
    // orderMargin = 10000/50000/1 = 0.2 BTC; available 0.9; floor 1.5×0.05=0.075; after 0.7 → ok
    await (client as any).handleSignalInner(
      signal({ symbol: 'BTC-PERPETUAL', quantity: 10_000, price: 50_000, metadata: { exchange: 'deribit' } }),
    )
    expect(adapter.placed).toHaveLength(1)
  })

  it('deribit inverse: rejects when the coin order margin breaches the floor', async () => {
    const adapter = new FakeAdapter(
      [bal({ accountId: 'btc', currency: 'BTC', equity: 0.3, initialMargin: 0.25, maintenanceMargin: 0.04 })],
      false,
      'deribit',
    )
    const { db, client } = build(adapter, row({ exchange: 'deribit', account: 'btc', buffer_mult: 1.5 }))
    // orderMargin = 5000/50000/1 = 0.1; available 0.05; after −0.05; floor 1.5×0.04=0.06 → reject
    await (client as any).handleSignalInner(
      signal({ symbol: 'BTC-PERPETUAL', quantity: 5_000, price: 50_000, metadata: { exchange: 'deribit' } }),
    )
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
  })

  it('uses server-supplied leverage from signal.metadata', async () => {
    // floor 0 (no maintenance) → rejects only when orderMargin > available.
    // MES notional = 1 × 50000 × mult 5 = 250000.
    // lev 1: 250000 > 10000 → reject. metadata.leverage 50: 5000 < 10000 → allow.
    const a1 = new FakeAdapter([bal({ equity: 10_000 })])
    const { client: c1 } = build(a1, row())
    await (c1 as any).handleSignalInner(signal({ quantity: 1, price: 50_000 }))
    expect(a1.placed).toHaveLength(0)

    const a2 = new FakeAdapter([bal({ equity: 10_000 })])
    const { client: c2 } = build(a2, row())
    await (c2 as any).handleSignalInner(
      signal({ quantity: 1, price: 50_000, metadata: { exchange: 'tradestation', signalBotId: 'bot-1', leverage: 50 } }),
    )
    expect(a2.placed).toHaveLength(1)
  })

  it('force bypass: signal.metadata.force skips the guard (server-driven)', async () => {
    const adapter = new FakeAdapter([bal({ equity: 20_000, initialMargin: 5_000, maintenanceMargin: 10_000 })])
    const { db, client } = build(adapter, row()) // these inputs reject without force
    await (client as any).handleSignalInner(signal({ metadata: { exchange: 'tradestation', signalBotId: 'bot-1', force: true } }))
    expect(adapter.placed).toHaveLength(1)
    expect(db.logs.some((l) => l.message === 'Breathing room bypassed (force)')).toBe(true)
  })

  it('selects the largest-equity wallet when the account id does not match (bybit)', async () => {
    // bybit wallets are tagged 'unified'/'contract' but sizingAccount is 'default'
    // → no exact match → pick the largest-equity wallet (unified). Using it, the
    // floor is breached → reject (proves the guard isn't silently skipped).
    const adapter = new FakeAdapter(
      [
        bal({ accountId: 'unified', equity: 20_000, initialMargin: 5_000, maintenanceMargin: 10_000 }),
        bal({ accountId: 'contract', equity: 1 }),
      ],
      false,
      'bybit',
    )
    const { db, client } = build(adapter, row({ exchange: 'bybit', buffer_mult: 1.5 }))
    await (client as any).handleSignalInner(
      signal({ symbol: 'BTCUSDT', quantity: 1, price: 5_000, metadata: { exchange: 'bybit' } }),
    )
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
  })

  it('deribit: never crosses to another coin wallet — skips when the symbol coin is absent', async () => {
    // Only a BTC wallet is present; an ETH-PERPETUAL order must NOT be checked
    // against the BTC pool (separate inverse collateral). The exact-coin lookup
    // misses → guard skips (fail-open) → order placed. Crossing to BTC (0.5 free
    // margin vs a ~1.67 BTC order) would have falsely rejected — the bug this fixes.
    const adapter = new FakeAdapter(
      [bal({ accountId: 'btc', currency: 'BTC', equity: 1.0, initialMargin: 0.5, maintenanceMargin: 0.5 })],
      false,
      'deribit',
    )
    const { client } = build(adapter, row({ exchange: 'deribit', account: 'eth', buffer_mult: 1.5 }))
    await (client as any).handleSignalInner(
      signal({ symbol: 'ETH-PERPETUAL', quantity: 5_000, price: 3_000, metadata: { exchange: 'deribit' } }),
    )
    expect(adapter.placed).toHaveLength(1)
  })
})

describe('breathing-room offset (opposing same-root open)', () => {
  // Tight account: 5000 free margin (10k equity − 5k initial), maintenance floor
  // 6000 at buffer 1. A buy 1 @ 5000 costs 5000 margin at lev 1 → after 0 < 6000,
  // so a NON-offsetting open is rejected. An opposing short offsets it → allowed.
  const tight = () => bal({ equity: 10_000, initialMargin: 5_000, maintenanceMargin: 6_000 })
  const cfgRow = () => row({ buffer_mult: 1 })
  // On the SAME routed account as the subscription (ACC1): positions on other
  // accounts never net/offset at the broker and are filtered out.
  const shortMes = (size = 1): Position => ({
    id: 'p1',
    accountId: 'ACC1',
    symbol: 'MESM26',
    side: 'short',
    size,
    entryPrice: 5_000,
    markPrice: 5_000,
    leverage: 1,
  })

  it('a pure offsetting open is allowed even under a tight floor (signal-2364)', async () => {
    // Broker short 1 MES; the buy fully offsets it, nets the broker down and
    // consumes no new margin → must pass despite the breached floor.
    const adapter = new FakeAdapter([tight()], false, 'tradestation', [shortMes()])
    const { db, client } = build(adapter, cfgRow())
    await (client as any).handleSignalInner(signal({ quantity: 1, price: 5_000 }))
    expect(adapter.placed).toHaveLength(1)
    expect(db.safetyClips.some((c) => c.reason === 'breathing_room')).toBe(false)
  })

  it('the same tight floor rejects a non-offsetting open (control)', async () => {
    // No opposing position → the buy is charged full margin → the floor bites.
    const adapter = new FakeAdapter([tight()], false, 'tradestation', [])
    const { db, client } = build(adapter, cfgRow())
    await (client as any).handleSignalInner(signal({ quantity: 1, price: 5_000 }))
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
  })

  it('a same-direction position is not treated as an offset (still rejected)', async () => {
    // An existing LONG must not credit a further long open — only opposing legs
    // offset. Same tight floor, an existing long 1 → the buy still pays full margin.
    const longMes: Position = { ...shortMes(), side: 'long' }
    const adapter = new FakeAdapter([tight()], false, 'tradestation', [longMes])
    const { db, client } = build(adapter, cfgRow())
    await (client as any).handleSignalInner(signal({ quantity: 1, price: 5_000 }))
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
  })

  it('only the excess past the offset is charged (partial flip)', async () => {
    // Short 1, buy 3 → 1 offsets, 2 net-new. Per-contract MES notional is
    // 5000 × mult 5 = 25000. Room for the 2 net-new (50000 ≤ 60000 free,
    // floor 0) but not all 3 (75000 > 60000) → allowed via offset.
    const adapter = new FakeAdapter(
      [bal({ equity: 60_000, initialMargin: 0, maintenanceMargin: 0 })],
      false,
      'tradestation',
      [shortMes()],
    )
    const { client } = build(adapter, cfgRow())
    await (client as any).handleSignalInner(signal({ quantity: 3, price: 5_000 }))
    expect(adapter.placed).toHaveLength(1)
  })

  // #39 regression: the offset credit (and the pure-offset floor skip it can
  // trigger) must never ride on the short positions cache. A snapshot showing
  // an opposing short that has since closed made a genuinely NEW open look like
  // a pure offset and bypassed the margin floor entirely. A cached opposing hit
  // must force a FRESH read before any credit is granted.
  it('does not grant offset credit from a stale cached positions snapshot', async () => {
    // Venue truth: flat. Stale cache (within TTL): an opposing short 1.
    const adapter = new FakeAdapter([tight()], false, 'tradestation', [])
    const { db, client } = build(adapter, cfgRow())
    ;(client as any).positionsCache.set('tradestation', {
      at: Date.now(),
      positions: [shortMes()],
    })

    await (client as any).handleSignalInner(signal({ quantity: 1, price: 5_000 }))

    // The fresh read shows no opposing position → full margin charged → the
    // tight floor rejects (old behavior: pure-offset skip → order placed).
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.safetyClips.some((c) => c.reason === 'breathing_room')).toBe(true)
  })

  it('#39 companion: a live opposing position confirmed by the fresh read still offsets', async () => {
    // Stale cache AND venue agree on the short → credit stands, open allowed.
    const adapter = new FakeAdapter([tight()], false, 'tradestation', [shortMes()])
    const { db, client } = build(adapter, cfgRow())
    ;(client as any).positionsCache.set('tradestation', {
      at: Date.now(),
      positions: [shortMes()],
    })

    await (client as any).handleSignalInner(signal({ quantity: 1, price: 5_000 }))

    expect(adapter.placed).toHaveLength(1)
    expect(db.safetyClips.some((c) => c.reason === 'breathing_room')).toBe(false)
  })

  it('#39: a failed fresh read grants no credit (fail-closed for the credit only)', async () => {
    // Cache shows an opposing short; the confirming re-read throws → no offset,
    // guard still runs on the snapshot → tight floor rejects.
    const adapter = new FakeAdapter([tight()], false, 'tradestation', [])
    const { db, client } = build(adapter, cfgRow())
    ;(client as any).positionsCache.set('tradestation', {
      at: Date.now(),
      positions: [shortMes()],
    })
    let calls = 0
    adapter.getPositions = async () => {
      calls++
      throw new Error('venue hiccup')
    }

    await (client as any).handleSignalInner(signal({ quantity: 1, price: 5_000 }))

    expect(calls).toBeGreaterThan(0)
    expect(adapter.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
  })
})
