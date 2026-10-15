// 15/10/2026, Fault-Line ETH on Deribit 'eth': the account holds a synthetic
// short of 12.356 next to the bot's 1.972 long, so the venue nets short. The
// trail stop ETH-SLTS-8046826 went up reduce-only and the venue dropped it at
// the trigger; the long stayed open. A stop on a lineage the book nets to the
// other side must move the net by the lineage's own qty, like the close.
// Real SQLite, fake Deribit.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { SignalWebSocketClient } from './signal-client.js'
import { protectiveStopOrder } from '../services/server-exit-stop.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

const BOT = 'bot-fl-eth'
const SYMBOL = 'ETH-PERPETUAL'
const ACCOUNT = 'eth'

let dir: string
let db: KaiBotDatabase
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-opposed-stops-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as any
})
afterEach(() => {
  globalThis.fetch = realFetch
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

class FakeAdapter {
  name = 'deribit'
  alwaysOpen = true
  // Market fills stop at this qty (terminal partial fill); 'pending' = unknown outcome.
  fillCap: number | 'pending' | null = null
  placed: Order[] = []
  cancelled: string[] = []
  positions: Position[] = []
  async getPositions() {
    return this.positions
  }
  async getBalances() {
    return []
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    const id = `ord-${this.placed.length}`
    if (o.orderType === 'stop') return { orderId: id, status: 'pending', filledQuantity: 0 }
    if (this.fillCap === 'pending') {
      this.statusOf[id] = 'working'
      return { orderId: id, status: 'pending', filledQuantity: 0 }
    }
    const filled = this.fillCap == null ? o.quantity : Math.min(o.quantity, this.fillCap)
    // The fill moves the venue net, like a real venue.
    const p = this.positions[0] ?? { id: `deribit:${o.symbol}`, accountId: ACCOUNT, symbol: o.symbol, side: 'long' as const, size: 0, entryPrice: 2400, markPrice: 2400 }
    const net = (p.side === 'long' ? p.size : -p.size) + (o.side === 'buy' ? filled : -filled)
    this.positions = net === 0 ? [] : [{ ...p, side: net > 0 ? 'long' : 'short', size: Math.abs(net) }]
    return { orderId: id, status: 'filled', filledQuantity: filled, averagePrice: 2400 }
  }
  // Cancel outcome per order id: an error message makes the cancel throw.
  cancelFails: Record<string, string> = {}
  // getOrderStatus state per order id (absent = 'cancelled').
  statusOf: Record<string, string> = {}
  async cancelOrder(id: string) {
    if (this.cancelFails[id]) throw new Error(this.cancelFails[id])
    this.cancelled.push(id)
  }
  async getOrderStatus(id: string) {
    return { orderId: id, state: (this.statusOf[id] ?? 'cancelled') as any }
  }
  stops() {
    return this.placed.filter((o) => o.orderType === 'stop')
  }
}

function build(adapter: FakeAdapter) {
  const manager = {
    async getSession(_u: string, exchangeName: string) {
      if (exchangeName !== 'deribit') return undefined
      return { adapter, status: 'connected', userId: 'default', exchangeName, connectionId: 'default:deribit' }
    },
  }
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  ;(client as any).apiUrl = 'http://api.test'
  ;(client as any).apiKey = 'key'
  return client
}

function seedSub() {
  db.upsertSubscription({
    id: 'sub-fl', signalBotId: BOT, selectedMarkets: [], factor: 1, status: 'active', exchange: 'deribit', accountId: ACCOUNT,
  })
}

function seedSynthetic(short: number) {
  db.insertSyntheticUsdPosition({
    id: 'syn-eth', exchange: 'deribit', account_id: ACCOUNT, symbol: SYMBOL,
    target_usd: short, holdings_basis_usd: short, leverage: 1, short_size: short, leverage_cap: 10,
  })
}

function seedRow(entryId: string, positionId: string, qty: number) {
  db.recordSignal({
    id: entryId, strategyId: 'strat-fl', symbol: SYMBOL, action: 'buy', quantity: 8,
    metadata: { exchange: 'deribit', signalBotId: BOT, positionId, exitAuthority: 'server' },
  })
  db.updateSignalStatus(entryId, 'executed')
  db.updateSignalOrderIds(entryId, `sl-${entryId}`)
  db.insertSignalExecution({ signalId: entryId, symbol: SYMBOL, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: qty, accountId: ACCOUNT })
  db.upsertServerExitState({
    positionId, entrySignalId: entryId, exchange: 'deribit', symbol: SYMBOL, direction: 'long', currentStop: 1300, slOrderId: `sl-${entryId}`,
  })
}

function venue(adapter: FakeAdapter, side: 'long' | 'short', size: number) {
  adapter.positions = [{ id: `deribit:${SYMBOL}`, accountId: ACCOUNT, symbol: SYMBOL, side, size, entryPrice: 2400, markPrice: 2400 }]
}

const update = (positionId: string, stop: number): Signal =>
  ({
    id: `upd-${positionId}`,
    strategy_id: 'strat-fl',
    symbol: SYMBOL,
    action: 'update',
    quantity: 0,
    price: stop,
    metadata: { exchange: 'deribit', signalBotId: BOT, positionId, exitSeq: 1 },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  }) as unknown as Signal

describe('protectiveStopOrder', () => {
  const base = { direction: 'long' as const, lineageQty: 986, tolerance: 0.5 }

  it('venue on the lineage side and covering: reduce-only', () => {
    expect(protectiveStopOrder({ ...base, bookNet: 1972, venueNet: 1972 })).toEqual({ quantity: 986, reduceOnly: true })
  })

  it('venue netted short by a synthetic the book explains: plain stop of the lineage qty', () => {
    expect(protectiveStopOrder({ ...base, bookNet: -10384, venueNet: -10384 })).toEqual({ quantity: 986, reduceOnly: false })
  })

  it('venue partly covering, book explains it: plain stop', () => {
    expect(protectiveStopOrder({ ...base, bookNet: 500, venueNet: 500 })).toEqual({ quantity: 986, reduceOnly: false })
  })

  it('book does not explain the venue (drift): stays reduce-only', () => {
    expect(protectiveStopOrder({ ...base, bookNet: 1972, venueNet: -10384 })).toEqual({ quantity: 986, reduceOnly: true })
  })

  it('without a venue read the book decides', () => {
    expect(protectiveStopOrder({ ...base, bookNet: -11370 })).toEqual({ quantity: 986, reduceOnly: false })
    expect(protectiveStopOrder({ ...base, bookNet: 986 })).toEqual({ quantity: 986, reduceOnly: true })
  })

  it('a short lineage mirrors it', () => {
    expect(protectiveStopOrder({ direction: 'short', lineageQty: 100, tolerance: 0.5, bookNet: 400, venueNet: 400 })).toEqual({ quantity: 100, reduceOnly: false })
    expect(protectiveStopOrder({ direction: 'short', lineageQty: 100, tolerance: 0.5, bookNet: -100, venueNet: -100 })).toEqual({ quantity: 100, reduceOnly: true })
  })
})

describe('server trail update on an account the synthetic nets short', () => {
  it('places a plain stop for the row qty, not reduce-only and never the venue size', async () => {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    seedRow('e2', 'row-2', 986)
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 10384)
    await (build(adapter) as any).handleSignalInner(update('row-2', 2375.18))

    expect(adapter.stops()).toHaveLength(1)
    expect(adapter.stops()[0]).toMatchObject({ side: 'sell', quantity: 986, stopPrice: 2375.18, reduceOnly: false })
    expect(adapter.cancelled).toEqual(['sl-e2'])
  })

  it('a single row on that account gets its own qty too, not the 10.384 venue net', async () => {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 11370)
    await (build(adapter) as any).handleSignalInner(update('row-1', 2375.18))

    expect(adapter.stops()[0]).toMatchObject({ quantity: 986, reduceOnly: false })
  })

  it('a plain account keeps the reduce-only stop', async () => {
    seedSub()
    seedRow('e1', 'row-1', 986)
    seedRow('e2', 'row-2', 986)
    const adapter = new FakeAdapter()
    venue(adapter, 'long', 1972)
    await (build(adapter) as any).handleSignalInner(update('row-2', 2375.18))

    expect(adapter.stops()[0]).toMatchObject({ quantity: 986, reduceOnly: true })
  })
})

