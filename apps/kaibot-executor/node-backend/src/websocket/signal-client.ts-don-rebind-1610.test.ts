// 16/10/2026, two false "stop gone" verdicts on live lineages.
//  - 21:00 UTC, TradeStation 21084931 (MESZ26, lineage aa9b457d): GTC stop
//    1324503597 went to status DON ("Queued") at the session close. DON was
//    read as cancelled: the sweep logged "tracked stop is gone at the venue,
//    lineage unprotected" and emptied the slot while the stop still rested. On
//    a server row the next update then puts a second plain stop next to it
//    (TradeStation has no reduce-only).
//  - 17:31 UTC, Bybit ZEREBRO: a stop replace (resize after add / amend)
//    moved the exit state to the new stop but left bracket_pairs on the old,
//    cancelled one; the sweep polled it and raised a false "unprotected".
// Real SQLite, real sweep, a fake venue that answers with raw TradeStation rows
// through the real status mapping.

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { SignalWebSocketClient } from './signal-client.js'
import { PENDING_ESCALATE_MS, resetVenueExitSweepAlerts, sweepVenueExitOrders } from '../services/venue-exit-sweep.js'
import { firedConfirm, replaceServerExitStop } from '../services/server-exit-stop.js'
import { pendingStopMarker } from '../services/pending-stop.js'
import {
  fetchTradeStationWorkingOrders,
  mapTradeStationOrderStatus,
} from '../services/exchanges/adapters/tradestation-orders.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, OrderStatus, Position } from '../services/exchanges/types.js'

const ENTRY = 'aa9b457d-e8a6-4b3a-939f-329dd365b887'
const ACCOUNT = '21084931'
const SYMBOL = 'MESZ26'
const MES_STOP = '1324503597'
const BOT = 'bot-mes'

let dir: string
let db: KaiBotDatabase
let logs: string[]
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-ts-don-1610-'))
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

// Raw TradeStation order row as GET /orders returns it.
function tsOrder(id: string, status: string, o: Partial<{ side: 'Buy' | 'Sell'; type: string; stop: number; qty: number; symbol: string; account: string; filled: number }> = {}) {
  return {
    OrderID: id,
    AccountID: o.account ?? ACCOUNT,
    Status: status,
    StatusDescription: status === 'DON' ? 'Queued' : status,
    OrderType: o.type ?? 'StopMarket',
    Duration: 'GTC',
    StopPrice: o.stop != null ? String(o.stop) : undefined,
    FilledPrice: '0',
    Legs: [
      {
        Symbol: o.symbol ?? SYMBOL,
        BuyOrSell: o.side ?? 'Sell',
        QuantityOrdered: String(o.qty ?? 1),
        ExecQuantity: String(o.filled ?? 0),
      },
    ],
  }
}

class FakeTradeStation {
  name = 'tradestation'
  orders = new Map<string, any>()
  positions: Position[] = []
  placed: Order[] = []
  cancelled: string[] = []
  statusCalls: string[] = []
  workingReadFails = false
  async getPositions() {
    return this.positions
  }
  async getBalances() {
    return []
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    const id = `ts-new-${this.placed.length}`
    const status = o.orderType === 'market' ? 'DON' : 'ACK'
    this.orders.set(id, tsOrder(id, status, { side: o.side === 'sell' ? 'Sell' : 'Buy', type: o.orderType === 'stop' ? 'StopMarket' : 'Market', stop: o.stopPrice, qty: o.quantity, symbol: o.symbol, account: o.accountId }))
    return { orderId: id, status: 'pending', filledQuantity: 0 }
  }
  async cancelOrder(id: string) {
    this.cancelled.push(id)
    const o = this.orders.get(id)
    if (o) o.Status = 'CAN'
  }
  async getOrderStatus(id: string): Promise<OrderStatus> {
    this.statusCalls.push(id)
    const o = this.orders.get(id)
    if (!o) return { orderId: id, state: 'unknown', absenceConfirmed: true }
    return mapTradeStationOrderStatus(id, o)
  }
  async getWorkingOrders(ctx: { accountId: string; symbol?: string }) {
    if (this.workingReadFails) throw new Error('TradeStation 503')
    return fetchTradeStationWorkingOrders(async () => ({ Orders: [...this.orders.values()] }), ctx.accountId, ctx.symbol)
  }
  stops() {
    return this.placed.filter((o) => o.orderType === 'stop')
  }
}

function mesLong(adapter: FakeTradeStation, size = 1, mark = 5900) {
  adapter.positions = [{ id: `tradestation:${SYMBOL}`, accountId: ACCOUNT, symbol: SYMBOL, side: 'long', size, entryPrice: 5850, markPrice: mark }]
}

let pushes: Array<{ title: string; body: string }> = []
function build(adapter: unknown, exchange = 'tradestation') {
  pushes = []
  const manager = {
    async getSession(_u: string, exchangeName: string) {
      if (exchangeName !== exchange) return undefined
      return { adapter, status: 'connected', userId: 'default', exchangeName, connectionId: `default:${exchange}` }
    },
  }
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  ;(client as any).notifications = { publish: (e: { title: string; body: string }) => pushes.push(e) }
  ;(client as any).apiUrl = 'http://api.test'
  ;(client as any).apiKey = 'key'
  client.setSettleOptions(2, 0)
  return client
}

const sweep = (client: SignalWebSocketClient, exchange = 'tradestation') =>
  sweepVenueExitOrders((client as any).venueExitSweepDeps(), exchange)

