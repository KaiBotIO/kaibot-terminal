import { describe, expect, it, beforeEach } from 'bun:test'
import { Reconciler, resolveReconcileExchanges } from './reconciler.js'
import type { ExchangeManager } from './exchanges/exchangeManager.js'
import type { Order, OrderStatus, Position } from './exchanges/types.js'

// Reconciler drift scenarios with a fake DB / manager / TradeStation-like
// adapter (non-24/7, with getOrderStatus + getMarketStatus + listWorkingOrders).
// Nothing hits a venue; the order lock is real (the tick wraps itself).

interface ExecRow {
  signal_id: string
  symbol: string
  exchange: string
  direction: 'long' | 'short'
  status: string
  qty_opened: number
  qty_closed: number
}

class FakeDb {
  logs: any[] = []
  reconciliations: any[] = []
  knownOrderIds = new Set<string>()
  manualSymbols = new Set<string>() // 'exchange|symbol'
  private execs: ExecRow[]

  constructor(execs: ExecRow[]) {
    this.execs = execs
  }

  hasManualPosition(exchange: string, symbol: string) {
    return this.manualSymbols.has(`${exchange}|${symbol}`)
  }
  clearManualPositionSymbol(exchange: string, symbol: string) {
    this.manualSymbols.delete(`${exchange}|${symbol}`)
  }

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  listExecutionSymbols(exchange: string) {
    return [...new Set(this.execs.filter((e) => e.exchange === exchange).map((e) => e.symbol))].map((symbol) => ({ symbol }))
  }
  listOpenExecutionsForExchange(exchange: string) {
    return this.execs.filter((e) => e.exchange === exchange && (e.status === 'open' || e.status === 'closing'))
  }
  listKnownOrderIds() {
    return this.knownOrderIds
  }
  insertReconciliation(row: any) {
    this.reconciliations.push(row)
  }
  byAction(action: string) {
    return this.reconciliations.filter((r) => r.action === action)
  }
}

class FakeAdapter {
  name = 'tradestation'
  alwaysOpen = false
  positions: Position[] = []
  placed: Order[] = []
  workingOrders: Array<{ orderId: string; symbol: string; accountId: string }> = []
  marketOpen = true
  placeStatus: OrderStatus['state'] = 'filled'

  async getPositions() {
    return this.positions
  }
  async placeOrder(o: Order) {
    this.placed.push(o)
    return { orderId: `corr-${this.placed.length}`, status: 'pending' as const }
  }
  async cancelOrder() {}
  async getOrderStatus(): Promise<OrderStatus> {
    return { orderId: 'x', state: this.placeStatus }
  }
  async getMarketStatus(symbols: string[]) {
    const m = new Map()
    const tradeTimeMs = this.marketOpen ? Date.now() : Date.now() - 60 * 60_000
    for (const s of symbols) m.set(s, { symbol: s, last: 5000, tradeTimeMs })
    return m
  }
  async listWorkingOrders() {
    return this.workingOrders
  }
}

class FakeManager {
  constructor(public adapter: FakeAdapter, public status: 'connected' | 'disconnected' = 'connected') {}
  async getSession() {
    return { adapter: this.adapter, status: this.status, userId: 'default', exchangeName: 'tradestation' }
  }
}

function pos(symbol: string, side: 'long' | 'short', size: number): Position {
  return { id: `p:${symbol}`, accountId: 'ACC1', symbol, side, size, entryPrice: 5000 }
}

function exec(symbol: string, direction: 'long' | 'short', qty: number, status = 'open'): ExecRow {
  return { signal_id: `s:${symbol}`, symbol, exchange: 'tradestation', direction, status, qty_opened: qty, qty_closed: 0 }
}

function build(execs: ExecRow[]) {
  const db = new FakeDb(execs)
  const adapter = new FakeAdapter()
  const manager = new FakeManager(adapter) as unknown as ExchangeManager
  const reconciler = new Reconciler({ db: db as any, exchangeManager: manager })
  return { db, adapter, reconciler }
}

