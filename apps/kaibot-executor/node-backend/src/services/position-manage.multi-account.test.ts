// Multi-account trail scoping (vangnet 2026-08-24 incident): TWO accounts can
// hold the SAME futures contract (933 + 936 both long MNQU26). A manual arm on
// one account must never adopt/retire the OTHER account's trail — that steals
// its venue stop-order and leaves that position unprotected the moment the
// thief trail moves. And the tick loop must match each trail row to ITS
// account's position, or a flat account keeps a phantom-alive trail via the
// sibling's position.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { createPositionManageService } from './position-manage.js'
import { LocalPositionManager } from './local-position-manager.js'
import { orderLockIdle } from './order-lock.js'
import { positionTrailKey } from './position-trail.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-multiacct-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const KEY_936 = positionTrailKey('tradestation', '936', 'MNQU26')
const KEY_933 = positionTrailKey('tradestation', '933', 'MNQU26')

function fakeStack(positions: any[]) {
  const placed: any[] = []
  const cancelled: string[] = []
  const adapter = {
    getPositions: async () => positions,
    placeOrder: async (o: any) => { placed.push(o); return { orderId: `new-${placed.length}`, status: 'filled' } },
    cancelOrder: async (id: string) => { cancelled.push(id) },
  }
  const exchangeManager = { getSession: async () => ({ status: 'connected', adapter }) }
  return { adapter, exchangeManager, placed, cancelled }
}

function seed936Trail() {
  db.upsertLocalTrailState({
    signalId: KEY_936, exchange: 'tradestation', symbol: 'MNQU26', direction: 'long',
    entryPrice: 29428.5, slOrderId: 'sl-936', extremePrice: 29430, oppositePrice: 29230,
    currentStop: 25014.25, manualStop: 25014.25, trailingLock: true,
    source: 'manual', accountId: '936',
  })
}

describe('manual arm across accounts on the same contract', () => {
  it('never adopts or retires the OTHER account\'s trail (one stop owner PER POSITION)', async () => {
    seed936Trail()
    const positions = [
      { accountId: '936', symbol: 'MNQU26', side: 'long', size: 1, entryPrice: 29428.5, markPrice: 29230 },
      { accountId: '933', symbol: 'MNQU26', side: 'long', size: 1, entryPrice: 29228, markPrice: 29230 },
    ]
    const stack = fakeStack(positions)
    const svc = createPositionManageService(db, stack.exchangeManager as any)

    await svc.manage({
      action: 'arm', exchange: 'tradestation', symbol: 'MNQU26', accountId: '933',
      manualStop: 27771.75, trailingLock: true,
    })

    // 936 keeps its trail AND its venue stop-order.
    const t936 = db.getLocalTrail(KEY_936)!
    expect(t936.active).toBe(1)
    expect(t936.sl_order_id).toBe('sl-936')
    // 933 starts without a stolen seed; the tick will place its own stop.
    const t933 = db.getLocalTrail(KEY_933)!
    expect(t933.active).toBe(1)
    expect(t933.sl_order_id).toBeNull()

    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })
    await mgr.tick()
    await orderLockIdle()

    // Fresh stop placed on 933's own account; nothing cancelled anywhere.
    expect(stack.cancelled).toHaveLength(0)
    const stops = stack.placed.filter((o) => o.orderType === 'stop')
    expect(stops).toHaveLength(1)
    expect(stops[0].accountId).toBe('933')
    expect(stops[0].stopPrice).toBeCloseTo(27771.75, 9)
    expect(db.getLocalTrail(KEY_933)!.sl_order_id).toBe('new-1')
    expect(db.getLocalTrail(KEY_936)!.sl_order_id).toBe('sl-936')
  })

  it('tick matches each trail to ITS account: a flat account retires only its own trail/stop', async () => {
    seed936Trail()
    db.upsertLocalTrailState({
      signalId: KEY_933, exchange: 'tradestation', symbol: 'MNQU26', direction: 'long',
      entryPrice: 29228, slOrderId: 'sl-933', extremePrice: 29230, oppositePrice: 29220,
      currentStop: 27771.75, manualStop: 27771.75, trailingLock: true,
      source: 'manual', accountId: '933',
    })
    // 936 went flat; 933 is still open.
    const positions = [
      { accountId: '933', symbol: 'MNQU26', side: 'long', size: 1, entryPrice: 29228, markPrice: 29230 },
    ]
    const stack = fakeStack(positions)
    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })
    await mgr.tick()
    await orderLockIdle()

    // 936's trail retired with its own orphan stop cancelled; 933 untouched.
    expect(db.getLocalTrail(KEY_936)!.active).toBe(0)
    expect(stack.cancelled).toContain('sl-936')
    const t933 = db.getLocalTrail(KEY_933)!
    expect(t933.active).toBe(1)
    expect(t933.sl_order_id).toBe('sl-933')
  })
})