// The MES lineage as it stood on 16/10 before 21:00.
function seedMes(opts: { serverRow?: boolean; stopLoss?: number; slOrderId?: string } = {}) {
  const sl = opts.slOrderId ?? MES_STOP
  db.upsertSubscription({ id: 'sub-mes', signalBotId: BOT, selectedMarkets: [], factor: 1, status: 'active', exchange: 'tradestation', accountId: ACCOUNT })
  db.recordSignal({
    id: ENTRY, strategyId: 'strat-mes', symbol: SYMBOL, action: 'buy', quantity: 1, stopLoss: opts.stopLoss ?? 5800,
    metadata: { exchange: 'tradestation', signalBotId: BOT, ...(opts.serverRow ? { positionId: 'row-mes', exitAuthority: 'server' } : {}) },
  })
  db.updateSignalStatus(ENTRY, 'executed')
  db.updateSignalOrderIds(ENTRY, sl)
  db.insertSignalExecution({ signalId: ENTRY, symbol: SYMBOL, exchange: 'tradestation', direction: 'long', status: 'open', qtyOpened: 1, accountId: ACCOUNT })
  db.upsertBracketPair({ signalId: ENTRY, exchange: 'tradestation', accountId: ACCOUNT, slOrderId: sl })
  if (opts.serverRow) {
    db.upsertServerExitState({ positionId: 'row-mes', entrySignalId: ENTRY, exchange: 'tradestation', symbol: SYMBOL, direction: 'long', currentStop: 5800, slOrderId: sl })
  }
}

const update = (positionId: string, stop: number, exitSeq: number): Signal =>
  ({
    id: `upd-${positionId}-${exitSeq}`,
    strategy_id: 'strat-mes',
    symbol: SYMBOL,
    action: 'update',
    quantity: 0,
    price: stop,
    metadata: { exchange: 'tradestation', signalBotId: BOT, positionId, exitSeq },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  }) as unknown as Signal

describe('bug 1: a queued (DON) TradeStation order is live', () => {
  it('21:00 replay: the queued GTC stop stays tracked, the sweep drops nothing and places nothing', async () => {
    seedMes()
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'DON', { stop: 5800 }))
    const client = build(adapter)

    expect(await sweep(client)).toBe(0)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBe(MES_STOP)
    expect(logs).not.toContain('error:Venue exit sweep: tracked stop is gone at the venue, lineage unprotected')
    expect(pushes).toEqual([])
    expect(adapter.placed).toEqual([])
    expect(adapter.cancelled).toEqual([])
  })

  it('server row: the queued stop keeps its slot, so the next update amends it instead of adding a second stop', async () => {
    seedMes({ serverRow: true })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'DON', { stop: 5800 }))
    const client = build(adapter)

    await sweep(client)
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe(MES_STOP)

    await (client as any).handleSignalInner(update('row-mes', 5820, 1))
    // The queued stop is cancelled before its replacement goes up: never two.
    expect(adapter.cancelled).toEqual([MES_STOP])
    expect(adapter.stops()).toHaveLength(1)
    const newId = db.getServerExitState('row-mes')!.sl_order_id
    expect(newId).toBe('ts-new-1')
    // The amend moved the bracket along (bug 2).
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBe('ts-new-1')
  })

  it('a queued close is left resting and never re-sent; it books once it fills at reopen', async () => {
    seedMes()
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'DON', { stop: 5800 }))
    ;(adapter as any).getMarketStatus = async () => new Map([[SYMBOL, { symbol: SYMBOL, last: 5900, tradeTimeMs: Date.now() }]])
    const client = build(adapter)
    const closeSignal = { id: 'close-1', symbol: SYMBOL, metadata: {} } as unknown as Signal

    const placed = await adapter.placeOrder({ accountId: ACCOUNT, symbol: SYMBOL, side: 'sell', orderType: 'market', quantity: 1, reduceOnly: true })
    const settled = await (client as any).settleClose(adapter, placed, closeSignal, SYMBOL, 'tradestation', ACCOUNT, 'sell', 1)
    expect(settled.outcome).toBe('unknown')
    // Not cancelled by settlement hygiene: it still closes at the open.
    expect(adapter.cancelled).toEqual([])
    expect(db.listUnresolvedSettlements('tradestation').map((r) => r.order_id)).toEqual([placed.orderId])
    expect(pushes.map((p) => p.title)).toEqual(['Close queued at the venue'])

    db.updateSignalExecution(ENTRY, { status: 'closing' })
    await client.retryPendingCloses('tradestation')
    expect(adapter.placed.filter((o) => o.orderType === 'market')).toHaveLength(1)

    // Reopen: the queued close fills.
    adapter.orders.get(placed.orderId).Status = 'FLL'
    adapter.orders.get(placed.orderId).FilledPrice = '5890'
    adapter.orders.get(placed.orderId).Legs[0].ExecQuantity = '1'
    await client.resolveUnknownOrders('tradestation')
    expect(db.listUnresolvedSettlements('tradestation')).toEqual([])
    expect(adapter.placed.filter((o) => o.orderType === 'market')).toHaveLength(1)
  })
})

