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
import { createRideHandoverService, handoverSignalId, type HandoverRequest, type HandoverResult } from './ride-handover.js'
import { withOrderLock } from './order-lock.js'
import { createManualTradeService } from './manual-trade.js'
import { createAccumulateService } from './accumulate-ride-service.js'
import { sweepVenueExitOrders } from './venue-exit-sweep.js'
import { createAccumulateRoutes } from '../routes/accumulate.js'
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
  failPlaceIf: ((o: Order) => boolean) | null = null
  ops: string[] = []

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
    if (this.failPlace || this.failPlaceIf?.(order)) throw new Error('venue down')
    if (order.clientOrderId) {
      const prior = [...this.orders.values()].find((o) => o.order.clientOrderId === order.clientOrderId && o.state !== 'cancelled')
      if (prior) return { orderId: prior.id, status: prior.state === 'filled' ? 'filled' : 'pending', filledQuantity: prior.filled }
    }
    const id = `o${++this.seq}`
    this.ops.push(`place:${id}`)
    if (this.trancheStopFilled && order.orderType === 'stop' && order.clientOrderId) {
      this.orders.set(id, { id, order, state: 'filled', filled: order.quantity })
      return { orderId: id, status: 'filled', filledQuantity: order.quantity }
    }
    if (order.orderType === 'market') {
      this.orders.set(id, { id, order, state: 'filled', filled: order.quantity })
      this.addToPosition(order.side, order.quantity, this.mark)
      return { orderId: id, status: 'filled', filledQuantity: order.quantity, averagePrice: this.mark }
    }
    this.orders.set(id, { id, order, state: 'working', filled: 0 })
    return { orderId: id, status: 'pending' }
  }
  failCancelIf: ((o: Order) => boolean) | null = null
  failStatusIds = new Set<string>()
  notFoundIds = new Set<string>()
  cancelTimeoutIds = new Set<string>()
  // A tranche stop (client id) comes back already filled (label dedup).
  trancheStopFilled = false
  async cancelOrder(orderId: string): Promise<void> {
    this.ops.push(`cancel:${orderId}`)
    if (this.notFoundIds.has(orderId)) throw new Error('order_not_found')
    if (this.cancelTimeoutIds.has(orderId)) throw new Error('cancel timed out')
    const f = this.orders.get(orderId)
    if (f && this.failCancelIf?.(f.order)) throw new Error('cancel timed out')
    const o = this.orders.get(orderId)
    if (o && o.state === 'working') o.state = 'cancelled'
  }
  async getOrderStatus(orderId: string): Promise<OrderStatus> {
    if (this.failStatusIds.has(orderId)) throw new Error('status timed out')
    const o = this.orders.get(orderId)
    if (!o) return { orderId, state: 'unknown', absenceConfirmed: true }
    return { orderId, state: o.state, filledQuantity: o.filled, averagePrice: o.order.price ?? this.mark }
  }
  // Venue-side fill of a resting limit.
  fill(orderId: string) {
    const o = this.orders.get(orderId)!
    o.state = 'filled'
    o.filled = o.order.quantity
    this.addToPosition(o.order.side, o.order.quantity, o.order.price!)
  }
  async getOpenOrders(ctx?: { symbol?: string }) {
    return [...this.orders.values()]
      .filter((o) => o.state === 'working' && (!ctx?.symbol || o.order.symbol === ctx.symbol))
      .map((o) => ({ orderId: o.id, symbol: o.order.symbol, side: o.order.side, type: o.order.orderType, amount: o.order.quantity, price: o.order.price ?? null, triggerPrice: o.order.stopPrice ?? null, reduceOnly: !!o.order.reduceOnly, label: o.order.label ?? null, state: 'open', createdAtMs: null }))
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

    const plan = await service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { startPct: 34, rearm: false } })
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
    const plan = await service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', params: { startPct: 34, rearm: false } })
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
    const plan = await service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { rearm: false } })
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
    await service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { rearm: false } })
    await expect(
      service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { rearm: false } }),
    ).rejects.toThrow('already runs')
  })

  it('places its own ladder when there are no rungs to adopt', async () => {
    const { venue, service } = setup()
    venue.pos = { id: SYM, accountId: ACC, symbol: SYM, side: 'long', size: 2_870, entryPrice: 84_443, markPrice: 84_443 }
    venue.bars = history([84_600])
    clock = T0 + 49 * H + 60_000
    const plan = await service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { rearm: false } })
    expect(plan.phase).toBe('ladder')
    expect(plan.rungs.open).toBe(10)
    expect(venue.working('limit').map((o) => o.order.price)[0]).toBe(83_598.5)
    // Pre-ride rungs never write real sizes into signal_fills.
    expect(db.listDcaRestingRungs().every((r) => r.signal_id.startsWith('manual:'))).toBe(true)
  })
})

