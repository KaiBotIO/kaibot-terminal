// F2: the edge manager engine inside the LocalPositionManager tick — reducers
// drive reduce-only closes and stop candidates against a live position, with
// state threaded through the DB between ticks.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { LocalPositionManager } from './local-position-manager.js'
import { createPositionManagersService } from './position-managers.js'
import { orderLockIdle } from './order-lock.js'
import { positionTrailKey } from './position-trail.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-mgr-loop-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const KEY = positionTrailKey('bybit', 'acct-1', 'BTCUSDT')

// Fake adapter whose positions array is LIVE (mutable between ticks).
function fakeStack(positions: any[]) {
  const placed: any[] = []
  const cancelled: string[] = []
  const adapter = {
    getPositions: async () => positions,
    placeOrder: async (o: any) => {
      placed.push(o)
      return { orderId: `new-${placed.length}`, status: 'filled' }
    },
    cancelOrder: async (id: string) => { cancelled.push(id) },
  }
  const exchangeManager = { getSession: async () => ({ status: 'connected', adapter }) }
  return { adapter, exchangeManager, placed, cancelled }
}

const pos = (over: Record<string, unknown> = {}) => ({
  accountId: 'acct-1',
  symbol: 'BTCUSDT',
  side: 'long',
  size: 8,
  entryPrice: 100,
  markPrice: 100,
  ...over,
})

async function attach(
  stack: ReturnType<typeof fakeStack>,
  managerId: string,
  params: Record<string, unknown>,
) {
  const svc = createPositionManagersService(db, stack.exchangeManager as any)
  await svc.manage({ action: 'attach', exchange: 'bybit', symbol: 'BTCUSDT', managerId, params })
}

