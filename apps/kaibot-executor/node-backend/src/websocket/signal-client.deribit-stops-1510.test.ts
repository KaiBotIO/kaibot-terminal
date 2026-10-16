// 15/10/2026 after 12:54 UTC (0.4.44), Deribit 'eth' (ETH-PERPETUAL): a
// synthetic short of 12.356 next to two Fault-Line longs of 986 (b16, b20),
// venue net -10.384.
//  - 16:03: b16's trail stop ETH-SLTS-8047026 fired and sold 986 (venue
//    -11.370). The spawned order answered order_not_found, the adapter said
//    'cancelled', the sweep dropped the stop and never booked the exit.
//  - 20:02: the next trail update for b16 found the book 986 off the venue and
//    placed ETH-SLTS-8047093 reduce-only sell 986 on the net-short account: it
//    could never fill, and the lineage it was for was already gone.
// Real SQLite, real sweep, fake venue.

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { EXIT_WAIT_ESCALATE_MS, SignalWebSocketClient } from './signal-client.js'
import { FIRED_ESCALATE_MS, resetVenueExitSweepAlerts, sweepVenueExitOrders } from '../services/venue-exit-sweep.js'
import { DeribitAdapter } from '../services/exchanges/adapters/deribit.js'
import { createPositionManageService } from '../services/position-manage.js'
import { firedConfirm } from '../services/server-exit-stop.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'

const BOT = 'bot-fl-eth'
const SYMBOL = 'ETH-PERPETUAL'
const ACCOUNT = 'eth'
const B16_STOP = 'ETH-SLTS-8047026'
const B16_SPAWNED = 'ETH-138800000001'
const B20_STOP = 'ETH-SLTS-8046826'

