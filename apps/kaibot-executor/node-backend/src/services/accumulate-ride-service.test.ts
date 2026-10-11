// Accumulate & ride end to end on a fake Deribit: adopt a manual position and
// its resting rungs, breakout -> hand-over -> new ladder, a rung fill growing
// the ride (stop resized), restart, ride exit -> waiting, re-entry, replay of
// an interrupted decision, stop. Real DB, real hand-over, manual trade and the
// signal client's resting-rung sweep; fake venue and server.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { SignalWebSocketClient } from '../websocket/signal-client.js'
import { createRideHandoverService, handoverSignalId } from './ride-handover.js'
import { createManualTradeService } from './manual-trade.js'
import { createAccumulateService } from './accumulate-ride-service.js'
import type { Order, OrderResult, OrderStatus, Position, Signal, VenueCandle } from './exchanges/types.js'

const H = 3_600_000
const T0 = Date.UTC(2026, 8, 27, 0, 0, 0)
const ENTRY_AT = T0 + 48 * H + 24 * 60_000
const SYM = 'BTC-PERPETUAL'
const ACC = 'btc'

interface FakeOrder {
  id: string
  order: Order
  state: OrderStatus['state']
  filled: number
}

class FakeDeribit {
  name = 'deribit'
  orders = new Map<string, FakeOrder>()
  seq = 0
  mark = 84_443
  bars: VenueCandle[] = []
  pos: Position | null = null
  failPlace = false

  async getAccounts() {
    return [{ id: 'deribit:btc', exchangeName: 'deribit', accountId: ACC, name: 'BTC', currency: 'BTC' }]
  }
  async getBalances() {
    return [{ accountId: ACC, balance: 0.1, equity: 0.1, realizedPnL: 0, unrealizedPnL: 0, currency: 'BTC', timestamp: 0 }]
  }
  async getPositions(): Promise<Position[]> {
    return this.pos && this.pos.size > 0 ? [{ ...this.pos }] : []
  }
  async getLastPrice() {
    return this.mark
  }
  async getCandles(): Promise<VenueCandle[]> {
    return this.bars
  }
  private addToPosition(side: 'buy' | 'sell', qty: number, price: number) {
    const signed = side === 'buy' ? qty : -qty
    const cur = this.pos ? (this.pos.side === 'long' ? this.pos.size : -this.pos.size) : 0
    const next = cur + signed
    const entry =
      this.pos && Math.sign(cur) === Math.sign(signed) && cur !== 0
        ? (this.pos.entryPrice * Math.abs(cur) + price * qty) / Math.abs(next)
        : this.pos && next !== 0 && Math.sign(next) === Math.sign(cur)
          ? this.pos.entryPrice
          : price
    this.pos =
      next === 0
        ? null
        : { id: SYM, accountId: ACC, symbol: SYM, side: next > 0 ? 'long' : 'short', size: Math.abs(next), entryPrice: entry, markPrice: this.mark }
  }
  async placeOrder(order: Order): Promise<OrderResult> {
    if (this.failPlace) throw new Error('venue down')
    if (order.clientOrderId) {
      const prior = [...this.orders.values()].find((o) => o.order.clientOrderId === order.clientOrderId && o.state !== 'cancelled')
      if (prior) return { orderId: prior.id, status: prior.state === 'filled' ? 'filled' : 'pending', filledQuantity: prior.filled }
    }
    const id = `o${++this.seq}`
    if (order.orderType === 'market') {
      this.orders.set(id, { id, order, state: 'filled', filled: order.quantity })
      this.addToPosition(order.side, order.quantity, this.mark)
      return { orderId: id, status: 'filled', filledQuantity: order.quantity, averagePrice: this.mark }
    }
    this.orders.set(id, { id, order, state: 'working', filled: 0 })
    return { orderId: id, status: 'pending' }
  }
  async cancelOrder(orderId: string): Promise<void> {
    const o = this.orders.get(orderId)
    if (o && o.state === 'working') o.state = 'cancelled'
  }
  async getOrderStatus(orderId: string): Promise<OrderStatus> {
    const o = this.orders.get(orderId)
    if (!o) return { orderId, state: 'unknown' }
    return { orderId, state: o.state, filledQuantity: o.filled, averagePrice: o.order.price ?? this.mark }
  }
  // Venue-side fill of a resting limit.
  fill(orderId: string) {
    const o = this.orders.get(orderId)!
    o.state = 'filled'
    o.filled = o.order.quantity
    this.addToPosition(o.order.side, o.order.quantity, o.order.price!)
  }
  working(kind?: Order['orderType']) {
    return [...this.orders.values()].filter((o) => o.state === 'working' && (!kind || o.order.orderType === kind))
  }
}