describe('entry stop on an account the synthetic nets short', () => {
  it('the initial stop is a plain stop of the filled qty', async () => {
    seedSub()
    seedSynthetic(12356)
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 12356)
    const entry = {
      id: 'entry-1',
      strategy_id: 'strat-fl',
      symbol: SYMBOL,
      action: 'buy',
      quantity: 986,
      price: 2400,
      type: 'market',
      stop_loss: 1367.7,
      metadata: { exchange: 'deribit', signalBotId: BOT },
      received_at: new Date(),
      status: 'pending',
      created_at: new Date(),
    } as unknown as Signal
    db.recordSignal({ id: entry.id, strategyId: 'strat-fl', symbol: SYMBOL, action: 'buy', metadata: entry.metadata })
    await (build(adapter) as any).handleSignalInner(entry)

    const main = adapter.placed.find((o) => o.orderType === 'market')
    expect(main).toBeTruthy()
    expect(adapter.stops()).toHaveLength(1)
    expect(adapter.stops()[0]).toMatchObject({ side: 'sell', quantity: main!.quantity, stopPrice: 1367.7, reduceOnly: false })
  })

  it('a plain account keeps the reduce-only entry stop', async () => {
    seedSub()
    const adapter = new FakeAdapter()
    const entry = {
      id: 'entry-2',
      strategy_id: 'strat-fl',
      symbol: SYMBOL,
      action: 'buy',
      quantity: 986,
      price: 2400,
      type: 'market',
      stop_loss: 1367.7,
      metadata: { exchange: 'deribit', signalBotId: BOT },
      received_at: new Date(),
      status: 'pending',
      created_at: new Date(),
    } as unknown as Signal
    db.recordSignal({ id: entry.id, strategyId: 'strat-fl', symbol: SYMBOL, action: 'buy', metadata: entry.metadata })
    await (build(adapter) as any).handleSignalInner(entry)

    expect(adapter.stops()[0]).toMatchObject({ reduceOnly: true })
  })
})