describe('bug 2: a stop replace rebinds bracket_pairs', () => {
  function seedBybitRow(sl = 'sl-seed') {
    db.recordSignal({ id: 'zb-1', strategyId: 's', symbol: 'ZEREBROUSDT', action: 'buy', quantity: 1, metadata: { exchange: 'bybit', positionId: 'row-zb', exitAuthority: 'server' } })
    db.updateSignalStatus('zb-1', 'executed')
    db.updateSignalOrderIds('zb-1', sl)
    db.insertSignalExecution({ signalId: 'zb-1', symbol: 'ZEREBROUSDT', exchange: 'bybit', direction: 'long', status: 'open', qtyOpened: 1000, accountId: 'acct' })
    db.upsertBracketPair({ signalId: 'zb-1', exchange: 'bybit', accountId: 'acct', slOrderId: sl })
    db.upsertServerExitState({ positionId: 'row-zb', entrySignalId: 'zb-1', exchange: 'bybit', symbol: 'ZEREBROUSDT', direction: 'long', currentStop: 0.02, slOrderId: sl })
  }
  function bybitVenue(size: number) {
    const statusOf: Record<string, OrderStatus['state']> = {}
    const placed: Order[] = []
    const cancelled: string[] = []
    const adapter = {
      name: 'bybit',
      getPositions: async () => [{ id: 'bybit:ZEREBROUSDT', accountId: 'acct', symbol: 'ZEREBROUSDT', side: 'long', size, entryPrice: 0.025, markPrice: 0.026 }] as Position[],
      getBalances: async () => [],
      placeOrder: async (o: Order) => {
        placed.push(o)
        const id = `sl-new-${placed.length}`
        statusOf[id] = 'working'
        return { orderId: id, status: 'pending' as const }
      },
      cancelOrder: async (id: string) => {
        cancelled.push(id)
        statusOf[id] = 'cancelled'
      },
      getOrderStatus: async (id: string): Promise<OrderStatus> => ({ orderId: id, state: statusOf[id] ?? 'working' }),
    }
    return { adapter, placed, cancelled, statusOf }
  }

  it('resize after add: bracket follows the new stop, no false "unprotected" on the next sweep', async () => {
    seedBybitRow()
    db.insertSignalExecution({ signalId: 'zb-add', symbol: 'ZEREBROUSDT', exchange: 'bybit', direction: 'long', status: 'open', qtyOpened: 1000, accountId: 'acct' })
    const v = bybitVenue(2000)
    const client = build(v.adapter, 'bybit')
    const add = { id: 'zb-add', action: 'buy', symbol: 'ZEREBROUSDT', metadata: { add: true, resizeStop: true, positionId: 'row-zb' } }

    await (client as any).resizeServerExitStopAfterAdd(add, { adapter: v.adapter }, 'bybit', 'acct')
    expect(db.getServerExitState('row-zb')!.sl_order_id).toBe('sl-new-1')
    expect(db.getBracketPair('zb-1')!.sl_order_id).toBe('sl-new-1')
    expect(v.cancelled).toEqual(['sl-seed'])

    await sweep(client, 'bybit')
    expect(logs).not.toContain('error:Venue exit sweep: tracked stop is gone at the venue, lineage unprotected')
    expect(pushes.map((p) => p.title)).not.toContain('Stop gone at the venue')
    expect(db.getServerExitState('row-zb')!.sl_order_id).toBe('sl-new-1')
  })

  it('amend: bracket follows the new stop, and the OCO map cancels the live stop on a TP fill', async () => {
    seedBybitRow()
    db.upsertBracketPair({ signalId: 'zb-1', exchange: 'bybit', accountId: 'acct', slOrderId: 'sl-seed', tpOrderIds: ['tp-1'] })
    const v = bybitVenue(1000)
    const client = build(v.adapter, 'bybit')
    client.loadPersistedBrackets()

    const state = db.getServerExitState('row-zb')!
    const live = (await v.adapter.getPositions())[0]
    await replaceServerExitStop({ db, adapter: v.adapter as any, state, live, lineageAccount: 'acct', stopPrice: 0.022, exitSeq: 1, label: 'amend' })
    expect(db.getBracketPair('zb-1')!.sl_order_id).toBe('sl-new-1')

    await sweep(client, 'bybit')
    expect(pushes.map((p) => p.title)).not.toContain('Stop gone at the venue')

    await client.onExchangeOrderUpdate({ orderId: 'tp-1', state: 'filled', exchangeName: 'bybit' })
    expect(v.cancelled).toEqual(['sl-seed', 'sl-new-1'])
  })

  it('a dead bracket stop next to a server row on a new id is dropped quietly and follows the server stop', async () => {
    seedBybitRow()
    db.applyServerExitUpdate('row-zb', { exitSeq: 1, currentStop: 0.022, slOrderId: 'sl-new-9' })
    const v = bybitVenue(1000)
    v.statusOf['sl-seed'] = 'cancelled'
    const client = build(v.adapter, 'bybit')

    await sweep(client, 'bybit')
    expect(logs).not.toContain('error:Venue exit sweep: tracked stop is gone at the venue, lineage unprotected')
    expect(pushes).toEqual([])
    expect(db.getServerExitState('row-zb')!.sl_order_id).toBe('sl-new-9')
    expect(db.getBracketPair('zb-1')!.sl_order_id).toBe('sl-new-9')
    expect(v.placed).toEqual([])
  })

  it('a live bracket stop on another account next to the server row stays polled and tracked', async () => {
    seedBybitRow()
    db.upsertBracketPair({ signalId: 'zb-1', exchange: 'bybit', accountId: 'acct2/acct', slOrderId: 'sl-stray' })
    db.applyServerExitUpdate('row-zb', { exitSeq: 1, currentStop: 0.022, slOrderId: 'sl-new-9' })
    const v = bybitVenue(1000)
    const client = build(v.adapter, 'bybit')
    const polled: string[] = []
    const orig = v.adapter.getOrderStatus
    v.adapter.getOrderStatus = async (id: string) => {
      polled.push(id)
      return orig(id)
    }

    await sweep(client, 'bybit')
    expect(polled).toContain('sl-stray')
    expect(db.getBracketPair('zb-1')!.sl_order_id).toBe('sl-stray')
    expect(pushes).toEqual([])
  })

  it('amend fills an emptied bracket slot of the same entry, so the last TP cancels the stop', async () => {
    seedBybitRow()
    db.upsertBracketPair({ signalId: 'zb-1', exchange: 'bybit', accountId: 'acct', slOrderId: null, tpOrderIds: ['tp-1'] })
    const v = bybitVenue(1000)
    const client = build(v.adapter, 'bybit')
    const state = db.getServerExitState('row-zb')!
    const live = (await v.adapter.getPositions())[0]
    await replaceServerExitStop({ db, adapter: v.adapter as any, state, live, lineageAccount: 'acct', stopPrice: 0.022, exitSeq: 1, label: 'amend' })
    expect(db.getBracketPair('zb-1')!.sl_order_id).toBe('sl-new-1')

    await client.onExchangeOrderUpdate({ orderId: 'tp-1', state: 'filled', exchangeName: 'bybit' })
    expect(v.cancelled).toEqual(['sl-seed', 'sl-new-1'])
  })
})