describe('Reconciler drift scenarios', () => {
  beforeEach(() => {
    // Fresh per test; nothing global to reset.
  })

  it('no mismatch → no correction', async () => {
    const { adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 4)]
    const s = await reconciler.tick()
    expect(s.mismatches).toBe(0)
    expect(adapter.placed).toHaveLength(0)
  })

  it('small drift is corrected with a reduce-only market order', async () => {
    // Expected long 4, broker holds long 2 → delta +2 → BUY 2.
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 2)]
    const s = await reconciler.tick()

    expect(s.mismatches).toBe(1)
    expect(s.corrected).toBe(1)
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].side).toBe('buy')
    expect(adapter.placed[0].quantity).toBe(2)
    expect(adapter.placed[0].reduceOnly).toBe(true)
    const corr = db.byAction('corrected')
    expect(corr).toHaveLength(1)
    expect(corr[0]).toMatchObject({ symbol: 'MESM26', expectedNet: 4, brokerNet: 2, delta: 2, side: 'buy', qty: 2 })
  })

  it('corrects a short side when the broker is too long', async () => {
    // Expected short 3 (-3), broker holds long 1 (+1) → delta -4 → SELL 4.
    const { adapter, reconciler } = build([exec('MNQM26', 'short', 3)])
    adapter.positions = [pos('MNQM26', 'long', 1)]
    await reconciler.tick()
    expect(adapter.placed[0].side).toBe('sell')
    expect(adapter.placed[0].quantity).toBe(4)
  })

  it('a LARGE mismatch is flagged, never auto-corrected', async () => {
    // Default max delta is 10; expected 0, broker 50 → |delta| 50 → flag only.
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 0)])
    // qty_opened 0 → expected net 0. Broker holds a runaway 50.
    adapter.positions = [pos('MESM26', 'long', 50)]
    const s = await reconciler.tick()

    expect(s.flaggedLarge).toBe(1)
    expect(s.corrected).toBe(0)
    expect(adapter.placed).toHaveLength(0)
    expect(db.byAction('skipped_large')).toHaveLength(1)
  })

  it('does NOT correct while a working order is on the symbol', async () => {
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 2)]
    // A known working order on the symbol → block correction.
    adapter.workingOrders = [{ orderId: 'w1', symbol: 'MESM26', accountId: 'ACC1' }]
    ;(db.knownOrderIds as Set<string>).add('w1')
    const s = await reconciler.tick()

    expect(s.skippedWorking).toBe(1)
    expect(s.corrected).toBe(0)
    expect(adapter.placed).toHaveLength(0)
    expect(db.byAction('skipped_working')).toHaveLength(1)
  })

  it('flags a foreign working order it did not place and holds off', async () => {
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 2)]
    // A working order on a symbol we trade that we never placed (not in known).
    adapter.workingOrders = [{ orderId: 'foreign-1', symbol: 'MESM26', accountId: 'ACC1' }]
    const s = await reconciler.tick()

    expect(s.foreignOrders).toBe(1)
    expect(s.corrected).toBe(0)
    expect(db.byAction('alert_foreign_order')).toHaveLength(1)
    // Still blocked from correcting (a working order is present).
    expect(adapter.placed).toHaveLength(0)
  })

  it('skips correction while the market is closed', async () => {
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 2)]
    adapter.marketOpen = false
    const s = await reconciler.tick()

    expect(s.skippedClosed).toBe(1)
    expect(s.corrected).toBe(0)
    expect(adapter.placed).toHaveLength(0)
    expect(db.byAction('skipped_closed')).toHaveLength(1)
  })

  it('respects the per-pair cooldown on a second tick', async () => {
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 2)]

    await reconciler.tick() // corrects once
    expect(adapter.placed).toHaveLength(1)
    // Broker still drifted (correction not reflected in this fake) → second tick
    // hits the cooldown instead of stacking another order.
    const s2 = await reconciler.tick()
    expect(s2.skippedCooldown).toBe(1)
    expect(adapter.placed).toHaveLength(1) // unchanged
    expect(db.byAction('skipped_cooldown').length).toBeGreaterThanOrEqual(1)
  })

  it('only touches symbols we have executed (ignores untracked broker positions)', async () => {
    const { adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [
      pos('MESM26', 'long', 4), // matched, no drift
      pos('GCZ25', 'long', 10), // a manual position we never traded
    ]
    const s = await reconciler.tick()
    // Only the one tracked symbol is considered; the manual one is untouched.
    expect(s.pairs).toBe(1)
    expect(adapter.placed).toHaveLength(0)
  })

  it('does nothing when the exchange session is not connected', async () => {
    const db = new FakeDb([exec('MESM26', 'long', 4)])
    const adapter = new FakeAdapter()
    adapter.positions = [pos('MESM26', 'long', 2)]
    const manager = new FakeManager(adapter, 'disconnected') as unknown as ExchangeManager
    const reconciler = new Reconciler({ db: db as any, exchangeManager: manager })
    const s = await reconciler.tick()
    expect(s.pairs).toBe(0)
    expect(adapter.placed).toHaveLength(0)
  })

  it('runs resolveUnknownOrders + retryPendingCloses before reconciling', async () => {
    const calls: string[] = []
    const db = new FakeDb([exec('MESM26', 'long', 4)])
    const adapter = new FakeAdapter()
    adapter.positions = [pos('MESM26', 'long', 4)]
    const manager = new FakeManager(adapter) as unknown as ExchangeManager
    const reconciler = new Reconciler({
      db: db as any,
      exchangeManager: manager,
      resolveUnknownOrders: async () => { calls.push('resolve') },
      retryPendingCloses: async () => { calls.push('retry') },
    })
    await reconciler.tick()
    expect(calls).toEqual(['resolve', 'retry'])
  })

  it('never corrects a symbol that has an open manual position (flags skipped_manual)', async () => {
    // Expected long 4, broker long 6 → delta -2. Normally a reduce-only SELL 2.
    // But a manual position is open on the symbol → skip, never undo it.
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 6)]
    db.manualSymbols.add('tradestation|MESM26')
    const s = await reconciler.tick()
    expect(s.mismatches).toBe(1)
    expect(s.skippedManual).toBe(1)
    expect(s.corrected).toBe(0)
    expect(adapter.placed).toHaveLength(0)
    expect(db.byAction('skipped_manual')).toHaveLength(1)
  })

  it('clears a stale manual marker once the broker net matches expected (auto-heal)', async () => {
    // Manual marker still set, but the manual overhang is gone (broker == expected
    // → delta 0). The reconciler clears the marker so reconciliation can resume.
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 4)]
    db.manualSymbols.add('tradestation|MESM26')
    await reconciler.tick()
    expect(db.hasManualPosition('tradestation', 'MESM26')).toBe(false)
    expect(adapter.placed).toHaveLength(0)
  })
})