// Review 15/10 ~12:4x: a plain stop is no longer harmless when it is stale or
// doubled. Three over-sell paths on 'eth', each with the fix's guard.
const stateOf = (positionId: string) => db.getServerExitState(positionId)!

function closeSignal(id: string, metadata: Record<string, unknown>): Signal {
  const s = {
    id,
    strategy_id: 'strat-fl',
    symbol: SYMBOL,
    action: 'close',
    quantity: 1,
    metadata: { exchange: 'deribit', signalBotId: BOT, ...metadata },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  } as unknown as Signal
  db.recordSignal({ id, strategyId: 'strat-fl', symbol: SYMBOL, action: 'close', metadata: s.metadata })
  return s
}

describe('partial close on an opposed book moves the plain stop to the remainder', () => {
  it('server row: 986 lineage, scale-out 0.5, the stop becomes a plain 493', async () => {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 11370)
    await (build(adapter) as any).handleSignalInner(closeSignal('close-half', { positionId: 'row-1', fraction: 0.5 }))

    const market = adapter.placed.filter((o) => o.orderType === 'market')
    expect(market.map((o) => [o.side, o.quantity, o.reduceOnly])).toEqual([['sell', 493, false]])
    expect(adapter.stops().map((o) => [o.side, o.quantity, o.stopPrice, o.reduceOnly])).toEqual([['sell', 493, 1300, false]])
    expect(adapter.cancelled).toEqual(['sl-e1'])
    expect(stateOf('row-1')).toMatchObject({ sl_order_id: 'ord-2', current_stop: 1300, last_exit_seq: 0 })
  })

  it('bracket-only lineage: its own stop moves to the remaining qty and the bracket follows', async () => {
    seedSub()
    seedSynthetic(12356)
    db.recordSignal({
      id: 'b1', strategyId: 'strat-fl', symbol: SYMBOL, action: 'buy', quantity: 8, stopLoss: 1300,
      metadata: { exchange: 'deribit', signalBotId: BOT },
    })
    db.updateSignalStatus('b1', 'executed')
    db.updateSignalOrderIds('b1', 'sl-b1')
    db.insertSignalExecution({ signalId: 'b1', symbol: SYMBOL, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 986, accountId: ACCOUNT })
    db.upsertBracketPair({ signalId: 'b1', exchange: 'deribit', accountId: ACCOUNT, slOrderId: 'sl-b1', tpOrderIds: [] })
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 11370)
    await (build(adapter) as any).handleSignalInner(closeSignal('close-half-b', { fraction: 0.5 }))

    expect(adapter.stops().map((o) => [o.quantity, o.stopPrice, o.reduceOnly])).toEqual([[493, 1300, false]])
    expect(adapter.cancelled).toEqual(['sl-b1'])
    expect(db.getBracketPair('b1')!.sl_order_id).toBe('ord-2')
  })
})