describe('review 16/10: a failed cancel on TradeStation never leaves two plain stops', () => {
  it('amend: cancel of the old stop fails (504): nothing placed, old stop stays tracked everywhere', async () => {
    seedMes({ serverRow: true })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    adapter.cancelOrder = async () => {
      throw new Error('TradeStation API error: 504')
    }
    const state = db.getServerExitState('row-mes')!
    const live = adapter.positions[0]

    await expect(
      replaceServerExitStop({ db, adapter: adapter as any, state, live, lineageAccount: ACCOUNT, stopPrice: 5820, exitSeq: 1, label: 'amend' }),
    ).rejects.toThrow('could not be cancelled')
    expect(adapter.placed).toEqual([])
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe(MES_STOP)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBe(MES_STOP)
  })

  it('resize after add: cancel-first; the seed stop does not cancel and still works: nothing placed', async () => {
    seedMes({ serverRow: true })
    db.insertSignalExecution({ signalId: 'mes-add', symbol: SYMBOL, exchange: 'tradestation', direction: 'long', status: 'open', qtyOpened: 1, accountId: ACCOUNT })
    const adapter = new FakeTradeStation()
    mesLong(adapter, 2)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    const cancelCalls: string[] = []
    adapter.cancelOrder = async (id: string) => {
      cancelCalls.push(id)
      throw new Error('TradeStation API error: 504')
    }
    const client = build(adapter)
    const add = { id: 'mes-add', action: 'buy', symbol: SYMBOL, metadata: { add: true, resizeStop: true, positionId: 'row-mes' } }

    await (client as any).resizeServerExitStopAfterAdd(add, { adapter }, 'tradestation', ACCOUNT)
    expect(cancelCalls).toEqual([MES_STOP])
    expect(adapter.placed).toEqual([])
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe(MES_STOP)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBe(MES_STOP)
    expect(pushes.map((p) => p.title)).toEqual(['Stop not resized after add'])
  })

  it('resize after add: a 504 cancel that did go through (status CAN) is a cancel: the full stop goes up, never naked', async () => {
    seedMes({ serverRow: true })
    db.insertSignalExecution({ signalId: 'mes-add', symbol: SYMBOL, exchange: 'tradestation', direction: 'long', status: 'open', qtyOpened: 1, accountId: ACCOUNT })
    const adapter = new FakeTradeStation()
    mesLong(adapter, 2)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    adapter.cancelOrder = async (id: string) => {
      adapter.orders.get(id).Status = 'CAN'
      throw new Error('TradeStation API error: 504')
    }
    const client = build(adapter)
    const add = { id: 'mes-add', action: 'buy', symbol: SYMBOL, metadata: { add: true, resizeStop: true, positionId: 'row-mes' } }

    await (client as any).resizeServerExitStopAfterAdd(add, { adapter }, 'tradestation', ACCOUNT)
    expect(adapter.stops()).toHaveLength(1)
    expect(adapter.stops()[0]).toMatchObject({ quantity: 2, stopPrice: 5800 })
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe('ts-new-1')
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBe('ts-new-1')
  })

  it('amend: a 504 cancel that did go through is read back as cancelled and the new stop goes up', async () => {
    seedMes({ serverRow: true })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    adapter.cancelOrder = async (id: string) => {
      adapter.orders.get(id).Status = 'CAN'
      throw new Error('TradeStation API error: 504')
    }
    const state = db.getServerExitState('row-mes')!
    await replaceServerExitStop({ db, adapter: adapter as any, state, live: adapter.positions[0], lineageAccount: ACCOUNT, stopPrice: 5820, exitSeq: 1, label: 'amend' })
    expect(adapter.stops()).toHaveLength(1)
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe('ts-new-1')
  })

  it('amend: the cancel is acked but the old stop had already filled: nothing placed', async () => {
    seedMes({ serverRow: true })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    adapter.cancelOrder = async (id: string) => {
      const o = adapter.orders.get(id)
      o.Status = 'FLL'
      o.Legs[0].ExecQuantity = '1'
    }
    const state = db.getServerExitState('row-mes')!
    await expect(
      replaceServerExitStop({ db, adapter: adapter as any, state, live: adapter.positions[0], lineageAccount: ACCOUNT, stopPrice: 5820, exitSeq: 1, label: 'amend' }),
    ).rejects.toThrow('no new stop')
    expect(adapter.placed).toEqual([])
  })
})