describe('LocalPositionManager — edge manager engine', () => {
  it('tp-ladder rung fires → reduce-only market close for the tranche; state threads', async () => {
    const positions = [pos()]
    const stack = fakeStack(positions)
    await attach(stack, 'tp-ladder', { target: 120, levelCount: 2, fractionPerTranche: 0.25 })
    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })

    // Below the first rung (entry 100 → rung0 at 104.72): nothing happens.
    positions[0].markPrice = 104
    await mgr.tick()
    await orderLockIdle()
    expect(stack.placed).toHaveLength(0)

    // Rung 0 (104.72) reached → close 25% of 8 = 2, reduce-only market.
    positions[0].markPrice = 105
    await mgr.tick()
    await orderLockIdle()
    expect(stack.placed).toHaveLength(1)
    expect(stack.placed[0]).toMatchObject({
      symbol: 'BTCUSDT', side: 'sell', orderType: 'market', reduceOnly: true, accountId: 'acct-1',
    })
    expect(stack.placed[0].quantity).toBeCloseTo(2, 9)

    // Rung marked fired in the threaded state; same price again → no re-fire.
    const state = JSON.parse(db.getPositionManager(KEY, 'tp-ladder')!.state)
    expect(state.scratch.tpTriggered).toBe(JSON.stringify([0]))
    positions[0].size = 6
    await mgr.tick()
    await orderLockIdle()
    expect(stack.placed).toHaveLength(1)

    // Settlement recorded + resolved for the tranche.
    const settlements = db.all(
      "SELECT * FROM order_settlements WHERE signal_id = ?", [KEY],
    ) as any[]
    expect(settlements).toHaveLength(1)
    expect(settlements[0].target_label).toBe('manage:tp-ladder:0')
    expect(settlements[0].status).toBe('filled')
  })

  it('tp-ladder partial close reduces the manual position marker', async () => {
    const positions = [pos()]
    const stack = fakeStack(positions)
    db.addManualPosition('bybit', 'acct-1', 'BTCUSDT', 'buy', 8)
    await attach(stack, 'tp-ladder', { target: 120, levelCount: 2, fractionPerTranche: 0.25 })
    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })
    positions[0].markPrice = 105
    await mgr.tick()
    await orderLockIdle()
    expect(db.getManualPosition('bybit', 'acct-1', 'BTCUSDT')!.net).toBeCloseTo(6, 9)
  })

  it('risk-guard global stop → FULL close with manual-close-parity cleanup', async () => {
    const positions = [pos()]
    const stack = fakeStack(positions)
    // A manual bracket + a trail row own resting protection.
    db.insertOrderSettlement({
      signalId: 'manual:abc', exchange: 'bybit', accountId: 'acct-1', symbol: 'BTCUSDT',
      kind: 'entry', side: 'buy', qty: 8, orderId: 'entry-1', targetLabel: 'entry', status: 'filled',
    })
    db.upsertLocalTrailState({
      signalId: KEY, exchange: 'bybit', symbol: 'BTCUSDT', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-live', trailPercentage: 2, extremePrice: 100,
      currentStop: 95, source: 'manual', accountId: 'acct-1',
    })
    await attach(stack, 'risk-guard', { globalStopPrice: 92 })

    const retired: string[] = []
    const rungCancels: string[][] = []
    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999,
      signalTrailingEnabled: false,
      retireBracket: (_ex, sid) => { retired.push(sid) },
      cancelEntryRungs: (_ex, sids) => { rungCancels.push(sids) },
    })

    // Price crashes through the guard's stop.
    positions[0].markPrice = 90
    await mgr.tick()
    await orderLockIdle()

    // Full reduce-only market close at the whole live size.
    const close = stack.placed.find((o) => o.orderType === 'market')
    expect(close).toBeDefined()
    expect(close.quantity).toBeCloseTo(8, 9)
    expect(close.reduceOnly).toBe(true)
    // Bracket + rung cleanup ran, the trail stop was cancelled, rows retired.
    expect(retired).toEqual(['manual:abc'])
    expect(rungCancels).toEqual([['manual:abc']])
    expect(stack.cancelled).toContain('sl-live')
    expect(db.listActiveLocalTrails()).toHaveLength(0)
    expect(db.listActiveManagedPositions()).toHaveLength(0)
    const settlements = db.all("SELECT * FROM order_settlements WHERE signal_id = ?", [KEY]) as any[]
    expect(settlements[0].target_label).toBe('manage:global-stop')
  })

  it('break-even manager stop candidate dispatches through the trail row (one stop owner)', async () => {
    const positions = [pos()]
    const stack = fakeStack(positions)
    // Attaching BE creates the stop-owner shell (no bracket to adopt → no id).
    await attach(stack, 'break-even-mover', { feePercentage: 0.001 })
    expect(db.listActiveLocalTrails()).toHaveLength(1)

    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })

    // Price moves into profit → BE fires (100 * 1.001 = 100.1), the trail row
    // dispatches it as a resting reduce-only stop.
    positions[0].markPrice = 102
    await mgr.tick()
    await orderLockIdle()

    const stops = stack.placed.filter((o) => o.orderType === 'stop')
    expect(stops).toHaveLength(1)
    expect(stops[0].stopPrice).toBeCloseTo(100.1, 9)
    expect(stops[0].reduceOnly).toBe(true)
    const trail = db.getLocalTrail(KEY)!
    expect(trail.current_stop).toBeCloseTo(100.1, 9)
    expect(trail.engine_stop).toBeCloseTo(100.1, 9)
    // BE is one-shot: armed flag threaded, no second stop placement.
    positions[0].markPrice = 103
    await mgr.tick()
    await orderLockIdle()
    expect(stack.placed.filter((o) => o.orderType === 'stop')).toHaveLength(1)
    const state = JSON.parse(db.getPositionManager(KEY, 'break-even-mover')!.state)
    expect(state.scratch.breakEvenArmed).toBe(true)
  })

  it('manager candidate composes with the manual stop rule (manual participates, engine improves)', async () => {
    const positions = [pos()]
    const stack = fakeStack(positions)
    await attach(stack, 'break-even-mover', { feePercentage: 0.001 })
    // The user pinned a manual stop ABOVE break-even — BE must not degrade it.
    db.updateLocalTrail(KEY, { manualStop: 101, currentStop: 101 })

    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })
    positions[0].markPrice = 102
    await mgr.tick()
    await orderLockIdle()

    // BE candidate 100.1 < manual 101 → no venue move; ratchet may record it.
    expect(stack.placed.filter((o) => o.orderType === 'stop')).toHaveLength(0)
    expect(db.getLocalTrail(KEY)!.current_stop).toBeCloseTo(101, 9)
  })

  it('managers retire when the position goes flat', async () => {
    const positions = [pos()]
    const stack = fakeStack(positions)
    await attach(stack, 'tp-ladder', { target: 120 })
    positions.length = 0 // flat
    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })
    await mgr.tick()
    await orderLockIdle()
    expect(db.listActiveManagedPositions()).toHaveLength(0)
  })

  it('marks advance and persist across ticks (adverse + favourable water marks)', async () => {
    const positions = [pos()]
    const stack = fakeStack(positions)
    await attach(stack, 'tp-ladder', { target: 150 })
    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })
    positions[0].markPrice = 96
    await mgr.tick()
    await orderLockIdle()
    positions[0].markPrice = 108
    await mgr.tick()
    await orderLockIdle()
    const row = db.getManagedPosition(KEY)!
    expect(row.extreme_price).toBe(108)
    expect(row.opposite_price).toBe(96)
  })
})

