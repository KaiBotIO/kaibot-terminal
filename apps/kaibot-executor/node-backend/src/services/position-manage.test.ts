import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { createPositionManageService, validateManageComponents } from './position-manage.js'
import { positionTrailKey } from './position-trail.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-manage-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function fakeManager(positions: any[]) {
  const adapter = {
    getPositions: async () => positions,
    placeOrder: async () => ({ orderId: 'x', status: 'filled' }),
    cancelOrder: async () => {},
  }
  return { getSession: async () => ({ status: 'connected', adapter }) } as any
}

const LONG_POS = {
  accountId: 'acct-1',
  symbol: 'BTC-PERPETUAL',
  side: 'long',
  size: 2,
  entryPrice: 100,
  markPrice: 105,
}

describe('validateManageComponents', () => {
  it('rejects an empty arm (nothing to protect with)', () => {
    expect(() => validateManageComponents({})).toThrow(/nothing to arm/)
  })
  it('rejects a fixed trail without a distance', () => {
    expect(() => validateManageComponents({ trail: { mode: 'fixed' } })).toThrow(/positive distance/)
  })
  it('rejects a drawdown trail without a floor or reference', () => {
    expect(() => validateManageComponents({ trail: { mode: 'drawdown' } })).toThrow(/distance floor/)
  })
  it('accepts a drawdown trail with only a reference anchor', () => {
    expect(() =>
      validateManageComponents({ trail: { mode: 'drawdown', referencePrice: 110 } }),
    ).not.toThrow()
  })
  it('rejects a nonsense breakeven fee and negative stops', () => {
    expect(() => validateManageComponents({ breakevenFee: 0.5 })).toThrow(/breakevenFee/)
    expect(() => validateManageComponents({ manualStop: -5 })).toThrow(/manualStop/)
  })
})

describe('positionManage — arm', () => {
  it('arms a position-scoped manual trail row on a live position', async () => {
    const svc = createPositionManageService(db, fakeManager([LONG_POS]))
    const view = await svc.manage({
      action: 'arm',
      exchange: 'deribit',
      symbol: 'BTC-PERPETUAL',
      trail: { mode: 'fixed', trailPercentage: 2 },
      breakevenFee: 0.001,
      manualStop: 95,
    })
    expect(view.key).toBe(positionTrailKey('deribit', 'acct-1', 'BTC-PERPETUAL'))
    expect(view.source).toBe('manual')
    expect(view.direction).toBe('long')
    expect(view.mode).toBe('fixed')
    expect(view.manualStop).toBe(95)
    expect(view.breakevenFee).toBe(0.001)
    // Water marks start at the arm-time mark.
    expect(view.extremePrice).toBe(105)
    expect(view.oppositePrice).toBe(105)
    // Manual stop participates immediately: effective = 95 (no engine yet).
    expect(view.effectiveStop).toBe(95)
    expect(db.listActiveLocalTrails()).toHaveLength(1)
  })

  it('refuses to arm without a live position', async () => {
    const svc = createPositionManageService(db, fakeManager([]))
    await expect(
      svc.manage({
        action: 'arm', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
        trail: { mode: 'fixed', trailPercentage: 2 },
      }),
    ).rejects.toThrow(/no open position/)
  })

  it('refuses a manual stop on the wrong side of the market', async () => {
    const svc = createPositionManageService(db, fakeManager([LONG_POS]))
    await expect(
      svc.manage({
        action: 'arm', exchange: 'deribit', symbol: 'BTC-PERPETUAL', manualStop: 120,
      }),
    ).rejects.toThrow(/below the current price/)
  })

  it('adopts the manual bracket stop as seed and records the bracket for rebinding', async () => {
    // A manual entry with a protective stop exists (F0 path).
    db.insertOrderSettlement({
      signalId: 'manual:abc', exchange: 'deribit', accountId: 'acct-1',
      symbol: 'BTC-PERPETUAL', kind: 'entry', side: 'buy', qty: 2,
      orderId: 'entry-1', targetLabel: 'entry', status: 'filled',
    })
    db.upsertBracketPair({
      signalId: 'manual:abc', exchange: 'deribit', slOrderId: 'sl-existing', tpOrderIds: ['tp-1'],
    })
    const svc = createPositionManageService(db, fakeManager([LONG_POS]))
    const view = await svc.manage({
      action: 'arm', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      trail: { mode: 'fixed', trailPercentage: 2 }, manualStop: 95,
    })
    const row = db.getLocalTrail(view.key)!
    expect(row.sl_order_id).toBe('sl-existing') // took the stop over as seed
    expect(row.bracket_signal_id).toBe('manual:abc')
    expect(row.current_stop).toBe(95) // seeded from the user's stop
  })

  it('enforces ONE stop owner: arming retires a sibling trail and inherits its seed', async () => {
    // A signal-armed trail already steers the position.
    db.upsertLocalTrailState({
      signalId: 'sig-1', exchange: 'deribit', symbol: 'BTC-PERPETUAL', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-sig', trailPercentage: 1, extremePrice: 104, currentStop: 96,
    })
    const svc = createPositionManageService(db, fakeManager([LONG_POS]))
    const view = await svc.manage({
      action: 'arm', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      trail: { mode: 'drawdown', trailPercentage: 2 },
    })
    const active = db.listActiveLocalTrails()
    expect(active).toHaveLength(1)
    expect(active[0].signal_id).toBe(view.key)
    // Inherited the sibling's live stop order + last stop as seed.
    expect(active[0].sl_order_id).toBe('sl-sig')
    expect(active[0].current_stop).toBe(96)
    expect(db.getLocalTrail('sig-1')!.active).toBe(0)
  })

  it('re-arm on the same position updates params and keeps the seed (state transition)', async () => {
    const svc = createPositionManageService(db, fakeManager([LONG_POS]))
    const first = await svc.manage({
      action: 'arm', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      trail: { mode: 'fixed', trailPercentage: 2 }, manualStop: 95,
    })
    // Simulate the loop having taken the stop over.
    db.updateLocalTrail(first.key, { slOrderId: 'sl-live', currentStop: 101 })
    const second = await svc.manage({
      action: 'arm', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      trail: { mode: 'drawdown', trailPercentage: 3, freezeExtreme: true, referencePrice: 112 },
    })
    expect(second.key).toBe(first.key)
    expect(second.mode).toBe('drawdown')
    expect(second.freezeExtreme).toBe(true)
    expect(second.referencePrice).toBe(112)
    expect(second.manualStop).toBeNull() // re-arm without a manual stop clears it
    const row = db.getLocalTrail(second.key)!
    expect(row.sl_order_id).toBe('sl-live') // stop ownership survives the re-arm
    expect(db.listActiveLocalTrails()).toHaveLength(1)
  })

  it('freezeExtreme without a reference snapshots the arm-time mark as anchor', async () => {
    const svc = createPositionManageService(db, fakeManager([LONG_POS]))
    const view = await svc.manage({
      action: 'arm', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      trail: { mode: 'drawdown', trailPercentage: 2, freezeExtreme: true },
    })
    expect(view.referencePrice).toBe(105)
  })
})

