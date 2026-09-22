// REGRESSION prod 22/09 (executor 0.4.13, first real call): one bot id,
// TWO executor subscriptions, the first on the default connection (its ETH
// belongs to a ride bot by now), the second an [ALLOC] sub on connection
// 'acct1'. The adopt path took "the bot's first active sub", so candidates
// came back empty and the adoption refused with "routes through the default
// connection, not acct1". Both must pick the subscription whose connection
// covers the given account; the bot's close must then run on that same
// connection, not on the first sub either.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { SignalWebSocketClient } from '../websocket/signal-client.js'
import { createAdoptPositionService, pickSubscriptionForAccount } from './adopt-position.js'
import { createManualTradeRoutes } from '../routes/manual-trade.js'
import type { Order, OrderResult, Position, Signal } from './exchanges/types.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-adopt-multi-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

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

// One adapter per connection, as the exchange manager hands them out by key.
class FakeAdapter {
  placed: Order[] = []
  cancelled: string[] = []
  constructor(public label: string, public positions: Position[]) {}
  async getPositions(): Promise<Position[]> {
    return this.positions
  }
  async getAccounts() {
    return this.positions.map((p) => ({ id: `deribit:${p.accountId}`, accountId: p.accountId }))
  }
  async placeOrder(order: Order): Promise<OrderResult> {
    this.placed.push(order)
    return {
      orderId: `${this.label}-ord-${this.placed.length}`,
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
  constructor(public byKey: Record<string, FakeAdapter>) {}
  async getSession(_user: string, exchangeName: string, key?: string) {
    this.keys.push(key)
    const adapter = this.byKey[key ?? 'default']
    if (!adapter) return null
    return { adapter, status: 'connected', userId: 'default', exchangeName }
  }
}

const DEFAULT_POS: Position = { id: 'p0', accountId: 'eth', symbol: 'ETH-PERPETUAL', side: 'long', size: 500, entryPrice: 4400, markPrice: 4480 }
const ACCT1_POS: Position = { id: 'p1', accountId: 'acct1/eth', symbol: 'ETH-PERPETUAL', side: 'long', size: 981, entryPrice: 4468, markPrice: 4480 }

function seedProdShape() {
  // Creation order matters: the default sub came first in prod.
  db.upsertSubscription({
    id: 'sub-default', signalBotId: BOT_ID, botName: 'Fault-Line ETH 4h', selectedMarkets: [], factor: 1,
    status: 'active', exchange: 'deribit', accountId: 'eth',
  })
  db.upsertSubscription({
    id: 'sub-acct1', signalBotId: BOT_ID, botName: '[ALLOC] Fault-Line ETH 4h (acct1)', selectedMarkets: [], factor: 1,
    status: 'active', exchange: 'deribit', accountId: 'acct1/eth', accountKey: 'acct1',
  })
  db.recordSignal({
    id: SIGNAL_ID, strategyId: 'fault-line', strategyName: 'Fault-Line', symbol: 'ETH', action: 'buy',
    quantity: 0.08, price: 4500, type: 'market', stopLoss: 1353.72, metadata: META,
  })
  db.updateSignalStatus(SIGNAL_ID, 'rejected', undefined, 'basis guard: signal 4500 vs venue 4468 (71 bps > 50)')
}

function build() {
  const dflt = new FakeAdapter('dflt', [DEFAULT_POS])
  const acct1 = new FakeAdapter('acct1', [ACCT1_POS])
  const manager = new FakeExchangeManager({ default: dflt, acct1 })
  const acks: any[] = []
  const svc = createAdoptPositionService(db, manager as any, {
    ackAdoptedEntry: async (signalId, fill, slOrderId) => {
      acks.push({ signalId, fill, slOrderId })
      db.recordSignalAck(signalId, true)
      return { ok: true, positionId: POSITION_ID }
    },
    registerBracket: (exchange, signalId, slOrderId, _tps, accountId) =>
      db.upsertBracketPair({ signalId, exchange, accountId: accountId ?? null, slOrderId: slOrderId ?? null }),
  })
  return { dflt, acct1, manager, svc, acks }
}

describe('pickSubscriptionForAccount', () => {
  const subs = [
    { id: 'sub-default', account_id: 'eth', account_key: null },
    { id: 'sub-acct1', account_id: 'acct1/eth', account_key: 'acct1' },
  ]
  it('picks by connection and account, never the first sub', () => {
    expect(pickSubscriptionForAccount(subs, 'acct1/eth').id).toBe('sub-acct1')
    expect(pickSubscriptionForAccount(subs, 'eth').id).toBe('sub-default')
    expect(() => pickSubscriptionForAccount(subs, 'acct9/eth')).toThrow(
      /no active subscription of this bot routes through the acct9 connection \(subscriptions: default, acct1\)/,
    )
    expect(() => pickSubscriptionForAccount(subs, 'acct1/btc')).toThrow(/routes to account acct1\/eth, not acct1\/btc/)
    expect(() => pickSubscriptionForAccount(subs)).toThrow(/has 2 subscriptions .*pass accountId/)
    expect(pickSubscriptionForAccount([subs[1]!]).id).toBe('sub-acct1')
  })
})

describe('REGRESSION prod 22/09: two subs per bot, adopt on the acct1 connection', () => {
  it('candidates and adopt use the acct1 sub; an unknown connection is refused with the reason', async () => {
    seedProdShape()
    const { acct1, dflt, manager, svc } = build()

    const list = await svc.candidates({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', side: 'long' })
    expect(list.map((c) => c.signalId)).toEqual([SIGNAL_ID])
    expect(list[0]!.subscriptionId).toBe('sub-acct1')

    await expect(
      svc.adopt({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct9/eth', signalId: SIGNAL_ID }),
    ).rejects.toThrow(/no active subscription of this bot routes through the acct9 connection/)
    expect(db.getSignalExecution(SIGNAL_ID)).toBeFalsy()

    const res = await svc.adopt({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', signalId: SIGNAL_ID })
    expect(res).toMatchObject({ accountId: 'acct1/eth', qty: 981, avgPrice: 4468, stop: { slOrderId: 'acct1-ord-1', source: 'placed' } })
    // The stop went to the acct1 connection; the default connection saw nothing.
    expect(manager.keys).toContain('acct1')
    expect(acct1.placed).toHaveLength(1)
    expect(acct1.placed[0]).toMatchObject({ accountId: 'acct1/eth', quantity: 981, reduceOnly: true })
    expect(dflt.placed).toHaveLength(0)
    expect(db.getSignalExecution(SIGNAL_ID)).toMatchObject({ account_id: 'acct1/eth', qty_opened: 981, status: 'open' })
  })

  it('the route answers 400 with the reason for a connection no sub routes through', async () => {
    seedProdShape()
    const { manager } = build()
    const app = createManualTradeRoutes(db, manager as any, { ackAdoptedEntry: async () => ({ ok: true, positionId: null }) })
    const res = await app.request('/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct9/eth', signalId: SIGNAL_ID }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/acct9 connection \(subscriptions: default, acct1\)/)
    const ok = await app.request('/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', signalId: SIGNAL_ID }),
    })
    expect(ok.status).toBe(200)
  })

  it("the bot's close then runs on the acct1 connection and leaves the default connection's ETH alone", async () => {
    seedProdShape()
    const { acct1, dflt, manager, svc } = build()
    await svc.adopt({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', signalId: SIGNAL_ID })
    manager.keys.length = 0

    const client = new SignalWebSocketClient(db as any, manager as any, null)
    const close: Signal = {
      id: 'close-1',
      strategy_id: 'fault-line',
      symbol: 'ETH',
      action: 'close',
      quantity: 1,
      metadata: { exchange: 'deribit', signalBotId: BOT_ID, positionId: POSITION_ID, exitAuthority: 'server', venueSymbols: META.venueSymbols },
      received_at: new Date(),
      status: 'pending',
      created_at: new Date(),
    } as Signal
    // The wire path: sub resolution happens inside.
    await (client as any).handleSignalInner(close)

    expect(dflt.placed).toHaveLength(0)
    const closeOrder = acct1.placed[acct1.placed.length - 1]!
    expect(closeOrder).toMatchObject({ accountId: 'acct1/eth', symbol: 'ETH-PERPETUAL', side: 'sell', quantity: 981, reduceOnly: true })
    expect(acct1.cancelled).toContain('acct1-ord-1')
    expect(manager.keys).toContain('acct1')
    expect(manager.keys).not.toContain(undefined)
    expect(db.getSignalExecution(SIGNAL_ID)).toMatchObject({ status: 'closed', qty_closed: 981 })
    expect(db.getServerExitState(POSITION_ID)!.active).toBe(0)
    expect(db.getSignalStatus('close-1')).toBe('executed')
  })

  it('with one sub the close keeps its sub (no change for single-connection bots)', async () => {
    seedProdShape()
    db.run("UPDATE executor_subscriptions SET status = 'cancelled' WHERE id = 'sub-acct1'")
    const { manager } = build()
    const client = new SignalWebSocketClient(db as any, manager as any, null)
    const current = db.getSubscription('sub-default')
    expect((client as any).subForLineageClose(BOT_ID, 'ETH', current)).toBe(current)
  })
})