describe('review 16/10 r2: a thrown placement on TradeStation that may have landed', () => {
  function throwAfterLanding(adapter: FakeTradeStation) {
    const realPlace = adapter.placeOrder.bind(adapter)
    adapter.placeOrder = async (o: Order) => {
      await realPlace(o)
      throw new Error('Order POST returned 401 (auth expired); NOT resent')
    }
  }

  it('amend: the stop landed: adopted, and the next update amends it instead of placing a second', async () => {
    seedMes({ serverRow: true })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    throwAfterLanding(adapter)
    const state = db.getServerExitState('row-mes')!
    await replaceServerExitStop({ db, adapter: adapter as any, state, live: adapter.positions[0], lineageAccount: ACCOUNT, stopPrice: 5820, exitSeq: 1, label: 'amend' })
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe('ts-new-1')
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBe('ts-new-1')
    expect(adapter.stops()).toHaveLength(1)
  })

  it('amend: nothing readable yet: the slot is parked, the next update places nothing, the sweep adopts the late stop', async () => {
    seedMes({ serverRow: true })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    let late: any = null
    adapter.placeOrder = async (o: Order) => {
      adapter.placed.push(o)
      late = tsOrder('ts-late', 'ACK', { stop: o.stopPrice, qty: o.quantity })
      throw new Error('TradeStation API error: 504')
    }
    const client = build(adapter)
    const state = db.getServerExitState('row-mes')!
    await expect(
      replaceServerExitStop({ db, adapter: adapter as any, state, live: adapter.positions[0], lineageAccount: ACCOUNT, stopPrice: 5820, exitSeq: 1, label: 'amend' }),
    ).rejects.toThrow('may still appear at the venue')
    expect(db.getServerExitState('row-mes')!.sl_order_id).toMatch(/^pending-stop:/)

    await (client as any).handleSignalInner(update('row-mes', 5830, 2))
    expect(adapter.placed).toHaveLength(1)

    adapter.orders.set('ts-late', late)
    await sweep(client)
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe('ts-late')
    expect(db.getEntryStopRow(ENTRY)!.stop_loss_order_id).toBe('ts-late')
    expect(pushes.map((p) => p.title)).toContain('Stop found and tracked')
    expect(adapter.placed).toHaveLength(1)
  })

  it('amend: the venue shows nothing on the re-read: the slot is freed and the next update places once', async () => {
    seedMes({ serverRow: true })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    const realPlace = adapter.placeOrder.bind(adapter)
    let fail = true
    adapter.placeOrder = async (o: Order) => {
      if (fail) {
        fail = false
        adapter.placed.push(o)
        throw new Error('TradeStation API error: 504')
      }
      return realPlace(o)
    }
    const client = build(adapter)
    const state = db.getServerExitState('row-mes')!
    await replaceServerExitStop({ db, adapter: adapter as any, state, live: adapter.positions[0], lineageAccount: ACCOUNT, stopPrice: 5820, exitSeq: 1, label: 'amend' }).catch(() => {})

    await sweep(client)
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBeNull()
    expect(pushes.map((p) => p.title)).toContain('Stop placement did not land')

    await (client as any).handleSignalInner(update('row-mes', 5830, 2))
    expect(adapter.placed).toHaveLength(2)
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe('ts-new-2')
  })

  it('resize after add: the full-size stop landed despite the throw: adopted', async () => {
    seedMes({ serverRow: true })
    db.insertSignalExecution({ signalId: 'mes-add', symbol: SYMBOL, exchange: 'tradestation', direction: 'long', status: 'open', qtyOpened: 1, accountId: ACCOUNT })
    const adapter = new FakeTradeStation()
    mesLong(adapter, 2)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    throwAfterLanding(adapter)
    const client = build(adapter)
    const add = { id: 'mes-add', action: 'buy', symbol: SYMBOL, metadata: { add: true, resizeStop: true, positionId: 'row-mes' } }

    await (client as any).resizeServerExitStopAfterAdd(add, { adapter }, 'tradestation', ACCOUNT)
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe('ts-new-1')
    expect(adapter.placed).toHaveLength(1)
  })

  it('resize after add: nothing readable: slot parked, push, a second resize places nothing', async () => {
    seedMes({ serverRow: true })
    db.insertSignalExecution({ signalId: 'mes-add', symbol: SYMBOL, exchange: 'tradestation', direction: 'long', status: 'open', qtyOpened: 1, accountId: ACCOUNT })
    const adapter = new FakeTradeStation()
    mesLong(adapter, 2)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    adapter.placeOrder = async (o: Order) => {
      adapter.placed.push(o)
      throw new Error('TradeStation API error: 504')
    }
    const client = build(adapter)
    const add = { id: 'mes-add', action: 'buy', symbol: SYMBOL, metadata: { add: true, resizeStop: true, positionId: 'row-mes' } }

    await (client as any).resizeServerExitStopAfterAdd(add, { adapter }, 'tradestation', ACCOUNT)
    await (client as any).resizeServerExitStopAfterAdd(add, { adapter }, 'tradestation', ACCOUNT)
    expect(adapter.placed).toHaveLength(1)
    expect(db.getServerExitState('row-mes')!.sl_order_id).toMatch(/^pending-stop:/)
    expect(pushes.map((p) => p.title)).toEqual(['Stop placement unresolved'])
  })
})

describe('review 16/10 r2: a stop cancelled after a partial fill', () => {
  it('books the partial, frees the slot, re-places for the rest (TradeStation bracket-only) and stops polling it', async () => {
    seedMes({ slOrderId: 'part-stop' })
    db.updateSignalExecution(ENTRY, { status: 'open' })
    ;(db as any).run?.('UPDATE signal_executions SET qty_opened = 3 WHERE signal_id = ?', [ENTRY])
    const adapter = new FakeTradeStation()
    mesLong(adapter, 2)
    adapter.orders.set('part-stop', { ...tsOrder('part-stop', 'CAN', { stop: 5800, qty: 3, filled: 1 }), FilledPrice: '5800' })
    const client = build(adapter)

    await sweep(client)
    expect(db.getSignalExecution(ENTRY)).toMatchObject({ qty_closed: 1 })
    expect(adapter.stops()).toHaveLength(1)
    expect(adapter.stops()[0]).toMatchObject({ quantity: 2, stopPrice: 5800 })
    expect(pushes.map((p) => p.title)).toEqual(['Stop re-placed'])

    adapter.statusCalls = []
    await sweep(client)
    expect(adapter.statusCalls).not.toContain('part-stop')
    expect(db.getSignalExecution(ENTRY)).toMatchObject({ qty_closed: 1 })
  })
})

describe('item 3: a genuinely gone stop on a bracket-only lineage', () => {
  it('is re-placed once, at the recorded level, only after the venue shows no live stop', async () => {
    seedMes({ slOrderId: 'old-stop' })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('old-stop', tsOrder('old-stop', 'CAN', { stop: 5800 }))
    const client = build(adapter)

    await sweep(client)
    expect(adapter.stops()).toHaveLength(1)
    expect(adapter.stops()[0]).toMatchObject({ accountId: ACCOUNT, symbol: SYMBOL, side: 'sell', quantity: 1, stopPrice: 5800 })
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBe('ts-new-1')
    expect(db.getEntryStopRow(ENTRY)!.stop_loss_order_id).toBe('ts-new-1')
    expect(pushes.map((p) => p.title)).toEqual(['Stop re-placed'])

    await sweep(client)
    await sweep(client)
    expect(adapter.stops()).toHaveLength(1)
  })

  it('TradeStation, venue orders unreadable: nothing placed, pushed, and not retried', async () => {
    seedMes({ slOrderId: 'old-stop' })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('old-stop', tsOrder('old-stop', 'CAN', { stop: 5800 }))
    adapter.workingReadFails = true
    const client = build(adapter)

    await sweep(client)
    expect(adapter.placed).toEqual([])
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBeNull()
    expect(pushes.map((p) => p.title)).toEqual(['Stop gone at the venue'])
    expect(pushes[0].body).toContain('Not re-placed automatically: venue orders read failed')

    adapter.workingReadFails = false
    await sweep(client)
    expect(adapter.placed).toEqual([])
  })

  it('TradeStation, a queued stop of the root still rests: nothing placed', async () => {
    seedMes({ slOrderId: 'old-stop' })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('old-stop', tsOrder('old-stop', 'CAN', { stop: 5800 }))
    adapter.orders.set('stray', tsOrder('stray', 'DON', { stop: 5790 }))
    const client = build(adapter)

    await sweep(client)
    expect(adapter.placed).toEqual([])
    expect(pushes[0].body).toContain('StopMarket stray (DON) still rests on the closing side')
  })
})

