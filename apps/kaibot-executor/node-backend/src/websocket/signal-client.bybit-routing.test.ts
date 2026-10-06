import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

// A server signal for exchange 'bybit' (lab universe: 'SOLUSDT') and a
// composite signal ('index' / 'SOL' with a venueSymbols map) must both land
// on the Bybit connection with the venue symbol, the wallet id the adapter
// reports ('unified') and a qty rounded to the instrument's qtyStep.

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  safetyClips: any[] = []
  executions = new Map<string, any>()
  settlements: any[] = []
  bracketPairs: any[] = []
  sub: any
  constructor(sub: any) {
    this.sub = sub
  }
  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {}
  recordSignalQueue() {}
  getSubscriptionForBot() { return this.sub }
  getSubscription() { return this.sub }
  getBotConfigs() { return [] }
  getMarginGuard() { return null }
  getAccountSize(): number | null { return null }
  updateSignalStatus(id: string, status: string, _t?: number, error?: string) {
    this.signalStatuses.push({ id, status, error })
  }
  updateSignalOrderIds() {}
  logSafetyClip(entry: any) { this.safetyClips.push(entry) }
  getOpenEntrySignals() { return [] }
  markEntrySignalClosed() {}
  getSignalExecution(id: string) { return this.executions.get(id) }
  insertSignalExecution(row: any) {
    if (this.executions.has(row.signalId)) return false
    this.executions.set(row.signalId, {
      signal_id: row.signalId, symbol: row.symbol, exchange: row.exchange, direction: row.direction,
      status: row.status, account_id: row.accountId ?? null, qty_opened: row.qtyOpened ?? 0, qty_closed: row.qtyClosed ?? 0,
    })
    return true
  }
  updateSignalExecution(id: string, patch: any) {
    const row = this.executions.get(id)
    if (!row) return
    if (patch.status !== undefined) row.status = patch.status
    if (patch.qtyOpened !== undefined) row.qty_opened = patch.qtyOpened
  }
  insertSignalFill() {}
  insertOrderSettlement(row: any): number {
    this.settlements.push(row)
    return this.settlements.length
  }
  getExitSettlement() { return undefined }
  targetAlreadyProcessed() { return false }
  hasUnresolvedSettlement() { return false }
  resolveOrderSettlement() {}
  upsertBracketPair(row: any) { this.bracketPairs.push(row) }
  listBracketPairs() { return this.bracketPairs }
  deleteBracketPair() {}
  listActiveServerExitStates() { return [] }
  deactivateServerExitState() {}
  getDcaRestingRungsForSignal() { return [] }
  deleteDcaRestingRung() {}
  listActiveLocalTrails() { return [] }
  deactivateLocalTrail() {}
  getLocalTrail() { return undefined }
  getPositionGroupLink() { return undefined }
  lastStatus() { return this.signalStatuses[this.signalStatuses.length - 1] }
}

