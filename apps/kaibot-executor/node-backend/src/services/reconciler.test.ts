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
  account_id: string | null
}

class FakeDb {
  logs: any[] = []
  reconciliations: any[] = []
  knownOrderIds = new Set<string>()
  // 'exchange|account|symbol' -> signed net
  manual = new Map<string, number>()
  execs: ExecRow[]

  constructor(execs: ExecRow[]) {
    this.execs = execs
  }

  getManualPosition(exchange: string, accountId: string, symbol: string) {
    const net = this.manual.get(`${exchange}|${accountId}|${symbol}`)
    return net == null ? undefined : { exchange, account_id: accountId, symbol, net, opened_at: 0, updated_at: 0 }
  }
  addManualPosition(exchange: string, accountId: string, symbol: string, side: 'buy' | 'sell', qty: number) {
    const key = `${exchange}|${accountId}|${symbol}`
    const net = (this.manual.get(key) ?? 0) + (side === 'buy' ? qty : -qty)
    if (net === 0) this.manual.delete(key)
    else this.manual.set(key, net)
  }
  clearManualPosition(exchange: string, accountId: string, symbol: string) {
    this.manual.delete(`${exchange}|${accountId}|${symbol}`)
  }
  hasManualPosition(exchange: string, symbol: string) {
    return [...this.manual.keys()].some((k) => k.startsWith(`${exchange}|`) && k.endsWith(`|${symbol}`))
  }
  clearManualPositionSymbol(exchange: string, symbol: string) {
    for (const k of [...this.manual.keys()]) {
      if (k.startsWith(`${exchange}|`) && k.endsWith(`|${symbol}`)) this.manual.delete(k)
    }
  }

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  listExecutionSymbols(exchange: string) {
    return [...new Set(this.execs.filter((e) => e.exchange === exchange).map((e) => e.symbol))].map((symbol) => ({ symbol }))
  }
  listExecutionAccountSymbols(exchange: string) {
    const seen = new Map<string, { account_id: string | null; symbol: string }>()
    for (const e of this.execs.filter((e) => e.exchange === exchange)) {
      seen.set(`${e.account_id}|${e.symbol}`, { account_id: e.account_id, symbol: e.symbol })
    }
    return [...seen.values()]
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

function pos(symbol: string, side: 'long' | 'short', size: number, accountId = 'ACC1'): Position {
  return { id: `p:${accountId}:${symbol}`, accountId, symbol, side, size, entryPrice: 5000 }
}

function exec(
  symbol: string,
  direction: 'long' | 'short',
  qty: number,
  status = 'open',
  accountId: string | null = 'ACC1',
): ExecRow {
  return {
    signal_id: `s:${accountId}:${symbol}`,
    symbol,
    exchange: 'tradestation',
    direction,
    status,
    qty_opened: qty,
    qty_closed: 0,
    account_id: accountId,
  }
}

function build(execs: ExecRow[]) {
  const db = new FakeDb(execs)
  const adapter = new FakeAdapter()
  const manager = new FakeManager(adapter) as unknown as ExchangeManager
  const adoptions: any[] = []
  const reconciler = new Reconciler({
    db: db as any,
    exchangeManager: manager,
    adoptVenueClose: async (input) => {
      adoptions.push(input)
    },
  })
  return { db, adapter, reconciler, adoptions }
}

// First tick after boot adopts pre-existing overhang instead of correcting it.
// Tests that exercise IN-SESSION drift start from a balanced baseline tick,
// then mutate the broker book.
async function baselineTick(reconciler: Reconciler, adapter: FakeAdapter, balanced: Position[]) {
  const before = adapter.positions
  adapter.positions = balanced
  await reconciler.tick()
  adapter.positions = before
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

  it('broker overhang shrinks with a reduce-only market order', async () => {
    // Expected long 2, broker holds long 4 in-session → delta -2 → SELL 2
    // (shrinks exposure toward the books; the only correction still allowed).
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 2)])
    await baselineTick(reconciler, adapter, [pos('MESM26', 'long', 2)])
    adapter.positions = [pos('MESM26', 'long', 4)]
    const s = await reconciler.tick()

    expect(s.mismatches).toBe(1)
    expect(s.corrected).toBe(1)
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].side).toBe('sell')
    expect(adapter.placed[0].quantity).toBe(2)
    expect(adapter.placed[0].reduceOnly).toBe(true)
    expect(adapter.placed[0].accountId).toBe('ACC1')
    const corr = db.byAction('corrected')
    expect(corr).toHaveLength(1)
    expect(corr[0]).toMatchObject({ symbol: 'MESM26', accountId: 'ACC1', expectedNet: 2, brokerNet: 4, delta: -2, side: 'sell', qty: 2 })
  })

  it('REGRESSION 2026-09-01: exposure the broker lost is adopted as a close, never re-bought', async () => {
    // Expected long 4, broker holds long 2 → the old behavior BOUGHT 2 back
    // (the MGCZ26 rebuy loop, after a filled GTC stop went unbooked). Now: no
    // order, the missing 2 are booked as an adopted close.
    const { db, adapter, reconciler, adoptions } = build([exec('MESM26', 'long', 4)])
    await baselineTick(reconciler, adapter, [pos('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 2)]
    const s = await reconciler.tick()

    expect(s.mismatches).toBe(1)
    expect(s.corrected).toBe(0)
    expect(s.adoptedCloses).toBe(1)
    expect(adapter.placed).toHaveLength(0)
    expect(adoptions).toEqual([
      { exchange: 'tradestation', accountId: 'ACC1', symbol: 'MESM26', side: 'sell', qty: 2 },
    ])
    const adopted = db.byAction('adopted_close')
    expect(adopted).toHaveLength(1)
    expect(adopted[0]).toMatchObject({ expectedNet: 4, brokerNet: 2, delta: 2, side: 'sell', qty: 2, status: 'booked' })
  })

  it('a broker side-flip adopts only OUR vanished book, then reduces the foreign rest', async () => {
    // Expected short 3 (-3), broker holds long 1 (+1). The old behavior sold 4
    // (re-opening the short). Now: adopt our 3 shorts as closed (buy side);
    // the foreign +1 is a reduce-only sell on a later tick.
    const { adapter, reconciler, adoptions } = build([exec('MNQM26', 'short', 3)])
    await baselineTick(reconciler, adapter, [pos('MNQM26', 'short', 3)])
    adapter.positions = [pos('MNQM26', 'long', 1)]
    const s = await reconciler.tick()
    expect(adapter.placed).toHaveLength(0)
    expect(s.adoptedCloses).toBe(1)
    expect(adoptions).toEqual([
      { exchange: 'tradestation', accountId: 'ACC1', symbol: 'MNQM26', side: 'buy', qty: 3 },
    ])
  })

  it('a LARGE mismatch is flagged, never auto-corrected', async () => {
    // Default max delta is 10; expected 0, broker 50 → |delta| 50 → flag only.
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 0)])
    await baselineTick(reconciler, adapter, [])
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
    await baselineTick(reconciler, adapter, [pos('MESM26', 'long', 4)])
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
    await baselineTick(reconciler, adapter, [pos('MESM26', 'long', 4)])
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

  it('skips a reduce-correction while the market is closed', async () => {
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 2)])
    await baselineTick(reconciler, adapter, [pos('MESM26', 'long', 2)])
    adapter.positions = [pos('MESM26', 'long', 4)]
    adapter.marketOpen = false
    const s = await reconciler.tick()

    expect(s.skippedClosed).toBe(1)
    expect(s.corrected).toBe(0)
    expect(adapter.placed).toHaveLength(0)
    expect(db.byAction('skipped_closed')).toHaveLength(1)
  })

  it('adopts a vanished position even while the market is closed (bookkeeping, no order)', async () => {
    const { adapter, reconciler, adoptions } = build([exec('MESM26', 'long', 4)])
    await baselineTick(reconciler, adapter, [pos('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 2)]
    adapter.marketOpen = false
    const s = await reconciler.tick()

    expect(s.adoptedCloses).toBe(1)
    expect(adapter.placed).toHaveLength(0)
    expect(adoptions).toHaveLength(1)
  })

  it('respects the per-pair cooldown on a second tick', async () => {
    const { db, adapter, reconciler, adoptions } = build([exec('MESM26', 'long', 4)])
    await baselineTick(reconciler, adapter, [pos('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 2)]

    const s1 = await reconciler.tick() // adopts once
    expect(s1.adoptedCloses).toBe(1)
    // Books still drifted (the hook is a stub) → second tick hits the cooldown
    // instead of stacking another adoption.
    const s2 = await reconciler.tick()
    expect(s2.skippedCooldown).toBe(1)
    expect(adoptions).toHaveLength(1) // unchanged
    expect(db.byAction('skipped_cooldown').length).toBeGreaterThanOrEqual(1)
  })

  it('only touches pairs we have executed (ignores untracked broker positions)', async () => {
    const { adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [
      pos('MESM26', 'long', 4), // matched, no drift
      pos('GCZ25', 'long', 10), // a manual position we never traded
    ]
    const s = await reconciler.tick()
    // Only the one tracked pair is considered; the manual one is untouched
    // (and adopted as a manual marker, never corrected).
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

  it('never corrects a pair that has an open manual position (flags skipped_manual)', async () => {
    // Expected long 4, broker long 6 → delta -2. Normally a reduce-only SELL 2.
    // But a manual position is open on the pair → skip, never undo it.
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 6)]
    db.manual.set('tradestation|ACC1|MESM26', 2)
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
    db.manual.set('tradestation|ACC1|MESM26', 2)
    await reconciler.tick()
    expect(db.hasManualPosition('tradestation', 'MESM26')).toBe(false)
    expect(adapter.placed).toHaveLength(0)
  })
})

// TS live blockers 2026-08: the reconciler used to net per SYMBOL across all
// broker accounts and send corrections to whichever account happened to appear
// last in getPositions. These scenarios pin the per-(account, symbol) keying
// and the first-connect adoption of pre-existing broker positions.
describe('per-account reconciliation + adoption', () => {
  it('REGRESSION: a foreign position on account B never draws a correction from a bot on account A', async () => {
    // Bot: long 1 MES on ACC-A, balanced. Kai's own short 2 MES sits on ACC-B.
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 1, 'open', 'ACC-A')])
    adapter.positions = [
      pos('MESM26', 'long', 1, 'ACC-A'),
      pos('MESM26', 'short', 2, 'ACC-B'),
    ]
    const s = await reconciler.tick()

    // No order anywhere — B's position is adopted, not "corrected".
    expect(adapter.placed).toHaveLength(0)
    expect(s.corrected).toBe(0)
    expect(s.adopted).toBe(1)
    expect(db.getManualPosition('tradestation', 'ACC-B', 'MESM26')?.net).toBe(-2)

    // The bot later opens 1 MES on ACC-B too: expected(B) +1 vs broker(B) -1
    // (short 2 + long 1) → delta +2, well within max-delta. The adopted marker
    // must still block the correction.
    db.execs.push(exec('MESM26', 'long', 1, 'open', 'ACC-B'))
    adapter.positions = [
      pos('MESM26', 'long', 1, 'ACC-A'),
      pos('MESM26', 'short', 1, 'ACC-B'),
    ]
    const s2 = await reconciler.tick()
    expect(adapter.placed).toHaveLength(0)
    expect(s2.corrected).toBe(0)
    expect(s2.skippedManual).toBe(1)
  })

  it('adopts a boot-time overhang on a pair we trade instead of correcting it', async () => {
    // Books say long 4 on ACC1, the broker holds 6 at first connect: the extra
    // 2 predate this session → adopt, never sell them off.
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 4)])
    adapter.positions = [pos('MESM26', 'long', 6)]
    const s = await reconciler.tick()

    expect(adapter.placed).toHaveLength(0)
    expect(s.corrected).toBe(0)
    expect(s.adopted).toBe(1)
    expect(db.getManualPosition('tradestation', 'ACC1', 'MESM26')?.net).toBe(2)
    expect(db.byAction('adopted_existing')).toHaveLength(1)
  })

  it('never corrects symbols whose executions predate account tracking (unattributed)', async () => {
    // Pre-migration row: account_id NULL. Broker drifted — still hands off.
    const { db, adapter, reconciler } = build([exec('MESM26', 'long', 4, 'open', null)])
    adapter.positions = [pos('MESM26', 'long', 2)]
    const s = await reconciler.tick()

    expect(adapter.placed).toHaveLength(0)
    expect(s.corrected).toBe(0)
    expect(s.skippedUnattributed).toBe(1)
    expect(db.byAction('skipped_unattributed')).toHaveLength(1)
    // Unattributed symbols are excluded from adoption too.
    expect(s.adopted).toBe(0)
  })

  it('corrections go to the pair own account, independent of getPositions order', async () => {
    // Overhang on ACC2 while ACC1 also holds the same symbol; the reduce-only
    // correction must carry ACC2, not the account that happened to appear last.
    const { adapter, reconciler } = build([
      exec('MESM26', 'long', 1, 'open', 'ACC1'),
      exec('MESM26', 'long', 3, 'open', 'ACC2'),
    ])
    await baselineTick(reconciler, adapter, [
      pos('MESM26', 'long', 1, 'ACC1'),
      pos('MESM26', 'long', 3, 'ACC2'),
    ])
    adapter.positions = [
      { ...pos('MESM26', 'long', 3, 'ACC2'), size: 5 }, // in-session overhang of 2
      pos('MESM26', 'long', 1, 'ACC1'),
    ]
    const s = await reconciler.tick()

    expect(s.corrected).toBe(1)
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].accountId).toBe('ACC2')
    expect(adapter.placed[0].side).toBe('sell')
    expect(adapter.placed[0].quantity).toBe(2)
  })

  it('adoption of a vanished book goes to the pair own account too', async () => {
    const { adapter, reconciler, adoptions } = build([
      exec('MESM26', 'long', 1, 'open', 'ACC1'),
      exec('MESM26', 'long', 3, 'open', 'ACC2'),
    ])
    await baselineTick(reconciler, adapter, [
      pos('MESM26', 'long', 1, 'ACC1'),
      pos('MESM26', 'long', 3, 'ACC2'),
    ])
    adapter.positions = [
      pos('MESM26', 'long', 1, 'ACC2'), // 2 of ACC2's 3 vanished at the broker
      pos('MESM26', 'long', 1, 'ACC1'),
    ]
    const s = await reconciler.tick()

    expect(adapter.placed).toHaveLength(0)
    expect(s.adoptedCloses).toBe(1)
    expect(adoptions).toEqual([
      { exchange: 'tradestation', accountId: 'ACC2', symbol: 'MESM26', side: 'sell', qty: 2 },
    ])
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
    return { signal_id: `s:${symbol}`, symbol, exchange: 'bybit', direction, status: 'open', qty_opened: qty, qty_closed: 0, account_id: 'unified' }
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
    db.manual.set('bybit|unified|BTCUSDT', 2)
    const s = await reconciler.tick()
    expect(s.observedMismatches).toBe(0)
    expect(alerts).toHaveLength(0)
  })
})

