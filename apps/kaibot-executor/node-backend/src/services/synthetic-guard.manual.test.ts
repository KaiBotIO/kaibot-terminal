import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KaiBotDatabase } from '../storage/database.js'
import { PaperExchangeAdapter } from './exchanges/adapters/paper.js'
import type { OpenOrder } from './exchanges/types.js'
import { orderLockIdle } from './order-lock.js'
import { createSyntheticUsdService } from './synthetic-usd.js'
import { createAccumulateStore } from './accumulate-ride-store.js'
import { createSyntheticUsdRoutes } from '../routes/synthetic-usd.js'
import { SignalWebSocketClient } from '../websocket/signal-client.js'
import {
  assessArmedMint,
  armedView,
  createSyntheticGuardService,
  manualCoverNative,
  type SyntheticGuardService,
} from './synthetic-guard.js'

const INV = 'BTC-PERPETUAL'

describe('manual cover pure rules', () => {
  it('covers only a manual position in the holdings direction, and only with coverManual on', () => {
    expect(manualCoverNative('long', 2_950, true)).toBe(2_950)
    expect(manualCoverNative('long', 2_950, false)).toBe(0)
    expect(manualCoverNative('long', -500, true)).toBe(0)
  })

  it('assessArmedMint: flat mints, a matching short adopts, anything else blocks', () => {
    expect(assessArmedMint({ syntheticShort: 0, expectedShortNative: 10_000, stepSize: 10 })).toEqual({ kind: 'mint' })
    expect(assessArmedMint({ syntheticShort: 10_000, expectedShortNative: 10_000, stepSize: 10 })).toEqual({
      kind: 'adopt', liveShort: 10_000,
    })
    const blocked = assessArmedMint({ syntheticShort: -2_000, expectedShortNative: 10_000, stepSize: 10 })
    expect(blocked.kind).toBe('blocked')
  })

  it('view: the over-hedge excludes the covered manual long', () => {
    const open = {
      status: 'open', arm_direction: 'long', arm_trigger_price: 90_000, arm_holdings_coin: 2,
      arm_fired_trigger_price: 90_000, arm_fired_price: 89_000, target_usd: 190_000,
      arm_covered_manual_usd: 10_000, arm_cover_manual: 1, arm_tolerance_pct: 0, arm_cycle: 1,
    } as any
    const v = armedView(open)
    expect(v.coveredManualUsd).toBe(10_000)
    expect(v.overHedgeUsd).toBe(2_000) // 190k − 10k − 2 × 89k
    expect(v.coverManual).toBe(true)
  })
})