describe('resolveReconcileExchanges allowlist', () => {
  it('keeps known net-per-symbol broker venues', () => {
    const logs: string[] = []
    expect(resolveReconcileExchanges('tradestation,interactivebrokers', (m) => logs.push(m)))
      .toEqual(['tradestation', 'interactivebrokers'])
    expect(logs).toHaveLength(0)
  })

  it('drops a crypto venue and logs an error (executor-never-decides)', () => {
    const logs: string[] = []
    const result = resolveReconcileExchanges('tradestation,bybit', (m) => logs.push(m))
    expect(result).toEqual(['tradestation'])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('bybit')
    expect(logs[0]).toContain('executor-never-decides')
  })

  it('defaults to tradestation when unset', () => {
    expect(resolveReconcileExchanges(undefined, () => {})).toEqual(['tradestation'])
  })

  it('normalizes casing/whitespace before allowlist check', () => {
    expect(resolveReconcileExchanges(' TradeStation , BYBIT ', () => {})).toEqual(['tradestation'])
  })
})

// EX2 regression: crypto venues (outside the correction allowlist) now get a
// detect-and-alert pass — a drift between our books and the live broker is
// logged + alerted, but NEVER auto-corrected (executor-never-decides).
describe('crypto detect-and-alert mode', () => {
  class CryptoDb extends FakeDb {
    listExecutionExchanges() {
      return [{ exchange: 'bybit' }]
    }
    listUnresolvedSettlements() {
      return []
    }
    listClosingExecutions() {
      return []
    }
    listDcaRestingRungs() {
      return []
    }
  }

  function cryptoExec(symbol: string, direction: 'long' | 'short', qty: number): ExecRow {
    return { signal_id: `s:${symbol}`, symbol, exchange: 'bybit', direction, status: 'open', qty_opened: qty, qty_closed: 0 }
  }

  class CryptoAdapter extends FakeAdapter {
    name = 'bybit'
    alwaysOpen = true
  }

  function buildCrypto(execs: ExecRow[]) {
    const db = new CryptoDb(execs)
    const adapter = new CryptoAdapter()
    const manager = new FakeManager(adapter) as unknown as ExchangeManager
    const alerts: string[] = []
    const notifications = { publish: (e: any) => alerts.push(e.body) }
    const reconciler = new Reconciler({ db: db as any, exchangeManager: manager, notifications: notifications as any })
    return { db, adapter, reconciler, alerts }
  }

  it('alerts on an unexpected broker position but places NO order', async () => {
    const { db, adapter, reconciler, alerts } = buildCrypto([cryptoExec('BTCUSDT', 'long', 0)])
    // Books expect flat; the broker holds a live long.
    adapter.positions = [pos('BTCUSDT', 'long', 2)]
    const s = await reconciler.tick()

    expect(s.observedMismatches).toBe(1)
    expect(s.corrected).toBe(0)
    expect(adapter.placed).toHaveLength(0) // never corrects a crypto venue
    expect(db.byAction('alert_observed_mismatch')).toHaveLength(1)
    expect(alerts.some((b) => b.includes('BTCUSDT'))).toBe(true)
  })

  it('alerts when a position we expect is gone at the broker', async () => {
    const { db, adapter, reconciler } = buildCrypto([cryptoExec('BTCUSDT', 'long', 3)])
    adapter.positions = [] // broker flat, books say long 3
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(1)
    expect(adapter.placed).toHaveLength(0)
    expect(db.byAction('alert_observed_mismatch')[0]).toMatchObject({ expectedNet: 3, brokerNet: 0 })
  })

  it('stays quiet when books and broker agree', async () => {
    const { adapter, reconciler, alerts } = buildCrypto([cryptoExec('BTCUSDT', 'long', 3)])
    adapter.positions = [pos('BTCUSDT', 'long', 3)]
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(0)
    expect(alerts).toHaveLength(0)
  })

  it('a manual position on the symbol suppresses the alert', async () => {
    const { db, adapter, reconciler, alerts } = buildCrypto([cryptoExec('BTCUSDT', 'long', 0)])
    adapter.positions = [pos('BTCUSDT', 'long', 2)]
    db.manualSymbols.add('bybit|BTCUSDT')
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(0)
    expect(alerts).toHaveLength(0)
  })
})
