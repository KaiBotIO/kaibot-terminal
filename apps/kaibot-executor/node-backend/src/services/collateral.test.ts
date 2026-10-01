// Collateral floor end to end against an in-memory Bybit (real BybitAdapter,
// mocked fetch): hedge arm → fire → recovery on the USDT perp, sell floor on
// the venue with ratchet/amend, fire, buy-back and re-arm, restart
// reconcile, the pot as sizing basis, the 1x cap and the margin-ratio guard.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KaiBotDatabase } from '../storage/database.js'
import { BybitSim } from './exchanges/adapters/bybit-sim.fixture.js'
import type { BybitAdapter } from './exchanges/adapters/bybit.js'
import { orderLockIdle } from './order-lock.js'
import { createSyntheticUsdService } from './synthetic-usd.js'
import { createSyntheticGuardService, type SyntheticGuardService } from './synthetic-guard.js'
import {
  checkCollateralEntry,
  createCollateralService,
  getCollateralSizingBasis,
  resetCollateralCaches,
  type CollateralService,
} from './collateral.js'
import { getCollateralFloor, listCollateralFloorEvents } from '../storage/collateral-store.js'
import { checkManualEntryGuards } from './manual-trade-guards.js'

const ACC = 'unified'

let dir: string
let db: KaiBotDatabase
let sim: BybitSim
let adapter: BybitAdapter
let guard: SyntheticGuardService
let service: CollateralService
let events: any[]
let manager: any

function build() {
  const synth = createSyntheticUsdService(db, manager)
  const bus = { publish: (e: any) => events.push(e) } as any
  guard = createSyntheticGuardService(db, manager, synth, bus)
  service = createCollateralService(db, manager, guard, bus)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-collateral-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  sim = new BybitSim()
  sim.prices = { BTCUSDT: 100_000, ETHUSDT: 4_000, SOLUSDT: 200, XRPUSDT: 2 }
  // Coin-only UTA: no stablecoins at all.
  sim.wallet = { BTC: 0.2, ETH: 10, SOL: 100 }
  sim.install()
  adapter = sim.adapter()
  const session = { exchangeName: 'bybit', status: 'connected', adapter }
  manager = { getSession: async () => session, getAllSessions: async () => [session] }
  events = []
  resetCollateralCaches()
  build()
})

afterEach(async () => {
  await orderLockIdle()
  sim.uninstall()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function tick() {
  const positions = await adapter.getPositions()
  await guard.tickExchange('bybit', adapter, positions)
  await service.tickExchange('bybit', adapter, positions)
  await orderLockIdle()
}
const creates = () => sim.requests.filter((r) => r.path === '/v5/order/create').map((r) => r.params)

describe('hedge floor: armed synthetic on the USDT perp', () => {
  it('arm → fire (short sized to holdings × trigger, one-way, qtyStep) → recovery (reduce-only buy-back) → re-armed', async () => {
    const floor = await service.armFloor({
      exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'hedge', triggerPrice: 85_000, recoveryPct: 5,
    })
    expect(floor).toMatchObject({ mode: 'hedge', status: 'armed', symbol: 'BTCUSDT', holdingsCoin: 0.2, plannedFloorUsd: 17_000 })
    expect(creates()).toHaveLength(0)

    sim.setPrice('BTCUSDT', 84_000)
    await tick()
    const mint = creates()[0]
    // 17.000 / 84.000 = 0,20238 → floored to qtyStep 0,001
    expect(mint).toMatchObject({ category: 'linear', symbol: 'BTCUSDT', side: 'Sell', orderType: 'Market', qty: '0.202', positionIdx: 0 })
    expect(mint.reduceOnly).toBeUndefined()
    expect(sim.positions.get('BTCUSDT')!.size).toBeCloseTo(-0.202, 9)
    let v = (await service.overview('bybit', ACC)).coins.find((c) => c.coin === 'BTC')!.floor!
    expect(v.status).toBe('fired')
    expect(v.realizedFloorUsd).toBeCloseTo(0.2 * 84_000, 6)

    // Below the recovery level (85.000 × 1,05 = 89.250) nothing happens.
    sim.setPrice('BTCUSDT', 89_000)
    await tick()
    expect(creates()).toHaveLength(1)

    sim.setPrice('BTCUSDT', 90_000)
    await tick()
    const unwind = creates()[1]
    expect(unwind).toMatchObject({ side: 'Buy', qty: '0.202', reduceOnly: true, positionIdx: 0 })
    expect(sim.positions.has('BTCUSDT')).toBe(false)
    v = (await service.overview('bybit', ACC)).coins.find((c) => c.coin === 'BTC')!.floor!
    expect(v.status).toBe('armed')
    expect(v.triggerPrice).toBe(85_000)
    expect(v.cycle).toBe(1)
    // The short lost 0,202 × 6.000 in USDT: a coin-only account now carries a loan.
    expect(sim.wallet.USDT).toBeCloseTo(-0.202 * 6_000, 6)
  })

  it('an unexplained long on the perp blocks the mint instead of netting through it', async () => {
    await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'hedge', triggerPrice: 85_000 })
    sim.positions.set('BTCUSDT', { size: 0.05, avg: 95_000 })
    sim.setPrice('BTCUSDT', 84_000)
    await tick()
    expect(creates()).toHaveLength(0)
    const v = (await service.overview('bybit', ACC)).coins.find((c) => c.coin === 'BTC')!.floor!
    expect(v.lastError).toMatch(/not flat/)
    expect(v.status).toBe('armed')
  })

  it('refuses a trigger at or above the mark and holdings above the wallet', async () => {
    await expect(
      service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'hedge', triggerPrice: 100_000 }),
    ).rejects.toThrow(/below the mark/)
    await expect(
      service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'hedge', triggerPrice: 90_000, holdingsCoin: 0.3 }),
    ).rejects.toThrow(/exceed/)
  })
})