// Regression (2026-08-26 phantom rebuy): the strategy's close filled at
// 06:31:55, but its bookkeeping had not landed when the reconciler's 06:31:59
// pass read "expected 1, broker 0" — it BOUGHT the just-closed position back.
// A fresh exit settlement on a pair must hold corrections for the grace window.
describe('exit-grace guard', () => {
  it('holds a correction while a fresh exit settlement sits on the pair', async () => {
    const { db, adapter, reconciler } = build([exec('MNQU26', 'long', 1)])
    ;(db as any).listRecentExitSettlements = () => [{ account_id: 'ACC1', symbol: 'MNQU26' }]
    await baselineTick(reconciler, adapter, [pos('MNQU26', 'long', 1)])
    adapter.positions = [] // close filled at the broker; books not yet updated
    const s = await reconciler.tick()
    expect(s.corrected).toBe(0)
    expect(s.skippedRecentExit).toBe(1)
    expect(adapter.placed).toHaveLength(0)
    expect(db.byAction('skipped_recent_exit')).toHaveLength(1)
  })

  it('adopts the close once no fresh exit settlement remains (never re-buys)', async () => {
    // The 2026-09-01 loop: after the grace window the old code re-bought the
    // stopped-out position. Now the disappearance is adopted as a close.
    const { db, adapter, reconciler, adoptions } = build([exec('MNQU26', 'long', 1)])
    ;(db as any).listRecentExitSettlements = () => []
    await baselineTick(reconciler, adapter, [pos('MNQU26', 'long', 1)])
    adapter.positions = []
    const s = await reconciler.tick()
    expect(s.corrected).toBe(0)
    expect(s.adoptedCloses).toBe(1)
    expect(s.skippedRecentExit).toBe(0)
    expect(adapter.placed).toHaveLength(0)
    expect(adoptions).toEqual([
      { exchange: 'tradestation', accountId: 'ACC1', symbol: 'MNQU26', side: 'sell', qty: 1 },
    ])
  })

  it('REGRESSION 2026-09-01 (a): a stop fill booked by the pre-step leaves nothing to correct or adopt', async () => {
    // Full incident chain, fixed: the sweep pre-step books the filled GTC stop
    // (execution closed + fresh exit settlement) BEFORE the netting comparison,
    // so "expected 1, broker 0" never materializes — no order, no adoption.
    const db = new FakeDb([exec('MNQU26', 'long', 1)])
    const adapter = new FakeAdapter()
    const manager = new FakeManager(adapter) as unknown as ExchangeManager
    const adoptions: any[] = []
    let recentExit: Array<{ account_id: string; symbol: string }> = []
    ;(db as any).listRecentExitSettlements = () => recentExit
    const reconciler = new Reconciler({
      db: db as any,
      exchangeManager: manager,
      adoptVenueClose: async (input) => {
        adoptions.push(input)
      },
      sweepRestingExits: async () => {
        // The sweep notices the broker filled our resting stop: it books the
        // exit (execution closed) and persists the exit settlement.
        const row = db.execs.find((e) => e.symbol === 'MNQU26')!
        if (row.status === 'open' && adapter.positions.length === 0) {
          row.status = 'closed'
          row.qty_closed = row.qty_opened
          recentExit = [{ account_id: 'ACC1', symbol: 'MNQU26' }]
        }
      },
    })
    await baselineTick(reconciler, adapter, [pos('MNQU26', 'long', 1)])
    adapter.positions = [] // the GTC stop filled at the broker
    const s = await reconciler.tick()

    expect(adapter.placed).toHaveLength(0)
    expect(s.mismatches).toBe(0)
    expect(s.adoptedCloses).toBe(0)
    expect(adoptions).toHaveLength(0)
    expect(db.byAction('corrected')).toHaveLength(0)
    expect(db.byAction('adopted_close')).toHaveLength(0)
  })
})

