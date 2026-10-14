import { describe, expect, it } from 'bun:test'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'
import { scopeAdapter } from '../services/exchanges/account-scope.js'

// Two Deribit accounts in one executor (2026-09-04): the default connection
// ('btc') and a labeled one ('acct2' → 'acct2/btc'). A subscription pinned to
// acct2 must open, close and guard on acct2 only; the default connection's
// same-symbol position is another lineage entirely.

interface EntryRow {
  id: string
  symbol: string
  action: 'buy' | 'sell'
  quantity: number | null
  stop_loss_order_id: string | null
  take_profit_order_id: string | null
  metadata: string | null
}

class FakeDb {
  logs: any[] = []
  signalStatuses: Array<{ id: string; status: string; error?: string }> = []
  closedEntries: Array<{ id: string; reason?: string }> = []
  safetyClips: any[] = []
  queue: any[] = []
  fills: any[] = []
  executions = new Map<string, any>()
  settlements: any[] = []
  bracketPairs: any[] = []
  dcaRestingRungs: any[] = []
  serverExitStates: any[] = []
  sub: any
  entries: EntryRow[]

  constructor(sub: any = null, entries: EntryRow[] = []) {
    this.sub = sub
    this.entries = entries
  }

  log(level: string, category: string, message: string, metadata?: any) {
    this.logs.push({ level, category, message, metadata })
  }
  recordSignal() {}
  recordSignalQueue(entry: any) { this.queue.push(entry) }
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
  getOpenEntrySignals(symbol: string, subFilter?: string): EntryRow[] {
    return this.entries.filter(
      (e) => e.symbol.toLowerCase() === symbol.toLowerCase() && (!subFilter || (e.metadata ?? '').includes(subFilter)),
    )
  }
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
      account_id: row.accountId ?? null,
      qty_opened: row.qtyOpened ?? 0,
      qty_closed: row.qtyClosed ?? 0,
    })
    return true
  }
  updateSignalExecution(id: string, patch: any) {
    const row = this.executions.get(id)
    if (!row) return
    if (patch.status !== undefined) row.status = patch.status
    if (patch.qtyOpened !== undefined) row.qty_opened = patch.qtyOpened
    if (patch.qtyClosed !== undefined) row.qty_closed = patch.qtyClosed
  }
  insertSignalFill(fill: any) { this.fills.push(fill) }
  insertOrderSettlement(row: any): number {
    const id = this.settlements.length + 1
    this.settlements.push({ id, signal_id: row.signalId, kind: row.kind, target_label: row.targetLabel ?? null, order_id: row.orderId, status: row.status ?? 'unknown' })
    return id
  }
  getExitSettlement(signalId: string, kind: string, targetLabel: string) {
    return this.settlements.find((s) => s.signal_id === signalId && s.kind === kind && s.target_label === targetLabel)
  }
  targetAlreadyProcessed(signalId: string, kind: string, targetLabel: string) {
    const row = this.getExitSettlement(signalId, kind, targetLabel)
    return !!row && !['rejected', 'cancelled'].includes(row.status)
  }
  hasUnresolvedSettlement() { return false }
  resolveOrderSettlement() {}
  upsertBracketPair(row: any) {
    const i = this.bracketPairs.findIndex((r) => r.signal_id === row.signalId)
    const rec = {
      signal_id: row.signalId,
      exchange: row.exchange,
      account_id: row.accountId ?? (i >= 0 ? this.bracketPairs[i].account_id : null),
      sl_order_id: row.slOrderId ?? null,
      tp_order_id: row.tpOrderIds?.[0] ?? row.tpOrderId ?? null,
      tp_order_ids: row.tpOrderIds ? JSON.stringify(row.tpOrderIds) : null,
    }
    if (i >= 0) this.bracketPairs[i] = rec
    else this.bracketPairs.push(rec)
  }
  listBracketPairs() { return this.bracketPairs }
  deleteBracketPair(signalId: string) {
    this.bracketPairs = this.bracketPairs.filter((r) => r.signal_id !== signalId)
  }
  listActiveServerExitStates() { return this.serverExitStates.filter((s) => s.active === 1) }
  deactivateServerExitState() {}
  getDcaRestingRungsForSignal(signalId: string) { return this.dcaRestingRungs.filter((r) => r.signal_id === signalId) }
  deleteDcaRestingRung(orderId: string) {
    this.dcaRestingRungs = this.dcaRestingRungs.filter((r) => r.order_id !== orderId)
  }
  listActiveLocalTrails() { return [] }
  deactivateLocalTrail() {}
  getLocalTrail() { return undefined }
  getPositionGroupLink() { return undefined }
  lastStatus() { return this.signalStatuses[this.signalStatuses.length - 1] }
}

