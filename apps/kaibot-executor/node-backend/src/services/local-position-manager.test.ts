import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { LocalPositionManager } from './local-position-manager.js'
import { isLocalTrailingEnabled } from './local-trailing-gate.js'
import { orderLockIdle } from './order-lock.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-trail-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// Minimal fake adapter + exchange manager.
function fakeStack(positions: any[]) {
  const placed: any[] = []
  const cancelled: string[] = []
  const adapter = {
    getPositions: async () => positions,
    placeOrder: async (o: any) => { placed.push(o); return { orderId: `new-${placed.length}`, status: 'filled' } },
    cancelOrder: async (id: string) => { cancelled.push(id) },
  }
  const exchangeManager = {
    getSession: async () => ({ status: 'connected', adapter }),
  }
  return { adapter, exchangeManager, placed, cancelled }
}

describe('LocalPositionManager.tick', () => {
  it('amends the stop upward as a long position runs (trailing)', async () => {
    db.upsertLocalTrailState({
      signalId: 'sig-1', exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-1', trailPercentage: 2, extremePrice: 100, currentStop: 95,
    })
    const { exchangeManager, placed, cancelled } = fakeStack([{ symbol: 'BTCUSDT', size: 1, markPrice: 110 }])
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, { tickMs: 999999 })

    await mgr.tick()
    await orderLockIdle()

    const [row] = db.listActiveLocalTrails()
    expect(row.extreme_price).toBe(110)
    expect(row.current_stop).toBeCloseTo(107.8, 6) // 110 - 2%
    expect(row.sl_order_id).toBe('new-1')
    expect(cancelled).toContain('sl-1')
    expect(placed[0]).toMatchObject({ side: 'sell', orderType: 'stop', reduceOnly: true })
    expect(placed[0].stopPrice).toBeCloseTo(107.8, 6)
  })

  // Regression (full-review 2026-07-04): when the old stop was cancelled but the
  // replacement place() failed, the DB kept pointing sl_order_id at the (now
  // cancelled) order — later a TP fill / close would cancel a dead id and leave
  // the trail stop resting (double-exit). On failure the stale id must be dropped.
  it('drops the stale stop id when re-placing the trailing stop fails', async () => {
    db.upsertLocalTrailState({
      signalId: 'sig-fail', exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-old', trailPercentage: 2, extremePrice: 100, currentStop: 95,
    })
    const cancelled: string[] = []
    const adapter = {
      getPositions: async () => [{ symbol: 'BTCUSDT', size: 1, markPrice: 110, accountId: 'btc' }],
      placeOrder: async () => { throw new Error('exchange rejected the stop') },
      cancelOrder: async (id: string) => { cancelled.push(id) },
    }
    const exchangeManager = { getSession: async () => ({ status: 'connected', adapter }) }
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, { tickMs: 999999 })

    await mgr.tick()
    await orderLockIdle()

    expect(cancelled).toContain('sl-old') // old stop was cancelled
    const [row] = db.listActiveLocalTrails()
    expect(row.sl_order_id).toBeNull() // stale/dead id dropped, not left dangling
  })

  it('does not move the stop when price has not advanced enough', async () => {
    db.upsertLocalTrailState({
      signalId: 'sig-2', exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-1', trailPercentage: 2, extremePrice: 110, currentStop: 107.8,
    })
    // Price ticks down to 108 → extreme stays 110 → trail stays 107.8, no improvement.
    const { exchangeManager, placed } = fakeStack([{ symbol: 'BTCUSDT', size: 1, markPrice: 108 }])
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, { tickMs: 999999 })

    await mgr.tick()
    await orderLockIdle()

    expect(placed).toHaveLength(0)
    const [row] = db.listActiveLocalTrails()
    expect(row.current_stop).toBeCloseTo(107.8, 6)
  })

  // SPINE regression (EXEC-1): without the EXECUTOR_LOCAL_TRAILING opt-in the
  // executor must NOT autonomously move the live protective stop. The gate is
  // default-OFF, and an un-started manager places no local stop even when a trail
  // would otherwise advance.
  it('does not start / move any local stop when the gate is unset (default OFF)', async () => {
    expect(isLocalTrailingEnabled({})).toBe(false)
    expect(isLocalTrailingEnabled({ EXECUTOR_LOCAL_TRAILING: '0' })).toBe(false)
    expect(isLocalTrailingEnabled({ EXECUTOR_LOCAL_TRAILING: 'false' })).toBe(false)
    expect(isLocalTrailingEnabled({ EXECUTOR_LOCAL_TRAILING: '1' })).toBe(true)
    expect(isLocalTrailingEnabled({ EXECUTOR_LOCAL_TRAILING: 'true' })).toBe(true)

    db.upsertLocalTrailState({
      signalId: 'sig-gate', exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-1', trailPercentage: 2, extremePrice: 100, currentStop: 95,
    })
    const { exchangeManager, placed, cancelled } = fakeStack([{ symbol: 'BTCUSDT', size: 1, markPrice: 110 }])
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, { tickMs: 999999 })

    // Gate OFF → start() is never called by the bootstrap. No timer, no tick →
    // no cancel/replace of the live stop.
    if (isLocalTrailingEnabled({})) mgr.start()
    await orderLockIdle()

    expect(placed).toHaveLength(0)
    expect(cancelled).toHaveLength(0)
    const [row] = db.listActiveLocalTrails()
    expect(row.sl_order_id).toBe('sl-1')
    expect(row.current_stop).toBeCloseTo(95, 6)
  })

  it('deactivates the trail when the position is flat', async () => {
    db.upsertLocalTrailState({
      signalId: 'sig-3', exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-1', trailPercentage: 2, extremePrice: 110, currentStop: 107.8,
    })
    const { exchangeManager } = fakeStack([]) // no live position
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, { tickMs: 999999 })

    await mgr.tick()
    expect(db.listActiveLocalTrails()).toHaveLength(0)
  })
})