// Re-arm (Kai 12/10): a riding plan whose stop rests at the venue arms a new
// tranche on the same market, ridden on its own.
describe('accumulate re-arm', () => {
  const plans = () => db.all('SELECT * FROM accumulate_plans ORDER BY tranche_index') as Array<Record<string, any>>
  const armed = () => plans().filter((p) => p.phase === 'armed')

  function closeSignal(id: string, positionId: string): Signal {
    const metadata = { exchange: 'deribit', signalBotId: 'ride-bot', positionId, exitAuthority: 'server' }
    db.recordSignal({ id, strategyId: 'ride', symbol: SYM, action: 'close', metadata })
    return { id, strategy_id: 'ride', symbol: SYM, action: 'close', quantity: 1, metadata, received_at: new Date(), status: 'pending', created_at: new Date() } as Signal
  }

  // Adopted manual long, then the breakout at bar 49 hands it to the ride.
  async function riding(params: Record<string, unknown> = {}) {
    const h = setup()
    await seedManualPosition(h.venue)
    h.venue.bars = history([84_600])
    clock = T0 + 49 * H + 60_000
    const plan = await h.service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { startPct: 34, ...params } as any })
    h.venue.mark = 85_500
    h.venue.bars = history([84_600, 85_500])
    clock = T0 + 50 * H + 60_000
    await h.service.tick()
    expect(h.service.status(plan.id)!.phase).toBe('riding')
    return { ...h, plan }
  }

  // Tranche 2's breakout at bar 51 (close 86.000 > 85.500).
  async function trancheTwoRides(h: Awaited<ReturnType<typeof riding>>) {
    h.venue.mark = 86_000
    h.venue.bars = history([84_600, 85_500, 86_000])
    clock = T0 + 51 * H + 60_000
    await h.service.tick()
  }

  it('(a) riding with a confirmed venue stop arms exactly one tranche, also after a restart', async () => {
    const h = await riding()
    expect(h.venue.working('stop')).toHaveLength(1)
    let a = armed()
    expect(a).toHaveLength(1)
    expect(a[0].parent_plan_id).toBe(h.plan.id)
    expect(a[0].tranche_index).toBe(2)
    expect(a[0].local_level).toBe(85_500)
    expect(a[0].reference).toBe(85_500)
    // Own ladder next to the ride's ladder.
    expect(h.venue.working('limit')).toHaveLength(20)
    const st = h.service.status(a[0].id)!
    expect(st.phase).toBe('armed')
    expect(st.parentPlanId).toBe(h.plan.id)
    expect(st.openTranches).toBe(1)
    expect(st.params.maxTranches).toBe(3)
    expect(st.params.rearmCooldownBars).toBe(24)

    const placed = h.venue.seq
    await h.service.tick()
    expect(armed()).toHaveLength(1)
    clock += H
    await h.service.tick()
    const restarted = h.make()
    await restarted.tick()
    expect(armed()).toHaveLength(1)
    expect(plans()).toHaveLength(2)
    expect(h.venue.seq).toBe(placed)
    a = armed()
    expect(a[0].tranche_index).toBe(2)
  })

  it('(b) a ride without a working venue stop does not re-arm', async () => {
    const h = setup()
    await seedManualPosition(h.venue)
    h.venue.bars = history([84_600])
    clock = T0 + 49 * H + 60_000
    const plan = await h.service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { rearm: false } })
    h.venue.mark = 85_500
    h.venue.bars = history([84_600, 85_500])
    clock = T0 + 50 * H + 60_000
    await h.service.tick()
    // Turn re-arm on, then lose the venue stop (server-only stop left).
    db.run('UPDATE accumulate_plans SET params = json_set(params, ?, json(?)) WHERE id = ?', ['$.rearm', 'true', plan.id])
    const stop = h.venue.working('stop')[0]
    await h.venue.cancelOrder(stop.id)
    await h.service.tick()
    expect(armed()).toHaveLength(0)
    // No stop id at all: the tick tries to re-place it; while the venue
    // refuses, the ride stays bare and nothing re-arms.
    db.run('UPDATE server_exit_state SET sl_order_id = NULL')
    h.venue.failPlace = true
    clock += H
    await h.service.tick()
    expect(armed()).toHaveLength(0)
    expect(db.getServerExitState('srv-1')!.sl_order_id).toBeNull()
  })

  it('(c) no re-arm once maxTranches rides are open', async () => {
    await riding({ maxTranches: 1 })
    expect(armed()).toHaveLength(0)
    clock += H
    expect(plans()).toHaveLength(1)
  })

  it('(d) no re-arm during the cooldown after a stop-out, re-arm after it', async () => {
    const h = await riding({ maxTranches: 2, rearmCooldownBars: 5 })
    const t2 = armed()[0]
    // Tranche 1 is closed by its ride while tranche 2 waits: tranche 1 retires.
    await (h.client as any).executeCloseSignal(closeSignal('close-t1', 'srv-1'), db.getSubscriptionForBot('ride-bot'))
    await h.service.tick()
    expect(h.service.status(h.plan.id)!.phase).toBe('closed')
    // Tranche 2 breaks out and rides; the cooldown holds the next re-arm.
    await trancheTwoRides(h)
    expect(h.service.status(t2.id)!.phase).toBe('riding')
    expect(armed()).toHaveLength(0)
    clock = T0 + 54 * H + 60_000
    h.venue.bars = history([84_600, 85_500, 86_000, 85_900, 85_800, 85_700])
    await h.service.tick()
    expect(armed()).toHaveLength(0)
    // 5 bars after the stop-out (bar 50 + 5 = bar 55).
    clock = T0 + 55 * H + 60_000
    h.venue.bars = history([84_600, 85_500, 86_000, 85_900, 85_800, 85_700, 85_600])
    await h.service.tick()
    const a = armed()
    expect(a).toHaveLength(1)
    expect(a[0].parent_plan_id).toBe(t2.id)
    expect(a[0].tranche_index).toBe(3)
  })

  it('(e) two tranches: a close of tranche 1 reduces only its qty, tranche 2 keeps its stop', async () => {
    const h = await riding({ maxTranches: 2 })
    const t2 = armed()[0]
    await trancheTwoRides(h)
    const st2 = h.service.status(t2.id)!
    expect(st2.lastError).toBeNull()
    expect(st2.phase).toBe('riding')
    expect(st2.ride?.positionId).toBe('srv-2')
    // 0,1 BTC x 86.000 x 34 % = 2.924 USD: its own ride next to tranche 1's 2.870.
    const e2 = db.getSignalExecution(handoverSignalId('srv-2'))!
    expect(e2.qty_opened).toBe(2_920)
    expect(db.getSignalExecution(handoverSignalId('srv-1'))!.qty_opened).toBe(2_870)
    expect(h.venue.pos!.size).toBe(2_870 + 2_920)
    const stops = h.venue.working('stop')
    expect(stops).toHaveLength(2)
    const stop2 = stops.find((o) => o.order.quantity === 2_920)!
    expect(stop2).toBeDefined()
    expect(st2.tranche?.qty).toBe(2_920)
    expect(st2.tranche?.entryPrice).toBeCloseTo(86_000, 6)
    expect(h.service.status(h.plan.id)!.openTranches).toBe(2)

    await (h.client as any).executeCloseSignal(closeSignal('close-t1', 'srv-1'), db.getSubscriptionForBot('ride-bot'))
    const closeOrder = [...h.venue.orders.values()].filter((o) => o.order.orderType === 'market').at(-1)!
    expect(closeOrder.order.quantity).toBe(2_870)
    expect(closeOrder.order.reduceOnly).toBe(true)
    expect(h.venue.pos!.size).toBe(2_920)
    expect(h.venue.orders.get(stop2.id)!.state).toBe('working')
    expect(h.venue.orders.get(stop2.id)!.order.quantity).toBe(2_920)
    expect(db.getSignalExecution(handoverSignalId('srv-2'))!.status).toBe('open')
    expect(db.getServerExitState('srv-2')!.active).toBeTruthy()

    await h.service.tick()
    expect(h.service.status(h.plan.id)!.phase).toBe('waiting')
    expect(h.service.status(t2.id)!.phase).toBe('riding')
  })

  it('a venue stop fill of tranche 1 books on tranche 1, tranche 2 and its stop stay', async () => {
    const h = await riding({ maxTranches: 2 })
    const t2 = armed()[0]
    await trancheTwoRides(h)
    const stop1 = db.getServerExitState('srv-1')!.sl_order_id!
    const stop2 = db.getServerExitState('srv-2')!.sl_order_id!
    // Tranche 1's (older) stop fills at the venue.
    const o = h.venue.orders.get(stop1)!
    o.state = 'filled'
    o.filled = o.order.quantity
    ;(h.venue as any).addToPosition('sell', o.order.quantity, o.order.stopPrice ?? h.venue.mark)
    expect(h.venue.pos!.size).toBe(2_920)
    const reported: string[] = []
    const booked = await sweepVenueExitOrders(
      { db: db as any, getAdapter: async () => h.venue as any, reportVenueExit: async (positionId) => { reported.push(positionId); return { sent: true } } },
      'deribit',
    )
    expect(booked).toBe(1)
    const e1 = db.getSignalExecution(handoverSignalId('srv-1'))!
    const e2 = db.getSignalExecution(handoverSignalId('srv-2'))!
    expect(e1.status).toBe('closed')
    expect(e1.qty_closed).toBe(2_870)
    expect(e2.status).toBe('open')
    expect(e2.qty_closed).toBe(0)
    expect(reported).toEqual(['srv-1'])
    const placed = h.venue.seq
    await h.service.tick()
    expect(h.service.status(t2.id)!.phase).toBe('riding')
    expect(h.venue.orders.get(stop2)!.state).toBe('working')
    expect(h.venue.orders.get(stop2)!.order.quantity).toBe(2_920)
    expect([...h.venue.orders.values()].slice(placed).filter((x) => x.order.orderType === 'stop')).toHaveLength(0)
  })

  function stopUpdate(id: string, positionId: string, price: number, exitSeq: number): Signal {
    const metadata = { exchange: 'deribit', signalBotId: 'ride-bot', positionId, exitSeq, exitAuthority: 'server' }
    db.recordSignal({ id, strategyId: 'ride', symbol: SYM, action: 'update', metadata })
    return { id, strategy_id: 'ride', symbol: SYM, action: 'update' as any, quantity: 0, price, metadata, received_at: new Date(), status: 'pending', created_at: new Date() } as Signal
  }

  it('an armed tranche: tranche 1 stop updates stay at its own qty while the armed rungs fill', async () => {
    const h = await riding({ maxTranches: 2 })
    const t2 = armed()[0]
    const rung = db.get('SELECT order_id FROM accumulate_rungs WHERE plan_id = ? AND state = ? ORDER BY idx LIMIT 1', [t2.id, 'open']) as { order_id: string }
    h.venue.fill(rung.order_id)
    expect(h.venue.pos!.size).toBeGreaterThan(2_870)
    await (h.client as any).handleServerExitUpdate(stopUpdate('upd-a', 'srv-1', 80_000, 1), await h.manager.getSession(), 'deribit')
    const st1 = db.getServerExitState('srv-1')!
    expect(h.venue.orders.get(st1.sl_order_id!)!.order.quantity).toBe(2_870)
  })

  // Pre-fix sizing: tranche 1's stop covers the whole venue position.
  async function growStopOne(h: Awaited<ReturnType<typeof riding>>) {
    const st = db.getServerExitState('srv-1')!
    h.venue.pos = { ...h.venue.pos!, size: 2_870 + 400 }
    const { replaceServerExitStop } = await import('./server-exit-stop.js')
    await replaceServerExitStop({
      db: db as any, adapter: h.venue as any, state: st as any,
      live: { id: SYM, accountId: ACC, symbol: SYM, side: 'long', size: 3_270, entryPrice: 0 },
      lineageAccount: ACC, stopPrice: st.current_stop!, exitSeq: st.last_exit_seq, label: 'kaibot-ride-sl',
    })
    h.venue.pos = { ...h.venue.pos!, size: 2_870 }
    return db.getServerExitState('srv-1')!.sl_order_id!
  }

  it('a tranche hand-over fits a grown sibling stop: new stop first, old one cancelled after', async () => {
    const h = await riding({ maxTranches: 2 })
    const grown = await growStopOne(h)
    expect(h.venue.orders.get(grown)!.order.quantity).toBe(3_270)
    h.venue.ops = []
    await trancheTwoRides(h)
    const fresh = db.getServerExitState('srv-1')!.sl_order_id!
    expect(fresh).not.toBe(grown)
    expect(h.venue.orders.get(fresh)!.order.quantity).toBe(2_870)
    expect(h.venue.orders.get(grown)!.state).toBe('cancelled')
    expect(h.venue.ops.indexOf(`place:${fresh}`)).toBeLessThan(h.venue.ops.indexOf(`cancel:${grown}`))
  })

  it('a server exit update that moved the stop while the fit waited on the lock wins', async () => {
    const h = await riding({ maxTranches: 2 })
    await trancheTwoRides(h)
    const st = db.getServerExitState('srv-1')!
    await h.venue.cancelOrder(st.sl_order_id!)
    db.applyServerExitUpdate('srv-1', { exitSeq: st.last_exit_seq, currentStop: st.current_stop, slOrderId: null })
    let release!: () => void
    const held = withOrderLock('deribit', async () => {
      await new Promise<void>((r) => (release = r))
      // The server update places stop B and records it.
      const b = await h.venue.placeOrder({ accountId: ACC, symbol: SYM, side: 'sell', orderType: 'stop', quantity: 2_870, stopPrice: st.current_stop!, reduceOnly: true, label: 'kaibot:x:exit-update' })
      db.applyServerExitUpdate('srv-1', { exitSeq: st.last_exit_seq + 1, currentStop: st.current_stop, slOrderId: b.orderId })
    })
    clock += 60_000
    const ticking = h.service.tickPlan(h.plan.id)
    await new Promise((r) => setTimeout(r, 50))
    release()
    await held
    await ticking
    const now1 = db.getServerExitState('srv-1')!.sl_order_id!
    expect(h.venue.orders.get(now1)!.order.label).toBe('kaibot:x:exit-update')
    expect(h.venue.working('stop').filter((o) => o.order.quantity === 2_870)).toHaveLength(1)
  })

  it('a stop swap whose old and new stop both refuse to cancel: no new placement until the orphan is gone', async () => {
    const venue0 = await riding({ maxTranches: 2 })
    const alerts: Array<{ title: string; body: string }> = []
    const h = { ...venue0, service: createAccumulateService(db, venue0.manager as any, {
      handover: (req) => createRideHandoverService(db, venue0.manager as any, {
        postToServer: async (path) => path === '/api/ride/handover'
          ? { ok: true, status: 200, body: { positionId: 'srv-2', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'create' } }
          : { ok: true, status: 200, body: {} },
      }).handover(req),
      placeMarket: (input) => createManualTradeService(db, venue0.manager as any, {}).place({ ...input, orderType: 'market' }),
      cancelEntryRungs: (exchange, ids) => venue0.client.cancelRestingDcaRungsForSignals(exchange, ids),
      now: () => clock,
      notify: (e) => alerts.push({ title: e.title, body: e.body }),
    }) }
    const grown = await growStopOne(h)
    const t2 = armed()[0]
    h.venue.failCancelIf = (o) => o.orderType === 'stop'
    await trancheTwoRides(h)
    // The orphan came up inside the hand-over: no ladder for tranche 2 this tick.
    expect(h.service.status(t2.id)!.rungs.open).toBe(0)
    expect(h.service.status(t2.id)!.pending).toBe(true)
    expect(db.getServerExitState('srv-1')!.sl_order_id).toBe(grown)
    const orphan = h.venue.working('stop').find((o) => o.id !== grown && o.order.quantity === 2_870)!
    expect(orphan).toBeDefined()
    expect(alerts.map((a) => a.title)).toContain('Untracked stop at the venue')
    expect(alerts.find((a) => a.title === 'Untracked stop at the venue')!.body).toContain(orphan.id)
    const seq = h.venue.seq
    clock += 60_000
    await h.service.tick()
    expect(h.venue.seq).toBe(seq)
    h.venue.failCancelIf = null
    clock += 60_000
    await h.service.tick()
    expect(h.venue.orders.get(orphan.id)!.state).toBe('cancelled')
    clock += 60_000
    await h.service.tick()
    const fresh = db.getServerExitState('srv-1')!.sl_order_id!
    expect(h.venue.orders.get(fresh)!.order.quantity).toBe(2_870)
    expect(h.venue.orders.get(grown)!.state).toBe('cancelled')
    expect(h.venue.working('stop').filter((o) => o.order.quantity === 2_870)).toHaveLength(1)
    expect(h.service.status(t2.id)!.rungs.open).toBeGreaterThan(0)
    expect(h.service.status(t2.id)!.pending).toBe(false)
  })

  it('an orphan the venue no longer knows does not block the market', async () => {
    const h = await riding({ maxTranches: 2 })
    const col = () => (db.get('SELECT orphan_stop_ids FROM accumulate_plans WHERE id = ?', [h.plan.id]) as { orphan_stop_ids: string | null }).orphan_stop_ids
    // The venue confirms it has no such order; a cancel would not get through.
    db.run('UPDATE accumulate_plans SET orphan_stop_ids = ? WHERE id = ?', [JSON.stringify(['ghost-1']), h.plan.id])
    h.venue.cancelTimeoutIds.add('ghost-1')
    clock += 60_000
    await h.service.tickPlan(h.plan.id)
    expect(h.service.status(h.plan.id)!.lastError).toBeNull()
    expect(col()).toBeNull()
    // Status lookup down and the cancel answers not found: gone as well.
    db.run('UPDATE accumulate_plans SET orphan_stop_ids = ? WHERE id = ?', [JSON.stringify(['ghost-2']), h.plan.id])
    h.venue.failStatusIds.add('ghost-2')
    h.venue.notFoundIds.add('ghost-2')
    clock += 60_000
    await h.service.tickPlan(h.plan.id)
    expect(col()).toBeNull()
  })

  it('a bare stop is re-placed only next to riding siblings, and never past the stop level', async () => {
    // Single ride, no stop id: left to the server, as on main.
    const single = await riding({ rearm: false })
    const st = db.getServerExitState('srv-1')!
    db.applyServerExitUpdate('srv-1', { exitSeq: st.last_exit_seq, currentStop: st.current_stop, slOrderId: null })
    const seq = single.venue.seq
    clock += 60_000
    await single.service.tick()
    expect(single.venue.seq).toBe(seq)
  })

  it('a bare sibling stop is not re-placed once the price is through its level', async () => {
    const h = await riding({ maxTranches: 2 })
    await trancheTwoRides(h)
    const st = db.getServerExitState('srv-1')!
    await h.venue.cancelOrder(st.sl_order_id!)
    db.applyServerExitUpdate('srv-1', { exitSeq: st.last_exit_seq, currentStop: st.current_stop, slOrderId: null })
    h.venue.mark = st.current_stop! - 100
    const before = [...h.venue.orders.values()].filter((o) => o.order.orderType === 'stop').length
    clock += 60_000
    await h.service.tickPlan(h.plan.id)
    expect([...h.venue.orders.values()].filter((o) => o.order.orderType === 'stop').length).toBe(before)
    h.venue.mark = 86_000
    clock += 60_000
    await h.service.tickPlan(h.plan.id)
    const fresh = db.getServerExitState('srv-1')!.sl_order_id!
    expect(h.venue.orders.get(fresh)!.order.quantity).toBe(2_870)
  })

  it('a sibling stop that already fits is left alone at the hand-over', async () => {
    const h = await riding({ maxTranches: 2 })
    const stop1 = db.getServerExitState('srv-1')!.sl_order_id!
    await trancheTwoRides(h)
    expect(db.getServerExitState('srv-1')!.sl_order_id).toBe(stop1)
    expect(h.venue.ops).not.toContain(`cancel:${stop1}`)
  })

  it('a failed sibling fit keeps the old stop, alerts once and retries next tick', async () => {
    const venue0 = await riding({ maxTranches: 2 })
    const alerts: string[] = []
    const h = { ...venue0, service: createAccumulateService(db, venue0.manager as any, {
      handover: (req) => createRideHandoverService(db, venue0.manager as any, {
        postToServer: async (path) => path === '/api/ride/handover'
          ? { ok: true, status: 200, body: { positionId: 'srv-2', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'create' } }
          : { ok: true, status: 200, body: {} },
      }).handover(req),
      placeMarket: (input) => createManualTradeService(db, venue0.manager as any, {}).place({ ...input, orderType: 'market' }),
      cancelEntryRungs: (exchange, ids) => venue0.client.cancelRestingDcaRungsForSignals(exchange, ids),
      now: () => clock,
      notify: (e) => alerts.push(e.title),
    }) }
    const grown = await growStopOne(h)
    // The fit's stop (no client id) fails; the tranche's own stop goes through.
    h.venue.failPlaceIf = (o) => o.orderType === 'stop' && !o.clientOrderId
    await trancheTwoRides(h)
    expect(db.getServerExitState('srv-1')!.sl_order_id).toBe(grown)
    expect(h.venue.orders.get(grown)!.state).toBe('working')
    expect(alerts).toEqual(['Accumulate ride stop not resized'])
    clock += 60_000
    await h.service.tick()
    expect(alerts).toHaveLength(1)
    h.venue.failPlaceIf = null
    clock += 60_000
    await h.service.tick()
    const fresh = db.getServerExitState('srv-1')!.sl_order_id!
    expect(h.venue.orders.get(fresh)!.order.quantity).toBe(2_870)
    expect(h.venue.orders.get(grown)!.state).toBe('cancelled')
  })

  it('re-arm off on tranche 2: its own stop-out ends its ride, no ladder under its closed entry', async () => {
    const h = await riding({ maxTranches: 2 })
    const t2 = armed()[0]
    await trancheTwoRides(h)
    h.service.updateParams(t2.id, { rearm: false })
    const stop2 = db.getServerExitState('srv-2')!.sl_order_id!
    const o = h.venue.orders.get(stop2)!
    o.state = 'filled'
    o.filled = o.order.quantity
    ;(h.venue as any).addToPosition('sell', o.order.quantity, o.order.stopPrice ?? h.venue.mark)
    await sweepVenueExitOrders({ db: db as any, getAdapter: async () => h.venue as any, reportVenueExit: async () => ({ sent: true }) }, 'deribit')
    expect(db.getSignalExecution(handoverSignalId('srv-2'))!.status).toBe('closed')
    clock += 60_000
    await h.service.tick()
    expect(['waiting', 'closed']).toContain(h.service.status(t2.id)!.phase)
    expect(h.service.status(h.plan.id)!.phase).toBe('riding')
    // A new high: nothing may rest under tranche 2's closed entry.
    h.venue.mark = 87_000
    h.venue.bars = history([84_600, 85_500, 86_000, 87_000])
    clock = T0 + 52 * H + 60_000
    await h.service.tick()
    expect(db.getDcaRestingRungsForSignal(handoverSignalId('srv-2'))).toHaveLength(0)
  })

  it('create with re-arm off on a market a plan already rides is refused', async () => {
    const h = await riding({ maxTranches: 3, rearm: false })
    await expect(
      h.service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { rearm: false } as any }),
    ).rejects.toThrow('re-arm must stay on')
    expect(plans()).toHaveLength(1)
  })

  it('(e) a stop update of one tranche resizes to that tranche only', async () => {
    const h = await riding({ maxTranches: 2 })
    await trancheTwoRides(h)
    const sig: Signal = {
      id: 'upd-1', strategy_id: 'ride', symbol: SYM, action: 'update' as any, quantity: 0, price: 80_000,
      metadata: { exchange: 'deribit', signalBotId: 'ride-bot', positionId: 'srv-1', exitSeq: 1, exitAuthority: 'server' },
      received_at: new Date(), status: 'pending', created_at: new Date(),
    } as Signal
    db.recordSignal({ id: sig.id, strategyId: 'ride', symbol: SYM, action: 'update', metadata: sig.metadata })
    await (h.client as any).handleServerExitUpdate(sig, await h.manager.getSession(), 'deribit')
    const st1 = db.getServerExitState('srv-1')!
    expect(st1.current_stop).toBe(80_000)
    const moved = h.venue.orders.get(st1.sl_order_id!)!
    expect(moved.order.quantity).toBe(2_870)
    const st2 = db.getServerExitState('srv-2')!
    expect(h.venue.orders.get(st2.sl_order_id!)!.state).toBe('working')
    expect(h.venue.orders.get(st2.sl_order_id!)!.order.quantity).toBe(2_920)
  })

  type Post = (path: string, body: any) => Promise<{ ok: boolean; status: number; body: any }>
  // Old server: one ride row per market, a repeat is idempotent.
  const oldServer: Post = async (path) =>
    path === '/api/ride/handover'
      ? { ok: true, status: 200, body: { positionId: 'srv-1', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'idempotent' } }
      : { ok: true, status: 200, body: {} }

  async function oldServerRig(post: Post = oldServer, wrap?: (h: (req: HandoverRequest) => Promise<HandoverResult>) => (req: HandoverRequest) => Promise<HandoverResult>) {
    const venue = new FakeDeribit()
    const manager = new FakeManager(venue)
    const client = new SignalWebSocketClient(db as any, manager as any, null)
    const ride = createRideHandoverService(db, manager as any, { postToServer: post })
    const trade = createManualTradeService(db, manager as any, {})
    const alerts: string[] = []
    const base = (req: HandoverRequest) => ride.handover(req)
    const service = createAccumulateService(db, manager as any, {
      handover: wrap ? wrap(base) : base,
      placeMarket: (input) => trade.place({ ...input, orderType: 'market' }),
      cancelEntryRungs: (exchange, ids) => client.cancelRestingDcaRungsForSignals(exchange, ids),
      now: () => clock,
      notify: (e) => alerts.push(e.title),
    })
    await seedManualPosition(venue)
    venue.bars = history([84_600])
    clock = T0 + 49 * H + 60_000
    await service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { maxTranches: 2, rearm: true } })
    venue.mark = 85_500
    venue.bars = history([84_600, 85_500])
    clock = T0 + 50 * H + 60_000
    await service.tick()
    return { venue, service, alerts }
  }

  it('a server without tranche support cannot hand tranche 2 the ride of tranche 1; its stop stays, placed once', async () => {
    const { venue, service, alerts } = await oldServerRig()
    const stop1 = db.getServerExitState('srv-1')!.sl_order_id
    const t2 = armed()[0]
    venue.mark = 86_000
    venue.bars = history([84_600, 85_500, 86_000])
    clock = T0 + 51 * H + 60_000
    await service.tick()
    const st = service.status(t2.id)!
    expect(st.lastError).toContain('tranche support')
    expect(st.pending).toBe(true)
    expect(db.getServerExitState('srv-1')!.sl_order_id).toBe(stop1)
    expect(db.getServerExitState('srv-1')!.entry_signal_id).toBe(handoverSignalId('srv-1'))
    // Tranche 2's entry keeps its own reduce-only stop at its own size.
    const stops = venue.working('stop')
    expect(stops).toHaveLength(2)
    const own = stops.find((o) => o.id !== stop1)!
    expect(own.order.quantity).toBe(2_920)
    expect(own.order.reduceOnly).toBe(true)
    expect(alerts).toHaveLength(1)
    // Retries reuse that stop: nothing new placed, no second alert.
    const placed = venue.seq
    for (let i = 0; i < 3; i++) {
      clock += 60_000
      await service.tick()
    }
    expect(venue.working('stop').map((o) => o.id).sort()).toEqual([stop1!, own.id].sort())
    expect([...venue.orders.values()].slice(placed).filter((o) => o.order.orderType === 'stop')).toHaveLength(0)
    expect(alerts).toHaveLength(1)
  })

  it('a lost hand-over answer: the stop stays, the replay finishes the tranche exactly once', async () => {
    // New server: srv-1 for the first ride; the tranche call commits but its
    // answer is lost (502), the replay with the same key answers idempotent.
    const keys: string[] = []
    const post: Post = async (path, body) => {
      if (path !== '/api/ride/handover') return { ok: true, status: 200, body: {} }
      if (!body.trancheKey) return { ok: true, status: 200, body: { positionId: 'srv-1', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'create' } }
      keys.push(body.trancheKey)
      return keys.length === 1
        ? { ok: false, status: 502, body: { error: 'bad gateway' } }
        : { ok: true, status: 200, body: { positionId: 'srv-2', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'idempotent' } }
    }
    const { venue, service, alerts } = await oldServerRig(post)
    const t2 = armed()[0]
    venue.mark = 86_000
    venue.bars = history([84_600, 85_500, 86_000])
    clock = T0 + 51 * H + 60_000
    await service.tick()
    expect(service.status(t2.id)!.pending).toBe(true)
    const kept = venue.working('stop').find((o) => o.order.quantity === 2_920)!
    expect(kept).toBeDefined()
    expect(alerts).toHaveLength(1)
    clock += 60_000
    await service.tick()
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
    const st = service.status(t2.id)!
    expect(st.pending).toBe(false)
    expect(st.ride?.positionId).toBe('srv-2')
    expect(db.getServerExitState('srv-2')!.sl_order_id).toBe(kept.id)
    expect(db.getSignalExecution(handoverSignalId('srv-2'))!.qty_opened).toBe(2_920)
    expect(venue.working('stop')).toHaveLength(2)
    expect([...venue.orders.values()].filter((o) => o.order.orderType === 'stop' && o.order.quantity === 2_920)).toHaveLength(1)
    expect(alerts).toHaveLength(1)
    clock += 60_000
    await service.tick()
    expect(keys).toHaveLength(2)
  })

  // New server whose first tranche answer is lost (502); later calls succeed.
  function lostOnce(keys: string[]): Post {
    return async (path, body) => {
      if (path !== '/api/ride/handover') return { ok: true, status: 200, body: {} }
      if (!body.trancheKey) return { ok: true, status: 200, body: { positionId: 'srv-1', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'create' } }
      keys.push(body.trancheKey)
      return keys.length === 1
        ? { ok: false, status: 502, body: { error: 'bad gateway' } }
        : { ok: true, status: 200, body: { positionId: 'srv-2', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'idempotent' } }
    }
  }

  async function keptStopAfterLostAnswer() {
    const keys: string[] = []
    const rig = await oldServerRig(lostOnce(keys))
    const t2 = armed()[0]
    rig.venue.mark = 86_000
    rig.venue.bars = history([84_600, 85_500, 86_000])
    clock = T0 + 51 * H + 60_000
    await rig.service.tick()
    const kept = rig.venue.working('stop').find((o) => o.order.quantity === 2_920)!
    return { ...rig, keys, t2, kept }
  }

  const trancheStops = (venue: FakeDeribit) =>
    [...venue.orders.values()].filter((o) => o.order.orderType === 'stop' && o.order.quantity === 2_920)

  it('the kept tranche stop: a failed status lookup places nothing and retries', async () => {
    const { venue, service, keys, t2, kept } = await keptStopAfterLostAnswer()
    venue.failStatusIds.add(kept.id)
    clock += 60_000
    await service.tick()
    expect(service.status(t2.id)!.lastError).toContain('status lookup failed')
    expect(trancheStops(venue)).toHaveLength(1)
    expect(keys).toHaveLength(1)
    venue.failStatusIds.clear()
    clock += 60_000
    await service.tick()
    expect(service.status(t2.id)!.ride?.positionId).toBe('srv-2')
    expect(db.getServerExitState('srv-2')!.sl_order_id).toBe(kept.id)
    expect(trancheStops(venue)).toHaveLength(1)
  })

  it('the kept tranche stop filled: no hand-over, one alert', async () => {
    const { venue, service, alerts, keys, t2, kept } = await keptStopAfterLostAnswer()
    const o = venue.orders.get(kept.id)!
    o.state = 'filled'
    o.filled = o.order.quantity
    for (let i = 0; i < 2; i++) {
      clock += 60_000
      await service.tick()
    }
    expect(service.status(t2.id)!.lastError).toContain('filled before the hand-over')
    expect(service.status(t2.id)!.ride).toBeNull()
    expect(keys).toHaveLength(1)
    expect(trancheStops(venue)).toHaveLength(1)
    expect(alerts.filter((a) => a === 'Accumulate tranche stop filled before its hand-over')).toHaveLength(1)
  })

  it('a hand-over whose local finish died is adopted on replay, not taken for an old server', async () => {
    const keys: string[] = []
    let died = false
    const create: Post = async (path, body) => {
      if (path !== '/api/ride/handover') return { ok: true, status: 200, body: {} }
      if (!body.trancheKey) return { ok: true, status: 200, body: { positionId: 'srv-1', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'create' } }
      keys.push(body.trancheKey)
      return { ok: true, status: 200, body: { positionId: 'srv-2', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: keys.length === 1 ? 'create' : 'idempotent' } }
    }
    // The executor's local writes for srv-2 land, then the process "dies"
    // before the plan records its ride.
    const { venue, service, alerts } = await oldServerRig(create, (h) => async (req) => {
      const res = await h(req)
      if (req.tranche && !died) {
        died = true
        throw new Error('process died')
      }
      return res
    })
    const t2 = armed()[0]
    venue.mark = 86_000
    venue.bars = history([84_600, 85_500, 86_000])
    clock = T0 + 51 * H + 60_000
    await service.tick()
    expect(service.status(t2.id)!.ride).toBeNull()
    clock += 60_000
    await service.tick()
    expect(keys).toHaveLength(2)
    expect(service.status(t2.id)!.ride?.positionId).toBe('srv-2')
    expect(service.status(t2.id)!.lastError).toBeNull()
    expect(db.getSignalExecution(handoverSignalId('srv-2'))!.qty_opened).toBe(2_920)
    expect(trancheStops(venue).filter((o) => o.state === 'working')).toHaveLength(1)
    expect(alerts).toHaveLength(0)
  })

  it('an unreachable API keeps the tranche stop id; the retry reuses that stop', async () => {
    let calls = 0
    const post: Post = async (path, body) => {
      if (path !== '/api/ride/handover') return { ok: true, status: 200, body: {} }
      if (!body.trancheKey) return { ok: true, status: 200, body: { positionId: 'srv-1', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'create' } }
      if (++calls === 1) throw new Error('connect ECONNREFUSED')
      return { ok: true, status: 200, body: { positionId: 'srv-2', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'create' } }
    }
    const { venue, service, alerts } = await oldServerRig(post)
    const t2 = armed()[0]
    venue.mark = 86_000
    venue.bars = history([84_600, 85_500, 86_000])
    clock = T0 + 51 * H + 60_000
    await service.tick()
    const kept = venue.working('stop').find((o) => o.order.quantity === 2_920)!
    expect(kept).toBeDefined()
    expect((db.get('SELECT tranche_stop_order_id FROM accumulate_plans WHERE id = ?', [t2.id]) as { tranche_stop_order_id: string }).tranche_stop_order_id).toBe(kept.id)
    expect(alerts).toEqual(['Accumulate tranche not handed over'])
    clock += 60_000
    await service.tick()
    expect(service.status(t2.id)!.ride?.positionId).toBe('srv-2')
    expect(db.getServerExitState('srv-2')!.sl_order_id).toBe(kept.id)
    expect(trancheStops(venue)).toHaveLength(1)
  })

  it('a tranche stop that comes back filled is never handed over', async () => {
    const keys: string[] = []
    const { venue, service, alerts } = await oldServerRig(lostOnce(keys))
    const t2 = armed()[0]
    venue.trancheStopFilled = true
    venue.mark = 86_000
    venue.bars = history([84_600, 85_500, 86_000])
    clock = T0 + 51 * H + 60_000
    await service.tick()
    clock += 60_000
    await service.tick()
    expect(service.status(t2.id)!.lastError).toContain('filled before the hand-over')
    expect(service.status(t2.id)!.ride).toBeNull()
    expect(keys).toHaveLength(0)
    expect(alerts.filter((a) => a === 'Accumulate tranche stop filled before its hand-over')).toHaveLength(1)
  })

  it('an old server is refused even when tranche 1 lost its stop id', async () => {
    const { venue, service } = await oldServerRig()
    // A failed stop replace left tranche 1 without an order id.
    db.run('UPDATE server_exit_state SET sl_order_id = NULL WHERE position_id = ?', ['srv-1'])
    const t2 = armed()[0]
    venue.mark = 86_000
    venue.bars = history([84_600, 85_500, 86_000])
    clock = T0 + 51 * H + 60_000
    await service.tick()
    expect(service.status(t2.id)!.lastError).toContain('tranche support')
    expect(service.status(t2.id)!.ride).toBeNull()
    const st1 = db.getServerExitState('srv-1')!
    expect(st1.entry_signal_id).toBe(handoverSignalId('srv-1'))
    expect(db.getSignalExecution(handoverSignalId('srv-1'))!.qty_opened).toBe(2_870)
    // Not handed tranche 2's stop; a single ride's bare stop is left to the server (as on main).
    expect(st1.sl_order_id).toBeNull()
  })

  it('PATCH /:id/params switches re-arm off on a riding plan before it re-arms', async () => {
    const h = setup()
    await seedManualPosition(h.venue)
    h.venue.bars = history([84_600])
    clock = T0 + 49 * H + 60_000
    const plan = await h.service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { rearm: true, maxTranches: 2 } })
    const app = createAccumulateRoutes(h.service)
    const patch = (body: unknown) =>
      app.request(`/${plan.id}/params`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await patch({ maxTranches: 0 })).status).toBe(400)
    expect((await patch({ rearm: 'no' })).status).toBe(400)
    expect((await patch({})).status).toBe(400)
    const res = await patch({ rearm: false, rearmCooldownBars: 12 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plan: { params: { rearm: boolean; rearmCooldownBars: number; maxTranches: number } } }
    expect(body.plan.params).toMatchObject({ rearm: false, rearmCooldownBars: 12, maxTranches: 2 })
    expect((await app.request('/nope/params', { method: 'PATCH', body: '{"rearm":false}' })).status).toBe(404)
    // The breakout hands over; re-arm stays off.
    h.venue.mark = 85_500
    h.venue.bars = history([84_600, 85_500])
    clock = T0 + 50 * H + 60_000
    await h.service.tick()
    expect(h.service.status(plan.id)!.phase).toBe('riding')
    clock += H
    await h.service.tick()
    expect(armed()).toHaveLength(0)
  })

  it('(f) rearm off stays a single plan per market', async () => {
    await riding({ rearm: false })
    clock += 3 * H
    expect(armed()).toHaveLength(0)
    expect(plans()).toHaveLength(1)
  })

  it('holds the re-arm while the account is halted or the floor fired', async () => {
    const h = setup()
    await seedManualPosition(h.venue)
    h.venue.bars = history([84_600])
    clock = T0 + 49 * H + 60_000
    const plan = await h.service.create({ exchange: 'deribit', symbol: SYM, accountId: ACC, rideBotId: 'ride-bot', openedAt: ENTRY_AT, params: { rearm: false } })
    h.venue.mark = 85_500
    h.venue.bars = history([84_600, 85_500])
    clock = T0 + 50 * H + 60_000
    await h.service.tick()
    db.run('UPDATE accumulate_plans SET params = json_set(params, ?, json(?)) WHERE id = ?', ['$.rearm', 'true', plan.id])
    db.run('INSERT INTO account_halts (exchange, account_id, reason, tripped_at) VALUES (?, ?, ?, ?)', ['deribit', ACC, 'test', clock])
    await h.service.tick()
    expect(armed()).toHaveLength(0)
    db.run('DELETE FROM account_halts')
    db.run("UPDATE synthetic_usd_positions SET status = 'open', short_size = 1000 WHERE id = 'syn-btc'")
    await h.service.tick()
    expect(armed()).toHaveLength(0)
    db.run("UPDATE synthetic_usd_positions SET status = 'armed', short_size = 0 WHERE id = 'syn-btc'")
    await h.service.tick()
    expect(armed()).toHaveLength(1)
  })
})

describe('accumulate migrations', () => {
  it('a DB that ran the first 052 gets the tranche stop column and re-arm off from 053', () => {
    const path = join(dir, 'test.db')
    db.run('ALTER TABLE accumulate_plans DROP COLUMN tranche_stop_order_id')
    db.run("DELETE FROM migrations WHERE name = 'accumulate_tranche_stop'")
    db.run(
      `INSERT INTO accumulate_plans (id, exchange, account_id, symbol, direction, ride_bot_id, params, phase, reference, entry_bar_time, ladder_seq, created_at, updated_at)
       VALUES ('p1', 'deribit', 'btc', 'BTC-PERPETUAL', 'long', 'ride-bot', ?, 'riding', 85000, 0, 0, 0, 0)`,
      [JSON.stringify({ rearm: true, maxTranches: 3 })],
    )
    db.close()
    db = new KaiBotDatabase(path)
    const row = db.get('SELECT params, tranche_stop_order_id FROM accumulate_plans WHERE id = ?', ['p1']) as { params: string; tranche_stop_order_id: string | null }
    expect(row.tranche_stop_order_id).toBeNull()
    expect(JSON.parse(row.params)).toMatchObject({ rearm: false, maxTranches: 3 })
  })
})
