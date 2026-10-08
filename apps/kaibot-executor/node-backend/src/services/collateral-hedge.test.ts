// Virtual hedge leg of a sell floor against the in-memory Bybit: the cold
// wallet is shorted on the perp when the sell floor breaks, refused when the
// account cannot carry it, alerted in three traps, never reduced by the MMR
// guard. Numbers mirror bybit/unified on 05/10/2026.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { BybitSim } from './exchanges/adapters/bybit-sim.fixture.js'
import type { BybitAdapter } from './exchanges/adapters/bybit.js'
import { orderLockIdle } from './order-lock.js'
import { resetDynamicConstraints } from './exchanges/contract-constraints.js'
import { createSyntheticUsdService } from './synthetic-usd.js'
import { createSyntheticGuardService, type SyntheticGuardService } from './synthetic-guard.js'
import {
  createCollateralService,
  getCollateralSizingBasis,
  liveHedgeLeg,
  resetCollateralCaches,
  type CollateralService,
} from './collateral.js'
import { getCollateralFloor, getCollateralSettings, listCollateralFloorEvents } from '../storage/collateral-store.js'
import { createRoleMiddleware } from '../auth/roles.js'
import type { AccountGrant, UserRole } from '../storage/types.js'
import { createCollateralRoutes } from '../routes/collateral.js'

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
  dir = mkdtempSync(join(tmpdir(), 'kaibot-collateral-hedge-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  sim = new BybitSim()
  sim.prices = { BTCUSDT: 86_000, ETHUSDT: 2_700, SOLUSDT: 120 }
  sim.wallet = { BTC: 0.05, ETH: 0.264, SOL: 4 }
  sim.mmRate = 0
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
  resetDynamicConstraints()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function tick() {
  resetCollateralCaches()
  const positions = await adapter.getPositions()
  await guard.tickExchange('bybit', adapter, positions)
  await service.tickExchange('bybit', adapter, positions)
  await orderLockIdle()
}
const creates = () => sim.requests.filter((r) => r.path === '/v5/order/create').map((r) => r.params)
const linear = () => creates().filter((p) => p.category === 'linear')
const alerts = (trap?: string) => events.filter((e) => e.type === 'collateral_alert' && (!trap || e.data?.trap === trap))
const cold = (coin: string, quantity: number) =>
  service.setVirtualLine({ exchange: 'bybit', accountId: ACC, coin, quantity, label: 'cold-wallet' })

async function kaiBook(coverage: 'hedge' | 'none') {
  cold('BTC', 0.079)
  cold('ETH', 1.35)
  cold('SOL', 115)
  service.updateSettings({ exchange: 'bybit', accountId: ACC, sizingBasis: 'floor', virtualCoverage: coverage })
  const arm = (coin: string, triggerPrice: number) =>
    service.armFloor({
      exchange: 'bybit', accountId: ACC, coin, mode: 'sell', triggerPrice, tolerancePct: 0.5, recoveryPct: 5, buyBack: true,
    })
  return { btc: await arm('BTC', 76_905), eth: await arm('ETH', 2_471), sol: await arm('SOL', 109) }
}

describe('virtualCoverage setting', () => {
  it("defaults to 'none': virtual lines are counted, not protected, and the view says how much", async () => {
    expect(getCollateralSettings(db, 'bybit', ACC).virtualCoverage).toBe('none')
    await kaiBook('none')
    expect(db.listArmCycleSyntheticUsdPositions()).toHaveLength(0)
    const o = await service.overview('bybit', ACC)
    const sol = o.coins.find((c) => c.coin === 'SOL')!
    expect(sol.hedge).toMatchObject({ enabled: true, status: 'off', qty: 115, notionalUsd: 115 * 109 })
    const n = 0.079 * 76_905 + 1.35 * 2_471 + 115 * 109
    expect(o.coverage.mode).toBe('none')
    expect(o.coverage.unprotectedUsd).toBeCloseTo(n, 6)
    // The plan still shows what 'hedge' would mean for this account.
    expect(o.coverage.plan.notionalUsd).toBeCloseTo(n, 6)
    expect(o.coverage.plan.leverage!).toBeCloseTo(n / (0.05 * 76_905 + 0.264 * 2_471 + 4 * 109), 6)
  })

  it('rejects an unknown coverage', () => {
    expect(() => service.updateSettings({ exchange: 'bybit', accountId: ACC, virtualCoverage: 'all' as any })).toThrow(
      /virtualCoverage/,
    )
  })

  it("switching to 'hedge' arms the legs, back to 'none' retires them", async () => {
    const { sol } = await kaiBook('none')
    service.updateSettings({ exchange: 'bybit', accountId: ACC, virtualCoverage: 'hedge' })
    const res = await service.syncHedges('bybit', ACC)
    expect(res.map((r) => [r.coin, r.status])).toEqual([['BTC', 'armed'], ['ETH', 'armed'], ['SOL', 'armed']])
    const leg = liveHedgeLeg(db, getCollateralFloor(db, sol.id)!)!
    expect(leg).toMatchObject({ symbol: 'SOLUSDT', status: 'armed', arm_holdings_coin: 115, arm_trigger_price: 109, arm_tolerance_pct: 0.5 })
    expect(leg.arm_cover_manual).toBe(0)
    expect(linear()).toHaveLength(0)

    service.updateSettings({ exchange: 'bybit', accountId: ACC, virtualCoverage: 'none' })
    await service.syncHedges('bybit', ACC)
    expect(db.listArmCycleSyntheticUsdPositions()).toHaveLength(0)
    expect((await service.overview('bybit', ACC)).coverage.unprotectedUsd).toBeGreaterThan(0)
  })
})

describe('hedge leg fires with the sell floor', () => {
  it('breach → spot sell of the venue coins + perp short of the virtual qty; the 1x cap does not stop it', async () => {
    const { sol } = await kaiBook('hedge')
    expect(sim.openOrders().filter((o) => o.symbol === 'SOLUSDT')).toHaveLength(1)

    sim.setPrice('SOLUSDT', 108)
    await tick()
    // Venue sold the 4 SOL at the conditional (109 × 0,995 = 108,455).
    const row = getCollateralFloor(db, sol.id)!
    expect(row.status).toBe('fired')
    expect(row.fired_qty).toBeCloseTo(4, 9)
    // Leg: 115 × 109 = 12.535 USD / 108 = 116,06 → qtyStep 0,1
    expect(linear()).toHaveLength(1)
    expect(linear()[0]).toMatchObject({ symbol: 'SOLUSDT', side: 'Sell', orderType: 'Market', qty: '116.0' })
    expect(sim.positions.get('SOLUSDT')!.size).toBeCloseTo(-116, 9)

    const o = await service.overview('bybit', ACC)
    const hedge = o.coins.find((c) => c.coin === 'SOL')!.hedge!
    expect(hedge).toMatchObject({ status: 'fired', firedPrice: 108, shortSize: 116 })
    // Locked as USD in the pot, not counted as open risk.
    const comp = o.pot.components.find((c) => c.coin === 'SOL' && c.virtual)!
    expect(comp).toEqual({ coin: 'SOL', usd: 115 * 108, source: 'hedged', virtual: true })
    expect(o.pot.usedNotionalUsd).toBe(0)
    const basis = await getCollateralSizingBasis(db, 'bybit', ACC, adapter)
    expect(basis!.components.find((c) => c.source === 'hedged')).toBeTruthy()
  })

  // The hedge protects: an account halt (daily-loss trip) never holds it back.
  it('fires the hedge leg on a halted account', async () => {
    await kaiBook('hedge')
    db.setAccountHalt('bybit', ACC, true, 'daily_loss')
    sim.setPrice('SOLUSDT', 108)
    await tick()
    expect(linear()).toHaveLength(1)
    expect(linear()[0]).toMatchObject({ symbol: 'SOLUSDT', side: 'Sell', qty: '116.0' })
  })

  it('fires a hedge-mode floor on a halted account', async () => {
    await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'hedge', triggerPrice: 80_000, holdingsCoin: 0.05, tolerancePct: 0 })
    db.setAccountHalt('bybit', ACC, true, 'daily_loss')
    sim.setPrice('BTCUSDT', 79_000)
    await tick()
    expect(linear().filter((p) => p.symbol === 'BTCUSDT' && p.side === 'Sell')).toHaveLength(1)
  })

  it('recovery unwinds the short and re-arms; the next breach alerts again (dedup resets per cycle)', async () => {
    await kaiBook('hedge')
    sim.setPrice('SOLUSDT', 108)
    await tick()
    await tick()
    expect(alerts('fired')).toHaveLength(1)
    expect(alerts('fired')[0].body).toMatch(/^Short 12\.\d{3} USD at 108, leverage \d+,\dx, liquidation at [\d.,]+\./)

    // 109 × 1,05 = 114,45: short bought back, sell floor buys back.
    sim.setPrice('SOLUSDT', 115)
    await tick()
    await tick()
    expect(linear().at(-1)).toMatchObject({ side: 'Buy', reduceOnly: true })
    expect(sim.positions.has('SOLUSDT')).toBe(false)

    sim.setPrice('SOLUSDT', 108)
    await tick()
    await tick()
    expect(alerts('fired')).toHaveLength(2)
  })
})