describe('item 3: never a stop next to a close in flight', () => {
  it('a queued close on the lineage blocks the re-placement', async () => {
    seedMes({ slOrderId: 'old-stop' })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('old-stop', tsOrder('old-stop', 'CAN', { stop: 5800 }))
    db.insertOrderSettlement({ signalId: 'close-1', exchange: 'tradestation', accountId: ACCOUNT, symbol: SYMBOL, kind: 'exit', side: 'sell', qty: 1, orderId: 'queued-close' })
    const client = build(adapter)

    await sweep(client)
    expect(adapter.placed).toEqual([])
    expect(pushes[0].body).toContain('a close on this account and symbol is still unresolved')
  })
})

describe('item 4: heal of a slot dropped while its stop still rests', () => {
  it('re-attaches the live queued MES stop to the emptied bracket slot without any order action', async () => {
    seedMes()
    db.dropBracketStop(ENTRY, MES_STOP)
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'DON', { stop: 5800 }))
    const client = build(adapter)

    await sweep(client)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBe(MES_STOP)
    expect(adapter.placed).toEqual([])
    expect(adapter.cancelled).toEqual([])
    expect(pushes.map((p) => p.title)).toEqual(['Stop tracked again'])
  })

  it('re-attaches the exit-state slot too, so the next update amends instead of placing a second stop', async () => {
    seedMes({ serverRow: true })
    db.dropBracketStop(ENTRY, MES_STOP)
    db.dropServerExitStopOrder('row-mes', MES_STOP)
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'DON', { stop: 5800 }))
    const client = build(adapter)

    await sweep(client)
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe(MES_STOP)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBe(MES_STOP)
    expect(adapter.placed).toEqual([])
  })

  it('leaves a recorded stop the venue reports cancelled alone and does not look it up again', async () => {
    seedMes({ slOrderId: 'old-stop' })
    db.dropBracketStop(ENTRY, 'old-stop')
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('old-stop', tsOrder('old-stop', 'CAN', { stop: 5800 }))
    const client = build(adapter)

    await sweep(client)
    await sweep(client)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBeNull()
    expect(adapter.statusCalls).toEqual(['old-stop'])
    expect(adapter.placed).toEqual([])
  })
})

describe('review 16/10: re-placement scope and rivals', () => {
  it('a queued close-side market order is a rival: nothing placed', async () => {
    seedMes({ slOrderId: 'old-stop' })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('old-stop', tsOrder('old-stop', 'CAN', { stop: 5800 }))
    adapter.orders.set('mkt', tsOrder('mkt', 'DON', { type: 'Market' }))
    const client = build(adapter)

    await sweep(client)
    expect(adapter.placed).toEqual([])
    expect(pushes[0].body).toContain('Market mkt (DON) still rests on the closing side')
  })

  it("the lineage's own queued take-profit is no rival", async () => {
    seedMes({ slOrderId: 'old-stop' })
    db.upsertBracketPair({ signalId: ENTRY, exchange: 'tradestation', accountId: ACCOUNT, slOrderId: 'old-stop', tpOrderIds: ['tp-own'] })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('old-stop', tsOrder('old-stop', 'CAN', { stop: 5800 }))
    adapter.orders.set('tp-own', tsOrder('tp-own', 'DON', { type: 'Limit' }))
    const client = build(adapter)

    await sweep(client)
    expect(adapter.stops()).toHaveLength(1)
  })

  it('placement throws on TradeStation and the stop did land: it is adopted, never placed twice', async () => {
    seedMes({ slOrderId: 'old-stop' })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('old-stop', tsOrder('old-stop', 'CAN', { stop: 5800 }))
    const realPlace = adapter.placeOrder.bind(adapter)
    adapter.placeOrder = async (o: Order) => {
      await realPlace(o)
      throw new Error('Order POST returned 401 (auth expired); NOT resent')
    }
    const client = build(adapter)

    await sweep(client)
    await sweep(client)
    expect(adapter.placed).toHaveLength(1)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBe('ts-new-1')
    expect(pushes.map((p) => p.title)).toEqual(['Stop re-placed'])
  })

  it('placement throws on TradeStation and nothing shows at the venue: parked, read once more, then freed; never placed twice', async () => {
    seedMes({ slOrderId: 'old-stop' })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('old-stop', tsOrder('old-stop', 'CAN', { stop: 5800 }))
    let attempts = 0
    adapter.placeOrder = async () => {
      attempts++
      throw new Error('TradeStation API error: 503')
    }
    const client = build(adapter)

    await sweep(client)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toMatch(/^pending-stop:/)
    expect(pushes[0].body).toContain('a stop may still appear at the venue, check it')
    await sweep(client)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBeNull()
    expect(pushes.map((p) => p.title)).toContain('Stop placement did not land')
    await sweep(client)
    expect(attempts).toBe(1)
  })

  it('Bybit: a gone bracket-only stop is not re-placed, the old push stands', async () => {
    db.recordSignal({ id: 'bb-1', strategyId: 's', symbol: 'SOLUSDT', action: 'buy', quantity: 1, stopLoss: 120, metadata: { exchange: 'bybit' } })
    db.updateSignalStatus('bb-1', 'executed')
    db.updateSignalOrderIds('bb-1', 'bb-stop')
    db.insertSignalExecution({ signalId: 'bb-1', symbol: 'SOLUSDT', exchange: 'bybit', direction: 'long', status: 'open', qtyOpened: 1, accountId: 'acct' })
    db.upsertBracketPair({ signalId: 'bb-1', exchange: 'bybit', accountId: 'acct', slOrderId: 'bb-stop' })
    const placed: Order[] = []
    const adapter = {
      name: 'bybit',
      getPositions: async () => [{ id: 'bybit:SOLUSDT', accountId: 'acct', symbol: 'SOLUSDT', side: 'long', size: 1, entryPrice: 130, markPrice: 131 }] as Position[],
      getBalances: async () => [],
      placeOrder: async (o: Order) => {
        placed.push(o)
        return { orderId: 'x', status: 'pending' as const }
      },
      cancelOrder: async () => {},
      getOrderStatus: async (id: string): Promise<OrderStatus> => ({ orderId: id, state: 'cancelled' }),
      getOrderFills: async () => ({ filledQuantity: 0 }),
    }
    const client = build(adapter, 'bybit')

    await sweep(client, 'bybit')
    expect(placed).toEqual([])
    expect(pushes.map((p) => p.title)).toEqual(['Stop gone at the venue'])
    expect(pushes[0].body).not.toContain('Not re-placed')
  })
})