class FakeAdapter {
  name = 'deribit'
  positions: Position[] = []
  placed: Order[] = []
  cancelled: string[] = []
  async getPositions() { return this.positions }
  async getBalances() { return [] }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: `${this.name}-ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity, averagePrice: o.price ?? 60000 }
  }
  async cancelOrder(id: string) { this.cancelled.push(id) }
}

// Two connections on 'deribit': default (bare ids) + 'acct2' (scoped ids).
class TwoConnectionManager {
  dflt = new FakeAdapter()
  acct2Inner = new FakeAdapter()
  acct2 = scopeAdapter(this.acct2Inner as any, 'acct2')
  async getSession(_userId: string, exchangeName: string, accountKey?: string) {
    if (exchangeName !== 'deribit') return undefined
    if (!accountKey) return { adapter: this.dflt, status: 'connected', userId: 'default', exchangeName, label: 'default', connectionId: 'default:deribit' }
    if (accountKey === 'acct2') return { adapter: this.acct2, status: 'connected', userId: 'default', exchangeName, label: 'acct2', accountKey, connectionId: 'default:deribit:acct2' }
    return undefined
  }
}

const btcLong = (size = 100): Position => ({
  id: 'deribit:BTC-PERPETUAL',
  accountId: 'btc',
  symbol: 'BTC-PERPETUAL',
  side: 'long',
  size,
  entryPrice: 60000,
  markPrice: 60000,
})

function entrySignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    strategy_id: 'strat-1',
    symbol: 'BTC-PERPETUAL',
    action: 'buy',
    quantity: 10,
    price: 60000,
    metadata: { exchange: 'deribit', signalBotId: 'bot-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as unknown as Signal
}

function closeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'close-1',
    strategy_id: 'strat-1',
    symbol: 'BTC-PERPETUAL',
    action: 'close',
    quantity: 1,
    metadata: { exchange: 'deribit', subscriptionId: 'sub-1' },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  } as Signal
}

function build(sub: any, entries: EntryRow[] = []) {
  const manager = new TwoConnectionManager()
  const db = new FakeDb(sub, entries)
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  client.setSettleOptions(2, 1)
  return { manager, db, client }
}

describe('entries route to the subscription’s connection', () => {
  it('a sub pinned to acct2 opens on acct2 with the venue’s bare account id, default untouched', async () => {
    const { manager, db, client } = build({ id: 'sub-1', factor: 1, exchange: 'deribit', account_key: 'acct2' })
    await (client as any).handleSignalInner(entrySignal())
    expect(manager.dflt.placed).toHaveLength(0)
    expect(manager.acct2Inner.placed).toHaveLength(1)
    expect(manager.acct2Inner.placed[0].accountId).toBe('btc')
    // The lineage is recorded under the namespaced account.
    expect(db.executions.get('sig-1').account_id).toBe('acct2/btc')
    expect(db.lastStatus().status).toBe('executed')
  })

  it('a sub without a key still opens on the default connection exactly as before', async () => {
    const { manager, db, client } = build({ id: 'sub-1', factor: 1, exchange: 'deribit' })
    await (client as any).handleSignalInner(entrySignal())
    expect(manager.dflt.placed).toHaveLength(1)
    expect(manager.dflt.placed[0].accountId).toBe('btc')
    expect(manager.acct2Inner.placed).toHaveLength(0)
    expect(db.executions.get('sig-1').account_id).toBe('btc')
  })

  it('a sub pinned to an unknown connection is rejected, nothing is placed', async () => {
    const { manager, db, client } = build({ id: 'sub-1', factor: 1, exchange: 'deribit', account_key: 'nope' })
    await (client as any).handleSignalInner(entrySignal())
    expect(manager.dflt.placed).toHaveLength(0)
    expect(manager.acct2Inner.placed).toHaveLength(0)
    expect(db.lastStatus().status).toBe('rejected')
    expect(db.lastStatus().error).toContain('no session')
  })

  it('maxConcurrentTrades counts the routed connection only (positions cache is per connection)', async () => {
    const manager = new TwoConnectionManager()
    // Default connection is at its cap; acct2 is flat.
    manager.dflt.positions = [btcLong()]
    const subDefault = { id: 'sub-d', factor: 1, exchange: 'deribit', max_concurrent_trades: 1 }
    const subAcct2 = { id: 'sub-2', factor: 1, exchange: 'deribit', account_key: 'acct2', max_concurrent_trades: 1 }

    const dbDefault = new FakeDb(subDefault)
    const clientDefault = new SignalWebSocketClient(dbDefault as any, manager as any, null)
    clientDefault.setSettleOptions(2, 1)
    await (clientDefault as any).handleSignalInner(entrySignal({ id: 'sig-d', symbol: 'ETH-PERPETUAL' }))
    expect(manager.dflt.placed).toHaveLength(0)
    expect(dbDefault.lastStatus().error).toContain('maxConcurrentTrades')

    // Same client instance (same caches) now serving the acct2 sub: the
    // default connection's snapshot must not leak into acct2's count.
    ;(clientDefault as any).db = new FakeDb(subAcct2)
    await (clientDefault as any).handleSignalInner(entrySignal({ id: 'sig-2', symbol: 'ETH-PERPETUAL' }))
    expect(manager.acct2Inner.placed).toHaveLength(1)
    expect(manager.dflt.placed).toHaveLength(0)
  })
})

describe('closes touch only their own connection’s lineage', () => {
  const entries = (): EntryRow[] => [
    { id: 'entry-1', symbol: 'BTC-PERPETUAL', action: 'buy', quantity: 100, stop_loss_order_id: 'sl-1', take_profit_order_id: 'tp-1', metadata: JSON.stringify({ subscriptionId: 'sub-1' }) },
  ]

  it('a close for the acct2 sub sells on acct2 only, even though default holds the same contract', async () => {
    const { manager, db, client } = build({ id: 'sub-1', exchange: 'deribit', account_key: 'acct2' }, entries())
    manager.dflt.positions = [btcLong(100)]
    manager.acct2Inner.positions = [btcLong(40)]
    db.executions.set('entry-1', { signal_id: 'entry-1', status: 'open', qty_opened: 40, qty_closed: 0, account_id: 'acct2/btc', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long' })

    await (client as any).executeCloseSignal(closeSignal(), db.sub)

    expect(manager.dflt.placed).toHaveLength(0)
    expect(manager.dflt.cancelled).toHaveLength(0)
    expect(manager.acct2Inner.placed).toHaveLength(1)
    const close = manager.acct2Inner.placed[0]
    expect(close.side).toBe('sell')
    expect(close.reduceOnly).toBe(true)
    expect(close.quantity).toBe(40)
    expect(close.accountId).toBe('btc')
    // Bracket legs of the acct2 lineage were cancelled on acct2.
    expect(manager.acct2Inner.cancelled.sort()).toEqual(['sl-1', 'tp-1'])
    expect(db.lastStatus().status).toBe('executed')
  })

  it('a close for the default sub flattens default only, acct2 keeps its position', async () => {
    const { manager, db, client } = build({ id: 'sub-1', exchange: 'deribit' }, entries())
    manager.dflt.positions = [btcLong(100)]
    manager.acct2Inner.positions = [btcLong(40)]
    db.executions.set('entry-1', { signal_id: 'entry-1', status: 'open', qty_opened: 100, qty_closed: 0, account_id: 'btc', symbol: 'BTC-PERPETUAL', exchange: 'deribit', direction: 'long' })

    await (client as any).executeCloseSignal(closeSignal(), db.sub)

    expect(manager.acct2Inner.placed).toHaveLength(0)
    expect(manager.acct2Inner.cancelled).toHaveLength(0)
    expect(manager.dflt.placed).toHaveLength(1)
    expect(manager.dflt.placed[0].quantity).toBe(100)
  })

  it('a close for the acct2 sub is a no-op when acct2 is flat, even with default long', async () => {
    const { manager, db, client } = build({ id: 'sub-1', exchange: 'deribit', account_key: 'acct2' }, entries())
    manager.dflt.positions = [btcLong(100)]
    manager.acct2Inner.positions = []

    await (client as any).executeCloseSignal(closeSignal(), db.sub)

    expect(manager.dflt.placed).toHaveLength(0)
    expect(manager.acct2Inner.placed).toHaveLength(0)
  })
})

describe('OCO siblings cancel on the connection that holds the bracket', () => {
  it('routes the sibling cancel by the bracket’s account, also after a restart rehydrate', async () => {
    const { manager, db, client } = build({ id: 'sub-1', exchange: 'deribit', account_key: 'acct2' })
    client.registerBracket('deribit', 'sig-x', 'sl-x', ['tp-x'], 'acct2/btc')
    expect(db.bracketPairs[0].account_id).toBe('acct2/btc')

    // Fresh client: nothing in memory until the persisted pairs are loaded.
    const client2 = new SignalWebSocketClient(db as any, manager as any, null)
    expect(client2.loadPersistedBrackets()).toBe(1)
    await client2.onExchangeOrderUpdate({ orderId: 'tp-x', state: 'filled', exchangeName: 'deribit' })

    expect(manager.acct2Inner.cancelled).toEqual(['sl-x'])
    expect(manager.dflt.cancelled).toHaveLength(0)
  })
})
