import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KaiBotDatabase } from '../storage/database.js'
import { PaperExchangeAdapter } from './exchanges/adapters/paper.js'
import { orderLockIdle } from './order-lock.js'
import { createSyntheticUsdService } from './synthetic-usd.js'
import { createSyntheticGuardService, type SyntheticGuardService } from './synthetic-guard.js'

// Live 2026-10-01 (Deribit default): Kai's manual BTC-PERPETUAL long sits in
// manual_positions, not in signal_executions. On a trigger breach the guard
// read it as an unexplained position and blocked the mint ("instrument not
// flat"), so the armed floor under 0,1001 BTC could never fire.
const INV = 'BTC-PERPETUAL'

describe('armed synthetic over a manual long (live regression 2026-10-01)', () => {
  let dir: string
  let db: KaiBotDatabase
  let adapter: PaperExchangeAdapter
  let guard: SyntheticGuardService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kaibot-floor-manual-'))
    db = new KaiBotDatabase(join(dir, 'test.db'))
    adapter = new PaperExchangeAdapter('deribit', { [INV]: 84_420 })
    const manager = { getSession: async () => ({ status: 'connected', adapter }) } as any
    const service = createSyntheticUsdService(db, manager)
    guard = createSyntheticGuardService(db, manager, service, null)
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

  it('fires the floor through a known manual long instead of blocking it', async () => {
    const row = await guard.arm({
      exchange: 'deribit', accountId: 'btc', symbol: INV,
      triggerPrice: 76_904.63, holdingsCoin: 0.1001, trailPct: 12, recoveryPct: 2, tolerancePct: 0.2,
    })
    // The manual long as manual-trade books it: venue fill + manual marker.
    await adapter.placeOrder({ accountId: 'btc', symbol: INV, side: 'buy', orderType: 'market', quantity: 2_950 } as any)
    db.addManualPosition('deribit', 'btc', INV, 'buy', 2_950)

    adapter.setMarkPrice(INV, 76_700) // below 76.904,63 × (1 − 0,2 %)
    await tick()

    const pos = db.getSyntheticUsdPosition(row.id)!
    expect(pos.arm_last_error ?? '').not.toMatch(/not flat/)
    expect(pos.status).toBe('open')
    const sells = adapter.getOrders().filter((o) => o.order.side === 'sell')
    expect(sells).toHaveLength(1)
    // Planned floor (0,1001 × 76.904,63 = 7.698) plus the manual long it covers.
    expect(sells[0].order.quantity).toBeGreaterThanOrEqual(10_640)
    expect(sells[0].order.quantity).toBeLessThanOrEqual(10_650)
    // Coins + perps USD-neutral: the venue holds the planned floor as net short.
    const [venue] = (await adapter.getPositions()).filter((p) => p.symbol === INV)
    expect(venue.side).toBe('short')
    expect(Math.abs(venue.size - 7_698)).toBeLessThanOrEqual(10)
  })
})