describe('trail update on an opposed book never leaves two plain stops', () => {
  it('old stop will not cancel: the new one is withdrawn, the old stays tracked', async () => {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 11370)
    adapter.cancelFails['sl-e1'] = 'network timeout'
    await (build(adapter) as any).handleSignalInner(update('row-1', 2375.18))

    expect(adapter.stops()).toHaveLength(1)
    expect(adapter.cancelled).toEqual(['ord-1'])
    expect(stateOf('row-1')).toMatchObject({ sl_order_id: 'sl-e1', current_stop: 1300, last_exit_seq: 0 })
  })

  it('old stop already gone (not filled): the update goes through', async () => {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 11370)
    adapter.cancelFails['sl-e1'] = 'Failed to cancel order: order_not_found'
    await (build(adapter) as any).handleSignalInner(update('row-1', 2375.18))

    expect(stateOf('row-1')).toMatchObject({ sl_order_id: 'ord-1', current_stop: 2375.18, last_exit_seq: 1 })
  })

  it('old stop already FILLED: the new one is withdrawn so it cannot sell the lineage twice', async () => {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 11370)
    adapter.cancelFails['sl-e1'] = 'Failed to cancel order: order_not_found'
    adapter.statusOf['sl-e1'] = 'filled'
    await (build(adapter) as any).handleSignalInner(update('row-1', 2375.18))

    expect(adapter.cancelled).toEqual(['ord-1'])
    expect(stateOf('row-1')).toMatchObject({ sl_order_id: 'sl-e1', last_exit_seq: 0 })
  })
})

describe('stop resize after an add on an opposed book', () => {
  const addSignal = {
    id: 'add-1',
    symbol: SYMBOL,
    action: 'buy',
    metadata: { exchange: 'deribit', signalBotId: BOT, positionId: 'row-1', add: true },
  } as unknown as Signal

  function seedAdd() {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    db.recordSignal({ id: 'add-1', strategyId: 'strat-fl', symbol: SYMBOL, action: 'buy', quantity: 8, metadata: addSignal.metadata })
    db.updateSignalStatus('add-1', 'executed')
    db.insertSignalExecution({ signalId: 'add-1', symbol: SYMBOL, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 500, accountId: ACCOUNT })
  }

  it('places a plain stop for entry + add and retires the seed stop', async () => {
    seedAdd()
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 10870)
    const client = build(adapter) as any
    await client.resizeServerExitStopAfterAdd(addSignal, { adapter, status: 'connected' }, 'deribit', ACCOUNT)

    expect(adapter.stops().map((o) => [o.quantity, o.stopPrice, o.reduceOnly])).toEqual([[1486, 1300, false]])
    expect(adapter.cancelled).toEqual(['sl-e1'])
    expect(stateOf('row-1').sl_order_id).toBe('ord-1')
  })

  it('seed stop will not cancel: the new one is withdrawn, the seed stop stays tracked', async () => {
    seedAdd()
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 10870)
    adapter.cancelFails['sl-e1'] = 'network timeout'
    const client = build(adapter) as any
    await client.resizeServerExitStopAfterAdd(addSignal, { adapter, status: 'connected' }, 'deribit', ACCOUNT)

    expect(adapter.cancelled).toEqual(['ord-1'])
    expect(stateOf('row-1').sl_order_id).toBe('sl-e1')
  })
})

