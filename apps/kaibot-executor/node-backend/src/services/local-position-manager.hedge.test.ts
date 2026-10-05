// Hedge guards inside the LocalPositionManager tick: an armed guard rides the
// same per-exchange position fetch as trails/managers — no trail or manager row
// needed for its exchange to be polled.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { LocalPositionManager } from './local-position-manager.js'
import { PaperExchangeAdapter } from './exchanges/adapters/paper.js'
import { createHedgeGuardService } from './hedge-guard.js'
import { orderLockIdle } from './order-lock.js'

const fastSettle = { attempts: 3, intervalMs: 1, sleep: async () => {} }
const MAIN = 'ETH-MAIN'
const HEDGE = 'ETH-HEDGE'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-hedge-loop-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(async () => {
  await orderLockIdle()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('LocalPositionManager — hedge guard pass', () => {
  it('polls a hedge-only exchange and executes the trigger through tick()', async () => {
    const adapter = new PaperExchangeAdapter('paper', { [MAIN]: 2000, [HEDGE]: 2000 })
    const exchangeManager = { getSession: async () => ({ status: 'connected', adapter }) } as any
    const hedgeService = createHedgeGuardService(db, exchangeManager, {}, fastSettle, null)
    const mgr = new LocalPositionManager(db, exchangeManager, null, {
      tickMs: 999999,
      signalTrailingEnabled: false,
      hedgeTicker: hedgeService,
    })

    await adapter.placeOrder({
      accountId: 'paper', symbol: MAIN, side: 'buy', orderType: 'market', quantity: 2,
    } as any)
    await hedgeService.arm({ exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE })

    // No trail rows, no managed positions — the guard alone must drive the poll.
    await mgr.tick()
    await orderLockIdle()
    expect(hedgeService.list()[0].status).toBe('armed')

    adapter.setMarkPrice(MAIN, 1890)
    adapter.setMarkPrice(HEDGE, 1890)
    await mgr.tick()
    await orderLockIdle()

    const row = hedgeService.list()[0]
    expect(row.status).toBe('hedged')
    const live = await adapter.getPositions()
    const hedgeLeg = live.find((p) => p.symbol === HEDGE)
    expect(hedgeLeg?.side).toBe('short')
    expect(hedgeLeg?.size).toBeCloseTo(2, 6)
  })

  it('winds down through tick() when the main position closes', async () => {
    const adapter = new PaperExchangeAdapter('paper', { [MAIN]: 2000, [HEDGE]: 2000 })
    const exchangeManager = { getSession: async () => ({ status: 'connected', adapter }) } as any
    const hedgeService = createHedgeGuardService(db, exchangeManager, {}, fastSettle, null)
    const mgr = new LocalPositionManager(db, exchangeManager, null, {
      tickMs: 999999,
      signalTrailingEnabled: false,
      hedgeTicker: hedgeService,
    })

    await adapter.placeOrder({
      accountId: 'paper', symbol: MAIN, side: 'buy', orderType: 'market', quantity: 2,
    } as any)
    await hedgeService.arm({
      exchange: 'paper', symbol: MAIN, triggerPrice: 1900, hedgeSymbol: HEDGE, onMainClose: 'close',
    })
    adapter.setMarkPrice(MAIN, 1890)
    await mgr.tick()
    await orderLockIdle()
    expect(hedgeService.list()[0].status).toBe('hedged')

    await adapter.placeOrder({
      accountId: 'paper', symbol: MAIN, side: 'sell', orderType: 'market', quantity: 2, reduceOnly: true,
    } as any)
    await mgr.tick()
    await orderLockIdle()

    const row = hedgeService.list()[0]
    expect(row.status).toBe('closed')
    expect(row.closeReason).toBe('main-closed')
    const live = await adapter.getPositions()
    expect(live.length).toBe(0)
  })
})