let dir: string
let db: KaiBotDatabase
let logs: string[]
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-deribit-1510-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  globalThis.fetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as any
  logs = []
  resetVenueExitSweepAlerts()
  firedConfirm.pauseMs = 0
  const orig = db.log.bind(db)
  ;(db as any).log = (level: string, category: string, message: string, meta?: unknown) => {
    logs.push(`${level}:${message}`)
    return orig(level as any, category, message, meta)
  }
})
afterEach(() => {
  firedConfirm.pauseMs = 1500
  globalThis.fetch = realFetch
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function seedSub() {
  db.upsertSubscription({
    id: 'sub-fl', signalBotId: BOT, selectedMarkets: [], factor: 1, status: 'active', exchange: 'deribit', accountId: ACCOUNT,
  })
}

function seedSynthetic(short = 12356) {
  db.insertSyntheticUsdPosition({
    id: 'syn-eth', exchange: 'deribit', account_id: ACCOUNT, symbol: SYMBOL,
    target_usd: short, holdings_basis_usd: short, leverage: 1, short_size: short, leverage_cap: 10,
  })
}

function seedRow(entryId: string, positionId: string, slOrderId: string, qty = 986, stop = 2435.65) {
  db.recordSignal({
    id: entryId, strategyId: 'strat-fl', symbol: SYMBOL, action: 'buy', quantity: 8,
    metadata: { exchange: 'deribit', signalBotId: BOT, positionId, exitAuthority: 'server' },
  })
  db.updateSignalStatus(entryId, 'executed')
  db.updateSignalOrderIds(entryId, slOrderId)
  db.insertSignalExecution({ signalId: entryId, symbol: SYMBOL, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: qty, accountId: ACCOUNT })
  db.upsertServerExitState({
    positionId, entrySignalId: entryId, exchange: 'deribit', symbol: SYMBOL, direction: 'long', currentStop: stop, slOrderId,
  })
}

// Both FL rows on 'eth' as they stood at 16:02: b16 trail stop at 2.435,65, b20 still on its own stop.
function seedFlEth() {
  seedSub()
  seedSynthetic()
  seedRow('b16', 'row-16', B16_STOP)
  seedRow('b20', 'row-20', B20_STOP, 986, 2375.18)
}

// Deribit as seen through the API on 15/10 16:03: the trigger fired, the
// history names the spawned order, and every lookup BY ORDER ID on it answers
// order_not_found, now and later. Only the instrument-wide indexes the
// scenario opens can find it.
const FIRED_AT = 1792080186000
function deribitAt1603(opts: {
  positions: () => Position[]
  historicalOrder?: () => boolean
  historicalTrades?: () => boolean
}) {
  const calls: Array<{ endpoint: string; params: Record<string, any> }> = []
  const adapter = new DeribitAdapter()
  adapter.getLastPrice = async () => null
  adapter.getPositions = async () => opts.positions()
  ;(adapter as any).call = async (endpoint: string, params: Record<string, any>) => {
    calls.push({ endpoint, params })
    if (endpoint === 'private/get_order_state' && params.order_id === B20_STOP) {
      return { order_id: B20_STOP, order_state: 'untriggered', instrument_name: SYMBOL, filled_amount: 0 }
    }
    if (endpoint === 'private/get_trigger_order_history') {
      return {
        entries: [
          { trigger_order_id: B16_STOP, order_id: B16_SPAWNED, order_state: 'triggered', request: 'trigger:order', instrument_name: SYMBOL, amount: 986, direction: 'sell', reduce_only: false, timestamp: FIRED_AT },
        ],
        continuation: 'none',
      }
    }
    if (endpoint === 'private/get_order_history_by_instrument') {
      if (params.historical && opts.historicalOrder?.()) {
        return [{ order_id: B16_SPAWNED, order_state: 'filled', instrument_name: SYMBOL, filled_amount: 986, average_price: 2435.5, last_update_timestamp: FIRED_AT + 584 }]
      }
      return []
    }
    if (endpoint === 'private/get_user_trades_by_instrument_and_time') {
      if (params.historical && opts.historicalTrades?.()) {
        return { trades: [{ trade_id: 't1', order_id: B16_SPAWNED, amount: 986, price: 2435.4, timestamp: FIRED_AT + 600, instrument_name: SYMBOL }], has_more: false }
      }
      return { trades: [], has_more: false }
    }
    if (endpoint === 'private/get_user_trades_by_order') throw new Error('order_not_found')
    if (endpoint === 'private/get_order_state') throw new Error('order_not_found')
    throw new Error(`unexpected ${endpoint}`)
  }
  return { adapter, calls }
}

const ethVenue = (net: number): Position[] => [
  { id: `deribit:${SYMBOL}`, accountId: ACCOUNT, symbol: SYMBOL, side: net > 0 ? 'long' : 'short', size: Math.abs(net), entryPrice: 2400, markPrice: 2440 },
]

function sweepDeps(adapter: unknown) {
  const pushed: Array<{ title: string; body: string }> = []
  return {
    pushed,
    deps: {
      db: db as any,
      getAdapter: async () => adapter as any,
      reportVenueExit: async () => ({ sent: true }),
      notify: (e: { title: string; body: string }) => pushed.push(e),
    },
  }
}

describe('bug 1: a fired stop whose spawned order is unreadable is never booked as cancelled', () => {
  it('books the fill from the HISTORICAL order index; get_order_state never returns it', async () => {
    seedFlEth()
    let indexed = false
    const { adapter, calls } = deribitAt1603({ positions: () => ethVenue(-11370), historicalOrder: () => indexed })
    const { deps, pushed } = sweepDeps(adapter)

    expect(await sweepVenueExitOrders(deps, 'deribit')).toBe(0)
    expect(db.getServerExitState('row-16')).toMatchObject({ active: 1, sl_order_id: B16_STOP })
    expect(db.getSignalExecution('b16')).toMatchObject({ status: 'open', qty_closed: 0 })
    expect(logs).not.toContain('error:Venue exit sweep: tracked stop is gone at the venue, lineage unprotected')
    // The venue moved by b16's 986: filled, not booked yet, pushed.
    expect(pushed.map((p) => p.title)).toEqual(['Stop filled, fill not readable'])
    expect(calls.some((c) => c.endpoint === 'private/get_order_history_by_instrument' && c.params.historical === true)).toBe(true)

    indexed = true
    expect(await sweepVenueExitOrders(deps, 'deribit')).toBe(1)
    expect(db.getSignalExecution('b16')).toMatchObject({ status: 'closed', qty_closed: 986 })
    expect(db.getSignalFills('b16').find((f) => f.kind === 'exit')).toMatchObject({ qty: 986, price: 2435.5, order_id: B16_STOP })
    expect(db.getServerExitState('row-16')!.active).toBe(0)
    expect(db.getSignalExecution('b20')).toMatchObject({ status: 'open', qty_closed: 0 })
    expect(db.getServerExitState('row-20')).toMatchObject({ active: 1, sl_order_id: B20_STOP })
    // Every by-id lookup of the spawned order missed.
    expect(calls.filter((c) => c.params.order_id === B16_SPAWNED).length).toBeGreaterThan(0)
  })

  it('books the fill from the historical instrument trades filtered on the spawned order id', async () => {
    seedFlEth()
    const { adapter, calls } = deribitAt1603({ positions: () => ethVenue(-11370), historicalTrades: () => true })
    const { deps } = sweepDeps(adapter)

    expect(await sweepVenueExitOrders(deps, 'deribit')).toBe(1)
    expect(db.getSignalFills('b16').find((f) => f.kind === 'exit')).toMatchObject({ qty: 986, price: 2435.4 })
    const tradeCalls = calls.filter((c) => c.endpoint === 'private/get_user_trades_by_instrument_and_time')
    expect(tradeCalls.map((c) => c.params.historical)).toEqual([false, true])
    expect(tradeCalls[0].params).toMatchObject({ instrument_name: SYMBOL, start_timestamp: FIRED_AT - 60_000 })
  })

  it('fired, unreadable, and the venue still holds b16: the venue dropped it, the slot frees up for a new stop', async () => {
    seedFlEth()
    const { adapter } = deribitAt1603({ positions: () => ethVenue(-10384) })
    const { deps, pushed } = sweepDeps(adapter)

    expect(await sweepVenueExitOrders(deps, 'deribit')).toBe(0)
    expect(db.getServerExitState('row-16')).toMatchObject({ active: 1, sl_order_id: null })
    expect(db.getSignalExecution('b16')).toMatchObject({ status: 'open' })
    expect(pushed.map((p) => p.title)).toEqual(['Stop gone at the venue'])
  })

  it('fired, unreadable, venue says neither: kept, pushed at once, escalated after the time limit', async () => {
    seedFlEth()
    const { adapter } = deribitAt1603({ positions: () => ethVenue(-11000) })
    const { deps, pushed } = sweepDeps(adapter)
    const t0 = Date.now()
    try {
      setSystemTime(new Date(t0))
      await sweepVenueExitOrders(deps, 'deribit')
      setSystemTime(new Date(t0 + 60_000))
      await sweepVenueExitOrders(deps, 'deribit')
      setSystemTime(new Date(t0 + FIRED_ESCALATE_MS + 1))
      await sweepVenueExitOrders(deps, 'deribit')
    } finally {
      setSystemTime()
    }
    expect(pushed.map((p) => p.title)).toEqual(['Stop fired, fill not readable yet', 'Stop outcome unresolved'])
    expect(db.getServerExitState('row-16')).toMatchObject({ active: 1, sl_order_id: B16_STOP })
  })

  it('a cancel verdict next to fills on the order keeps the state', async () => {
    seedFlEth()
    const adapter = new DeribitAdapter()
    adapter.getLastPrice = async () => null
    ;(adapter as any).call = async (endpoint: string, params: Record<string, any>) => {
      if (endpoint === 'private/get_order_state' && params.order_id === B20_STOP) {
        return { order_id: B20_STOP, order_state: 'untriggered', filled_amount: 0 }
      }
      if (endpoint === 'private/get_order_state') throw new Error('order_not_found')
      if (endpoint === 'private/get_trigger_order_history') {
        return { entries: [{ trigger_order_id: B16_STOP, order_id: B16_STOP, order_state: 'cancelled' }], continuation: 'none' }
      }
      if (endpoint === 'private/get_user_trades_by_order' && params.order_id === B16_STOP && !params.historical) {
        return { trades: [{ trade_id: 't1', amount: 986, price: 2435.5, timestamp: 1792080186584 }] }
      }
      return { trades: [] }
    }
    const { deps, pushed } = sweepDeps(adapter)
    await sweepVenueExitOrders(deps, 'deribit')

    expect(db.getServerExitState('row-16')).toMatchObject({ active: 1, sl_order_id: B16_STOP })
    expect(logs).toContain('error:Venue exit sweep: tracked stop reported gone but fills are not ruled out, state kept')
    expect(pushed.map((p) => p.title)).toEqual(['Stop gone, fills not ruled out'])
  })
})

class FakeVenue {
  name = 'deribit'
  placed: Order[] = []
  cancelled: string[] = []
  positions: Position[] = []
  cancelFails: Record<string, string> = {}
  statusOf: Record<string, string> = {}
  async getPositions() {
    return this.positions
  }
  async getBalances() {
    return []
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: `ETH-SLTS-new-${this.placed.length}`, status: 'pending', filledQuantity: 0 }
  }
  async cancelOrder(id: string) {
    if (this.cancelFails[id]) throw new Error(this.cancelFails[id])
    this.cancelled.push(id)
  }
  async getOrderStatus(id: string) {
    if (this.statusOf[id] === 'fired') return { orderId: id, state: 'unknown' as const, absenceConfirmed: false, triggered: true }
    if (this.statusOf[id] === 'inconclusive') return { orderId: id, state: 'unknown' as const, absenceConfirmed: false }
    return { orderId: id, state: (this.statusOf[id] ?? 'cancelled') as any }
  }
  stops() {
    return this.placed.filter((o) => o.orderType === 'stop')
  }
}

function venue(adapter: FakeVenue, side: 'long' | 'short', size: number) {
  adapter.positions = [{ id: `deribit:${SYMBOL}`, accountId: ACCOUNT, symbol: SYMBOL, side, size, entryPrice: 2400, markPrice: 2460 }]
}

let pushes: string[] = []
function build(adapter: FakeVenue) {
  pushes = []
  const manager = {
    async getSession(_u: string, exchangeName: string) {
      if (exchangeName !== 'deribit') return undefined
      return { adapter, status: 'connected', userId: 'default', exchangeName, connectionId: 'default:deribit' }
    },
  }
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  ;(client as any).notifications = { publish: (e: { title: string }) => pushes.push(e.title) }
  ;(client as any).apiUrl = 'http://api.test'
  ;(client as any).apiKey = 'key'
  return client
}

const update = (positionId: string, stop: number, exitSeq: number): Signal =>
  ({
    id: `upd-${positionId}-${exitSeq}`,
    strategy_id: 'strat-fl',
    symbol: SYMBOL,
    action: 'update',
    quantity: 0,
    price: stop,
    metadata: { exchange: 'deribit', signalBotId: BOT, positionId, exitSeq },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  }) as unknown as Signal

describe('bug 2: no reduce-only stop on the net-short account, none for a lineage that is out', () => {
  it('20:02 replay: b16 already sold at the venue, unbooked; the trail update places nothing', async () => {
    seedFlEth()
    // What the 16:03 sweep left behind: exit-state slot empty, entry bracket still on 8047026.
    db.dropServerExitStopOrder('row-16', B16_STOP)
    const adapter = new FakeVenue()
    venue(adapter, 'short', 11370)
    adapter.cancelFails[B16_STOP] = 'Failed to cancel order: order_not_found'
    adapter.statusOf[B16_STOP] = 'filled'
    await (build(adapter) as any).handleSignalInner(update('row-16', 2448.24, 2))

    expect(adapter.stops()).toEqual([])
    expect(db.getServerExitState('row-16')!.last_exit_seq).toBe(0)
    expect(logs).toContain('error:Stop not placed: the book does not explain the venue and a reduce-only stop could never fill')
  })

  it('a drifted net-short venue gets no inert reduce-only stop, and the resting stop is not cancelled', async () => {
    seedFlEth()
    const adapter = new FakeVenue()
    venue(adapter, 'short', 11370)
    await (build(adapter) as any).handleSignalInner(update('row-20', 2400, 1))

    expect(adapter.stops()).toEqual([])
    expect(adapter.cancelled).toEqual([])
    expect(db.getServerExitState('row-20')).toMatchObject({ sl_order_id: B20_STOP, last_exit_seq: 0 })
  })

  it('reduce-only path: an old stop that filled gets no replacement (it would close the sibling)', async () => {
    seedSub()
    seedRow('a1', 'row-a1', 'sl-a1', 986)
    seedRow('a2', 'row-a2', 'sl-a2', 986)
    const adapter = new FakeVenue()
    // a1's stop sold 986, not booked yet: the venue still holds a2.
    venue(adapter, 'long', 986)
    adapter.cancelFails['sl-a1'] = 'Failed to cancel order: order_not_found'
    adapter.statusOf['sl-a1'] = 'filled'
    await (build(adapter) as any).handleSignalInner(update('row-a1', 2440, 1))

    expect(adapter.stops()).toEqual([])
    expect(db.getServerExitState('row-a1')).toMatchObject({ sl_order_id: 'sl-a1', last_exit_seq: 0 })
    expect(logs).toContain('error:Exit stop amend: old stop filled, no new stop for this lineage')
  })

  it('a lineage already closed in the book gets no stop and its exit state retires', async () => {
    seedFlEth()
    db.updateSignalExecution('b16', { status: 'closed', qtyClosed: 986 })
    const adapter = new FakeVenue()
    venue(adapter, 'short', 11370)
    await (build(adapter) as any).handleSignalInner(update('row-16', 2448.24, 2))

    expect(adapter.stops()).toEqual([])
    expect(db.getServerExitState('row-16')!.active).toBe(0)
  })

  it('stop floor on a bot row of the net-short account: plain stop of the row qty, not reduce-only', async () => {
    seedFlEth()
    const adapter = new FakeVenue()
    venue(adapter, 'short', 10384)
    const svc = createPositionManageService(db, { getSession: async () => ({ status: 'connected', adapter }) } as any)
    await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, accountId: ACCOUNT, manualStop: 2440 })

    expect(adapter.stops()).toHaveLength(1)
    expect(adapter.stops()[0]).toMatchObject({ side: 'sell', quantity: 986, stopPrice: 2440, reduceOnly: false })
  })
})