describe('sell floor: resting spot conditional on the venue', () => {
  it('arm → ratchet amends the venue trigger → fire → buy-back with the proceeds → re-armed', async () => {
    const floor = await service.armFloor({
      exchange: 'bybit', accountId: ACC, coin: 'ETH', mode: 'sell', triggerPrice: 3_400,
      trailPct: 10, recoveryPct: 5, tolerancePct: 0.5, buyBack: true,
    })
    expect(floor).toMatchObject({ mode: 'sell', status: 'armed', buyBack: true, plannedFloorUsd: 34_000 })
    expect(sim.openOrders()).toHaveLength(1)
    // tolerance widens the venue trigger: 3.400 × 0,995
    expect(sim.openOrders()[0]).toMatchObject({ side: 'Sell', qty: 10, triggerPrice: 3_383, orderFilter: 'StopOrder' })

    sim.setPrice('ETHUSDT', 4_500)
    await tick()
    let row = getCollateralFloor(db, floor.id)!
    expect(row.trigger_price).toBe(4_050)
    expect(sim.openOrders()[0].triggerPrice).toBeCloseTo(4_029.75, 2)
    expect(sim.requests.some((r) => r.path === '/v5/order/amend')).toBe(true)

    // The venue fires with nobody watching.
    sim.setPrice('ETHUSDT', 4_000)
    expect(sim.wallet.ETH).toBe(0)
    await tick()
    row = getCollateralFloor(db, floor.id)!
    expect(row.status).toBe('fired')
    expect(row.fired_price).toBe(4_000)
    expect(row.proceeds_usd).toBeCloseTo(40_000 - 40, 6)
    // Buy-back rests at the fired trigger + 5 %, spending the proceeds only.
    const bb = sim.openOrders()[0]
    expect(bb).toMatchObject({ side: 'Buy', marketUnit: 'quoteCoin', orderFilter: 'StopOrder' })
    expect(bb.triggerPrice).toBeCloseTo(4_252.5, 2)
    expect(bb.qty).toBeCloseTo(39_960, 4)
    expect(events.some((e) => e.title === 'Collateral floor sold')).toBe(true)

    await service.updateSettings({ exchange: 'bybit', accountId: ACC, sizingBasis: 'floor' })
    const pot = await getCollateralSizingBasis(db, 'bybit', ACC, adapter)
    expect(pot!.components.find((c) => c.coin === 'ETH')).toMatchObject({ source: 'sold' })

    sim.setPrice('ETHUSDT', 4_300)
    await tick()
    row = getCollateralFloor(db, floor.id)!
    expect(row.status).toBe('armed')
    expect(row.trigger_price).toBe(4_050)
    expect(row.holdings_coin).toBeCloseTo((39_960 / 4_300) * 0.999, 6)
    const resting = sim.openOrders()
    expect(resting).toHaveLength(1)
    expect(resting[0].side).toBe('Sell')
    expect(listCollateralFloorEvents(db, floor.id).map((e) => e.kind)).toEqual(['arm', 'ratchet', 'fired', 'buy_back'])
  })

  it('the order lives on the venue: fired while the executor was down, reconciled by a fresh process', async () => {
    const floor = await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'sell', triggerPrice: 90_000 })
    sim.setPrice('BTCUSDT', 88_000)
    build() // restart: new service instances, same DB
    await tick()
    const row = getCollateralFloor(db, floor.id)!
    expect(row.status).toBe('fired')
    expect(row.fired_qty).toBeCloseTo(0.2, 9)
    expect(row.proceeds_usd).toBeCloseTo(0.2 * 88_000 * 0.999, 6)
  })

  it('a crash between the venue ack and the persist is adopted by orderLinkId, never placed twice', async () => {
    const floor = await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'SOL', mode: 'sell', triggerPrice: 150 })
    const row = getCollateralFloor(db, floor.id)!
    // Forget the venue id as if the process died before persisting it.
    db.run('UPDATE collateral_floors SET venue_order_id = NULL WHERE id = ?', [row.id])
    build()
    await tick()
    expect(getCollateralFloor(db, floor.id)!.venue_order_id).toBe(row.venue_order_id)
    expect(creates()).toHaveLength(1)
  })

  it('an order cancelled on the venue surfaces as an error; update places it again', async () => {
    const floor = await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'sell', triggerPrice: 90_000 })
    sim.openOrders()[0].orderStatus = 'Cancelled'
    // The next periodic venue check (15 s later).
    db.run('UPDATE collateral_floors SET last_check_at = 0 WHERE id = ?', [floor.id])
    await tick()
    let row = getCollateralFloor(db, floor.id)!
    expect(row.venue_order_id).toBeNull()
    expect(row.last_error).toMatch(/gone from the venue/)
    await service.updateFloor(floor.id, { triggerPrice: 91_000 })
    row = getCollateralFloor(db, floor.id)!
    expect(row.venue_order_id).not.toBeNull()
    expect(sim.openOrders()[0].triggerPrice).toBe(91_000)
  })

  it('a venue rejection at arm leaves no floor behind', async () => {
    sim.failNextCreate = 'Insufficient balance'
    await expect(
      service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'sell', triggerPrice: 90_000 }),
    ).rejects.toThrow(/Insufficient/)
    const ov = await service.overview('bybit', ACC)
    expect(ov.coins.find((c) => c.coin === 'BTC')!.floor).toBeNull()
  })
})

