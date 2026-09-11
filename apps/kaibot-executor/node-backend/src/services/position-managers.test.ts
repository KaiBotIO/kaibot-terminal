import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import {
  createPositionManagersService,
  validateManagerAgainstPosition,
} from './position-managers.js'
import {
  normalizeBreakEvenParams,
  normalizeRiskGuardParams,
  normalizeTpLadderParams,
} from './edge-managers/registry.js'
import { positionTrailKey } from './position-trail.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-managers-test-'))
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

const KEY = positionTrailKey('deribit', 'acct-1', 'BTC-PERPETUAL')

describe('registry param normalization (schema-default mirrors)', () => {
  it('applies the SDK defaults for break-even-mover', () => {
    expect(normalizeBreakEvenParams({})).toEqual({
      feePercentage: 0.0015, triggerPercentage: 0, useEntryReference: false, referencePrice: 0,
    })
    expect(() => normalizeBreakEvenParams({ feePercentage: 2 })).toThrow(/feePercentage/)
    expect(() => normalizeBreakEvenParams({ triggerPercentage: -1 })).toThrow(/triggerPercentage/)
    expect(() => normalizeBreakEvenParams({ useEntryReference: 'yes' })).toThrow(/boolean/)
  })

  it('enforces the tp-ladder prices-or-target refinement + ranges', () => {
    expect(() => normalizeTpLadderParams({})).toThrow(/either explicit prices or a target/)
    expect(() => normalizeTpLadderParams({ target: -5 })).toThrow(/target/)
    expect(() => normalizeTpLadderParams({ target: 120, levelCount: 9 })).toThrow(/levelCount/)
    expect(() => normalizeTpLadderParams({ target: 120, levelCount: 2.5 })).toThrow(/integer/)
    expect(() => normalizeTpLadderParams({ prices: [100, -3] })).toThrow(/positive numbers/)
    expect(normalizeTpLadderParams({ target: 120 })).toEqual({
      prices: [], target: 120, levelCount: 6, fractionPerTranche: 0.25, runnerFraction: 0,
    })
  })

  it('risk-guard needs at least one knob', () => {
    expect(() => normalizeRiskGuardParams({})).toThrow(/at least one/)
    expect(normalizeRiskGuardParams({ globalStopPrice: 90 })).toEqual({ globalStopPrice: 90 })
    expect(() => normalizeRiskGuardParams({ maxSize: 0 })).toThrow(/maxSize/)
  })
})

describe('validateManagerAgainstPosition', () => {
  it('risk-guard global stop must be protective', () => {
    expect(() =>
      validateManagerAgainstPosition({
        managerId: 'risk-guard', params: { globalStopPrice: 110 },
        direction: 'long', avgEntryPrice: 100, markPrice: 105,
      }),
    ).toThrow(/below the current price/)
    expect(() =>
      validateManagerAgainstPosition({
        managerId: 'risk-guard', params: { globalStopPrice: 95 },
        direction: 'long', avgEntryPrice: 100, markPrice: 105,
      }),
    ).not.toThrow()
  })

  it('tp-ladder target must be in the winning direction', () => {
    expect(() =>
      validateManagerAgainstPosition({
        managerId: 'tp-ladder', params: { prices: [], target: 90 },
        direction: 'long', avgEntryPrice: 100, markPrice: 105,
      }),
    ).toThrow(/above the average entry/)
    expect(() =>
      validateManagerAgainstPosition({
        managerId: 'tp-ladder', params: { prices: [104, 90] },
        direction: 'short', avgEntryPrice: 100, markPrice: 95,
      }),
    ).not.toThrow()
    expect(() =>
      validateManagerAgainstPosition({
        managerId: 'tp-ladder', params: { prices: [104, 108] },
        direction: 'short', avgEntryPrice: 100, markPrice: 95,
      }),
    ).toThrow(/losing side/)
  })
})

