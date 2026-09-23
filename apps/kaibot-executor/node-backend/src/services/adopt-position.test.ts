// Adopting a manual venue position into the lineage of a refused bot entry:
// what it writes locally (execution, fill, stop, server_exit_state, ack), that
// it never doubles a stop, that a repeat is a no-op, and that the bot's
// close / stop update then take their unchanged paths. Real executor DB, fake
// adapter, fake server.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { SignalWebSocketClient } from '../websocket/signal-client.js'
import { createAdoptPositionService } from './adopt-position.js'
import type { Order, OrderResult, Position } from './exchanges/types.js'
import type { Signal } from '../storage/types.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-adopt-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

class FakeAdapter {
  name = 'deribit'
  placed: Order[] = []
  cancelled: string[] = []
  constructor(public positions: Position[]) {}
  async getPositions(): Promise<Position[]> {
    return this.positions
  }
  async getAccounts() {
    return [{ id: 'deribit:acct1/eth', accountId: 'acct1/eth' }]
  }
  async placeOrder(order: Order): Promise<OrderResult> {
    this.placed.push(order)
    return {
      orderId: `ord-${this.placed.length}`,
      status: order.orderType === 'stop' ? 'pending' : 'filled',
      filledQuantity: order.orderType === 'stop' ? 0 : order.quantity,
      averagePrice: 4480,
    }
  }
  async cancelOrder(orderId: string): Promise<void> {
    this.cancelled.push(orderId)
  }
}

class FakeExchangeManager {
  keys: Array<string | undefined> = []
  constructor(public adapter: FakeAdapter) {}
  async getSession(_user: string, exchangeName: string, key?: string) {
    this.keys.push(key)
    return { adapter: this.adapter, status: 'connected', userId: 'default', exchangeName }
  }
}

// The prod case (22/09): Fault-Line ETH 4h fired a buy the executor refused
// (basis guard); the user opened ETH-PERPETUAL long 981 USD by hand on the
// 'acct1' Deribit connection five days later.
const SIGNAL_ID = 'e347521a-086f-46db-91fd-1776c7fac26e'
const POSITION_ID = '6a876333-8392-488e-935a-a3e5439a314b'
const BOT_ID = 'bot-fault-line-eth-4h'
const META = {
  signalBotId: BOT_ID,
  positionId: POSITION_ID,
  exitAuthority: 'server',
  exchange: 'deribit',
  venueSymbols: { deribit: 'ETH-PERPETUAL', bybit: 'ETHUSDT' },
}
const POS: Position = {
  id: 'p', accountId: 'acct1/eth', symbol: 'ETH-PERPETUAL', side: 'long', size: 981, entryPrice: 4468, markPrice: 4480,
}

function seedRefusedEntry(opts: { status?: string } = {}) {
  db.upsertSubscription({
    id: 'sub-acct1',
    signalBotId: BOT_ID,
    botName: '[ALLOC] Fault-Line ETH 4h · acct1',
    selectedMarkets: [],
    factor: 1,
    status: 'active',
    exchange: 'deribit',
    accountId: 'acct1/eth',
    accountKey: 'acct1',
  })
  db.recordSignal({
    id: SIGNAL_ID,
    strategyId: 'fault-line',
    strategyName: 'Fault-Line',
    symbol: 'ETH',
    action: 'buy',
    quantity: 0.08,
    price: 4500,
    type: 'market',
    stopLoss: 1353.72,
    metadata: META,
  })
  db.updateSignalStatus(
    SIGNAL_ID,
    opts.status ?? 'rejected',
    undefined,
    'basis guard: signal 4500 vs venue 4468 (71 bps > 50)',
  )
}