describe('arm rules', () => {
  it('refuses above 5x with the deposit it needs, once; the other legs still arm', async () => {
    cold('SOL', 1_000)
    service.updateSettings({ exchange: 'bybit', accountId: ACC, virtualCoverage: 'hedge' })
    const btc = await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'sell', triggerPrice: 76_905 })
    const sol = await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'SOL', mode: 'sell', triggerPrice: 109 })
    expect(sol.status).toBe('armed')
    expect(liveHedgeLeg(db, getCollateralFloor(db, sol.id)!)).toBeNull()
    await tick()
    // Amounts in the reason drift with the mark: still the same cause, no new alert.
    sim.setPrice('BTCUSDT', 87_500)
    await tick()
    const refused = alerts('refused')
    expect(refused).toHaveLength(1)
    expect(refused[0].body).toMatch(/^Leverage after it fires 21,98x \(max 5x\); liquidation [\d,]+% above the trigger \(min 15%\)\. Deposit [\d.]+ USD to arm it$/)
    const h = (await service.overview('bybit', ACC)).coins.find((c) => c.coin === 'SOL')!.hedge!
    expect(h.status).toBe('refused')
    expect(h.topUpToArmUsd).toBeGreaterThan(0)
    expect(liveHedgeLeg(db, getCollateralFloor(db, btc.id)!)).toBeNull() // BTC has no virtual line
  })

  it('refuses a liquidation closer than 15 %', async () => {
    sim.perpMmr.SOLUSDT = 0.25
    cold('SOL', 115)
    service.updateSettings({ exchange: 'bybit', accountId: ACC, virtualCoverage: 'hedge' })
    await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'BTC', mode: 'sell', triggerPrice: 76_905 })
    await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'ETH', mode: 'sell', triggerPrice: 2_471 })
    const sol = await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'SOL', mode: 'sell', triggerPrice: 109 })
    expect(liveHedgeLeg(db, getCollateralFloor(db, sol.id)!)).toBeNull()
    expect(alerts('refused')[0].body).toMatch(/^Liquidation [\d,]+% above the trigger \(min 15%\)/)
  })

  it('a bigger virtual line that breaks the rules does not resize the armed leg', async () => {
    const { sol } = await kaiBook('hedge')
    cold('SOL', 2_000)
    await tick()
    await tick()
    sim.setPrice('BTCUSDT', 88_000)
    await tick()
    expect(liveHedgeLeg(db, getCollateralFloor(db, sol.id)!)!.arm_holdings_coin).toBe(115)
    expect(alerts('refused')).toHaveLength(1)
    expect(alerts('refused')[0].body).toMatch(/resize to 2000 SOL refused/)
    expect((await service.overview('bybit', ACC)).coins.find((c) => c.coin === 'SOL')!.hedge!.error).toMatch(/resize/)
    cold('SOL', 120)
    await tick()
    expect(liveHedgeLeg(db, getCollateralFloor(db, sol.id)!)!.arm_holdings_coin).toBe(120)
  })
})