class FakeManager {
  constructor(public adapter: FakeDeribit) {}
  async getSession() {
    return { adapter: this.adapter, status: 'connected', userId: 'default', exchangeName: 'deribit' }
  }
  async getSessions() {
    return [await this.getSession()]
  }
  async getAllSessions() {
    return [await this.getSession()]
  }
}

// Flat history at 85.000 (the local high), then bars from `closes`.
function history(closes: number[]): VenueCandle[] {
  const out: VenueCandle[] = []
  for (let i = 0; i < 48; i++) out.push({ time: T0 + i * H, open: 84_500, high: 85_000, low: 84_000, close: 84_500 })
  closes.forEach((c, i) => out.push({ time: T0 + (48 + i) * H, open: c, high: c, low: c - 50, close: c }))
  return out
}

let dir: string
let db: KaiBotDatabase
let clock = ENTRY_AT

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-accumulate-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  clock = ENTRY_AT
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function setup(opts: { serverFails?: () => boolean } = {}) {
  const venue = new FakeDeribit()
  const manager = new FakeManager(venue)
  const client = new SignalWebSocketClient(db as any, manager as any, null)
  let n = 0
  const ride = createRideHandoverService(db, manager as any, {
    postToServer: async (path) => {
      if (path !== '/api/ride/handover') return { ok: true, status: 200, body: {} }
      if (opts.serverFails?.()) return { ok: false, status: 502, body: { error: 'server down' } }
      n++
      return { ok: true, status: 200, body: { positionId: `srv-${n}`, runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'create' } }
    },
  })
  const trade = createManualTradeService(db, manager as any, {})
  const make = () =>
    createAccumulateService(db, manager as any, {
      handover: (req) => ride.handover(req),
      placeMarket: (input) => trade.place({ ...input, orderType: 'market' }),
      cancelEntryRungs: (exchange, ids) => client.cancelRestingDcaRungsForSignals(exchange, ids),
      now: () => clock,
    })
  return { venue, manager, client, service: make(), make }
}

// Kai's manual trade: 2.870 long + 10 rungs of 80 USD, tracked like the
// manual-trade path tracks them.
async function seedManualPosition(venue: FakeDeribit) {
  venue.pos = { id: SYM, accountId: ACC, symbol: SYM, side: 'long', size: 2_870, entryPrice: 84_443, markPrice: 84_443 }
  db.addManualPosition('deribit', ACC, SYM, 'buy', 2_870)
  for (let i = 1; i <= 10; i++) {
    const r = await venue.placeOrder({ accountId: ACC, symbol: SYM, side: 'buy', orderType: 'limit', quantity: 80, price: 84_443 * (1 - i / 100), label: `kaibot-manual-dca${i}` })
    db.insertDcaRestingRung({ orderId: r.orderId, signalId: 'manual:176', exchange: 'deribit', accountId: ACC, symbol: SYM, side: 'buy', qty: 80, price: 84_443 * (1 - i / 100) })
  }
  db.insertSyntheticUsdPosition({ id: 'syn-btc', exchange: 'deribit', account_id: ACC, symbol: SYM, target_usd: 0, holdings_basis_usd: 8_000, leverage: 0, short_size: 0, leverage_cap: 2, status: 'armed' })
  db.run('UPDATE synthetic_usd_positions SET arm_holdings_coin = ?, arm_trigger_price = ? WHERE id = ?', [0.1, 76_900, 'syn-btc'])
}

