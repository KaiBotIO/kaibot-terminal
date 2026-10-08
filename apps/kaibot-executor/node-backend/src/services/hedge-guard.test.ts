import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KaiBotDatabase } from '../storage/database.js'
import { PaperExchangeAdapter } from './exchanges/adapters/paper.js'
import { orderLockIdle } from './order-lock.js'
import {
  computeHedgeOpenPlan,
  createHedgeGuardService,
  defaultHedgeSymbolFor,
  deribitAccountIdFor,
  hedgeRecoveryReached,
  hedgeTriggerBreached,
  type HedgeGuardService,
} from './hedge-guard.js'

const fastSettle = { attempts: 3, intervalMs: 1, sleep: async () => {} }

// Paper venue named 'paper' so contract-constraint lookups never touch a real
// venue endpoint (linear sizing on both legs).
const MAIN = 'ETH-MAIN'
const HEDGE = 'ETH-HEDGE'

function fakeManager(adapter: PaperExchangeAdapter) {
  return {
    getSession: async () => ({ status: 'connected', adapter }),
  } as any
}

describe('hedge-guard pure rules', () => {
  it('trigger breach is direction-aware (legacy adverse compare)', () => {
    expect(hedgeTriggerBreached('long', 99, 100)).toBe(true)
    expect(hedgeTriggerBreached('long', 101, 100)).toBe(false)
    expect(hedgeTriggerBreached('short', 101, 100)).toBe(true)
    expect(hedgeTriggerBreached('short', 99, 100)).toBe(false)
  })

  it('recovery is the favourable direction of the MAIN', () => {
    expect(hedgeRecoveryReached('long', 101, 100)).toBe(true)
    expect(hedgeRecoveryReached('long', 99, 100)).toBe(false)
    expect(hedgeRecoveryReached('short', 99, 100)).toBe(true)
    expect(hedgeRecoveryReached('short', 101, 100)).toBe(false)
  })

  it('derives the Deribit paired instrument both ways, none elsewhere', () => {
    expect(defaultHedgeSymbolFor('deribit', 'BTC-PERPETUAL')).toBe('BTC_USDC-PERPETUAL')
    expect(defaultHedgeSymbolFor('deribit', 'ETH_USDC-PERPETUAL')).toBe('ETH-PERPETUAL')
    expect(defaultHedgeSymbolFor('deribit', 'BTC-27MAR26')).toBeNull()
    expect(defaultHedgeSymbolFor('bybit', 'BTCUSDT')).toBeNull()
  })

  it('derives the Deribit settle-currency account like the adapter', () => {
    expect(deribitAccountIdFor('BTC_USDC-PERPETUAL')).toBe('usdc')
    expect(deribitAccountIdFor('BTC-PERPETUAL')).toBe('btc')
    expect(deribitAccountIdFor('ETH-PERPETUAL')).toBe('eth')
  })

  it('match-sizes an inverse main onto a linear hedge (USD notional bridge)', () => {
    // Inverse main: size IS the USD notional. Linear hedge: qty = usd / price.
    const plan = computeHedgeOpenPlan({
      exchange: 'deribit',
      mainSymbol: 'BTC-PERPETUAL',
      mainSide: 'long',
      mainSize: 50_000,
      mainPrice: 77_000,
      hedgeSymbol: 'BTC_USDC-PERPETUAL',
      hedgePrice: 77_000,
      sizeMode: 'match',
      fixedUsd: null,
      constraints: { minSize: 0.001, stepSize: 0.001 },
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.side).toBe('sell')
    expect(plan.usdNotional).toBe(50_000)
    expect(plan.qty).toBeCloseTo(0.649, 3)
  })

  it('match-sizes a linear main onto an inverse hedge (qty becomes USD)', () => {
    const plan = computeHedgeOpenPlan({
      exchange: 'deribit',
      mainSymbol: 'BTC_USDC-PERPETUAL',
      mainSide: 'short',
      mainSize: 0.5,
      mainPrice: 80_000,
      hedgeSymbol: 'BTC-PERPETUAL',
      hedgePrice: null, // inverse hedge needs no price
      sizeMode: 'match',
      fixedUsd: null,
      constraints: { minSize: 10, stepSize: 10 },
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.side).toBe('buy')
    expect(plan.qty).toBe(40_000)
  })

  it('fails closed on a missing linear hedge price and on below-min sizes', () => {
    const noPrice = computeHedgeOpenPlan({
      exchange: 'deribit',
      mainSymbol: 'BTC-PERPETUAL',
      mainSide: 'long',
      mainSize: 50_000,
      mainPrice: 77_000,
      hedgeSymbol: 'BTC_USDC-PERPETUAL',
      hedgePrice: null,
      sizeMode: 'match',
      fixedUsd: null,
      constraints: { minSize: 0.001, stepSize: 0.001 },
    })
    expect('error' in noPrice).toBe(true)
    const belowMin = computeHedgeOpenPlan({
      exchange: 'deribit',
      mainSymbol: 'BTC-PERPETUAL',
      mainSide: 'long',
      mainSize: 20,
      mainPrice: 77_000,
      hedgeSymbol: 'BTC_USDC-PERPETUAL',
      hedgePrice: 77_000,
      sizeMode: 'match',
      fixedUsd: null,
      constraints: { minSize: 0.001, stepSize: 0.001 },
    })
    expect('error' in belowMin).toBe(true)
  })
})

describe('hedge-guard service', () => {
  let dir: string
  let db: KaiBotDatabase
  let adapter: PaperExchangeAdapter
  let service: HedgeGuardService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kaibot-hedge-test-'))
    db = new KaiBotDatabase(join(dir, 'test.db'))
    adapter = new PaperExchangeAdapter('paper', { [MAIN]: 2000, [HEDGE]: 2000 })
    service = createHedgeGuardService(db, fakeManager(adapter), {}, fastSettle, null)
  })

  afterEach(async () => {
    await orderLockIdle()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function openMain(side: 'buy' | 'sell' = 'buy', qty = 2) {
    await adapter.placeOrder({
      accountId: 'paper', symbol: MAIN, side, orderType: 'market', quantity: qty,
    } as any)
  }

  async function tick() {
    const positions = await adapter.getPositions()
    await service.tickExchange('paper', adapter, positions)
    await orderLockIdle()
  }

  function hedgePos() {
    return adapter
      .getOrders()
      .filter((o) => o.order.symbol === HEDGE)
  }

  it('refuses to arm without a live position or with a same-symbol hedge', async () => {
    await expect(
      service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE }),
    ).rejects.toThrow('no open position')
    await openMain()
    await expect(
      service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: MAIN }),
    ).rejects.toThrow('must differ')
    await expect(
      service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900 }),
    ).rejects.toThrow('no default hedge instrument')
  })

  it('arms once and refuses a second active guard', async () => {
    await openMain()
    const view = await service.arm({
      exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE,
    })
    expect(view.status).toBe('armed')
    expect(view.direction).toBe('long')
    expect(view.onMainClose).toBe('keep') // legacy default
    await expect(
      service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1800, hedgeSymbol: HEDGE }),
    ).rejects.toThrow('already active')
  })

  it('opens the hedge on an adverse breach, one-shot, sized to match', async () => {
    await openMain('buy', 2)
    await service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE })

    await tick() // mark 2000: no breach
    expect(hedgePos().length).toBe(0)

    adapter.setMarkPrice(MAIN, 1890)
    adapter.setMarkPrice(HEDGE, 1890)
    await tick()
    const orders = hedgePos()
    expect(orders.length).toBe(1)
    expect(orders[0].order.side).toBe('sell')
    // match: 2 × 1890 USD ÷ 1890 = 2 native on the hedge leg
    expect(orders[0].filledQuantity).toBeCloseTo(2, 6)

    const row = service.list()[0]
    expect(row.status).toBe('hedged')
    expect(row.hedgeSide).toBe('sell')
    expect(row.lastError).toBeNull()

    // One-shot: further breached ticks never open a second leg.
    adapter.setMarkPrice(MAIN, 1850)
    await tick()
    expect(hedgePos().length).toBe(1)
  })

  it('links main + hedge into one position group at open', async () => {
    await openMain()
    await service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE })
    adapter.setMarkPrice(MAIN, 1890)
    await tick()

    const links = db.listPositionGroupLinks()
    expect(links.length).toBe(2)
    expect(new Set(links.map((l) => l.group_id)).size).toBe(1)
    const group = db.getPositionGroup(links[0].group_id!)
    expect(group?.source).toBe('manual')
  })

  it('uses fixed-usd sizing when configured', async () => {
    await openMain('buy', 2)
    await service.arm({
      exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE,
      sizeMode: 'fixed-usd', fixedUsd: 945,
    })
    adapter.setMarkPrice(MAIN, 1890)
    adapter.setMarkPrice(HEDGE, 1890)
    await tick()
    expect(hedgePos()[0].filledQuantity).toBeCloseTo(0.5, 6)
  })

  it('keeps the guard armed on a rejected open and retries next tick', async () => {
    await openMain()
    await service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE })
    adapter.setMarkPrice(MAIN, 1890)
    adapter.setRejectAll('margin')
    await tick()
    let row = service.list()[0]
    expect(row.status).toBe('armed')
    expect(row.lastError).toContain('rejected')

    adapter.setRejectAll(null)
    await tick()
    row = service.list()[0]
    expect(row.status).toBe('hedged')
    expect(row.lastError).toBeNull()
  })

  it('closes the hedge on recovery through the recovery price', async () => {
    await openMain('buy', 2)
    await service.arm({
      exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE,
      recoveryPrice: 1950,
    })
    adapter.setMarkPrice(MAIN, 1890)
    await tick()
    expect(service.list()[0].status).toBe('hedged')

    adapter.setMarkPrice(MAIN, 1960)
    await tick()
    const row = service.list()[0]
    expect(row.status).toBe('closed')
    expect(row.closeReason).toBe('recovery')
    // Hedge leg is flat on the venue again (reduce-only close).
    const live = await adapter.getPositions()
    expect(live.find((p) => p.symbol === HEDGE)).toBeUndefined()
    expect(live.find((p) => p.symbol === MAIN)).toBeDefined()
  })

  it("wind-down 'keep' orphans the hedge when the main closes (legacy freeze)", async () => {
    await openMain('buy', 2)
    await service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE })
    adapter.setMarkPrice(MAIN, 1890)
    await tick()

    // Flatten the main leg outside the guard.
    await adapter.placeOrder({
      accountId: 'paper', symbol: MAIN, side: 'sell', orderType: 'market', quantity: 2, reduceOnly: true,
    } as any)
    await tick()
    const row = service.list()[0]
    expect(row.status).toBe('orphaned')
    // The hedge leg is still standing on the venue.
    const live = await adapter.getPositions()
    expect(live.find((p) => p.symbol === HEDGE)).toBeDefined()
  })

  it("wind-down 'close' flattens the hedge when the main closes", async () => {
    await openMain('buy', 2)
    await service.arm({
      exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE, onMainClose: 'close',
    })
    adapter.setMarkPrice(MAIN, 1890)
    await tick()

    await adapter.placeOrder({
      accountId: 'paper', symbol: MAIN, side: 'sell', orderType: 'market', quantity: 2, reduceOnly: true,
    } as any)
    await tick()
    const row = service.list()[0]
    expect(row.status).toBe('closed')
    expect(row.closeReason).toBe('main-closed')
    const live = await adapter.getPositions()
    expect(live.find((p) => p.symbol === HEDGE)).toBeUndefined()
  })

  it('retires an armed guard when the main closes before the trigger', async () => {
    await openMain()
    await service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE })
    await adapter.placeOrder({
      accountId: 'paper', symbol: MAIN, side: 'sell', orderType: 'market', quantity: 2, reduceOnly: true,
    } as any)
    await tick()
    const row = service.list()[0]
    expect(row.status).toBe('closed')
    expect(row.closeReason).toBe('main-flat-before-trigger')
  })

  it('records an externally closed hedge leg', async () => {
    await openMain('buy', 2)
    await service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE })
    adapter.setMarkPrice(MAIN, 1890)
    await tick()

    await adapter.placeOrder({
      accountId: 'paper', symbol: HEDGE, side: 'buy', orderType: 'market', quantity: 2, reduceOnly: true,
    } as any)
    await tick()
    const row = service.list()[0]
    expect(row.status).toBe('closed')
    expect(row.closeReason).toBe('hedge-closed-externally')
  })

  it('disarm works while armed, refuses while hedged; close is the inverse', async () => {
    await openMain()
    await service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE })
    await expect(service.close({ exchange: 'paper', symbol: MAIN })).rejects.toThrow('no open hedge')

    adapter.setMarkPrice(MAIN, 1890)
    await tick()
    await expect(service.disarm({ exchange: 'paper', symbol: MAIN })).rejects.toThrow('close it instead')

    const closed = await service.close({ exchange: 'paper', symbol: MAIN })
    expect(closed.status).toBe('closed')
    expect(closed.closeReason).toBe('manual')
    const live = await adapter.getPositions()
    expect(live.find((p) => p.symbol === HEDGE)).toBeUndefined()
  })

  it('allows re-arming after a terminal lifecycle (one-shot, manual re-arm)', async () => {
    await openMain()
    await service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE })
    await service.disarm({ exchange: 'paper', symbol: MAIN })
    const again = await service.arm({
      exchange: 'paper', symbol: MAIN, triggerPrice: 1880, hedgeSymbol: HEDGE,
    })
    expect(again.status).toBe('armed')
    expect(again.triggerPrice).toBe(1880)
  })

  it('update adjusts an armed guard but only wind-down knobs while hedged', async () => {
    await openMain()
    await service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE })
    const upd = await service.update({
      exchange: 'paper', symbol: MAIN, triggerPrice: 1850, recoveryPrice: 1990,
    })
    expect(upd.triggerPrice).toBe(1850)
    expect(upd.recoveryPrice).toBe(1990)

    adapter.setMarkPrice(MAIN, 1840)
    await tick()
    await expect(
      service.update({ exchange: 'paper', symbol: MAIN, triggerPrice: 1800 }),
    ).rejects.toThrow('only recoveryPrice and onMainClose')
    const winddown = await service.update({
      exchange: 'paper', symbol: MAIN, onMainClose: 'close', recoveryPrice: null,
    })
    expect(winddown.onMainClose).toBe('close')
  })

  it('hedges a SHORT main with a long hedge leg on a short-side breach', async () => {
    await openMain('sell', 2)
    await service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 2100, hedgeSymbol: HEDGE })
    adapter.setMarkPrice(MAIN, 2050)
    await tick()
    expect(hedgePos().length).toBe(0) // 2050 < 2100: not breached for a short

    adapter.setMarkPrice(MAIN, 2110)
    adapter.setMarkPrice(HEDGE, 2110)
    await tick()
    const orders = hedgePos()
    expect(orders.length).toBe(1)
    expect(orders[0].order.side).toBe('buy')
  })

  it('tracks the hedge leg as a manual position marker (reconciler-proof)', async () => {
    await openMain('buy', 2)
    await service.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE })
    adapter.setMarkPrice(MAIN, 1890)
    adapter.setMarkPrice(HEDGE, 1890)
    await tick()
    expect(db.getManualPosition('paper', 'paper', HEDGE)?.net).toBeCloseTo(-2, 6)

    await service.close({ exchange: 'paper', symbol: MAIN })
    expect(db.getManualPosition('paper', 'paper', HEDGE) ?? undefined).toBeUndefined()
  })
})