describe('positionManage — update / lock / remove transitions', () => {
  async function armed() {
    const svc = createPositionManageService(db, fakeManager([LONG_POS]))
    const view = await svc.manage({
      action: 'arm', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      trail: { mode: 'fixed', trailPercentage: 2 }, manualStop: 95,
    })
    return { svc, key: view.key }
  }

  it('update adjusts the manual stop on the active row', async () => {
    const { svc } = await armed()
    const view = await svc.manage({
      action: 'update', exchange: 'deribit', symbol: 'BTC-PERPETUAL', manualStop: 97,
    })
    expect(view.manualStop).toBe(97)
    expect(view.effectiveStop).toBe(97)
  })

  it('update can clear the manual stop with null', async () => {
    const { svc } = await armed()
    const view = await svc.manage({
      action: 'update', exchange: 'deribit', symbol: 'BTC-PERPETUAL', manualStop: null,
    })
    expect(view.manualStop).toBeNull()
  })

  it('lock/unlock toggle trailing_lock; lock makes the manual stop absolute', async () => {
    const { svc, key } = await armed()
    // Engine has ratcheted above the manual stop.
    db.updateLocalTrail(key, { engineStop: 99 })
    let view = await svc.manage({ action: 'lock', exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(view.trailingLock).toBe(true)
    expect(view.effectiveStop).toBe(95) // manual absolute, engine 99 ignored
    view = await svc.manage({ action: 'unlock', exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(view.trailingLock).toBe(false)
    expect(view.effectiveStop).toBe(99) // engine improves again
  })

  it('remove deactivates the row and leaves the resting stop untouched', async () => {
    const { svc, key } = await armed()
    db.updateLocalTrail(key, { slOrderId: 'sl-live' })
    const view = await svc.manage({ action: 'remove', exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(view.active).toBe(false)
    expect(db.listActiveLocalTrails()).toHaveLength(0)
    // Detach never strips protection: the order id is still on the row, no cancel happened.
    expect(db.getLocalTrail(key)!.sl_order_id).toBe('sl-live')
  })

  it('update/lock/remove on a position without a trail is a clean error', async () => {
    const svc = createPositionManageService(db, fakeManager([LONG_POS]))
    for (const action of ['update', 'lock', 'unlock', 'remove'] as const) {
      await expect(
        svc.manage({ action, exchange: 'deribit', symbol: 'BTC-PERPETUAL', manualStop: 90 }),
      ).rejects.toThrow(/no active trail/)
    }
  })
})