// The stop fired, its fill cannot be read, then the next trail update comes
// in: retireOldStop lets the venue position decide between fill and drop.
describe('fired + unreadable, then a trail update', () => {
  it('fill (venue moved by the lineage): no replacement, the old id stays tracked', async () => {
    seedSub()
    seedRow('a1', 'row-a1', 'sl-a1', 986)
    seedRow('a2', 'row-a2', 'sl-a2', 986)
    const adapter = new FakeVenue()
    venue(adapter, 'long', 986)
    adapter.cancelFails['sl-a1'] = 'Failed to cancel order: order_not_found'
    adapter.statusOf['sl-a1'] = 'fired'
    await (build(adapter) as any).handleSignalInner(update('row-a1', 2440, 1))

    expect(adapter.stops()).toEqual([])
    expect(db.getServerExitState('row-a1')).toMatchObject({ sl_order_id: 'sl-a1', last_exit_seq: 0 })
    expect(logs).toContain('error:Exit stop amend: old stop filled, no new stop for this lineage')
  })

  it('drop on a plain account (venue still holds the lineage): a fresh reduce-only stop goes up', async () => {
    seedSub()
    seedRow('a1', 'row-a1', 'sl-a1', 986)
    seedRow('a2', 'row-a2', 'sl-a2', 986)
    const adapter = new FakeVenue()
    venue(adapter, 'long', 1972)
    adapter.cancelFails['sl-a1'] = 'Failed to cancel order: order_not_found'
    adapter.statusOf['sl-a1'] = 'fired'
    await (build(adapter) as any).handleSignalInner(update('row-a1', 2440, 1))

    expect(adapter.stops().map((o) => [o.side, o.quantity, o.stopPrice, o.reduceOnly])).toEqual([['sell', 986, 2440, true]])
    expect(db.getServerExitState('row-a1')).toMatchObject({ sl_order_id: 'ETH-SLTS-new-1', last_exit_seq: 1 })
  })

  it("drop on 'eth' (venue -10.384, the book explains it): a plain stop of 986 replaces it", async () => {
    seedFlEth()
    const adapter = new FakeVenue()
    venue(adapter, 'short', 10384)
    adapter.cancelFails[B16_STOP] = 'Failed to cancel order: order_not_found'
    adapter.statusOf[B16_STOP] = 'fired'
    await (build(adapter) as any).handleSignalInner(update('row-16', 2448.24, 2))

    expect(adapter.stops().map((o) => [o.side, o.quantity, o.stopPrice, o.reduceOnly])).toEqual([['sell', 986, 2448.24, false]])
    expect(adapter.cancelled).toEqual([])
    expect(db.getServerExitState('row-16')).toMatchObject({ sl_order_id: 'ETH-SLTS-new-1', last_exit_seq: 2 })
  })
})