function service(adapter: FakeAdapter, acks: any[] = [], ackOk = true) {
  const manager = new FakeExchangeManager(adapter)
  const notified: any[] = []
  const svc = createAdoptPositionService(db, manager as any, {
    ackAdoptedEntry: async (signalId, fill, slOrderId) => {
      acks.push({ signalId, fill, slOrderId })
      db.recordSignalAck(signalId, ackOk)
      return { ok: ackOk, positionId: ackOk ? POSITION_ID : null }
    },
    registerBracket: (exchange, signalId, slOrderId, _tps, accountId) =>
      db.upsertBracketPair({ signalId, exchange, accountId: accountId ?? null, slOrderId: slOrderId ?? null }),
    notify: (e) => notified.push(e),
  })
  return { svc, manager, notified }
}

const REQ = { exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', signalId: SIGNAL_ID }

describe('adopt: candidates', () => {
  it('lists the refused entry of an active sub on this (exchange, account, symbol), matching side', async () => {
    seedRefusedEntry()
    const { svc } = service(new FakeAdapter([POS]))
    const list = await svc.candidates({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', side: 'long' })
    expect(list.map((c) => c.signalId)).toEqual([SIGNAL_ID])
    expect(list[0]).toMatchObject({ botId: BOT_ID, action: 'buy', stopLoss: 1353.72, positionId: POSITION_ID, venueSymbol: 'ETH-PERPETUAL' })
    expect(list[0]!.reason).toMatch(/basis guard/)
    // Wrong side, other symbol, other connection: nothing.
    expect(await svc.candidates({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', side: 'short' })).toEqual([])
    expect(await svc.candidates({ exchange: 'deribit', symbol: 'BTC-PERPETUAL', accountId: 'acct1/btc' })).toEqual([])
    expect(await svc.candidates({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'eth' })).toEqual([])
  })
})

describe('adopt: happy path', () => {
  it('writes the lineage a fill would have written, places the signal stop once, acks the server', async () => {
    seedRefusedEntry()
    db.addManualPosition('deribit', 'acct1/eth', 'ETH-PERPETUAL', 'buy', 981)
    const adapter = new FakeAdapter([POS])
    const acks: any[] = []
    const { svc, manager, notified } = service(adapter, acks)

    const res = await svc.adopt(REQ)
    expect(res).toMatchObject({
      signalId: SIGNAL_ID, botId: BOT_ID, accountId: 'acct1/eth', symbol: 'ETH-PERPETUAL', canonicalSymbol: 'ETH',
      direction: 'long', qty: 981, avgPrice: 4468, positionId: POSITION_ID, alreadyAdopted: false,
      stop: { price: 1353.72, slOrderId: 'ord-1', source: 'placed' }, serverAck: { ok: true, positionId: POSITION_ID },
    })
    // The session for the labeled connection.
    expect(manager.keys).toContain('acct1')
    // Exactly one order: the reduce-only stop, never an entry.
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0]).toMatchObject({
      accountId: 'acct1/eth', symbol: 'ETH-PERPETUAL', side: 'sell', orderType: 'stop', quantity: 981, stopPrice: 1353.72, reduceOnly: true,
    })
    // Lineage the close looks up: executed + bot id in metadata, canonical symbol.
    expect(db.getOpenEntrySignals('ETH', BOT_ID).map((e) => e.id)).toEqual([SIGNAL_ID])
    expect(db.getSignalExecution(SIGNAL_ID)).toMatchObject({
      symbol: 'ETH-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qty_opened: 981, qty_closed: 0, account_id: 'acct1/eth',
    })
    expect(db.getSignalFills(SIGNAL_ID)).toHaveLength(1)
    expect(db.getSignalFills(SIGNAL_ID)[0]).toMatchObject({ kind: 'entry', side: 'buy', qty: 981, price: 4468 })
    expect(db.getSignalBracket(SIGNAL_ID)).toMatchObject({ stop_loss_order_id: 'ord-1' })
    expect(db.listBracketPairs().find((p) => p.signal_id === SIGNAL_ID)).toMatchObject({ sl_order_id: 'ord-1', account_id: 'acct1/eth' })
    expect(db.getServerExitState(POSITION_ID)).toMatchObject({
      entry_signal_id: SIGNAL_ID, symbol: 'ETH-PERPETUAL', direction: 'long', current_stop: 1353.72, sl_order_id: 'ord-1', active: 1,
    })
    // The marker moved into the execution; the server got price/time + stop id, never the size.
    expect(db.getManualPosition('deribit', 'acct1/eth', 'ETH-PERPETUAL')).toBeFalsy()
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ signalId: SIGNAL_ID, slOrderId: 'ord-1', fill: { price: 4468 } })
    expect(JSON.stringify(acks[0])).not.toContain('981')
    expect(notified.map((n) => n.type)).toEqual(['position_adopted'])
    const meta = JSON.parse((db.get('SELECT metadata FROM signals WHERE id = ?', [SIGNAL_ID]) as any).metadata)
    expect(meta.signalBotId).toBe(BOT_ID)
    expect(meta.adopted.avgPrice).toBe(4468)
  })

  it('is idempotent per (signal, account): a repeat writes nothing, places nothing, only re-acks a failed ack', async () => {
    seedRefusedEntry()
    const adapter = new FakeAdapter([POS])
    const acks: any[] = []
    const first = service(adapter, acks, false)
    const r1 = await first.svc.adopt(REQ)
    expect(r1.serverAck).toEqual({ ok: false, positionId: null })
    expect(acks).toHaveLength(1)

    const second = service(adapter, acks, true)
    const r2 = await second.svc.adopt(REQ)
    expect(r2.alreadyAdopted).toBe(true)
    expect(r2.stop).toEqual({ price: 1353.72, slOrderId: 'ord-1', source: 'lineage' })
    expect(r2.serverAck).toEqual({ ok: true, positionId: POSITION_ID })
    expect(acks).toHaveLength(2) // the failed ack was retried
    expect(adapter.placed).toHaveLength(1)
    expect(db.getSignalFills(SIGNAL_ID)).toHaveLength(1)
    expect(second.notified).toHaveLength(0)

    const r3 = await second.svc.adopt(REQ)
    expect(r3.alreadyAdopted).toBe(true)
    expect(acks).toHaveLength(2) // acked ok → not sent again

    // Another account never reaches the lineage: the sub's routing refuses first.
    await expect(second.svc.adopt({ ...REQ, accountId: 'eth' })).rejects.toThrow(/routes through the default connection \(subscriptions: acct1\)/)
  })

  it('takes over a resting manual stop instead of placing a second one', async () => {
    seedRefusedEntry()
    // The manual entry's bracket: a resting stop at 4300 recorded under the
    // manual signal id (order_settlements + bracket_pairs), as the manual
    // order path leaves it.
    db.insertOrderSettlement({
      signalId: 'manual:abc', exchange: 'deribit', accountId: 'acct1/eth', symbol: 'ETH-PERPETUAL',
      kind: 'entry', side: 'buy', qty: 981, orderId: 'man-entry', status: 'filled',
    })
    db.upsertBracketPair({ signalId: 'manual:abc', exchange: 'deribit', accountId: 'acct1/eth', slOrderId: 'man-sl' })
    const adapter = new FakeAdapter([POS])
    const { svc } = service(adapter)

    const res = await svc.adopt({ ...REQ, stopPrice: 4300 })
    expect(adapter.placed).toHaveLength(0)
    expect(adapter.cancelled).toHaveLength(0)
    expect(res.stop).toEqual({ price: 4300, slOrderId: 'man-sl', source: 'manual' })
    const pairs = db.listBracketPairs()
    expect(pairs.find((p) => p.signal_id === 'manual:abc')).toBeUndefined()
    expect(pairs.find((p) => p.signal_id === SIGNAL_ID)).toMatchObject({ sl_order_id: 'man-sl' })
    expect(db.getServerExitState(POSITION_ID)).toMatchObject({ sl_order_id: 'man-sl', current_stop: 4300 })
  })

  it('keeps a stop the lineage already holds', async () => {
    seedRefusedEntry()
    db.upsertBracketPair({ signalId: SIGNAL_ID, exchange: 'deribit', accountId: 'acct1/eth', slOrderId: 'sl-old' })
    const adapter = new FakeAdapter([POS])
    const { svc } = service(adapter)
    const res = await svc.adopt(REQ)
    expect(adapter.placed).toHaveLength(0)
    expect(res.stop).toEqual({ price: 1353.72, slOrderId: 'sl-old', source: 'lineage' })
  })

  it('refuses a signal stop the market already crossed unless a stop is passed', async () => {
    seedRefusedEntry()
    db.run('UPDATE signals SET stop_loss = ? WHERE id = ?', [4490, SIGNAL_ID])
    const adapter = new FakeAdapter([POS])
    const { svc } = service(adapter)
    await expect(svc.adopt(REQ)).rejects.toThrow(/already crossed/)
    expect(adapter.placed).toHaveLength(0)
    const res = await svc.adopt({ ...REQ, stopPrice: 4200 })
    expect(res.stop).toMatchObject({ price: 4200, source: 'placed' })
    expect(adapter.placed[0]).toMatchObject({ stopPrice: 4200 })
  })
})

describe('adopt: refusals', () => {
  it('needs a refused entry of an active sub that maps onto this position', async () => {
    const adapter = new FakeAdapter([POS])
    const { svc } = service(adapter)
    await expect(svc.adopt(REQ)).rejects.toThrow(/signal not found/)

    seedRefusedEntry({ status: 'executed' })
    await expect(svc.adopt(REQ)).rejects.toThrow(/already executed/)
    db.updateSignalStatus(SIGNAL_ID, 'rejected')

    await expect(svc.adopt({ ...REQ, symbol: 'BTC-PERPETUAL' })).rejects.toThrow(/is for ETH-PERPETUAL, not BTC-PERPETUAL/)
    await expect(svc.adopt({ ...REQ, exchange: 'bybit' })).rejects.toThrow(/trades on deribit, not bybit/)
    await expect(svc.adopt({ ...REQ, accountId: 'eth' })).rejects.toThrow(/routes through the default connection/)

    // A short venue position cannot take a buy signal.
    const shortAdapter = new FakeAdapter([{ ...POS, side: 'short' }])
    await expect(service(shortAdapter).svc.adopt(REQ)).rejects.toThrow(/position is short, the signal is a long entry/)

    // No position at the venue.
    await expect(service(new FakeAdapter([])).svc.adopt(REQ)).rejects.toThrow(/no open position/)

    // Paused sub.
    db.run("UPDATE executor_subscriptions SET status = 'paused' WHERE id = 'sub-acct1'")
    await expect(svc.adopt(REQ)).rejects.toThrow(/no active subscription/)
    expect(adapter.placed).toHaveLength(0)
    expect(db.getSignalExecution(SIGNAL_ID)).toBeFalsy()
  })

  it('refuses a lineage that already closed', async () => {
    seedRefusedEntry()
    db.insertSignalExecution({ signalId: SIGNAL_ID, symbol: 'ETH-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'closed', qtyOpened: 981, qtyClosed: 981, accountId: 'acct1/eth' })
    const { svc } = service(new FakeAdapter([POS]))
    await expect(svc.adopt(REQ)).rejects.toThrow(/already closed/)
  })
})

// The bot's close for this lineage, as the server wires it (signalBotId +
// positionId, canonical symbol).
function botClose(id: string): Signal {
  return {
    id,
    strategy_id: 'fault-line',
    symbol: 'ETH',
    action: 'close',
    quantity: 1,
    metadata: { exchange: 'deribit', signalBotId: BOT_ID, positionId: POSITION_ID, exitAuthority: 'server', venueSymbols: META.venueSymbols },
    received_at: new Date(),
    status: 'pending',
    created_at: new Date(),
  } as Signal
}

describe('REGRESSION prod 22/09: refused Fault-Line ETH entry, manual long on acct1', () => {
  it('before adoption the bot close is a no-op; after adoption it flattens the acct1 position via the lineage', async () => {
    seedRefusedEntry()
    const adapter = new FakeAdapter([POS])
    const manager = new FakeExchangeManager(adapter)
    const client = new SignalWebSocketClient(db as any, manager as any, null)
    const sub = db.getSubscriptionForBot(BOT_ID)
    expect(sub).toMatchObject({ account_id: 'acct1/eth', account_key: 'acct1' })

    // The situation on prod: the run is long server-side, the executor holds
    // no lineage → the close leaves the manual position alone.
    const close1 = botClose('close-before')
    db.recordSignal({ id: close1.id, strategyId: 'fault-line', symbol: 'ETH', action: 'close', metadata: close1.metadata })
    await (client as any).executeCloseSignal(close1, sub)
    expect(adapter.placed).toHaveLength(0)
    expect(db.getSignalStatus(close1.id)).toBe('executed') // no-op ack
    expect((db.get('SELECT error_message FROM signals WHERE id = ?', [close1.id]) as any).error_message).toMatch(/no open entries/)

    // Adopt.
    const { svc } = service(adapter)
    const res = await svc.adopt(REQ)
    expect(res.stop.slOrderId).toBe('ord-1')
    expect(adapter.placed).toHaveLength(1)

    // The same close now finds the lineage and flattens exactly the venue qty.
    const close2 = botClose('close-after')
    db.recordSignal({ id: close2.id, strategyId: 'fault-line', symbol: 'ETH', action: 'close', metadata: close2.metadata })
    await (client as any).executeCloseSignal(close2, sub)
    const closeOrder = adapter.placed[adapter.placed.length - 1]!
    expect(closeOrder).toMatchObject({ symbol: 'ETH-PERPETUAL', side: 'sell', quantity: 981, reduceOnly: true, accountId: 'acct1/eth' })
    expect(adapter.cancelled).toContain('ord-1') // the lineage stop retired with the close
    const exec = db.getSignalExecution(SIGNAL_ID)!
    expect(exec.status).toBe('closed')
    expect(exec.qty_closed).toBe(981)
    expect(db.getSignalFills(SIGNAL_ID).map((f) => f.kind)).toEqual(['entry', 'exit'])
    expect(db.getServerExitState(POSITION_ID)!.active).toBe(0)
    expect(db.getOpenEntrySignals('ETH', BOT_ID)).toHaveLength(0)
  })

  it('after adoption a server stop update sharpens the adopted stop', async () => {
    seedRefusedEntry()
    const adapter = new FakeAdapter([POS])
    const manager = new FakeExchangeManager(adapter)
    const { svc } = service(adapter)
    await svc.adopt(REQ)

    const client = new SignalWebSocketClient(db as any, manager as any, null)
    const update: Signal = {
      id: 'upd-1',
      strategy_id: 'fault-line',
      symbol: 'ETH-PERPETUAL',
      action: 'buy',
      price: 4300,
      metadata: { positionId: POSITION_ID, exitSeq: 1, exitAuthority: 'server' },
      received_at: new Date(),
      status: 'pending',
      created_at: new Date(),
    } as Signal
    db.recordSignal({ id: update.id, strategyId: 'fault-line', symbol: 'ETH-PERPETUAL', action: 'update', metadata: update.metadata })
    await (client as any).handleServerExitUpdate(update, { adapter, status: 'connected' }, 'deribit')
    expect(adapter.cancelled).toEqual(['ord-1'])
    expect(adapter.placed[adapter.placed.length - 1]).toMatchObject({ orderType: 'stop', stopPrice: 4300, quantity: 981, reduceOnly: true })
    expect(db.getServerExitState(POSITION_ID)).toMatchObject({ current_stop: 4300, sl_order_id: 'ord-2', last_exit_seq: 1 })
    expect(db.getSignalBracket(SIGNAL_ID)).toMatchObject({ stop_loss_order_id: 'ord-2' })
  })
})