describe('positionManagers — attach', () => {
  it('attaches tp-ladder: managed row + manager row with init state, no trail shell', async () => {
    const svc = createPositionManagersService(db, fakeManager([LONG_POS]))
    const view = await svc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'tp-ladder', params: { target: 120, levelCount: 3 },
    })
    expect(view.key).toBe(KEY)
    expect(view.direction).toBe('long')
    expect(view.avgEntryPrice).toBe(100) // REAL venue avg entry
    expect(view.size).toBe(2)
    // Marks start at the attach-time mark.
    expect(view.extremePrice).toBe(105)
    expect(view.oppositePrice).toBe(105)
    expect(view.managers).toHaveLength(1)
    const m = view.managers[0]
    expect(m.managerId).toBe('tp-ladder')
    expect(m.params).toEqual({ prices: [], target: 120, levelCount: 3, fractionPerTranche: 0.25, runnerFraction: 0 })
    // init() ran: rung prices frozen + original size captured.
    expect(m.state.scratch.tpOriginalSize).toBe(2)
    expect(typeof m.state.scratch.tpLevels).toBe('string')
    // A close-only manager creates no stop-owner shell.
    expect(db.listActiveLocalTrails()).toHaveLength(0)
  })

  it('refuses unknown / non-attachable managers and missing positions', async () => {
    const svc = createPositionManagersService(db, fakeManager([LONG_POS]))
    await expect(
      svc.manage({ action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'hedge-mirror' }),
    ).rejects.toThrow(/unknown or non-attachable/)
    // drawdown is runtime-supported but armed via /manage, not here.
    await expect(
      svc.manage({ action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'drawdown-trailing-stop' }),
    ).rejects.toThrow(/unknown or non-attachable/)
    const empty = createPositionManagersService(db, fakeManager([]))
    await expect(
      empty.manage({ action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'risk-guard', params: { globalStopPrice: 90 } }),
    ).rejects.toThrow(/no open position/)
  })

  it('break-even-mover (stop-emitting) creates a stop-owner shell adopting the bracket stop', async () => {
    // Manual entry with a resting protective stop exists (F0 path).
    db.insertOrderSettlement({
      signalId: 'manual:abc', exchange: 'deribit', accountId: 'acct-1',
      symbol: 'BTC-PERPETUAL', kind: 'entry', side: 'buy', qty: 2,
      orderId: 'entry-1', targetLabel: 'entry', status: 'filled',
    })
    db.upsertBracketPair({
      signalId: 'manual:abc', exchange: 'deribit', slOrderId: 'sl-existing', tpOrderIds: [],
    })
    const svc = createPositionManagersService(db, fakeManager([LONG_POS]))
    await svc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'break-even-mover',
    })
    const trails = db.listActiveLocalTrails()
    expect(trails).toHaveLength(1)
    expect(trails[0].signal_id).toBe(KEY)
    expect(trails[0].source).toBe('manual')
    expect(trails[0].sl_order_id).toBe('sl-existing')
    expect(trails[0].bracket_signal_id).toBe('manual:abc')
    // The shell computes no stop of its own.
    expect(trails[0].trail_percentage).toBeNull()
    expect(trails[0].breakeven_fee).toBeNull()
  })

  it('does not create a second stop owner when a trail row already exists', async () => {
    db.upsertLocalTrailState({
      signalId: KEY, exchange: 'deribit', symbol: 'BTC-PERPETUAL', direction: 'long',
      entryPrice: 100, slOrderId: 'sl-live', trailPercentage: 2, extremePrice: 104,
      currentStop: 96, source: 'manual', accountId: 'acct-1',
    })
    const svc = createPositionManagersService(db, fakeManager([LONG_POS]))
    const view = await svc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'break-even-mover',
    })
    expect(db.listActiveLocalTrails()).toHaveLength(1)
    expect(db.getLocalTrail(KEY)!.sl_order_id).toBe('sl-live')
    // The mirror's current-stop yardstick seeded from the resting stop.
    expect(view.currentStopLoss).toBe(96)
  })

  it('multiple managers share ONE managed position with canonical exec order', async () => {
    const svc = createPositionManagersService(db, fakeManager([LONG_POS]))
    await svc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'risk-guard', params: { globalStopPrice: 90 },
    })
    const view = await svc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'tp-ladder', params: { target: 120 },
    })
    expect(view.managers.map((m) => m.managerId)).toEqual(['tp-ladder', 'risk-guard'])
    expect(view.managers.map((m) => m.execOrder)).toEqual([30, 100]) // guard LAST
    expect(db.listActiveManagedPositions()).toHaveLength(1)
  })
})