// Review round 2: a "dropped" verdict frees the slot for a second stop, so it
// may only come from fresh venue reads taken after the status read, and must
// hold twice. Positions here change per read to stage the races.
class SweepVenue {
  name = 'deribit'
  statusOf: Record<string, string> = {}
  fills: Record<string, { qty: number; price: number }> = {}
  reads = 0
  constructor(private netAt: (read: number) => number | null) {}
  async getPositions(): Promise<Position[]> {
    this.reads += 1
    const net = this.netAt(this.reads)
    return net == null || net === 0 ? [] : ethVenue(net)
  }
  async getOrderStatus(id: string) {
    const st = this.statusOf[id] ?? 'working'
    if (st === 'fired') return { orderId: id, state: 'unknown' as const, absenceConfirmed: false, triggered: true }
    if (st === 'filled') return { orderId: id, state: 'filled' as const, filledQuantity: this.fills[id].qty, averagePrice: this.fills[id].price }
    return { orderId: id, state: st as any }
  }
  async getOrderFills() {
    return { filledQuantity: 0 }
  }
}

describe('fired verdict races (fresh reads, dropped confirmed twice)', () => {
  it('sweep: the fill lands between the two reads, so it is unresolved and the slot stays', async () => {
    seedFlEth()
    const v = new SweepVenue((read) => (read === 1 ? -10384 : -11370))
    v.statusOf[B16_STOP] = 'fired'
    const { deps, pushed } = sweepDeps(v)
    await sweepVenueExitOrders(deps, 'deribit')

    expect(v.reads).toBe(2)
    expect(db.getServerExitState('row-16')).toMatchObject({ active: 1, sl_order_id: B16_STOP })
    expect(pushed.map((p) => p.title)).toEqual(['Stop fired, fill not readable yet'])
  })

  it('sweep: a sibling booked earlier in the same sweep; the later fired stop reads the venue fresh', async () => {
    seedSub()
    seedSynthetic()
    // Candidate order = insertion order: b30, b20, b16.
    seedRow('b30', 'row-30', 'ETH-SLTS-30')
    seedRow('b20', 'row-20', B20_STOP)
    seedRow('b16', 'row-16', B16_STOP)
    // b20 filled before the sweep (readable); b16 fills while the sweep runs.
    const v = new SweepVenue((read) => (read === 1 ? -10384 : -11370))
    v.statusOf['ETH-SLTS-30'] = 'fired'
    v.statusOf[B20_STOP] = 'filled'
    v.fills[B20_STOP] = { qty: 986, price: 2375 }
    v.statusOf[B16_STOP] = 'fired'
    const { deps } = sweepDeps(v)
    expect(await sweepVenueExitOrders(deps, 'deribit')).toBe(1)

    expect(db.getSignalExecution('b20')).toMatchObject({ status: 'closed' })
    // A read cached at b30 would say -10.384 = the book after b20, "dropped".
    expect(db.getServerExitState('row-16')).toMatchObject({ active: 1, sl_order_id: B16_STOP })
    expect(logs).not.toContain('error:Venue exit sweep: tracked stop is gone at the venue, lineage unprotected')
  })

  it('trail update (placeFirst): the fill lands after the order lookup, the new plain stop is withdrawn', async () => {
    seedFlEth()
    const adapter = new FakeVenue()
    let reads = 0
    adapter.getPositions = async () => {
      reads += 1
      return ethVenue(reads <= 2 ? -10384 : -11370)
    }
    adapter.cancelFails[B16_STOP] = 'Failed to cancel order: order_not_found'
    adapter.statusOf[B16_STOP] = 'fired'
    await (build(adapter) as any).handleSignalInner(update('row-16', 2438, 2))

    expect(reads).toBe(3)
    expect(adapter.stops()).toHaveLength(1)
    expect(adapter.cancelled).toEqual(['ETH-SLTS-new-1'])
    expect(db.getServerExitState('row-16')).toMatchObject({ sl_order_id: B16_STOP, last_exit_seq: 0 })
  })
})