// F1 (pilot-ladder decomposition): position-scoped manual trails.
describe('LocalPositionManager — manual position trails', () => {
  it('drives MANUAL rows even when signal trailing is gated off; signal rows stay inert', async () => {
    db.upsertLocalTrailState({
      signalId: 'sig-gated', exchange: 'bybit', symbol: 'ETHUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-sig', trailPercentage: 2, extremePrice: 100, currentStop: 95,
      source: 'signal',
    })
    db.upsertLocalTrailState({
      signalId: 'pos:bybit:acct-1:BTCUSDT', exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-man', trailPercentage: 2, extremePrice: 100, currentStop: 95,
      source: 'manual', accountId: 'acct-1',
    })
    const { exchangeManager, placed, cancelled } = fakeStack([
      { symbol: 'BTCUSDT', size: 1, markPrice: 110 },
      { symbol: 'ETHUSDT', size: 1, markPrice: 110 },
    ])
    // EXECUTOR_LOCAL_TRAILING unset → signalTrailingEnabled false.
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })

    await mgr.tick()
    await orderLockIdle()

    // Only the manual row moved its stop.
    expect(cancelled).toEqual(['sl-man'])
    expect(placed).toHaveLength(1)
    expect(placed[0].symbol).toBe('BTCUSDT')
    const sig = db.getLocalTrail('sig-gated')!
    expect(sig.current_stop).toBeCloseTo(95, 6)
    expect(sig.sl_order_id).toBe('sl-sig')
  })

  it('drawdown mode trails by the carried depth (SDK maths) and ratchets the engine stop', async () => {
    db.upsertLocalTrailState({
      signalId: 'pos:bybit:acct-1:BTCUSDT', exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-0', extremePrice: 100, oppositePrice: 100,
      source: 'manual', accountId: 'acct-1', mode: 'drawdown', minPercentage: 2,
    })
    const { exchangeManager, placed } = fakeStack([{ symbol: 'BTCUSDT', size: 1, markPrice: 110 }])
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })

    await mgr.tick()
    await orderLockIdle()

    // Depth (110-100)/110 ≈ 9.09% > floor 2%, capped at default 40% →
    // stop = 110 * (1 - 10/110) = 100.
    const row = db.getLocalTrail('pos:bybit:acct-1:BTCUSDT')!
    expect(row.extreme_price).toBe(110)
    expect(row.engine_stop).toBeCloseTo(100, 6)
    expect(row.current_stop).toBeCloseTo(100, 6)
    expect(placed[0].stopPrice).toBeCloseTo(100, 6)
  })

  // Regression (vangnet 2026-08-24): a fresh manual arm with only a manualStop
  // (no adoptable seed) writes current_stop = manualStop with sl_order_id null;
  // the tick then saw "effective == current_stop" and never placed the venue
  // stop — the UI showed a stop that did not exist on the exchange. Same root
  // cause killed the retry after a failed replace (sl_order_id nulled,
  // current_stop kept). No resting order → place regardless of stop delta.
  it('places the venue stop on first tick after a manual arm without a seed order', async () => {
    db.upsertLocalTrailState({
      signalId: 'pos:tradestation:936:MNQU26', exchange: 'tradestation', symbol: 'MNQU26',
      direction: 'long', entryPrice: 29428.5, slOrderId: null,
      extremePrice: 29428.5, oppositePrice: 29428.5, currentStop: 25014,
      source: 'manual', accountId: '936', trailingLock: true, manualStop: 25014,
    })
    const { exchangeManager, placed, cancelled } = fakeStack([
      { symbol: 'MNQU26', size: 1, markPrice: 29500, accountId: '936' },
    ])
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })

    await mgr.tick()
    await orderLockIdle()

    expect(cancelled).toHaveLength(0)
    expect(placed).toHaveLength(1)
    expect(placed[0]).toMatchObject({ side: 'sell', orderType: 'stop', reduceOnly: true, accountId: '936' })
    expect(placed[0].stopPrice).toBeCloseTo(25014, 6)
    const row = db.getLocalTrail('pos:tradestation:936:MNQU26')!
    expect(row.sl_order_id).toBe('new-1')
  })

  it('locked manual stop is ABSOLUTE: replaces the venue stop even against the engine', async () => {
    db.upsertLocalTrailState({
      signalId: 'pos:bybit:acct-1:BTCUSDT', exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-0', trailPercentage: 2, extremePrice: 110,
      currentStop: 107.8, engineStop: 107.8,
      source: 'manual', accountId: 'acct-1', trailingLock: true, manualStop: 101,
    })
    const { exchangeManager, placed, cancelled } = fakeStack([{ symbol: 'BTCUSDT', size: 1, markPrice: 112 }])
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })

    await mgr.tick()
    await orderLockIdle()

    // The human pinned 101 — the stop moves DOWN from 107.8 to 101.
    expect(cancelled).toContain('sl-0')
    expect(placed[0].stopPrice).toBeCloseTo(101, 6)
    const row = db.getLocalTrail('pos:bybit:acct-1:BTCUSDT')!
    expect(row.current_stop).toBeCloseTo(101, 6)
    // The engine ratchet is preserved for when the lock lifts.
    expect(row.engine_stop).toBeCloseTo(107.8, 6)
  })

  it('manual stop participates unlocked: engine only improves on it', async () => {
    db.upsertLocalTrailState({
      signalId: 'pos:bybit:acct-1:BTCUSDT', exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-0', trailPercentage: 2, extremePrice: 100,
      currentStop: 104, manualStop: 104,
      source: 'manual', accountId: 'acct-1',
    })
    // Price 105 → trail candidate 105-2% = 102.9 < manual 104 → no move.
    const { exchangeManager, placed } = fakeStack([{ symbol: 'BTCUSDT', size: 1, markPrice: 105 }])
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })
    await mgr.tick()
    await orderLockIdle()
    expect(placed).toHaveLength(0)

    // Price runs to 110 → trail 107.8 beats the manual 104 → engine improves.
    const stack2 = fakeStack([{ symbol: 'BTCUSDT', size: 1, markPrice: 110 }])
    const mgr2 = new LocalPositionManager(db, stack2.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })
    await mgr2.tick()
    await orderLockIdle()
    expect(stack2.placed[0].stopPrice).toBeCloseTo(107.8, 6)
  })

  it('cancels the manual trail stop when the position goes flat (no orphan stop)', async () => {
    db.upsertLocalTrailState({
      signalId: 'pos:bybit:acct-1:BTCUSDT', exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-live', trailPercentage: 2, extremePrice: 110, currentStop: 107.8,
      source: 'manual', accountId: 'acct-1',
    })
    const { exchangeManager, cancelled } = fakeStack([]) // flat
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })

    await mgr.tick()
    await orderLockIdle()

    expect(cancelled).toContain('sl-live')
    expect(db.listActiveLocalTrails()).toHaveLength(0)
  })

  it('rebinds the adopted bracket stop to the fresh order id on replace', async () => {
    db.upsertBracketPair({
      signalId: 'manual:abc', exchange: 'bybit', slOrderId: 'sl-old', tpOrderIds: ['tp-1'],
    })
    db.upsertLocalTrailState({
      signalId: 'pos:bybit:acct-1:BTCUSDT', exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-old', trailPercentage: 2, extremePrice: 100, currentStop: 95,
      source: 'manual', accountId: 'acct-1', bracketSignalId: 'manual:abc',
    })
    const rebinds: Array<[string, string, string]> = []
    const { exchangeManager } = fakeStack([{ symbol: 'BTCUSDT', size: 1, markPrice: 110 }])
    const mgr = new LocalPositionManager(db, exchangeManager as any, null, {
      tickMs: 999999,
      signalTrailingEnabled: false,
      rebindBracketStop: (ex, sid, oid) => rebinds.push([ex, sid, oid]),
    })

    await mgr.tick()
    await orderLockIdle()

    expect(rebinds).toEqual([['bybit', 'manual:abc', 'new-1']])
  })
})