describe('accumulate & ride', () => {
  it('runs the whole cycle without closing the adopted position', async () => {
    const { venue, client, service, make } = setup()
    await seedManualPosition(venue)
    venue.bars = history([84_600])
    clock = T0 + 49 * H + 60_000

    const plan = await service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { startPct: 34 } })
    expect(plan.phase).toBe('ladder')
    expect(plan.localLevel).toBe(85_000)
    expect(plan.rungs.open).toBe(10)
    expect(plan.floor?.triggerPrice).toBe(76_900)
    expect(venue.working('limit')).toHaveLength(10) // adoption placed and cancelled nothing

    // Bar at 84.600 is not a breakout.
    await service.tick()
    expect(service.status(plan.id)!.phase).toBe('ladder')

    // ── Breakout: close 85.500 > 85.000. ──
    venue.mark = 85_500
    venue.bars = history([84_600, 85_500])
    clock = T0 + 50 * H + 60_000
    await service.tick()
    let st = service.status(plan.id)!
    expect(st.lastError).toBeNull()
    expect(st.phase).toBe('riding')
    expect(st.reference).toBe(85_500)
    const entryId = handoverSignalId('srv-1')
    expect(db.getSignalExecution(entryId)!.qty_opened).toBe(2_870)
    // Old rungs cancelled, 10 new ones from the breakout level, all on the ride.
    const newRungs = venue.working('limit')
    expect(newRungs).toHaveLength(10)
    expect(newRungs[0].order.price).toBe(84_645)
    expect(newRungs.every((o) => o.order.quantity === 80)).toBe(true)
    expect(db.listDcaRestingRungs().every((r) => r.signal_id === entryId)).toBe(true)
    const stop = venue.working('stop')
    expect(stop).toHaveLength(1)
    expect(stop[0].order.stopPrice).toBe(76_095) // 11 steps below 85.500
    expect(stop[0].order.quantity).toBe(2_870)

    // ── A rung fills: the sweep books it into the ride, the stop follows. ──
    venue.fill(newRungs[0].id)
    await client.expireDcaRungs('deribit')
    expect(db.getSignalExecution(entryId)!.qty_opened).toBe(2_950)
    await service.tick()
    st = service.status(plan.id)!
    expect(st.rungs.filled).toBe(1)
    const resized = venue.working('stop')
    expect(resized).toHaveLength(1)
    expect(resized[0].order.quantity).toBe(2_950)
    expect(resized[0].order.stopPrice).toBe(76_095)

    // ── Restart: a fresh service on the same DB acts on nothing twice. ──
    const restarted = make()
    const placedBefore = venue.seq
    await restarted.tick()
    expect(venue.seq).toBe(placedBefore)
    expect(restarted.status(plan.id)!.phase).toBe('riding')

    // ── The ride closes the position (server close signal). ──
    const close: Signal = {
      id: 'close-1',
      strategy_id: 'ride',
      symbol: SYM,
      action: 'close',
      quantity: 1,
      metadata: { exchange: 'deribit', signalBotId: 'ride-bot', positionId: 'srv-1', exitAuthority: 'server' },
      received_at: new Date(),
      status: 'pending',
      created_at: new Date(),
    } as Signal
    db.recordSignal({ id: close.id, strategyId: 'ride', symbol: SYM, action: 'close', metadata: close.metadata })
    await (client as any).executeCloseSignal(close, db.getSubscriptionForBot('ride-bot'))
    expect(venue.pos).toBeNull()
    await restarted.tick()
    st = restarted.status(plan.id)!
    expect(st.phase).toBe('waiting')
    expect(st.rungs.open).toBe(0)
    expect(venue.working('limit')).toHaveLength(0)

    // ── Next breakout above the rolling high re-enters with 34 % of the basis. ──
    venue.mark = 90_000
    venue.bars = history([84_600, 85_500, 86_000, 87_000, 90_000])
    clock = T0 + 53 * H + 60_000
    await restarted.tick()
    st = restarted.status(plan.id)!
    expect(st.lastError).toBeNull()
    expect(st.phase).toBe('riding')
    // 0,1 BTC x 90.000 x 34 % = 3.060 USD
    expect(venue.pos!.size).toBe(3_060)
    expect(db.getSignalExecution(handoverSignalId('srv-2'))!.qty_opened).toBe(3_060)
    expect(venue.working('limit')).toHaveLength(10)

    // ── Stop: rungs gone, the position stays. ──
    const stopped = await restarted.stop(plan.id)
    expect(stopped.phase).toBe('stopped')
    expect(venue.working('limit')).toHaveLength(0)
    expect(venue.pos!.size).toBe(3_060)
    await restarted.tick()
    expect(venue.pos!.size).toBe(3_060)
  })

  it('replays an interrupted decision without a second entry', async () => {
    let fail = true
    const { venue, service } = setup({ serverFails: () => fail })
    venue.mark = 90_000
    venue.bars = history([84_600, 90_000])
    clock = T0 + 50 * H + 60_000
    const plan = await service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', params: { startPct: 34 } })
    expect(plan.phase).toBe('waiting')

    await service.tick()
    let st = service.status(plan.id)!
    expect(st.pending).toBe(true)
    expect(st.lastError).toContain('server down')
    expect(venue.pos!.size).toBe(3_060) // equity fallback basis: 0,1 BTC x 90.000

    fail = false
    await service.tick()
    st = service.status(plan.id)!
    expect(st.pending).toBe(false)
    expect(st.phase).toBe('riding')
    expect(venue.pos!.size).toBe(3_060)
    expect([...venue.orders.values()].filter((o) => o.order.orderType === 'market')).toHaveLength(1)
    expect(venue.working('limit')).toHaveLength(10)
  })

  it('holds the breakout while a synthetic short nets the instrument', async () => {
    const { venue, service } = setup()
    await seedManualPosition(venue)
    venue.bars = history([84_600])
    clock = T0 + 49 * H + 60_000
    const plan = await service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT })
    db.run("UPDATE synthetic_usd_positions SET status = 'open', short_size = 7690 WHERE id = 'syn-btc'")
    venue.bars = history([84_600, 85_500])
    clock = T0 + 50 * H + 60_000
    await service.tick()
    const st = service.status(plan.id)!
    expect(st.phase).toBe('ladder')
    expect(st.lastNote).toContain('synthetic')
    expect(venue.working('limit')).toHaveLength(10)
  })

  it('refuses a second plan on the same market and without a ride bot', async () => {
    const { venue, service } = setup()
    await seedManualPosition(venue)
    venue.bars = history([84_600])
    clock = T0 + 49 * H + 60_000
    await expect(service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: '' })).rejects.toThrow('ride bot')
    await service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT })
    await expect(
      service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT }),
    ).rejects.toThrow('already runs')
  })

  it('places its own ladder when there are no rungs to adopt', async () => {
    const { venue, service } = setup()
    venue.pos = { id: SYM, accountId: ACC, symbol: SYM, side: 'long', size: 2_870, entryPrice: 84_443, markPrice: 84_443 }
    venue.bars = history([84_600])
    clock = T0 + 49 * H + 60_000
    const plan = await service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT })
    expect(plan.phase).toBe('ladder')
    expect(plan.rungs.open).toBe(10)
    expect(venue.working('limit').map((o) => o.order.price)[0]).toBe(83_598.5)
    // Pre-ride rungs never write real sizes into signal_fills.
    expect(db.listDcaRestingRungs().every((r) => r.signal_id.startsWith('manual:'))).toBe(true)
  })
})
