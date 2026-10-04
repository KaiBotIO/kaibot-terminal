import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KaiBotDatabase } from '../storage/database.js'
import { PaperExchangeAdapter } from './exchanges/adapters/paper.js'
import { orderLockIdle } from './order-lock.js'
import { scopeAdapter } from './exchanges/account-scope.js'
import { getSyntheticSizingBasis } from './synthetic-sizing.js'
import { LocalPositionManager } from './local-position-manager.js'
import { createSyntheticUsdService, type SyntheticUsdService } from './synthetic-usd.js'
import {
  armedBreached,
  armedView,
  createSyntheticGuardService,
  ratchetTrigger,
  recoveryReached,
  resolveRecoveryLevel,
  type SyntheticGuardService,
} from './synthetic-guard.js'

// Deribit inverse: BTC-PERPETUAL (static constraints, step 10 USD, no network).
// Deribit linear: BTC_USDC-PERPETUAL (no static entry → {0,0}, no network).
const INV = 'BTC-PERPETUAL'
const LIN = 'BTC_USDC-PERPETUAL'

describe('synthetic-guard pure rules', () => {
  it('breach is direction-aware with an optional wick margin', () => {
    expect(armedBreached('long', 89_999, 90_000)).toBe(true)
    expect(armedBreached('long', 90_000, 90_000)).toBe(false)
    expect(armedBreached('long', 89_500, 90_000, 1)).toBe(false) // 1% margin → < 89 100
    expect(armedBreached('long', 89_000, 90_000, 1)).toBe(true)
    expect(armedBreached('short', 90_001, 90_000)).toBe(true)
    expect(armedBreached('short', 89_000, 90_000)).toBe(false)
  })

  it('ratchet follows the high-water mark and never moves the trigger down', () => {
    const base = { direction: 'long' as const, triggerPrice: 90_000, highWater: null, trailPct: 10, trailAbs: null }
    let r = ratchetTrigger(base, 100_000)
    expect(r).toEqual({ triggerPrice: 90_000, highWater: 100_000 })
    r = ratchetTrigger({ ...base, ...r }, 120_000)
    expect(r).toEqual({ triggerPrice: 108_000, highWater: 120_000 })
    r = ratchetTrigger({ ...base, ...r }, 110_000) // pullback: nothing moves
    expect(r).toEqual({ triggerPrice: 108_000, highWater: 120_000 })
    r = ratchetTrigger({ ...base, ...r }, 100_000)
    expect(r.triggerPrice).toBe(108_000)
  })

  it('ratchet with an absolute trail, and no trail = fixed trigger', () => {
    const abs = ratchetTrigger(
      { direction: 'long', triggerPrice: 90_000, highWater: 100_000, trailPct: null, trailAbs: 5_000 },
      120_000,
    )
    expect(abs).toEqual({ triggerPrice: 115_000, highWater: 120_000 })
    const fixed = ratchetTrigger(
      { direction: 'long', triggerPrice: 90_000, highWater: 100_000, trailPct: null, trailAbs: null },
      150_000,
    )
    expect(fixed.triggerPrice).toBe(90_000)
  })

  it('recovery level: explicit price wins over pct over none', () => {
    expect(resolveRecoveryLevel({ direction: 'long', firedTriggerPrice: 90_000, recoveryPrice: 95_000, recoveryPct: 10 })).toBe(95_000)
    expect(resolveRecoveryLevel({ direction: 'long', firedTriggerPrice: 90_000, recoveryPrice: null, recoveryPct: 5 })).toBe(94_500)
    expect(resolveRecoveryLevel({ direction: 'long', firedTriggerPrice: 90_000, recoveryPrice: null, recoveryPct: null })).toBeNull()
    expect(recoveryReached('long', 94_600, 94_500)).toBe(true)
    expect(recoveryReached('long', 94_500, 94_500)).toBe(false)
  })

  it('view: planned floor + upside while armed, realized floor once minted', () => {
    const armed = {
      status: 'armed', arm_direction: 'long', arm_trigger_price: 90_000, arm_holdings_coin: 2,
      arm_last_mark: 100_000, arm_tolerance_pct: 0, arm_cycle: 0,
    } as any
    const v = armedView(armed)
    expect(v.protectedUsd).toBe(180_000)
    expect(v.protection).toBe('planned')
    expect(v.upsideUsd).toBe(20_000)
    expect(v.distanceToTriggerPct).toBeCloseTo(10, 5)
    const open = { ...armed, status: 'open', arm_fired_trigger_price: 90_000, arm_fired_price: 89_000, arm_recovery_pct: 5 }
    const o = armedView(open, 92_000)
    expect(o.protectedUsd).toBe(178_000)
    expect(o.protection).toBe('realized')
    expect(o.upsideUsd).toBe(0)
    expect(o.recoveryLevel).toBe(94_500)
    expect(armedView({ status: 'open', arm_trigger_price: null } as any).inCycle).toBe(false)
  })
})