describe('concurrency', () => {
  it('a tick and a PUT racing through the arm path arm one leg; a restart mid-fire places one short', async () => {
    cold('SOL', 115)
    await service.armFloor({ exchange: 'bybit', accountId: ACC, coin: 'SOL', mode: 'sell', triggerPrice: 109 })
    service.updateSettings({ exchange: 'bybit', accountId: ACC, virtualCoverage: 'hedge' })
    // A slow venue: price reads span a timer, so the racing calls overlap
    // inside the arm path like they do against the real API.
    const last = adapter.getLastPrice.bind(adapter)
    adapter.getLastPrice = async (symbol: string) => {
      await new Promise((r) => setTimeout(r, 5))
      return last(symbol)
    }
    await Promise.all([service.syncHedges('bybit', ACC), service.syncHedges('bybit', ACC), tick()])
    const armed = db.listArmCycleSyntheticUsdPositions().filter((r) => r.symbol === 'SOLUSDT')
    expect(armed).toHaveLength(1)
    // The losing call must not report a refusal (the unique live index would throw it).
    expect(alerts('refused')).toHaveLength(0)

    sim.setPrice('SOLUSDT', 108)
    const positions = await adapter.getPositions()
    await Promise.all([
      guard.tickExchange('bybit', adapter, positions),
      service.syncHedges('bybit', ACC),
      service.tickExchange('bybit', adapter, positions),
    ])
    build() // restart: fresh services, same DB
    await tick()
    await tick()
    expect(linear().filter((p) => p.side === 'Sell')).toHaveLength(1)
    expect(sim.positions.get('SOLUSDT')!.size).toBeCloseTo(-116, 9)
  })
})