describe('LocalPositionManager — group risk-guard (G2)', () => {
  const attachTo = async (
    stack: ReturnType<typeof fakeStack>,
    symbol: string,
    params: Record<string, unknown>,
  ) => {
    const svc = createPositionManagersService(db, stack.exchangeManager as any)
    await svc.manage({ action: 'attach', exchange: 'bybit', symbol, managerId: 'group-risk-guard', params })
  }
  const linkToGroup = (groupId: string, symbol: string) =>
    db.upsertPositionGroupLink({
      positionKey: positionTrailKey('bybit', 'acct-1', symbol),
      exchange: 'bybit', accountId: 'acct-1', symbol,
      groupId, assignedBy: 'user',
    })

  it('a group loss breach fully closes every group member on the SAME tick; ungrouped positions stay', async () => {
    const positions: any[] = [
      pos({ symbol: 'BTCUSDT', size: 10, entryPrice: 100, markPrice: 100, unrealizedPnL: 0 }),
      pos({ symbol: 'ETHUSDT', size: 5, entryPrice: 50, markPrice: 50, unrealizedPnL: 0 }),
      pos({ symbol: 'SOLUSDT', size: 4, entryPrice: 20, markPrice: 20, unrealizedPnL: 0 }),
    ]
    const stack = fakeStack(positions)
    db.createPositionGroup({ id: 'grp', name: 'Book', source: 'manual' })
    linkToGroup('grp', 'BTCUSDT')
    linkToGroup('grp', 'ETHUSDT')
    // SOL carries the guard too, but no group → the guard must stay inert.
    db.insertBalanceSnapshot({ exchange: 'bybit', accountId: 'acct-1', equity: 10_000, balance: 10_000 })
    for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
      await attachTo(stack, symbol, { maxGroupLossFraction: 0.02 })
    }
    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })

    // Aggregate group loss -150 > -200 threshold (2% of 10k): nothing fires.
    positions[0].markPrice = 85
    positions[0].unrealizedPnL = -150
    await mgr.tick()
    await orderLockIdle()
    expect(stack.placed).toHaveLength(0)

    // ETH slides too: aggregate -210 breaches → BOTH members close full,
    // reduce-only, in the same tick. SOL (ungrouped) is untouched.
    positions[1].markPrice = 38
    positions[1].unrealizedPnL = -60
    await mgr.tick()
    await orderLockIdle()
    const closes = stack.placed.filter((o) => o.orderType === 'market' && o.reduceOnly)
    expect(closes.map((o) => o.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(closes.find((o) => o.symbol === 'BTCUSDT')!.quantity).toBeCloseTo(10, 9)
    expect(closes.find((o) => o.symbol === 'ETHUSDT')!.quantity).toBeCloseTo(5, 9)
    // Both managed rows retired; SOL's guard row stays armed.
    const active = db.listActiveManagedPositions().map((r) => r.symbol)
    expect(active).toEqual(['SOLUSDT'])
    const settlements = db.all(
      "SELECT * FROM order_settlements WHERE target_label = 'manage:group-loss'",
    ) as any[]
    expect(settlements).toHaveLength(2)
  })

  it('without a balance snapshot the loss-fraction check stays inert (equity unknown)', async () => {
    const positions = [
      pos({ symbol: 'BTCUSDT', size: 10, entryPrice: 100, markPrice: 60, unrealizedPnL: -400 }),
    ]
    const stack = fakeStack(positions)
    db.createPositionGroup({ id: 'grp', name: 'Book', source: 'manual' })
    linkToGroup('grp', 'BTCUSDT')
    await attachTo(stack, 'BTCUSDT', { maxGroupLossFraction: 0.01 })
    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })
    await mgr.tick()
    await orderLockIdle()
    expect(stack.placed).toHaveLength(0)
  })

  it('the notional cap needs no equity basis and closes the group', async () => {
    const positions = [
      pos({ symbol: 'BTCUSDT', size: 10, entryPrice: 100, markPrice: 100, unrealizedPnL: 0 }),
    ]
    const stack = fakeStack(positions)
    db.createPositionGroup({ id: 'grp', name: 'Book', source: 'manual' })
    linkToGroup('grp', 'BTCUSDT')
    await attachTo(stack, 'BTCUSDT', { maxGroupNotional: 900 })
    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })
    await mgr.tick()
    await orderLockIdle()
    const closes = stack.placed.filter((o) => o.orderType === 'market' && o.reduceOnly)
    expect(closes).toHaveLength(1)
    expect(closes[0].quantity).toBeCloseTo(10, 9)
  })
})