describe('one floor per coin, mode switch = disarm + arm', () => {
  it('refuses a second floor, disarm cancels the venue order, then the other mode arms', async () => {
    const sell = await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'sell', triggerPrice: 90_000 })
    await expect(
      service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'hedge', triggerPrice: 88_000 }),
    ).rejects.toThrow(/already has a floor/)
    const closed = await service.disarmFloor(sell.id)
    expect(closed.status).toBe('closed')
    expect(sim.openOrders()).toHaveLength(0)
    const hedge = await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'hedge', triggerPrice: 88_000 })
    expect(hedge.mode).toBe('hedge')
    await service.disarmFloor(hedge.id)
    expect(db.getSyntheticUsdPosition(hedge.syntheticPositionId!)!.status).toBe('closed')
  })
})

describe('pot as sizing basis, 1x cap, margin-ratio guard', () => {
  beforeEach(async () => {
    await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'hedge', triggerPrice: 85_000 })
    await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'ETH', mode: 'sell', triggerPrice: 3_400 })
  })

  it('off by default; on: pot = Σ coins × trigger × venue ratio, SOL (no floor) excluded', async () => {
    expect(await getCollateralSizingBasis(db, 'bybit', ACC, adapter)).toBeNull()
    service.updateSettings({ exchange: 'bybit', accountId: ACC, sizingBasis: 'floor' })
    const pot = await getCollateralSizingBasis(db, 'bybit', ACC, adapter)
    expect(pot!.basisUsd).toBeCloseTo(0.2 * 85_000 * 0.95 + 10 * 3_400 * 0.95, 6)
    service.updateSettings({ exchange: 'bybit', accountId: ACC, unfloored: 'margin' })
    resetCollateralCaches()
    const withSol = await getCollateralSizingBasis(db, 'bybit', ACC, adapter)
    // SOL tier 0,9 below 50.000 coins
    expect(withSol!.basisUsd).toBeCloseTo(48_450 + 100 * 200 * 0.9, 6)
  })

  it('the cap refuses an entry past 1x the pot; an order closing an opposing position is credited', async () => {
    service.updateSettings({ exchange: 'bybit', accountId: ACC, sizingBasis: 'floor' })
    sim.positions.set('SOLUSDT', { size: 150, avg: 200 }) // 30.000 open
    const ok = await checkCollateralEntry(db, 'bybit', ACC, adapter, { symbol: 'XRPUSDT', side: 'buy', quantity: 9_000 })
    expect(ok.ok).toBe(true) // 30.000 + 18.000 ≤ 48.450
    const no = await checkCollateralEntry(db, 'bybit', ACC, adapter, { symbol: 'XRPUSDT', side: 'buy', quantity: 10_000 })
    expect(no).toMatchObject({ ok: false, guard: 'collateral cap' })
    const close = await checkCollateralEntry(db, 'bybit', ACC, adapter, { symbol: 'SOLUSDT', side: 'sell', quantity: 150 })
    expect(close.ok).toBe(true)
  })

  it('entries are refused from the block threshold, with or without the collateral basis', async () => {
    sim.mmRate = 0.61
    resetCollateralCaches()
    const r = await checkCollateralEntry(db, 'bybit', ACC, adapter, { symbol: 'XRPUSDT', side: 'buy', quantity: 1 })
    expect(r).toMatchObject({ ok: false, guard: 'margin ratio' })
    expect(r.reason).toMatch(/61\.0%/)
    service.updateSettings({ exchange: 'bybit', accountId: ACC, blockMmrPct: 70, warnMmrPct: 85 })
    const again = await checkCollateralEntry(db, 'bybit', ACC, adapter, { symbol: 'XRPUSDT', side: 'buy', quantity: 1 })
    expect(again.ok).toBe(true)
  })

  it('the manual entry path runs the same gate', async () => {
    sim.mmRate = 0.9
    resetCollateralCaches()
    const r = await checkManualEntryGuards(db, adapter, {
      exchange: 'bybit', accountId: ACC, symbol: 'XRPUSDT', orderType: 'market', quantity: 10, side: 'buy',
    })
    expect(r).toMatchObject({ ok: false, guard: 'margin ratio' })
  })
})