describe('guards and alerts', () => {
  it('the MMR guard measures and alerts once, but never reduces the hedge', async () => {
    await kaiBook('hedge')
    service.updateSettings({ exchange: 'bybit', accountId: ACC, autoReduce: true })
    sim.setPrice('SOLUSDT', 108)
    await tick()
    const before = linear().length
    sim.mmRate = 0.9
    await tick()
    await tick()
    expect(linear()).toHaveLength(before)
    expect(sim.positions.get('SOLUSDT')!.size).toBeCloseTo(-116, 9)
    expect(alerts('mmr')).toHaveLength(1)
    expect(alerts('mmr')[0].title).toBe('Margin ratio 90% with the SOL hedge open')
  })

  it('near the trigger: one "top up now" alert per cycle, shown in the banner list', async () => {
    const { sol } = await kaiBook('hedge')
    sim.setPrice('SOLUSDT', 112) // 2,7 % above 109
    await tick()
    await tick()
    expect(alerts('near')).toHaveLength(1)
    expect(alerts('near')[0].body).toMatch(/^Top up [\d.]+ USD now: the 12\.535 USD hedge fires at 109\.$/)
    expect(service.activeAlerts()).toMatchObject([{ coin: 'SOL', trap: 'near', floorId: sol.id }])
    sim.setPrice('SOLUSDT', 125)
    await tick()
    expect(service.activeAlerts()).toHaveLength(0)
  })

  it('the leg follows the sell floor: trigger, trail and toggle', async () => {
    const { sol } = await kaiBook('hedge')
    await service.updateFloor(sol.id, { triggerPrice: 112, trailPct: 10 })
    let leg = liveHedgeLeg(db, getCollateralFloor(db, sol.id)!)!
    expect(leg).toMatchObject({ arm_trigger_price: 112, arm_trail_pct: 10 })
    // Ratchet: 130 × 0,9 = 117 on whichever leg sees it first, then both.
    sim.setPrice('SOLUSDT', 130)
    await tick()
    await tick()
    leg = liveHedgeLeg(db, getCollateralFloor(db, sol.id)!)!
    expect(leg.arm_trigger_price).toBeCloseTo(117, 9)
    expect(getCollateralFloor(db, sol.id)!.trigger_price).toBeCloseTo(117, 9)

    await service.updateFloor(sol.id, { virtualHedge: false })
    expect(liveHedgeLeg(db, getCollateralFloor(db, sol.id)!)).toBeNull()
    expect(listCollateralFloorEvents(db, sol.id).map((e) => e.kind)).toContain('hedge_disarm')
  })

  it('disarming the floor retires an armed leg', async () => {
    const { eth } = await kaiBook('hedge')
    const legId = getCollateralFloor(db, eth.id)!.virtual_hedge_id!
    await service.disarmFloor(eth.id)
    expect(db.getSyntheticUsdPosition(legId)!.status).toBe('closed')
  })
})