describe('positionManagers — configure / detach / state roundtrip', () => {
  it('configure re-arms the reducer state with new params', async () => {
    const svc = createPositionManagersService(db, fakeManager([LONG_POS]))
    await svc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'tp-ladder', params: { target: 120, levelCount: 3 },
    })
    // Simulate a fired rung.
    const before = db.getPositionManager(KEY, 'tp-ladder')!
    const dirty = JSON.parse(before.state)
    dirty.scratch.tpTriggered = JSON.stringify([0])
    db.updatePositionManagerState(KEY, 'tp-ladder', JSON.stringify(dirty))

    const view = await svc.manage({
      action: 'configure', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'tp-ladder', params: { target: 130, levelCount: 2 },
    })
    const m = view.managers.find((x) => x.managerId === 'tp-ladder')!
    expect(m.params.target).toBe(130)
    expect(m.state.scratch.tpTriggered).toBe(JSON.stringify([])) // re-armed
  })

  it('configure/detach on a non-attached manager is a clean error', async () => {
    const svc = createPositionManagersService(db, fakeManager([LONG_POS]))
    await svc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'risk-guard', params: { globalStopPrice: 90 },
    })
    await expect(
      svc.manage({ action: 'configure', exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'tp-ladder', params: { target: 120 } }),
    ).rejects.toThrow(/not attached/)
    await expect(
      svc.manage({ action: 'detach', exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'tp-ladder' }),
    ).rejects.toThrow(/not attached/)
  })

  it('detach removes one manager; the last detach retires the position row', async () => {
    const svc = createPositionManagersService(db, fakeManager([LONG_POS]))
    await svc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'tp-ladder', params: { target: 120 },
    })
    await svc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'risk-guard', params: { globalStopPrice: 90 },
    })
    let view = await svc.manage({
      action: 'detach', exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'tp-ladder',
    })
    expect(view.managers.map((m) => m.managerId)).toEqual(['risk-guard'])
    expect(db.listActiveManagedPositions()).toHaveLength(1)

    view = await svc.manage({
      action: 'detach', exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'risk-guard',
    })
    expect(view.managers).toHaveLength(0)
    expect(view.active).toBe(false)
    expect(db.listActiveManagedPositions()).toHaveLength(0)
  })

  it('state roundtrips through the DB (list reflects persisted params + state)', async () => {
    const svc = createPositionManagersService(db, fakeManager([LONG_POS]))
    await svc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'break-even-mover', params: { feePercentage: 0.002, triggerPercentage: 1 },
    })
    // Simulate the loop threading state + marks.
    db.updatePositionManagerState(
      KEY, 'break-even-mover',
      JSON.stringify({ lastTs: null, position: 'none', scratch: { breakEvenArmed: true, breakEvenRef: 100 } }),
    )
    db.updateManagedPosition(KEY, { extremePrice: 111, oppositePrice: 99, size: 1.5 })

    const [view] = svc.list()
    expect(view.key).toBe(KEY)
    expect(view.extremePrice).toBe(111)
    expect(view.oppositePrice).toBe(99)
    expect(view.size).toBe(1.5)
    const m = view.managers[0]
    expect(m.params).toEqual({ feePercentage: 0.002, triggerPercentage: 1, useEntryReference: false, referencePrice: 0 })
    expect(m.state.scratch.breakEvenArmed).toBe(true)
  })
})