describe('review 16/10: heal guards', () => {
  it('refuses a recorded stop another lineage tracks (its bracket slot)', async () => {
    seedMes()
    db.dropBracketStop(ENTRY, MES_STOP)
    db.upsertBracketPair({ signalId: 'other-entry', exchange: 'tradestation', accountId: ACCOUNT, slOrderId: MES_STOP })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'DON', { stop: 5800 }))
    const client = build(adapter)

    await sweep(client)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBeNull()
    expect(logs).toContain('warn:Venue exit sweep: recorded stop is claimed by another lineage, not re-attached')
  })

  it('refuses a recorded stop another entry records as its own (adoption)', async () => {
    seedMes()
    db.dropBracketStop(ENTRY, MES_STOP)
    db.recordSignal({ id: 'adopted-1', strategyId: 'manual', symbol: SYMBOL, action: 'buy', quantity: 1, metadata: {} })
    db.updateSignalOrderIds('adopted-1', MES_STOP)
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'DON', { stop: 5800 }))
    const client = build(adapter)

    await sweep(client)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBeNull()
    expect(adapter.statusCalls).toEqual([])
  })

  it('backs off an inconclusive lookup instead of repeating it every sweep', async () => {
    seedMes()
    db.dropBracketStop(ENTRY, MES_STOP)
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    let lookups = 0
    adapter.getOrderStatus = async (id: string) => {
      lookups++
      return { orderId: id, state: 'unknown', absenceConfirmed: false, triggered: true }
    }
    const client = build(adapter)

    await sweep(client)
    await sweep(client)
    await sweep(client)
    expect(lookups).toBe(1)
  })

  it('a heal that throws never holds up the fill booking', async () => {
    seedMes({ slOrderId: 'old-stop' })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('old-stop', tsOrder('old-stop', 'FLL', { stop: 5800, filled: 1 }))
    adapter.orders.get('old-stop').FilledPrice = '5800'
    ;(db as any).getEntryStopRow = () => {
      throw new Error('db busy')
    }
    db.upsertServerExitState({ positionId: 'row-x', entrySignalId: 'x-entry', exchange: 'tradestation', symbol: SYMBOL, direction: 'long', currentStop: 1, slOrderId: null })
    const client = build(adapter)

    expect(await sweep(client)).toBe(1)
    expect(db.getSignalExecution(ENTRY)).toMatchObject({ status: 'closed' })
    expect(logs).toContain('warn:Venue exit sweep: heal of dropped stops failed')
  })
})

describe('review 16/10: a partial on a queued order that is cancelled later', () => {
  it('maps to a terminal partial and the close books only what executed', async () => {
    seedMes()
    const adapter = new FakeTradeStation()
    mesLong(adapter, 3)
    const client = build(adapter)
    adapter.orders.set('close-q', { ...tsOrder('close-q', 'CAN', { type: 'Market', qty: 3, filled: 1 }), FilledPrice: '5890' })
    const settled = await (client as any).settleClose(adapter, { orderId: 'close-q', status: 'pending' }, { id: 'close-1', symbol: SYMBOL, metadata: {} }, SYMBOL, 'tradestation', ACCOUNT, 'sell', 3)
    expect(settled).toMatchObject({ outcome: 'filled', filledQty: 1, avgPrice: 5890 })
  })
})