// Kai, 2026-09-05: a clean pass writes no row, so the page could only ever show
// the last incident. Without a heartbeat "healthy and quiet" and "not running"
// look identical.
describe('clean-pass heartbeat', () => {
  it('starts empty and fills in after a pass that found nothing', async () => {
    const db = new FakeDb([exec('MESM26', 'long', 4)])
    const adapter = new FakeAdapter()
    adapter.positions = [pos('MESM26', 'long', 4)]
    const manager = new FakeManager(adapter) as unknown as ExchangeManager
    const reconciler = new Reconciler({ db: db as any, exchangeManager: manager })

    expect(reconciler.status().lastTickAt).toBeNull()
    expect(reconciler.status().lastCleanPassAt).toBeNull()

    const s = await reconciler.tick()
    expect(s.mismatches).toBe(0)
    const after = reconciler.status()
    expect(after.lastTickAt).not.toBeNull()
    expect(after.lastCleanPassAt).toBe(after.lastTickAt)
    expect(after.intervalMs).toBeGreaterThan(0)
  })

  it('advances the tick but not the clean pass when a pass finds drift', async () => {
    const db = new FakeDb([exec('MESM26', 'long', 4)])
    const adapter = new FakeAdapter()
    adapter.positions = [pos('MESM26', 'long', 2)]
    const manager = new FakeManager(adapter) as unknown as ExchangeManager
    const reconciler = new Reconciler({ db: db as any, exchangeManager: manager })

    const s = await reconciler.tick()
    expect(s.mismatches).toBeGreaterThan(0)
    const after = reconciler.status()
    expect(after.lastTickAt).not.toBeNull()
    expect(after.lastCleanPassAt).toBeNull()
  })
})