describe('synthetic-guard service', () => {
  let dir: string
  let db: KaiBotDatabase
  let adapter: PaperExchangeAdapter
  let service: SyntheticUsdService
  let guard: SyntheticGuardService
  let events: any[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kaibot-synth-guard-'))
    db = new KaiBotDatabase(join(dir, 'test.db'))
    adapter = new PaperExchangeAdapter('deribit', { [INV]: 100_000, [LIN]: 100_000 })
    const manager = { getSession: async () => ({ status: 'connected', adapter }) } as any
    service = createSyntheticUsdService(db, manager)
    events = []
    guard = createSyntheticGuardService(db, manager, service, { publish: (e: any) => events.push(e) } as any)
    // 2 BTC of holdings at the 100k mark.
    db.setHoldingsBasis('manual:cold', 200_000, true)
  })

  afterEach(async () => {
    await orderLockIdle()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function tick() {
    const positions = await adapter.getPositions()
    await guard.tickExchange('deribit', adapter, positions)
    await orderLockIdle()
  }
  const market = { exchange: 'deribit', accountId: 'btc', symbol: INV }
  const sells = () => adapter.getOrders().filter((o) => o.order.side === 'sell')

  it('arms a planned floor of holdings × trigger and blocks a plain mint on that market', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 })
    expect(row.status).toBe('armed')
    expect(row.arm_planned_usd).toBe(180_000)
    expect(row.short_size).toBe(0)
    expect(adapter.getOrders()).toHaveLength(0)
    expect(db.listSyntheticUsdPositions().map((r) => r.id)).toEqual([row.id])
    await expect(service.mint({ ...market, targetUsd: 1000 })).rejects.toThrow(/armed/)
    await expect(guard.arm({ ...market, triggerPrice: 91_000, holdingsCoin: 2 })).rejects.toThrow(/already armed/)
    expect(db.listSyntheticUsdMutations(row.id).map((m) => m.kind)).toEqual(['arm'])
  })

  it("derives holdingsCoin from this account's venue line only, never the summed basis", async () => {
    // Only a manual line: nothing says how much BTC sits on deribit:btc.
    await expect(guard.arm({ ...market, triggerPrice: 90_000 })).rejects.toThrow(/pass holdingsCoin/)
    db.setHoldingsBasis('deribit:btc', 150_000, false)
    db.setHoldingsBasis('deribit:eth', 900_000, false) // must not leak into the BTC row
    const row = await guard.arm({ ...market, triggerPrice: 90_000 })
    expect(row.arm_holdings_coin).toBeCloseTo(1.5, 9)
    expect(row.arm_planned_usd).toBeCloseTo(135_000, 6)
    expect(row.holdings_basis_usd).toBeCloseTo(150_000, 6)
  })

  it('keeps the factor-basis flag and the holdings through the recovery buy-back', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 5 })
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    service.setFactorBasis(row.id, true)
    expect(db.getFactorBasisSyntheticUsdPosition()!.id).toBe(row.id)
    adapter.setMarkPrice(INV, 95_000)
    await tick()
    const rearmed = db.getSyntheticUsdPosition(row.id)!
    expect(rearmed.status).toBe('armed')
    expect(rearmed.is_factor_basis).toBe(1) // preserved on the row …
    expect(db.getFactorBasisSyntheticUsdPosition()!.id).toBe(row.id) // … and still the basis while armed
    expect(rearmed.arm_holdings_coin).toBe(2)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    expect(db.getFactorBasisSyntheticUsdPosition()!.id).toBe(row.id) // and once minted again
  })

  it('an armed row can be the sizing basis before the mint; disarm removes it with a warning', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 })
    service.setFactorBasis(row.id, true)
    const basis = db.getFactorBasisSyntheticUsdPosition()!
    expect(basis.id).toBe(row.id)
    expect(basis.status).toBe('armed')
    expect(basis.arm_planned_usd).toBe(180_000)
    const retired = guard.disarm(row.id)
    expect(retired.status).toBe('closed')
    expect(retired.is_factor_basis).toBe(0)
    expect(db.getFactorBasisSyntheticUsdPosition()).toBeNull() // fallback = plain contract sizing
    expect(events.find((e) => e.title === 'Synthetic sizing basis removed')).toBeDefined()
  })

  it('recoveryPct 0 unwinds as soon as the mark is back above the fired trigger', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 0 })
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('open')
    expect(guard.view(db.getSyntheticUsdPosition(row.id)!).recoveryLevel).toBe(90_000)
    adapter.setMarkPrice(INV, 90_000) // at the line: not yet
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('open')
    adapter.setMarkPrice(INV, 90_001)
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('armed')
  })

  it('refuses a dated Deribit future as the mint instrument', async () => {
    await expect(
      guard.arm({ exchange: 'deribit', accountId: 'btc', symbol: 'BTC-27MAR26', triggerPrice: 90_000, holdingsCoin: 1 }),
    ).rejects.toThrow(/perpetuals only/)
  })

  it('pauses the recovery unwind when the venue net no longer matches the recorded short', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 5 })
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    // A strategy long on the same instrument nets 50k of the short away.
    await adapter.placeOrder({ accountId: 'btc', symbol: INV, side: 'buy', orderType: 'market', quantity: 50_000 } as any)
    adapter.setMarkPrice(INV, 95_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.short_size).toBe(180_000)
    expect(pos.arm_last_error).toMatch(/unwind paused/)
    expect(adapter.getOrders().filter((o) => o.order.side === 'buy' && o.order.reduceOnly)).toHaveLength(0)
    expect(events.filter((e) => e.type === 'synthetic_armed_failed')).toHaveLength(1)
  })

  it('mints on an adverse breach through the mint path, planned vs realized logged', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 })
    adapter.setMarkPrice(INV, 95_000)
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('armed')
    expect(adapter.getOrders()).toHaveLength(0)

    adapter.setMarkPrice(INV, 89_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.short_size).toBe(180_000) // inverse: notional IS the qty
    expect(pos.target_usd).toBe(180_000)
    expect(pos.arm_cycle).toBe(1)
    expect(pos.arm_fired_trigger_price).toBe(90_000)
    expect(pos.arm_fired_price).toBe(89_000)
    expect(sells()).toHaveLength(1)
    expect(sells()[0].order.quantity).toBe(180_000)
    expect(sells()[0].order.label).toBe('kaibot-synthetic-usd')

    const mint = db.listSyntheticUsdMutations(row.id).find((m) => m.kind === 'mint')!
    const meta = JSON.parse(mint.meta!)
    expect(meta.plannedUsd).toBe(180_000)
    expect(meta.realizedUsd).toBe(180_000)
    expect(meta.avgFillPrice).toBe(89_000)
    expect(meta.gapPct).toBeCloseTo(1.111, 2)
    expect(meta.capped).toBe(false)
    // Realized floor = holdings × fill.
    expect(guard.view(pos).protectedUsd).toBe(178_000)
    expect(guard.view(pos).protection).toBe('realized')
    expect(events.map((e) => e.type)).toEqual(['synthetic_armed_minted'])

    // One-shot: another adverse tick does nothing.
    adapter.setMarkPrice(INV, 85_000)
    await tick()
    expect(sells()).toHaveLength(1)
  })

  it('ratchets the trigger up with the market and fires on the pullback', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, trailPct: 10 })
    adapter.setMarkPrice(INV, 120_000)
    await tick()
    let pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.arm_trigger_price).toBe(108_000)
    expect(pos.arm_high_water).toBe(120_000)
    expect(pos.arm_planned_usd).toBe(216_000)
    adapter.setMarkPrice(INV, 110_000)
    await tick()
    pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.arm_trigger_price).toBe(108_000)
    expect(pos.status).toBe('armed')
    adapter.setMarkPrice(INV, 107_000)
    await tick()
    pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.short_size).toBe(216_000)
  })

  it('unwinds on recovery, re-arms at the fired trigger (hysteresis), and cycles again', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 5 })
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('open')
    expect(guard.view(db.getSyntheticUsdPosition(row.id)!).recoveryLevel).toBe(94_500)

    adapter.setMarkPrice(INV, 94_000) // inside the band: still hedged
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('open')

    adapter.setMarkPrice(INV, 95_000)
    await tick()
    let pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('armed')
    expect(pos.short_size).toBe(0)
    expect(pos.target_usd).toBe(0)
    expect(pos.arm_trigger_price).toBe(90_000)
    expect(pos.arm_planned_usd).toBe(180_000)
    expect(pos.arm_fired_at).toBeNull()
    const live = await adapter.getPositions()
    expect(live.filter((p) => p.symbol === INV)).toHaveLength(0)
    const buy = adapter.getOrders().find((o) => o.order.side === 'buy')!
    expect(buy.order.reduceOnly).toBe(true)
    expect(buy.order.quantity).toBe(180_000)
    expect(db.listSyntheticUsdMutations(row.id).map((m) => m.kind)).toEqual(['arm', 'mint', 'recovery_close'])

    // Hysteresis: a dip that stays above the trigger does not re-fire.
    adapter.setMarkPrice(INV, 91_000)
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('armed')
    adapter.setMarkPrice(INV, 89_900)
    await tick()
    pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.arm_cycle).toBe(2)
    expect(events.map((e) => e.type)).toEqual([
      'synthetic_armed_minted', 'synthetic_armed_closed', 'synthetic_armed_minted',
    ])
  })

  it('tolerance margin holds off a wick; a gap fills lower and records the gap honestly', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, tolerancePct: 1 })
    adapter.setMarkPrice(INV, 89_500)
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('armed')
    // Gap straight through: stop-market semantics, fill at the gapped mark.
    adapter.setMarkPrice(INV, 80_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.short_size).toBe(180_000) // sized to the TRIGGER, not the fill
    expect(pos.arm_fired_price).toBe(80_000)
    const meta = JSON.parse(db.listSyntheticUsdMutations(row.id).find((m) => m.kind === 'mint')!.meta!)
    expect(meta.gapPct).toBeCloseTo(11.11, 1)
    expect(meta.lockedUsd).toBe(160_000)
    expect(meta.overHedgeUsd).toBe(20_000) // S = holdings × trigger; the gap shows as over-hedge
    const v = guard.view(pos)
    expect(v.protectedUsd).toBe(160_000) // realized floor = holdings × fill
    expect(v.overHedgeUsd).toBe(20_000)
  })

  it("caps on this account's own collateral (coin × mark), at arm time and at mint time", async () => {
    // Cap 1: a trigger above the mark would size the short beyond the coin's value.
    await expect(
      guard.arm({ ...market, triggerPrice: 110_000, holdingsCoin: 2, leverageCap: 1 }),
    ).rejects.toThrow(/exceeds the 1x cap on this account/)
    // A huge ETH basis line changes nothing for the BTC row (never summed).
    db.setHoldingsBasis('deribit:eth', 5_000_000, false)
    await expect(
      guard.arm({ ...market, triggerPrice: 110_000, holdingsCoin: 2, leverageCap: 1 }),
    ).rejects.toThrow(/exceeds the 1x cap/)
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 }) // cap 2
    // A gap so deep that 2 BTC at the fill can't carry a trigger-sized short
    // under the 2x cap: 2 × 40k × 2 = 160k < 180k → clamped, like a manual mint.
    adapter.setMarkPrice(INV, 40_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.short_size).toBe(160_000)
    expect(pos.holdings_basis_usd).toBe(80_000)
    const meta = JSON.parse(db.listSyntheticUsdMutations(row.id).find((m) => m.kind === 'mint')!.meta!)
    expect(meta.capped).toBe(true)
    expect(meta.plannedUsd).toBe(180_000)
    expect(meta.realizedUsd).toBe(160_000)
  })

  it('stays armed on a rejected order, records the error once, retries next tick', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 })
    adapter.rejectNextOrder('insufficient margin')
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    let pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('armed')
    expect(pos.arm_last_error).toMatch(/did not fill/)
    expect(events.filter((e) => e.type === 'synthetic_armed_failed')).toHaveLength(1)
    await tick()
    pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.arm_last_error).toBeNull()
  })

  it('restart safety: adopts a matching live short instead of minting twice', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 })
    // A mint that filled but never persisted (crash between fill and DB write).
    await adapter.placeOrder({ accountId: 'btc', symbol: INV, side: 'sell', orderType: 'market', quantity: 180_000 } as any)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.short_size).toBe(180_000)
    expect(sells()).toHaveLength(1) // no second order
    const meta = JSON.parse(db.listSyntheticUsdMutations(row.id).find((m) => m.kind === 'mint')!.meta!)
    expect(meta.adopted).toBe(true)
    // And a second process restart with the same DB sees an open row: nothing fires again.
    await tick()
    expect(sells()).toHaveLength(1)
  })

  it('blocks the mint while the instrument is not flat (would net against a live position)', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 })
    await adapter.placeOrder({ accountId: 'btc', symbol: INV, side: 'buy', orderType: 'market', quantity: 50_000 } as any)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('armed')
    expect(pos.arm_last_error).toMatch(/not flat/)
    expect(sells()).toHaveLength(0)
  })

  // Inverse switch (2026-09-08): the strategies trade the same BTC-PERPETUAL
  // the synthetic hedges on, and Deribit nets both into one position. The
  // guard must read its OWN short through the executor's book, not the venue
  // net: a bot long must neither block the mint nor pause the unwind.
  it('mints through a bot long on the instrument when the executor book explains the venue net, and buys back the full short without reduce-only', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 0 })
    db.insertSignalExecution({ signalId: 'bot-long', symbol: INV, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 50_000, accountId: 'btc' })
    await adapter.placeOrder({ accountId: 'btc', symbol: INV, side: 'buy', orderType: 'market', quantity: 50_000 } as any)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    let pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.short_size).toBe(180_000)
    expect(sells().map((o) => o.order.quantity)).toEqual([180_000])
    // Venue nets to short 130k; the guard still sees its own 180k short.
    const [venue] = (await adapter.getPositions()).filter((p) => p.symbol === INV)
    expect(venue).toMatchObject({ side: 'short', size: 130_000 })

    adapter.setMarkPrice(INV, 95_000)
    await tick()
    pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('armed')
    expect(pos.short_size).toBe(0)
    const buyBack = adapter.getOrders().filter((o) => o.order.side === 'buy' && o.order.quantity === 180_000)
    expect(buyBack).toHaveLength(1)
    expect(buyBack[0].reduceOnly).toBe(false)
    // The bot long is what remains at the venue.
    const [after] = (await adapter.getPositions()).filter((p) => p.symbol === INV && Math.abs(p.size) > 0)
    expect(after).toMatchObject({ side: 'long', size: 50_000 })
  })

  it('never auto-rebalances an arm-cycle row', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 })
    expect(db.listAutoRebalanceSyntheticUsdPositions()).toHaveLength(0)
    expect(() => service.setAutoRebalance(row.id, { enabled: true, targetPct: 100 })).toThrow()
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('open')
    expect(() => service.setAutoRebalance(row.id, { enabled: true, targetPct: 100 })).toThrow(/armed/)
    expect(db.listAutoRebalanceSyntheticUsdPositions()).toHaveLength(0)
  })

  it('disarm retires an armed row without an order and detaches an open one keeping the short', async () => {
    const a = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 })
    const retired = guard.disarm(a.id)
    expect(retired.status).toBe('closed')
    expect(adapter.getOrders()).toHaveLength(0)
    expect(db.listSyntheticUsdPositions()).toHaveLength(0)

    const b = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 })
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    const detached = guard.disarm(b.id)
    expect(detached.status).toBe('open')
    expect(detached.short_size).toBe(180_000)
    expect(detached.arm_trigger_price).toBeNull()
    expect(guard.activeExchanges()).toEqual([])
    // A detached row is a plain synthetic again: closable via the normal path.
    const closed = await service.close(b.id)
    expect(closed.status).toBe('closed')
  })

  it('updateArm: trigger/holdings only while armed, recovery knobs while open; a new trigger restarts the ratchet', async () => {
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, trailPct: 10 })
    adapter.setMarkPrice(INV, 120_000)
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.arm_trigger_price).toBe(108_000)
    const u = guard.updateArm(row.id, { triggerPrice: 100_000, holdingsCoin: 1.5 })
    expect(u.arm_trigger_price).toBe(100_000)
    expect(u.arm_planned_usd).toBe(150_000)
    expect(u.arm_high_water).toBeNull() // ratchet restarts from the next mark
    expect(() => guard.updateArm(row.id, { trailPct: 5, trailAbs: 100 })).toThrow(/not both/)
    expect(() => guard.updateArm(row.id, { recoveryPrice: 95_000 })).toThrow(/favourable side/)
    adapter.setMarkPrice(INV, 99_000)
    await tick()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('open')
    expect(() => guard.updateArm(row.id, { triggerPrice: 95_000 })).toThrow(/short is open/)
    const r = guard.updateArm(row.id, { recoveryPct: 3 })
    expect(guard.view(r).recoveryLevel).toBe(103_000)
  })

  it('migration path: attaches a cycle to an existing open synthetic; recovery unwinds and re-arms', async () => {
    const open = await service.mint({ ...market, targetUsd: 150_000 })
    const attached = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 5 })
    expect(attached.id).toBe(open.id)
    expect(attached.status).toBe('open')
    expect(attached.short_size).toBe(150_000)
    expect(attached.arm_cycle).toBe(1)
    expect(guard.view(attached).recoveryLevel).toBe(94_500)
    adapter.setMarkPrice(INV, 95_000)
    await tick()
    const rearmed = db.getSyntheticUsdPosition(open.id)!
    expect(rearmed.status).toBe('armed')
    expect(rearmed.short_size).toBe(0)
    expect(rearmed.arm_trigger_price).toBe(90_000)
    expect(rearmed.arm_planned_usd).toBe(180_000)
    adapter.setMarkPrice(INV, 89_000)
    await tick()
    expect(db.getSyntheticUsdPosition(open.id)!.short_size).toBe(180_000)
  })

  it('linear (USDC) path: qty = usd / mark, notional tracked in USD, buyback of the native qty', async () => {
    const lin = { exchange: 'deribit', accountId: 'usdc', symbol: LIN }
    const row = await guard.arm({ ...lin, triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 5 })
    adapter.setMarkPrice(LIN, 89_000)
    await tick()
    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.status).toBe('open')
    expect(pos.short_size).toBeCloseTo(180_000 / 89_000, 9) // coin qty
    expect(pos.target_usd).toBeCloseTo(180_000, 6)
    const sell = adapter.getOrders().find((o) => o.order.side === 'sell')!
    expect(sell.order.quantity).toBeCloseTo(2.0225, 4)
    adapter.setMarkPrice(LIN, 95_000)
    await tick()
    const rearmed = db.getSyntheticUsdPosition(row.id)!
    expect(rearmed.status).toBe('armed')
    const buy = adapter.getOrders().find((o) => o.order.side === 'buy')!
    expect(buy.order.quantity).toBeCloseTo(2.0225, 4)
    expect((await adapter.getPositions()).filter((p) => p.symbol === LIN)).toHaveLength(0)
  })

  it('ticks only the rows of its own connection (labeled account ids route to the labeled session)', async () => {
    // Second Deribit connection 'acct2': its adapter namespaces account ids.
    const acct2 = new PaperExchangeAdapter('deribit', { [INV]: 100_000 })
    const scoped = scopeAdapter(acct2 as any, 'acct2')
    const sessions = [
      { status: 'connected', adapter },
      { status: 'connected', adapter: scoped, label: 'acct2', accountKey: 'acct2' },
    ]
    const manager = {
      getSession: async (_u: string, _e: string, key?: string) =>
        key === 'acct2' ? sessions[1] : key ? null : sessions[0],
      getSessions: async () => sessions,
    } as any
    const svc = createSyntheticUsdService(db, manager)
    const g = createSyntheticGuardService(db, manager, svc, null)
    const a = await g.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 })
    // accountKey + bare venue account → namespaced row; a wrong label or a
    // label with no session is refused.
    await expect(
      g.arm({ exchange: 'deribit', accountId: 'acct2/btc', accountKey: 'acct1', symbol: INV, triggerPrice: 1, holdingsCoin: 1 }),
    ).rejects.toThrow(/belongs to connection "acct2"/)
    await expect(
      g.arm({ exchange: 'deribit', accountId: 'btc', accountKey: 'nope', symbol: INV, triggerPrice: 1, holdingsCoin: 1 }),
    ).rejects.toThrow(/no "nope" connection/)
    const b = await g.arm({ exchange: 'deribit', accountId: 'btc', accountKey: 'acct2', symbol: INV, triggerPrice: 92_000, holdingsCoin: 1 })
    expect(b.account_id).toBe('acct2/btc')
    expect(db.getSyntheticUsdPosition(b.id)!.arm_last_mark).toBe(100_000) // mark came from the acct2 session

    // Only acct2 breaches: the default connection's row must stay armed even
    // though both connections are ticked with the same instrument name.
    acct2.setMarkPrice(INV, 91_000)
    for (const sess of sessions) {
      await g.tickExchange('deribit', sess.adapter as any, await sess.adapter.getPositions())
    }
    await orderLockIdle()
    expect(db.getSyntheticUsdPosition(a.id)!.status).toBe('armed')
    const fired = db.getSyntheticUsdPosition(b.id)!
    expect(fired.status).toBe('open')
    expect(fired.account_id).toBe('acct2/btc')
    // The order went to the labeled venue with the venue's own account id.
    expect(adapter.getOrders()).toHaveLength(0)
    expect(acct2.getOrders()).toHaveLength(1)
    expect(acct2.getOrders()[0].order.accountId).toBe('btc')
    expect(fired.short_size).toBe(92_000)

    // Each account carries its own sizing basis: flagging acct2 does not
    // unflag the default row (one basis per (exchange, account)).
    svc.setFactorBasis(a.id, true)
    svc.setFactorBasis(b.id, true)
    expect(db.getFactorBasisSyntheticUsdPosition('deribit', 'btc')!.id).toBe(a.id)
    expect(db.getFactorBasisSyntheticUsdPosition('deribit', 'acct2/btc')!.id).toBe(b.id)
    expect(db.listFactorBasisSyntheticUsdPositions()).toHaveLength(2)
    expect(getSyntheticSizingBasis(db, 'deribit', 'btc')!.basisUsd).toBe(180_000) // armed → planned
    expect(getSyntheticSizingBasis(db, 'deribit', 'acct2/btc')!.basisKind).toBe('realized')
    expect(getSyntheticSizingBasis(db, 'deribit', 'eth')).toBeNull()
  })

  it('rides the LocalPositionManager tick with no position on the venue', async () => {
    const manager = { getSession: async () => ({ status: 'connected', adapter }) } as any
    const lpm = new LocalPositionManager(db, manager, null, {
      tickMs: 999_999,
      signalTrailingEnabled: false,
      syntheticTicker: guard,
    })
    const row = await guard.arm({ ...market, triggerPrice: 90_000, holdingsCoin: 2 })
    await lpm.tick()
    await orderLockIdle()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('armed')
    expect(db.getSyntheticUsdPosition(row.id)!.arm_last_mark).toBe(100_000)
    adapter.setMarkPrice(INV, 89_000)
    await lpm.tick()
    await orderLockIdle()
    expect(db.getSyntheticUsdPosition(row.id)!.status).toBe('open')
  })
})