describe('venue-exit sweep: a stop the venue cancelled stops being polled', () => {
  it('drops the order from the exit state and the bracket', async () => {
    const { sweepVenueExitOrders } = await import('../services/venue-exit-sweep.js')
    seedRow('e1', 'row-1', 986)
    db.upsertBracketPair({ signalId: 'e1', exchange: 'deribit', accountId: ACCOUNT, slOrderId: 'sl-e1', tpOrderIds: [] })
    const adapter = new FakeAdapter()
    adapter.statusOf['sl-e1'] = 'cancelled'
    const booked = await sweepVenueExitOrders({ db: db as any, getAdapter: async () => adapter as any }, 'deribit')

    expect(booked).toBe(0)
    expect(stateOf('row-1')).toMatchObject({ active: 1, sl_order_id: null })
    expect(db.getBracketPair('e1')!.sl_order_id).toBeNull()
    expect(db.getSignalExecution('e1')).toMatchObject({ status: 'open' })
  })
})

// Verification 15/10 ~12:4x of 154e6a5e5: gaps in the partial-close resize.
function spyLogs(): string[] {
  const seen: string[] = []
  const orig = db.log.bind(db)
  ;(db as any).log = (level: string, category: string, message: string, meta?: unknown) => {
    seen.push(`${level}:${message}`)
    return orig(level as any, category, message, meta)
  }
  return seen
}

describe('partial close that leaves the venue flat', () => {
  it('long 10 next to a synthetic short 5: after closing 5 the venue is flat, the plain stop still moves to 5', async () => {
    seedSub()
    seedSynthetic(5)
    seedRow('e1', 'row-1', 10)
    const adapter = new FakeAdapter()
    venue(adapter, 'long', 5)
    await (build(adapter) as any).handleSignalInner(closeSignal('close-5', { positionId: 'row-1', fraction: 0.5 }))

    expect(adapter.positions).toEqual([])
    expect(adapter.stops().map((o) => [o.quantity, o.stopPrice, o.reduceOnly])).toEqual([[5, 1300, false]])
    expect(adapter.cancelled).toEqual(['sl-e1'])
  })

  it('a venue the book cannot explain gets an alert instead of a silent skip', async () => {
    seedSub()
    seedSynthetic(5)
    seedRow('e1', 'row-1', 10)
    db.updateSignalExecution('e1', { qtyClosed: 5 })
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 3)
    const logs = spyLogs()
    const row = db.getEntryStopRow('e1')!
    await (build(adapter) as any).resizePlainStopsAfterPartial('deribit', adapter, [row], SYMBOL, 'close-x')

    expect(adapter.stops()).toHaveLength(0)
    expect(logs).toContain('error:Partial close: plain stop not resized, it still covers the closed part')
  })
})

describe('close paths that return before the resize', () => {
  it('terminal partial fill: the plain stop follows what actually closed', async () => {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 11370)
    adapter.fillCap = 300
    await (build(adapter) as any).handleSignalInner(closeSignal('close-half', { positionId: 'row-1', fraction: 0.5 }))

    expect(adapter.stops().map((o) => [o.quantity, o.reduceOnly])).toEqual([[686, false]])
    expect(db.getSignalExecution('e1')).toMatchObject({ status: 'closing', qty_closed: 300, qty_pending_close: 193 })
  })

  it('unknown outcome: an alert names the plain stop that is still sized for the whole lineage', async () => {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 11370)
    adapter.fillCap = 'pending'
    const client = build(adapter) as any
    client.settleIntervalMs = 1
    client.settleAttempts = 2
    const logs = spyLogs()
    await client.handleSignalInner(closeSignal('close-half', { positionId: 'row-1', fraction: 0.5 }))

    expect(adapter.stops()).toHaveLength(0)
    expect(logs).toContain('error:Close pending: plain stop still sized for the whole lineage')
  })
})