describe('API', () => {
  function app(role: UserRole, grants: AccountGrant[] = [{ exchange: 'bybit', kind: 'account', ref: ACC }]) {
    const a = new Hono()
    a.use('*', async (c, next) => {
      c.set('role', role)
      if (role === 'viewer') c.set('accountScope', { all: false, grants })
      return next()
    })
    a.use('/api/*', createRoleMiddleware())
    a.route('/api/collateral', createCollateralRoutes(db, service))
    return a
  }
  const send = (a: Hono, path: string, method: string, body: unknown) =>
    a.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('admin sets coverage and toggles the leg; GET shows the hedge per coin', async () => {
    const a = app('admin')
    const { sol } = await kaiBook('none')
    const res = await send(a, '/api/collateral/settings', 'PUT', { exchange: 'bybit', accountId: ACC, virtualCoverage: 'hedge' })
    expect(res.status).toBe(200)
    const j = (await res.json()) as any
    expect(j.settings.virtualCoverage).toBe('hedge')
    expect(j.hedges.map((h: any) => h.status)).toEqual(['armed', 'armed', 'armed'])
    const o = (await (await a.request('/api/collateral?exchange=bybit&accountId=unified')).json()) as any
    expect(o.coins.find((c: any) => c.coin === 'SOL').hedge).toMatchObject({ status: 'armed', qty: 115 })
    expect(o.coverage).toMatchObject({ mode: 'hedge', unprotectedUsd: 0 })
    const off = await send(a, `/api/collateral/floors/${sol.id}/update`, 'POST', { virtualHedge: false })
    expect(off.status).toBe(200)
    expect(liveHedgeLeg(db, getCollateralFloor(db, sol.id)!)).toBeNull()
    expect((await a.request('/api/collateral/alerts')).status).toBe(200)
  })

  it('a viewer reads coverage and alerts but changes nothing', async () => {
    const { sol } = await kaiBook('hedge')
    const a = app('viewer')
    expect((await a.request('/api/collateral?exchange=bybit&accountId=unified')).status).toBe(200)
    expect((await a.request('/api/collateral/alerts')).status).toBe(200)
    expect((await send(a, '/api/collateral/settings', 'PUT', { exchange: 'bybit', accountId: ACC, virtualCoverage: 'none' })).status).toBe(403)
    expect((await send(a, `/api/collateral/floors/${sol.id}/update`, 'POST', { virtualHedge: false })).status).toBe(403)
    expect(getCollateralSettings(db, 'bybit', ACC).virtualCoverage).toBe('hedge')
    expect(liveHedgeLeg(db, getCollateralFloor(db, sol.id)!)).not.toBeNull()
  })

  it('GET /alerts only lists accounts in the viewer scope', async () => {
    await kaiBook('hedge')
    sim.setPrice('SOLUSDT', 112)
    await tick()
    const get = async (a: Hono) => ((await (await a.request('/api/collateral/alerts')).json()) as any).alerts
    expect(await get(app('admin'))).toHaveLength(1)
    expect(await get(app('viewer'))).toMatchObject([{ coin: 'SOL', trap: 'near' }])
    expect(await get(app('viewer', [{ exchange: 'bybit', kind: 'account', ref: 'other' }]))).toEqual([])
  })
})