describe('coin-only collateral in the pre-flight', () => {
  it('a negative USDT balance does not block an order the UTA margin covers', async () => {
    sim.wallet.USDT = -2_500 // a loan from earlier perp losses
    db.setMarginGuard('bybit', ACC, { enabled: true, bufferMult: 1, floorMode: 'maintenance', equityPct: 0.2 })
    const r = await checkManualEntryGuards(db, adapter, {
      exchange: 'bybit', accountId: ACC, symbol: 'XRPUSDT', orderType: 'market', quantity: 500, side: 'buy',
    })
    expect(r.ok).toBe(true)
  })
})

describe('margin warning and opt-in auto-reduce', () => {
  it('warns (throttled) above the warning threshold and places nothing by default', async () => {
    service.updateSettings({ exchange: 'bybit', accountId: ACC })
    sim.positions.set('SOLUSDT', { size: 100, avg: 200 })
    sim.mmRate = 0.85
    resetCollateralCaches()
    await tick()
    await tick()
    expect(events.filter((e) => e.title === 'Margin ratio high')).toHaveLength(1)
    expect(creates()).toHaveLength(0)
  })

  it('with auto-reduce on, cuts the largest non-hedge position by the set percentage, reduce-only', async () => {
    service.updateSettings({ exchange: 'bybit', accountId: ACC, autoReduce: true, autoReducePct: 50 })
    sim.positions.set('SOLUSDT', { size: 100, avg: 200 })
    sim.positions.set('XRPUSDT', { size: 1_000, avg: 2 })
    sim.mmRate = 0.85
    resetCollateralCaches()
    await tick()
    const cut = creates()[0]
    expect(cut).toMatchObject({ symbol: 'SOLUSDT', side: 'Sell', qty: '50.0', reduceOnly: true })
    expect(sim.positions.get('SOLUSDT')!.size).toBe(50)
  })
})