class FakeAdapter {
  name: string
  positions: Position[] = []
  placed: Order[] = []
  constructor(name: string) {
    this.name = name
  }
  async getPositions() { return this.positions }
  async getBalances() {
    return [{ accountId: this.name === 'bybit' ? 'unified' : 'btc', balance: 1000, equity: 1000, realizedPnL: 0, unrealizedPnL: 0, currency: 'USDT', timestamp: Date.now() }]
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: `${this.name}-ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity, averagePrice: o.price ?? 150 }
  }
  async cancelOrder() {}
}

class Manager {
  bybit = new FakeAdapter('bybit')
  deribit = new FakeAdapter('deribit')
  async getSession(_userId: string, exchangeName: string, accountKey?: string) {
    if (accountKey) return undefined
    const adapter = exchangeName === 'bybit' ? this.bybit : exchangeName === 'deribit' ? this.deribit : undefined
    if (!adapter) return undefined
    return { adapter, status: 'connected', userId: 'default', exchangeName, label: 'default', connectionId: `default:${exchangeName}` }
  }
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol: 'SOLUSDT',
    action: 'buy',
    quantity: 10.37,
    price: 150,
    metadata: { exchange: 'bybit', signalBotId: 'bot-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as unknown as Signal
}

function build(sub: any) {
  const manager = new Manager()
  const db = new FakeDb(sub)
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  client.setSettleOptions(2, 1)
  return { manager, db, client }
}

// instruments-info for the dynamic constraints lookup (SOLUSDT is not in
// the static map). No network: the public endpoint is answered here.
const realFetch = globalThis.fetch
const instrumentFetches: string[] = []
beforeEach(() => {
  instrumentFetches.length = 0
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    instrumentFetches.push(u)
    if (u.includes('/v5/market/instruments-info') && u.includes('SOLUSDT')) {
      return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [{ symbol: 'SOLUSDT', lotSizeFilter: { qtyStep: '0.1', minOrderQty: '0.1' }, priceFilter: { tickSize: '0.01' } }] } }))
    }
    return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [] } }))
  }) as any
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('server signals for bybit land on the Bybit connection', () => {
  it("exchange 'bybit' + 'SOLUSDT': venue symbol, wallet 'unified', qty floored to qtyStep 0.1", async () => {
    const { manager, db, client } = build({ id: 'sub-1', factor: 1, exchange: 'bybit' })
    await (client as any).handleSignalInner(signal())
    expect(manager.deribit.placed).toHaveLength(0)
    expect(manager.bybit.placed).toHaveLength(1)
    const order = manager.bybit.placed[0]
    expect(order.symbol).toBe('SOLUSDT')
    expect(order.accountId).toBe('unified')
    expect(order.side).toBe('buy')
    expect(order.quantity).toBe(10.3)
    expect(db.safetyClips.some((c) => c.reason === 'step_size_round' && c.adjustedQuantity === 10.3)).toBe(true)
    // The lineage row carries the same wallet id the adapter reports.
    expect(db.executions.get('sig-1').account_id).toBe('unified')
    expect(db.executions.get('sig-1').exchange).toBe('bybit')
    expect(db.lastStatus().status).toBe('executed')
    expect(instrumentFetches.some((u) => u.includes('category=linear') && u.includes('symbol=SOLUSDT'))).toBe(true)
  })

  it("composite 'index' / 'SOL' with a venueSymbols map: sub on bybit → SOLUSDT on the Bybit connection", async () => {
    const { manager, db, client } = build({ id: 'sub-1', factor: 1, exchange: 'bybit' })
    await (client as any).handleSignalInner(
      signal({
        id: 'sig-2',
        symbol: 'SOL',
        quantity: 2.55,
        metadata: { exchange: 'index', signalBotId: 'bot-1', venueSymbols: { bybit: 'SOLUSDT', deribit: 'SOL_USDC-PERPETUAL' } },
      } as any),
    )
    expect(manager.bybit.placed).toHaveLength(1)
    expect(manager.bybit.placed[0].symbol).toBe('SOLUSDT')
    expect(manager.bybit.placed[0].accountId).toBe('unified')
    expect(manager.bybit.placed[0].quantity).toBe(2.5)
    expect(db.executions.get('sig-2').symbol).toBe('SOLUSDT')
    expect(db.lastStatus().status).toBe('executed')
  })

  it("composite 'BTC' without a map uses the static registry (BTCUSDT, step 0.001)", async () => {
    const { manager, db, client } = build({ id: 'sub-1', factor: 1, exchange: 'bybit' })
    await (client as any).handleSignalInner(
      signal({ id: 'sig-3', symbol: 'BTC', quantity: 0.0125, price: 60000, metadata: { exchange: 'index', signalBotId: 'bot-1' } } as any),
    )
    expect(manager.bybit.placed).toHaveLength(1)
    expect(manager.bybit.placed[0].symbol).toBe('BTCUSDT')
    expect(manager.bybit.placed[0].quantity).toBe(0.012)
    expect(db.lastStatus().status).toBe('executed')
  })

  it('a bybit signal without a Bybit connection is rejected loudly (never routed elsewhere)', async () => {
    const manager = new Manager()
    ;(manager as any).bybit = undefined
    manager.getSession = async (_u: string, ex: string) =>
      ex === 'deribit' ? ({ adapter: manager.deribit, status: 'connected', userId: 'default', exchangeName: ex, label: 'default', connectionId: 'default:deribit' } as any) : undefined
    const db = new FakeDb({ id: 'sub-1', factor: 1, exchange: 'bybit' })
    const client = new SignalWebSocketClient(db as any, manager as any, null)
    client.setSettleOptions(2, 1)
    await (client as any).handleSignalInner(signal())
    expect(manager.deribit.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
  })

  it('the same signal on a deribit sub still resolves the coin wallet (unchanged)', async () => {
    const { manager, db, client } = build({ id: 'sub-1', factor: 1, exchange: 'deribit' })
    await (client as any).handleSignalInner(signal({ id: 'sig-5', symbol: 'BTC-PERPETUAL', quantity: 20, price: 60000, metadata: { exchange: 'deribit', signalBotId: 'bot-1' } } as any))
    expect(manager.bybit.placed).toHaveLength(0)
    expect(manager.deribit.placed).toHaveLength(1)
    expect(manager.deribit.placed[0].accountId).toBe('btc')
    expect(db.executions.get('sig-5').account_id).toBe('btc')
  })
})

// Collateral floor as the sizing basis (Bybit UTA): the signal's factor is a
// percent of the pot (coins × floor trigger × collateral ratio) and the 1x
// pot cap gates the entry.
class CollateralDb extends FakeDb {
  settings: any = null
  floors: any[] = []
  get(sql: string) {
    return sql.includes('collateral_settings') ? this.settings : null
  }
  all(sql: string) {
    if (sql.includes('collateral_floors')) return this.floors
    if (sql.includes('collateral_settings')) return this.settings ? [this.settings] : []
    return []
  }
  listSyntheticUsdPositions() { return [] }
}

class CollateralAdapter extends FakeAdapter {
  walletFails = false
  async getCollateralWallet() {
    if (this.walletFails) throw new Error('wallet timeout')
    return {
      accountType: 'UNIFIED', totalEquity: 100_000, totalMarginBalance: 100_000, totalAvailableBalance: 90_000,
      totalInitialMargin: 10_000, totalMaintenanceMargin: 5_000, accountIMRate: 0.1, accountMMRate: 0.05,
      coins: [{ coin: 'BTC', walletBalance: 0.2, equity: 0.2, usdValue: 20_000, borrowAmount: 0, collateralSwitch: true, marginCollateral: true, locked: 0 }],
    }
  }
  async getLastPrice() { return 150 }
}

function buildCollateral() {
  const manager = new Manager()
  manager.bybit = new CollateralAdapter('bybit') as any
  const db = new CollateralDb({ id: 'sub-1', factor: 1, exchange: 'bybit' })
  db.settings = {
    exchange: 'bybit', account_id: 'unified', sizing_basis: 'floor', unfloored: 'exclude', block_mmr_pct: 60,
    warn_mmr_pct: 80, auto_reduce: 0, auto_reduce_pct: 50, ratio_overrides: '{}', updated_at: 0,
  }
  db.floors = [{
    id: 'f1', exchange: 'bybit', account_id: 'unified', coin: 'BTC', mode: 'sell', status: 'armed', symbol: 'BTCUSDT',
    holdings_coin: 0.2, trigger_price: 85_000, fired_trigger_price: null, proceeds_usd: null,
  }]
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  client.setSettleOptions(2, 1)
  return { manager, db, client }
}

describe('collateral floor as the sizing basis', () => {
  it('qty 10 = 10 % of the pot (0,2 BTC × 85.000 × 0,95 = 16.150) → 1.615 USD / 150 → 10,7 SOL', async () => {
    const { manager, db, client } = buildCollateral()
    await (client as any).handleSignalInner(signal({ quantity: 10 }))
    expect(manager.bybit.placed).toHaveLength(1)
    expect(manager.bybit.placed[0].quantity).toBe(10.7)
    expect(db.safetyClips.some((c) => c.reason === 'collateral_sizing_applied' && c.originalQuantity === 10)).toBe(true)
    expect(db.lastStatus().status).toBe('executed')
  })

  it('the 1x pot cap refuses the entry when open notional is already at the pot', async () => {
    const { manager, db, client } = buildCollateral()
    manager.bybit.positions = [{ id: 'p', accountId: 'unified', symbol: 'XRPUSDT', side: 'long', size: 8_000, entryPrice: 2, markPrice: 2 }]
    await (client as any).handleSignalInner(signal({ quantity: 10 }))
    expect(manager.bybit.placed).toHaveLength(0)
    expect(db.lastStatus()).toMatchObject({ status: 'rejected' })
    expect(db.lastStatus().error).toMatch(/collateral cap/)
  })

  it('fails closed when the pot cannot be read', async () => {
    const { manager, db, client } = buildCollateral()
    ;(manager.bybit as any).walletFails = true
    await (client as any).handleSignalInner(signal({ quantity: 10 }))
    expect(manager.bybit.placed).toHaveLength(0)
    expect(db.lastStatus().error).toMatch(/collateral sizing: wallet timeout/)
  })
})