describe('every sweep candidate kind gets an outcome when its stop is gone', () => {
  function seedBracketOnly(id: string, slOrderId: string, tpOrderIds: string[] = []) {
    db.recordSignal({ id, strategyId: 'strat-fl', symbol: SYMBOL, action: 'buy', quantity: 8, metadata: { exchange: 'deribit', signalBotId: BOT } })
    db.updateSignalStatus(id, 'executed')
    db.updateSignalOrderIds(id, slOrderId)
    db.insertSignalExecution({ signalId: id, symbol: SYMBOL, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 986, accountId: ACCOUNT })
    db.upsertBracketPair({ signalId: id, exchange: 'deribit', accountId: ACCOUNT, slOrderId, tpOrderIds })
  }

  it('bracket-only stop, fired and dropped (confirmed twice): the bracket slot frees up and a push goes out', async () => {
    seedSub()
    seedSynthetic()
    seedBracketOnly('k1', 'sl-k1')
    const v = new SweepVenue(() => -11370)
    v.statusOf['sl-k1'] = 'fired'
    const { deps, pushed } = sweepDeps(v)
    await sweepVenueExitOrders(deps, 'deribit')

    expect(v.reads).toBe(2)
    expect(db.getBracketPair('k1')!.sl_order_id).toBeNull()
    expect(pushed.map((p) => p.title)).toEqual(['Stop gone at the venue'])
  })

  it('bracket-only stop, fired and unresolved: pushed, then escalated', async () => {
    seedSub()
    seedSynthetic()
    seedBracketOnly('k1', 'sl-k1')
    const v = new SweepVenue(() => -11000)
    v.statusOf['sl-k1'] = 'fired'
    const { deps, pushed } = sweepDeps(v)
    const t0 = Date.now()
    try {
      setSystemTime(new Date(t0))
      await sweepVenueExitOrders(deps, 'deribit')
      setSystemTime(new Date(t0 + FIRED_ESCALATE_MS + 1))
      await sweepVenueExitOrders(deps, 'deribit')
    } finally {
      setSystemTime()
    }
    expect(db.getBracketPair('k1')!.sl_order_id).toBe('sl-k1')
    expect(pushed.map((p) => p.title)).toEqual(['Stop fired, fill not readable yet', 'Stop outcome unresolved'])
  })

  it('trail stop cancelled at the venue: the trail slot frees up and a push goes out', async () => {
    seedSub()
    db.recordSignal({ id: 't1', strategyId: 'strat-fl', symbol: SYMBOL, action: 'buy', quantity: 8, metadata: { exchange: 'deribit', signalBotId: BOT } })
    db.insertSignalExecution({ signalId: 't1', symbol: SYMBOL, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 986, accountId: ACCOUNT })
    db.upsertLocalTrailState({ signalId: 't1', exchange: 'deribit', symbol: SYMBOL, direction: 'long', entryPrice: 2400, slOrderId: 'tr-1', trailPercentage: 2, extremePrice: 2400, currentStop: 2300 })
    const v = new SweepVenue(() => 986)
    v.statusOf['tr-1'] = 'cancelled'
    const { deps, pushed } = sweepDeps(v)
    await sweepVenueExitOrders(deps, 'deribit')

    expect(db.getLocalTrail('t1')!.sl_order_id).toBeNull()
    expect(pushed.map((p) => p.title)).toEqual(['Stop gone at the venue'])
  })

  it('take-profit cancelled at the venue: pushed, not silently polled', async () => {
    seedSub()
    seedBracketOnly('k2', 'sl-k2', ['tp-k2'])
    const v = new SweepVenue(() => 986)
    v.statusOf['tp-k2'] = 'cancelled'
    const { deps, pushed } = sweepDeps(v)
    await sweepVenueExitOrders(deps, 'deribit')

    expect(pushed.map((p) => p.title)).toEqual(['Take-profit gone at the venue'])
    expect(db.getBracketPair('k2')!.sl_order_id).toBe('sl-k2')
  })
})