describe('armed synthetic with manual positions', () => {
  let dir: string
  let db: KaiBotDatabase
  let adapter: PaperExchangeAdapter
  let manager: any
  let guard: SyntheticGuardService
  let events: any[]
  let cancelCalls: string[][]

  function build(withDeps = true) {
    const service = createSyntheticUsdService(db, manager)
    cancelCalls = []
    // Stands in for the signal client's verify-before-drop rung cancel.
    const cancelEntryRungs = async (_exchange: string, signalIds: string[]) => {
      cancelCalls.push(signalIds)
      for (const id of signalIds) {
        for (const r of db.getDcaRestingRungsForSignal(id)) {
          await adapter.cancelOrder(r.order_id)
          db.deleteDcaRestingRung(r.order_id)
        }
      }
    }
    guard = createSyntheticGuardService(
      db, manager, service, { publish: (e: any) => events.push(e) } as any, 'default',
      withDeps ? { cancelEntryRungs } : {},
    )
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kaibot-floor-manual-'))
    db = new KaiBotDatabase(join(dir, 'test.db'))
    adapter = new PaperExchangeAdapter('deribit', { [INV]: 100_000 })
    manager = { getSession: async () => ({ status: 'connected', adapter }) }
    events = []
    build()
  })

  afterEach(async () => {
    await orderLockIdle()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function tick() {
    await guard.tickExchange('deribit', adapter, await adapter.getPositions())
    await orderLockIdle()
  }
  const market = { exchange: 'deribit', accountId: 'btc', symbol: INV }
  const sells = () => adapter.getOrders().filter((o) => o.order.side === 'sell')
  async function manualLong(qty: number) {
    await adapter.placeOrder({ accountId: 'btc', symbol: INV, side: 'buy', orderType: 'market', quantity: qty } as any)
    db.addManualPosition('deribit', 'btc', INV, 'buy', qty)
  }
  function rung(orderId: string, signalId: string, price: number, side: 'buy' | 'sell' = 'buy') {
    db.insertDcaRestingRung({ orderId, signalId, exchange: 'deribit', accountId: 'btc', symbol: INV, side, qty: 100, price })
  }
  async function venuePosition() {
    return (await adapter.getPositions()).find((p) => p.symbol === INV && Math.abs(p.size) > 0) ?? null
  }

  it('coverManual (default): mint = planned + manual long, venue net short = planned, netting in the meta', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    expect(row.arm_cover_manual).toBe(1)
    await manualLong(10_000)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.short_size).toBe(100_000)
    expect(pos.arm_covered_manual_usd).toBe(10_000)
    expect(sells().map((o) => o.order.quantity)).toEqual([100_000])
    expect(await venuePosition()).toMatchObject({ side: 'short', size: 90_000 })
    const meta = JSON.parse(db.listSyntheticUsdMutations(row.id).find((m) => m.kind === 'mint')!.meta!)
    expect(meta).toMatchObject({
      plannedUsd: 90_000, coveredManualUsd: 10_000, coverManual: true,
      manualNetBefore: 10_000, venueNetShortBefore: -10_000, nettedManualNative: 0, overHedgeUsd: 1_000,
    })
    expect(guard.view(pos).coveredManualUsd).toBe(10_000)
  })

  it('coverManual off: mint = planned only, the manual long nets part of the short away', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1, coverManual: false })
    expect(row.arm_cover_manual).toBe(0)
    await manualLong(10_000)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(sells().map((o) => o.order.quantity)).toEqual([90_000])
    expect(await venuePosition()).toMatchObject({ side: 'short', size: 80_000 })
    const meta = JSON.parse(db.listSyntheticUsdMutations(row.id).find((m) => m.kind === 'mint')!.meta!)
    expect(meta).toMatchObject({ coverManual: false, coveredManualUsd: 0, nettedManualNative: 10_000 })
  })

  it('updateArm toggles coverManual', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    expect(guard.updateArm(row.id, { coverManual: false }).arm_cover_manual).toBe(0)
    expect(guard.updateArm(row.id, { coverManual: true }).arm_cover_manual).toBe(1)
  })

  it('a position beyond the manual marker still blocks (unexplained)', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    await manualLong(10_000)
    await adapter.placeOrder({ accountId: 'btc', symbol: INV, side: 'buy', orderType: 'market', quantity: 5_000 } as any)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('armed')
    expect(pos.arm_last_error).toMatch(/not flat/)
    expect(sells()).toHaveLength(0)
  })

  it('a lineage long (acct1 case) is unchanged: explained by the signal book, not covered', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    db.insertSignalExecution({ signalId: 'adopted-long', symbol: INV, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 1_000, accountId: 'btc' })
    await adapter.placeOrder({ accountId: 'btc', symbol: INV, side: 'buy', orderType: 'market', quantity: 1_000 } as any)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(sells().map((o) => o.order.quantity)).toEqual([90_000])
    expect(pos.arm_covered_manual_usd).toBe(0)
  })

  it('cancels manual entry rungs at the fire, keeps bot DCA and exit-side rungs, and logs which', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    await manualLong(10_000)
    rung('dca-1', 'manual:entry-1', 88_000)
    rung('dca-2', 'manual:entry-1', 87_000)
    rung('bot-dca', 'bot-signal-1', 88_500)
    rung('tp-like', 'manual:entry-2', 95_000, 'sell')
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    expect(cancelCalls).toEqual([['manual:entry-1']])
    const left = db.listDcaRestingRungs('deribit').map((r) => r.order_id).sort()
    expect(left).toEqual(['bot-dca', 'tp-like'])
    const m = db.listSyntheticUsdMutations(row.id).find((x) => x.kind === 'floor_rungs_cancelled')!
    expect(JSON.parse(m.meta!)).toMatchObject({ cancelled: ['dca-1', 'dca-2'], failed: [], reArmReplaces: false })
    expect(events.some((e) => /entry rungs cancelled/.test(e.title))).toBe(true)
  })

  it('without the signal-client hook the rungs are cancelled on the adapter directly', async () => {
    build(false)
    await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    rung('dca-1', 'manual:entry-1', 88_000)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    expect(db.listDcaRestingRungs('deribit')).toHaveLength(0)
  })

  it('also cancels labeled manual rungs the executor never tracked (venue open orders)', async () => {
    const venueOrders: OpenOrder[] = [
      { orderId: 'v-1', symbol: INV, side: 'buy', type: 'limit', amount: 80, price: 88_000, triggerPrice: null, reduceOnly: false, label: 'kaibot-manual-dca3', state: 'open', createdAtMs: null },
      { orderId: 'v-stop', symbol: INV, side: 'sell', type: 'stop_market', amount: 80, price: null, triggerPrice: 80_000, reduceOnly: true, label: 'kaibot-manual-sl', state: 'open', createdAtMs: null },
      { orderId: 'v-other', symbol: INV, side: 'buy', type: 'limit', amount: 80, price: 88_000, triggerPrice: null, reduceOnly: false, label: 'someone-else', state: 'open', createdAtMs: null },
    ]
    ;(adapter as any).getOpenOrders = async () => venueOrders
    const cancelled: string[] = []
    const orig = adapter.cancelOrder.bind(adapter)
    adapter.cancelOrder = async (id: string) => {
      cancelled.push(id)
      return orig(id)
    }
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    const pre = await guard.preflight(row.id)
    expect(pre.rungsToCancel).toEqual([{ orderId: 'v-1', price: 88_000, qty: 80, source: 'venue' }])
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    expect(cancelled).toEqual(['v-1'])
  })

  it('recovery buys back exactly what the mint sold: the manual long is open again, rungs are not re-placed', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1, recoveryPct: 2 })
    await manualLong(10_000)
    rung('dca-1', 'manual:entry-1', 88_000)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.short_size).toBe(100_000)

    adapter.setMarkPrice(INV, 92_000) // > 90k × 1,02
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('armed')
    expect(pos.arm_trigger_price).toBe(90_000)
    expect(pos.arm_covered_manual_usd).toBeNull()
    const buys = adapter.getOrders().filter((o) => o.order.side === 'buy' && o.order.quantity === 100_000)
    expect(buys).toHaveLength(1)
    expect(buys[0].reduceOnly).toBe(false)
    expect(await venuePosition()).toMatchObject({ side: 'long', size: 10_000 })
    // No new resting entry orders after the recovery.
    expect(adapter.getOrders().filter((o) => o.order.orderType === 'limit')).toHaveLength(0)
    expect(db.listDcaRestingRungs('deribit')).toHaveLength(0)
    const rec = JSON.parse(db.listSyntheticUsdMutations(row.id).find((m) => m.kind === 'recovery_close')!.meta!)
    expect(rec.coveredManualUsdRestored).toBe(10_000)
    expect(events.find((e) => e.type === 'synthetic_armed_closed').body).toMatch(/Manual long of \$10\.000 is open again/)
  })

  it('restart safety with a covered manual long: adopts planned + covered and still cancels the rungs', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    await manualLong(10_000)
    rung('dca-1', 'manual:entry-1', 88_000)
    // Mint filled, process died before the persist.
    await adapter.placeOrder({ accountId: 'btc', symbol: INV, side: 'sell', orderType: 'market', quantity: 100_000 } as any)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.short_size).toBe(100_000)
    expect(pos.arm_covered_manual_usd).toBe(10_000)
    expect(sells()).toHaveLength(1)
    expect(JSON.parse(db.listSyntheticUsdMutations(row.id).find((m) => m.kind === 'mint')!.meta!).adopted).toBe(true)
    expect(db.listDcaRestingRungs('deribit')).toHaveLength(0)
  })

  it('stops an active accumulate plan on the market and cancels its rungs', async () => {
    const store = createAccumulateStore(db)
    store.insert({
      id: 'plan-1', exchange: 'deribit', account_id: 'btc', symbol: INV, direction: 'long', ride_bot_id: 'ride',
      params: '{}', phase: 'ladder', reference: 100_000, entry_bar_time: 0, local_level: null,
      last_evaluated_bar: null, ladder_seq: 1, basis_usd: null, ride_position_id: null,
      ride_entry_signal_id: 'ride-entry', stop_sized_qty: null, pending: null, last_note: null,
      last_error: null, last_breakout: null,
    })
    store.upsertRung({ order_id: 'acr-1', plan_id: 'plan-1', ladder_seq: 1, idx: 0, price: 88_000, qty: 100, state: 'open', filled_qty: 0, adopted: 0 })
    rung('acr-1', 'ride-entry', 88_000)
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    expect((await guard.preflight(row.id)).accumulatePlanId).toBe('plan-1')
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    expect(store.get('plan-1')!.phase).toBe('stopped')
    expect(store.get('plan-1')!.last_note).toMatch(/floor fired/)
    expect(store.rungs('plan-1')[0].state).toBe('cancelled')
    expect(db.listDcaRestingRungs('deribit')).toHaveLength(0)
  })

  it('preflight: green with the covered manual long, red with the reason, no order either way', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    await manualLong(10_000)
    rung('dca-1', 'manual:entry-1', 88_000)
    let p = await guard.preflight(row.id)
    expect(p).toMatchObject({
      canFire: true, reason: null, connected: true, manualNet: 10_000, venueNetShort: -10_000,
      syntheticShort: 0, coveredManualUsd: 10_000, mintUsd: 100_000, capped: false,
    })
    expect(p.rungsToCancel).toEqual([{ orderId: 'dca-1', price: 88_000, qty: 100, source: 'manual' }])
    await adapter.placeOrder({ accountId: 'btc', symbol: INV, side: 'buy', orderType: 'market', quantity: 5_000 } as any)
    p = await guard.preflight(row.id)
    expect(p.canFire).toBe(false)
    expect(p.reason).toMatch(/not flat/)
    expect(sells()).toHaveLength(0)
  })

  it('preflight reports a missing connection', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    manager.getSession = async () => ({ status: 'error', adapter })
    const p = await guard.preflight(row.id)
    expect(p).toMatchObject({ canFire: false, connected: false })
    expect(p.reason).toMatch(/not connected/)
  })

  it('GET /api/synthetic-usd/:id/preflight serves it', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 1 })
    const app = createSyntheticUsdRoutes(db, manager, { guard })
    const res = await app.request(`/${row.id}/preflight`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: row.id, canFire: true })
    expect((await app.request('/nope/preflight')).status).toBe(404)
  })
})

describe('manual rung fills grow the manual marker', () => {
  it('books a manual rung fill into manual_positions (and still not into signal_fills)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kaibot-rung-marker-'))
    const db = new KaiBotDatabase(join(dir, 'test.db'))
    try {
      db.addManualPosition('deribit', 'btc', INV, 'buy', 2_950)
      db.insertDcaRestingRung({ orderId: 'r-1', signalId: 'manual:entry-1', exchange: 'deribit', accountId: 'btc', symbol: INV, side: 'buy', qty: 80, price: 82_000 })
      const client = new SignalWebSocketClient(db, { getSession: async () => null } as any, null)
      const row = db.listDcaRestingRungs('deribit')[0]
      expect((client as any).bookRestingRungFillDelta(row, 80, 82_000)).toBe(80)
      expect(db.getManualPosition('deribit', 'btc', INV)!.net).toBe(3_030)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