describe('review 16/10 r3: pending placements are always settled from the venue', () => {
  const MANUAL = `pos:tradestation:${ACCOUNT}:${SYMBOL}`
  function seedManualTrail(marker: string) {
    db.upsertLocalTrailState({
      signalId: MANUAL, exchange: 'tradestation', symbol: SYMBOL, direction: 'long',
      entryPrice: 5850, slOrderId: marker, trailPercentage: 1, extremePrice: 5900, currentStop: 5841, accountId: ACCOUNT,
    })
  }

  it('manual trail (no execution, no executions on the exchange): the landed stop is adopted, not released', async () => {
    const marker = pendingStopMarker(5841, 1, { accountId: ACCOUNT })
    seedManualTrail(marker)
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('ts-landed', tsOrder('ts-landed', 'ACK', { stop: 5841, qty: 1 }))
    const client = build(adapter)

    await client.sweepRestingExitOrders()
    expect(db.listActiveLocalTrails()[0].sl_order_id).toBe('ts-landed')
    expect(pushes.map((p) => p.title)).toEqual(['Stop found and tracked'])
  })

  it('manual trail whose position is gone: a landed stop is an orphan and is cancelled', async () => {
    const marker = pendingStopMarker(5841, 1, { accountId: ACCOUNT })
    seedManualTrail(marker)
    const adapter = new FakeTradeStation()
    adapter.positions = []
    adapter.orders.set('ts-orphan', tsOrder('ts-orphan', 'ACK', { stop: 5841, qty: 1 }))
    const client = build(adapter)

    await client.sweepRestingExitOrders()
    expect(adapter.cancelled).toEqual(['ts-orphan'])
    expect(db.listActiveLocalTrails()[0].sl_order_id).toBeNull()
    expect(pushes.map((p) => p.title)).toEqual(['Orphan stop cancelled'])
  })

  it('closed lineage with several matching stops: pushed with the candidate ids, nothing cancelled', async () => {
    seedMes({ serverRow: true })
    db.updateSignalExecution(ENTRY, { status: 'closed', qtyClosed: 1 })
    const marker = pendingStopMarker(5820, 1, { accountId: ACCOUNT })
    db.applyServerExitUpdate('row-mes', { exitSeq: 0, currentStop: 5820, slOrderId: marker })
    db.dropBracketStop(ENTRY, MES_STOP)
    const adapter = new FakeTradeStation()
    adapter.orders.set('c1', tsOrder('c1', 'ACK', { stop: 5820 }))
    adapter.orders.set('c2', tsOrder('c2', 'DON', { stop: 5820 }))
    const client = build(adapter)

    await sweep(client)
    expect(adapter.cancelled).toEqual([])
    const push = pushes.find((p) => p.title === 'Stop placement unresolved')!
    expect(push.body).toContain('c1, c2')
  })

  it('the marker account is used when the execution has none, as at placement', async () => {
    seedMes({ serverRow: true })
    ;(db as any).run('UPDATE signal_executions SET account_id = NULL WHERE signal_id = ?', [ENTRY])
    const marker = pendingStopMarker(5820, 1, { accountId: ACCOUNT })
    db.applyServerExitUpdate('row-mes', { exitSeq: 0, currentStop: 5820, slOrderId: marker })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set('ts-late', tsOrder('ts-late', 'ACK', { stop: 5820 }))
    const client = build(adapter)

    await sweep(client)
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe('ts-late')
  })

  it('unreadable for longer than the limit: still parked, pushed once an hour, never silent', async () => {
    seedMes({ serverRow: true })
    const t0 = Date.now()
    const marker = pendingStopMarker(5820, 1, { accountId: ACCOUNT, atMs: t0 })
    db.applyServerExitUpdate('row-mes', { exitSeq: 0, currentStop: 5820, slOrderId: marker })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.workingReadFails = true
    const client = build(adapter)
    try {
      setSystemTime(new Date(t0 + 60_000))
      await sweep(client)
      expect(pushes).toEqual([])
      setSystemTime(new Date(t0 + PENDING_ESCALATE_MS + 1))
      await sweep(client)
      setSystemTime(new Date(t0 + PENDING_ESCALATE_MS + 120_000))
      await sweep(client)
    } finally {
      setSystemTime()
    }
    expect(pushes.map((p) => p.title)).toEqual(['Stop placement still unresolved'])
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe(marker)
    expect(adapter.placed).toEqual([])
  })

  it('a disconnected venue escalates the same way', async () => {
    seedMes({ serverRow: true })
    const marker = pendingStopMarker(5820, 1, { accountId: ACCOUNT, atMs: Date.now() - PENDING_ESCALATE_MS - 1 })
    db.applyServerExitUpdate('row-mes', { exitSeq: 0, currentStop: 5820, slOrderId: marker })
    const client = build(null)

    await sweep(client)
    expect(pushes.map((p) => p.title)).toEqual(['Stop placement still unresolved'])
    expect(pushes[0].body).toContain('the connection is not live')
  })
})

describe('review 16/10 r3: placeFirst on TradeStation after a thrown placement', () => {
  function opposedAmend(adapter: FakeTradeStation) {
    const state = db.getServerExitState('row-mes')!
    return replaceServerExitStop({
      db, adapter: adapter as any, state, live: adapter.positions[0], lineageAccount: ACCOUNT,
      stopPrice: 5820, exitSeq: 1, label: 'amend', quantity: 1, reduceOnly: false, placeFirst: true,
    })
  }

  it('landed: adopted and the old stop retired, one stop rests', async () => {
    seedMes({ serverRow: true })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    const realPlace = adapter.placeOrder.bind(adapter)
    adapter.placeOrder = async (o: Order) => {
      await realPlace(o)
      throw new Error('TradeStation API error: 504')
    }
    await opposedAmend(adapter)
    expect(adapter.cancelled).toEqual([MES_STOP])
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe('ts-new-1')
  })

  it('nothing readable: parked keeping the old stop; a late newcomer is withdrawn and the old stop restored', async () => {
    seedMes({ serverRow: true })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    let late: any = null
    adapter.placeOrder = async (o: Order) => {
      adapter.placed.push(o)
      late = tsOrder('ts-late', 'ACK', { stop: o.stopPrice, qty: o.quantity })
      throw new Error('TradeStation API error: 504')
    }
    const client = build(adapter)
    await expect(opposedAmend(adapter)).rejects.toThrow('may still appear at the venue')
    expect(db.getServerExitState('row-mes')!.sl_order_id).toMatch(/^pending-stop:.*:k=1324503597/)
    expect(db.getBracketPair(ENTRY)!.sl_order_id).toBe(MES_STOP)

    adapter.orders.set('ts-late', late)
    await sweep(client)
    expect(adapter.cancelled).toEqual(['ts-late'])
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe(MES_STOP)
    expect(pushes.map((p) => p.title)).toContain('Stop placement withdrawn')
  })

  it('nothing landed: the old stop is restored, nothing cancelled', async () => {
    seedMes({ serverRow: true })
    const adapter = new FakeTradeStation()
    mesLong(adapter)
    adapter.orders.set(MES_STOP, tsOrder(MES_STOP, 'ACK', { stop: 5800 }))
    adapter.placeOrder = async (o: Order) => {
      adapter.placed.push(o)
      throw new Error('TradeStation API error: 504')
    }
    const client = build(adapter)
    await opposedAmend(adapter).catch(() => {})
    await sweep(client)
    expect(adapter.cancelled).toEqual([])
    expect(db.getServerExitState('row-mes')!.sl_order_id).toBe(MES_STOP)
  })
})