describe('retryPendingCloses on a hedged account stops for a human', () => {
  it('hedge larger than the lineage (venue short): no order, alert, still closing', async () => {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    db.updateSignalExecution('e1', { status: 'closing', qtyPendingClose: 493 })
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 11370)
    const logs = spyLogs()
    await (build(adapter) as any).retryPendingCloses('deribit')

    expect(adapter.placed).toHaveLength(0)
    expect(logs).toContain('error:Close retry needs manual action: hedged account')
    expect(db.getSignalExecution('e1')).toMatchObject({ status: 'closing', qty_closed: 0, qty_pending_close: 493 })
  })

  it('hedge smaller than the lineage (venue still long): no reduce-only close of the venue size either', async () => {
    seedSub()
    seedSynthetic(300)
    seedRow('e1', 'row-1', 986)
    db.updateSignalExecution('e1', { status: 'closing' })
    const adapter = new FakeAdapter()
    venue(adapter, 'long', 686)
    const logs = spyLogs()
    await (build(adapter) as any).retryPendingCloses('deribit')

    expect(adapter.placed).toHaveLength(0)
    expect(logs).toContain('error:Close retry needs manual action: hedged account')
    expect(db.getSignalExecution('e1')).toMatchObject({ status: 'closing', qty_closed: 0 })
  })

  it('the alert is throttled per lineage', async () => {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    db.updateSignalExecution('e1', { status: 'closing', qtyPendingClose: 493 })
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 11370)
    const logs = spyLogs()
    const client = build(adapter) as any
    await client.retryPendingCloses('deribit')
    await client.retryPendingCloses('deribit')

    expect(logs.filter((l) => l === 'error:Close retry needs manual action: hedged account')).toHaveLength(1)
  })
})

describe('retryPendingCloses, every account', () => {
  function seedPlain(id: string, positionId: string, qty: number) {
    seedRow(id, positionId, qty)
  }

  it('waits while an earlier exit order on the pair is unresolved', async () => {
    seedSub()
    seedPlain('e1', 'row-1', 10)
    db.updateSignalExecution('e1', { status: 'closing' })
    db.insertOrderSettlement({
      signalId: 'close-1', exchange: 'deribit', accountId: ACCOUNT, symbol: SYMBOL, kind: 'exit', side: 'sell', qty: 10,
      orderId: 'ETH-1', targetLabel: 'close', status: 'unknown',
    })
    const adapter = new FakeAdapter()
    venue(adapter, 'long', 10)
    await (build(adapter) as any).retryPendingCloses('deribit')

    expect(adapter.placed).toHaveLength(0)
    expect(db.getSignalExecution('e1')).toMatchObject({ status: 'closing' })
  })

  it('lineage A (4) next to B (6): a retry of 4 closes A, cancels its stop and retires its state; B stays', async () => {
    seedSub()
    seedPlain('eA', 'row-A', 4)
    seedPlain('eB', 'row-B', 6)
    db.updateSignalExecution('eA', { status: 'closing', qtyPendingClose: 4 })
    const adapter = new FakeAdapter()
    venue(adapter, 'long', 10)
    await (build(adapter) as any).retryPendingCloses('deribit')

    expect(adapter.placed.map((o) => [o.side, o.quantity, o.reduceOnly])).toEqual([['sell', 4, true]])
    expect(db.getSignalExecution('eA')).toMatchObject({ status: 'closed', qty_closed: 4 })
    expect(adapter.cancelled).toEqual(['sl-eA'])
    expect(stateOf('row-A').active).toBe(0)
    expect(db.getSignalExecution('eB')).toMatchObject({ status: 'open', qty_closed: 0 })
    expect(stateOf('row-B').active).toBe(1)
  })

  it('a full-close retry never takes another lineage on the same side', async () => {
    seedSub()
    seedPlain('eA', 'row-A', 4)
    seedPlain('eB', 'row-B', 6)
    db.updateSignalExecution('eA', { status: 'closing' })
    const adapter = new FakeAdapter()
    venue(adapter, 'long', 10)
    await (build(adapter) as any).retryPendingCloses('deribit')

    expect(adapter.placed.map((o) => [o.side, o.quantity])).toEqual([['sell', 4]])
    expect(db.getSignalExecution('eB')).toMatchObject({ status: 'open', qty_closed: 0 })
  })
})

describe('plain stop replacement when the old stop rests on another account', () => {
  it('places nothing and keeps the old stop tracked', async () => {
    seedSub()
    seedSynthetic(12356)
    seedRow('e1', 'row-1', 986)
    db.upsertBracketPair({ signalId: 'e1', exchange: 'deribit', accountId: 'acct1/eth', slOrderId: 'sl-e1', tpOrderIds: [] })
    const adapter = new FakeAdapter()
    venue(adapter, 'short', 11370)
    await (build(adapter) as any).handleSignalInner(update('row-1', 2375.18))

    expect(adapter.stops()).toHaveLength(0)
    expect(adapter.cancelled).toEqual([])
    expect(stateOf('row-1')).toMatchObject({ sl_order_id: 'sl-e1', last_exit_seq: 0 })
  })
})