describe('review round 3', () => {
  it('trail update: old stop not found and its status inconclusive, so the new plain stop is withdrawn and pushed', async () => {
    seedFlEth()
    const adapter = new FakeVenue()
    venue(adapter, 'short', 10384)
    adapter.cancelFails[B16_STOP] = 'Failed to cancel order: order_not_found'
    adapter.statusOf[B16_STOP] = 'inconclusive'
    await (build(adapter) as any).handleSignalInner(update('row-16', 2448.24, 2))

    expect(adapter.stops()).toHaveLength(1)
    expect(adapter.cancelled).toEqual(['ETH-SLTS-new-1'])
    expect(db.getServerExitState('row-16')).toMatchObject({ sl_order_id: B16_STOP, last_exit_seq: 0 })
    expect(pushes).toContain('Stop possibly missing')
  })

  it('reduce-only path: an inconclusive status after not_found places nothing', async () => {
    seedSub()
    seedRow('a1', 'row-a1', 'sl-a1', 986)
    seedRow('a2', 'row-a2', 'sl-a2', 986)
    const adapter = new FakeVenue()
    venue(adapter, 'long', 1972)
    adapter.cancelFails['sl-a1'] = 'Failed to cancel order: order_not_found'
    adapter.statusOf['sl-a1'] = 'inconclusive'
    await (build(adapter) as any).handleSignalInner(update('row-a1', 2440, 1))

    expect(adapter.stops()).toEqual([])
    expect(db.getServerExitState('row-a1')).toMatchObject({ sl_order_id: 'sl-a1', last_exit_seq: 0 })
  })

  it("a timed-out close of the lineage (settled under the CLOSE signal's id) blocks its stop update", async () => {
    seedFlEth()
    db.insertOrderSettlement({ signalId: 'close-16', exchange: 'deribit', accountId: ACCOUNT, symbol: SYMBOL, kind: 'exit', side: 'sell', qty: 986, orderId: 'ETH-1', status: 'unknown' })
    const adapter = new FakeVenue()
    venue(adapter, 'short', 10384)
    await (build(adapter) as any).handleSignalInner(update('row-16', 2448.24, 2))

    expect(adapter.placed).toEqual([])
    expect(adapter.cancelled).toEqual([])
    expect(db.getServerExitState('row-16')).toMatchObject({ sl_order_id: B16_STOP, last_exit_seq: 0 })
  })

  it('an unresolved exit on another connection (acct1/eth) does not block it', async () => {
    seedFlEth()
    db.insertOrderSettlement({ signalId: 'close-x', exchange: 'deribit', accountId: 'acct1/eth', symbol: SYMBOL, kind: 'exit', side: 'sell', qty: 601, orderId: 'ETH-2', status: 'unknown' })
    const adapter = new FakeVenue()
    venue(adapter, 'short', 10384)
    await (build(adapter) as any).handleSignalInner(update('row-16', 2448.24, 2))

    expect(adapter.stops()).toHaveLength(1)
  })

  it('a stop id shared by a trail row and a bracket pair: both slots free up, one push', async () => {
    seedSub()
    db.recordSignal({ id: 'sh', strategyId: 'strat-fl', symbol: SYMBOL, action: 'buy', quantity: 8, metadata: { exchange: 'deribit', signalBotId: BOT } })
    db.updateSignalStatus('sh', 'executed')
    db.insertSignalExecution({ signalId: 'sh', symbol: SYMBOL, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 986, accountId: ACCOUNT })
    db.upsertBracketPair({ signalId: 'sh', exchange: 'deribit', accountId: ACCOUNT, slOrderId: 'sh-1', tpOrderIds: [] })
    db.upsertLocalTrailState({ signalId: 'sh', exchange: 'deribit', symbol: SYMBOL, direction: 'long', entryPrice: 2400, slOrderId: 'sh-1', trailPercentage: 2, extremePrice: 2400, currentStop: 2300 })
    const v = new SweepVenue(() => 986)
    v.statusOf['sh-1'] = 'cancelled'
    const { deps, pushed } = sweepDeps(v)
    await sweepVenueExitOrders(deps, 'deribit')
    await sweepVenueExitOrders(deps, 'deribit')

    expect(db.getLocalTrail('sh')!.sl_order_id).toBeNull()
    expect(db.getBracketPair('sh')!.sl_order_id).toBeNull()
    expect(pushed.map((p) => p.title)).toEqual(['Stop gone at the venue'])
  })
})

describe('review round 4: held stop updates are visible', () => {
  it('an unresolved exit on the account pushes at once and escalates once it is old', async () => {
    seedFlEth()
    const adapter = new FakeVenue()
    venue(adapter, 'short', 10384)
    const t0 = Date.now()
    try {
      setSystemTime(new Date(t0))
      db.insertOrderSettlement({ signalId: 'hedge:x:close', exchange: 'deribit', accountId: ACCOUNT, symbol: SYMBOL, kind: 'exit', side: 'buy', qty: 100, orderId: 'ETH-77', status: 'unknown' })
      const client = build(adapter) as any
      await client.handleSignalInner(update('row-16', 2448.24, 2))
      expect(pushes.filter((t) => t.startsWith('Stop'))).toEqual(['Stop update held'])
      setSystemTime(new Date(t0 + EXIT_WAIT_ESCALATE_MS + 60_000))
      await client.handleSignalInner(update('row-16', 2448.5, 3))
      expect(pushes.filter((t) => t.startsWith('Stop'))).toEqual(['Stop update held', 'Stop updates frozen'])
    } finally {
      setSystemTime()
    }
    expect(adapter.placed).toEqual([])
  })

  it('a lineage without an account is held only by its own exits', async () => {
    seedSub()
    db.recordSignal({
      id: 'na', strategyId: 'strat-fl', symbol: SYMBOL, action: 'buy', quantity: 8,
      metadata: { exchange: 'deribit', signalBotId: BOT, positionId: 'row-na', exitAuthority: 'server' },
    })
    db.updateSignalStatus('na', 'executed')
    db.updateSignalOrderIds('na', 'sl-na')
    db.insertSignalExecution({ signalId: 'na', symbol: SYMBOL, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 986 })
    db.upsertServerExitState({ positionId: 'row-na', entrySignalId: 'na', exchange: 'deribit', symbol: SYMBOL, direction: 'long', currentStop: 2300, slOrderId: 'sl-na' })
    db.insertOrderSettlement({ signalId: 'other-close', exchange: 'deribit', accountId: 'acct1/eth', symbol: SYMBOL, kind: 'exit', side: 'sell', qty: 601, orderId: 'ETH-88', status: 'unknown' })
    const adapter = new FakeVenue()
    venue(adapter, 'long', 986)
    adapter.positions[0].accountId = undefined as any
    await (build(adapter) as any).handleSignalInner(update('row-na', 2400, 1))

    expect(adapter.stops()).toHaveLength(1)
    expect(pushes).not.toContain('Stop update held')
  })
})
