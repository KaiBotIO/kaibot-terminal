// Stop floor on a BOT-managed position through /api/trade/manage, without a
// take-over: update/lock/unlock/remove land on server_exit_state, the venue
// stop is amended right away through the exit-update path (one resting stop
// per position), and the bot keeps its own stop underneath.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { createPositionManageService, type StopFloorView } from './position-manage.js'
import type { Order, OrderResult, Position } from './exchanges/types.js'

let dir: string
let dbPath: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-stop-floor-'))
  dbPath = join(dir, 'test.db')
  db = new KaiBotDatabase(dbPath)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const SYMBOL = 'BTC-PERPETUAL'
const ENTRY = 'entry-1'
const POS = 'pos-1'

class FakeAdapter {
  placed: Order[] = []
  cancelled: string[] = []
  constructor(public positions: Position[]) {}
  async getPositions() {
    return this.positions
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    return { orderId: `new-${this.placed.length}`, status: 'pending', filledQuantity: 0, averagePrice: 0 }
  }
  async cancelOrder(id: string) {
    this.cancelled.push(id)
  }
}

function manager(adapter: FakeAdapter) {
  return { getSession: async () => ({ status: 'connected', adapter }) } as any
}

function longPos(accountId = 'acct-1', markPrice = 61000): Position {
  return { id: 'p1', accountId, symbol: SYMBOL, side: 'long', size: 10, entryPrice: 60000, markPrice }
}

function seedBotPosition(opts: {
  entry?: string
  positionId?: string
  accountId?: string
  direction?: 'long' | 'short'
  stop?: number
  slOrderId?: string
} = {}) {
  const entry = opts.entry ?? ENTRY
  const positionId = opts.positionId ?? POS
  const direction = opts.direction ?? 'long'
  db.recordSignal({
    id: entry, strategyId: 'strat', symbol: 'BTC', action: direction === 'long' ? 'buy' : 'sell',
    quantity: 10, price: 60000, stopLoss: opts.stop ?? 55000,
    metadata: { exchange: 'deribit', exitAuthority: 'server', positionId },
  })
  db.insertSignalExecution({
    signalId: entry, symbol: SYMBOL, exchange: 'deribit', direction, status: 'open',
    qtyOpened: 10, accountId: opts.accountId ?? 'acct-1',
  })
  db.updateSignalOrderIds(entry, opts.slOrderId ?? 'sl-0', undefined)
  db.upsertServerExitState({
    positionId, entrySignalId: entry, exchange: 'deribit', symbol: SYMBOL, direction,
    currentStop: opts.stop ?? 55000, slOrderId: opts.slOrderId ?? 'sl-0',
  })
}

const asFloor = (v: unknown) => v as StopFloorView

describe('stop floor on a bot position (no take-over)', () => {
  it('update sets the floor, amends the venue stop once and keeps the bot stop', async () => {
    seedBotPosition()
    const adapter = new FakeAdapter([longPos()])
    const svc = createPositionManageService(db, manager(adapter))

    const view = asFloor(await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 58000 }))

    expect(view.kind).toBe('floor')
    expect(view.manualStop).toBe(58000)
    expect(view.engineStop).toBe(55000)
    expect(view.effectiveStop).toBe(58000)
    expect(view.currentStop).toBe(58000)
    expect(view.accountId).toBe('acct-1')
    expect(adapter.cancelled).toEqual(['sl-0'])
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0]).toMatchObject({ orderType: 'stop', side: 'sell', stopPrice: 58000, reduceOnly: true, quantity: 10 })
    expect(adapter.placed[0].label).toBe(`kaibot:${ENTRY}:stop-floor`)
    const state = db.getServerExitState(POS)!
    expect(state.manual_stop).toBe(58000)
    expect(state.engine_stop).toBe(55000)
    expect(state.current_stop).toBe(58000)
    expect(state.sl_order_id).toBe('new-1')
    expect(state.last_exit_seq).toBe(0)
    expect(state.active).toBe(1)
    // The entry bracket now points at the live stop.
    expect(db.getSignalBracket(ENTRY)!.stop_loss_order_id).toBe('new-1')
    // No trail row was created: the bot still manages the exit.
    expect(db.listActiveLocalTrails()).toHaveLength(0)
  })

  it('is idempotent: the same floor twice places nothing the second time', async () => {
    seedBotPosition()
    const adapter = new FakeAdapter([longPos()])
    const svc = createPositionManageService(db, manager(adapter))
    await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 58000 })
    adapter.cancelled = []
    const before = adapter.placed.length
    await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 58000 })
    expect(adapter.placed.length).toBe(before)
    expect(adapter.cancelled).toHaveLength(0)
  })

  it('a floor below the bot stop is stored but does not move the venue stop', async () => {
    seedBotPosition()
    const adapter = new FakeAdapter([longPos()])
    const svc = createPositionManageService(db, manager(adapter))
    const view = asFloor(await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 52000 }))
    expect(view.manualStop).toBe(52000)
    expect(view.effectiveStop).toBe(55000)
    expect(adapter.placed).toHaveLength(0)
    expect(adapter.cancelled).toHaveLength(0)
  })

  it('refuses a floor on the wrong side of the market (EX4) and touches nothing', async () => {
    seedBotPosition()
    const adapter = new FakeAdapter([longPos()])
    const svc = createPositionManageService(db, manager(adapter))
    await expect(
      svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 62000 }),
    ).rejects.toThrow(/below the current price/)
    expect(adapter.placed).toHaveLength(0)
    expect(db.getServerExitState(POS)!.manual_stop).toBeNull()
  })

  it('short: the floor sits above the market and tightens the bot stop', async () => {
    seedBotPosition({ direction: 'short', stop: 66000 })
    const adapter = new FakeAdapter([{ ...longPos(), side: 'short' }])
    const svc = createPositionManageService(db, manager(adapter))
    await expect(
      svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 60000 }),
    ).rejects.toThrow(/above the current price/)
    const view = asFloor(await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 63000 }))
    expect(view.effectiveStop).toBe(63000)
    expect(adapter.placed[0]).toMatchObject({ side: 'buy', stopPrice: 63000 })
  })

  it('lock makes the floor absolute (may move against the position); unlock resumes from the bot stop', async () => {
    seedBotPosition()
    const adapter = new FakeAdapter([longPos()])
    const svc = createPositionManageService(db, manager(adapter))
    await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 58000 })

    // Locked floor under the resting stop: the venue stop follows it down.
    let view = asFloor(await svc.manage({ action: 'lock', exchange: 'deribit', symbol: SYMBOL, manualStop: 57000 }))
    expect(view.trailingLock).toBe(true)
    expect(view.effectiveStop).toBe(57000)
    expect(adapter.placed[adapter.placed.length - 1].stopPrice).toBe(57000)

    // The bot sharpens to 59000 while locked: recorded, not placed.
    db.applyServerExitUpdate(POS, { exitSeq: 1, currentStop: 57000, slOrderId: 'new-2', engineStop: 59000 })
    const placedBefore = adapter.placed.length

    view = asFloor(await svc.manage({ action: 'unlock', exchange: 'deribit', symbol: SYMBOL }))
    expect(view.trailingLock).toBe(false)
    expect(view.effectiveStop).toBe(59000)
    expect(adapter.placed.length).toBe(placedBefore + 1)
    expect(adapter.placed[adapter.placed.length - 1].stopPrice).toBe(59000)
    expect(db.getServerExitState(POS)!.engine_stop).toBe(59000)
  })

  it('remove clears only the floor: the bot stop stays and the venue stop falls back to it', async () => {
    seedBotPosition()
    const adapter = new FakeAdapter([longPos()])
    const svc = createPositionManageService(db, manager(adapter))
    await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 58000, trailingLock: true })

    const view = asFloor(await svc.manage({ action: 'remove', exchange: 'deribit', symbol: SYMBOL }))

    expect(view.manualStop).toBeNull()
    expect(view.trailingLock).toBe(false)
    expect(view.engineStop).toBe(55000)
    expect(view.effectiveStop).toBe(55000)
    expect(view.active).toBe(true)
    expect(adapter.placed[adapter.placed.length - 1]).toMatchObject({ stopPrice: 55000, side: 'sell' })
    const state = db.getServerExitState(POS)!
    expect(state.active).toBe(1)
    expect(state.current_stop).toBe(55000)
  })

  it('never places a stop on the wrong side of the market when the composition is stale', async () => {
    // Bot stop above the mark (the market fell through it): removing the floor
    // must not re-place the bot stop at that level.
    seedBotPosition({ stop: 55000 })
    const adapter = new FakeAdapter([longPos('acct-1', 61000)])
    const svc = createPositionManageService(db, manager(adapter))
    await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 58000 })
    db.applyServerExitUpdate(POS, { exitSeq: 1, currentStop: 58000, slOrderId: 'new-1', engineStop: 59500 })
    adapter.positions = [longPos('acct-1', 59000)]
    const placedBefore = adapter.placed.length

    const view = asFloor(await svc.manage({ action: 'remove', exchange: 'deribit', symbol: SYMBOL }))

    expect(view.manualStop).toBeNull()
    expect(adapter.placed.length).toBe(placedBefore)
    expect(db.getServerExitState(POS)!.current_stop).toBe(58000)
  })

  it('is account scoped: two connections on the same contract each keep their own floor', async () => {
    seedBotPosition({ entry: 'entry-a', positionId: 'pos-a', accountId: 'acct-1', slOrderId: 'sl-a' })
    seedBotPosition({ entry: 'entry-b', positionId: 'pos-b', accountId: 'acct-2', slOrderId: 'sl-b' })
    const adapter = new FakeAdapter([longPos('acct-1'), longPos('acct-2')])
    const svc = createPositionManageService(db, manager(adapter))

    await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, accountId: 'acct-2', manualStop: 58000 })

    expect(db.getServerExitState('pos-b')!.manual_stop).toBe(58000)
    expect(db.getServerExitState('pos-a')!.manual_stop).toBeNull()
    expect(adapter.cancelled).toEqual(['sl-b'])
    expect(adapter.placed).toHaveLength(1)
    expect(adapter.placed[0].accountId).toBe('acct-2')
  })

  it('a position with neither a trail nor a bot stop is a clean error', async () => {
    const svc = createPositionManageService(db, manager(new FakeAdapter([longPos()])))
    await expect(
      svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 58000 }),
    ).rejects.toThrow(/no active trail/)
  })

  it('a flat position refuses the floor', async () => {
    seedBotPosition()
    const svc = createPositionManageService(db, manager(new FakeAdapter([])))
    await expect(
      svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 58000 }),
    ).rejects.toThrow(/no open position/)
  })

  it('listFloors exposes every active bot position with its account', async () => {
    seedBotPosition()
    const svc = createPositionManageService(db, manager(new FakeAdapter([longPos()])))
    expect(svc.listFloors()).toMatchObject([
      { kind: 'floor', positionId: POS, symbol: SYMBOL, accountId: 'acct-1', manualStop: null, effectiveStop: 55000 },
    ])
  })

  it('the floor survives a restart (reconcile keeps composing with it)', async () => {
    seedBotPosition()
    const adapter = new FakeAdapter([longPos()])
    await createPositionManageService(db, manager(adapter)).manage({
      action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 58000, trailingLock: true,
    })
    db.close()

    db = new KaiBotDatabase(dbPath)
    const svc = createPositionManageService(db, manager(adapter))
    const floors = svc.listFloors()
    expect(floors).toHaveLength(1)
    expect(floors[0]).toMatchObject({ manualStop: 58000, trailingLock: true, engineStop: 55000, effectiveStop: 58000 })
    // Same floor again after the restart: nothing to amend.
    const before = adapter.placed.length
    await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 58000 })
    expect(adapter.placed.length).toBe(before)
  })
})

describe('stop floor with a local trail row on the bot entry', () => {
  it('writes the floor to both records and leaves the venue stop to the trail tick', async () => {
    seedBotPosition()
    db.upsertLocalTrailState({
      signalId: ENTRY, exchange: 'deribit', symbol: SYMBOL, direction: 'long', entryPrice: 60000,
      slOrderId: 'sl-0', trailPercentage: 2, extremePrice: 61000, currentStop: 55000, source: 'signal', accountId: 'acct-1',
    })
    const adapter = new FakeAdapter([longPos()])
    const svc = createPositionManageService(db, manager(adapter))

    const view = await svc.manage({ action: 'update', exchange: 'deribit', symbol: SYMBOL, manualStop: 58000 })

    expect((view as any).kind).toBeUndefined()
    expect(view.manualStop).toBe(58000)
    expect(db.getLocalTrail(ENTRY)!.manual_stop).toBe(58000)
    expect(db.getServerExitState(POS)!.manual_stop).toBe(58000)
    expect(adapter.placed).toHaveLength(0)
  })

  it('remove on a signal-armed trail clears the floor but keeps the trail active', async () => {
    seedBotPosition()
    db.upsertLocalTrailState({
      signalId: ENTRY, exchange: 'deribit', symbol: SYMBOL, direction: 'long', entryPrice: 60000,
      slOrderId: 'sl-0', trailPercentage: 2, extremePrice: 61000, currentStop: 55000, source: 'signal',
      accountId: 'acct-1', manualStop: 58000, trailingLock: true,
    })
    db.updateServerExitStopFloor(POS, { manualStop: 58000, trailingLock: true })
    const svc = createPositionManageService(db, manager(new FakeAdapter([longPos()])))

    const view = await svc.manage({ action: 'remove', exchange: 'deribit', symbol: SYMBOL })

    expect(view.manualStop).toBeNull()
    expect(view.trailingLock).toBe(false)
    expect(view.active).toBe(true)
    expect(db.listActiveLocalTrails()).toHaveLength(1)
    expect(db.getServerExitState(POS)!.manual_stop).toBeNull()
  })

  it('arming a trail on the bot position inherits the floor', async () => {
    seedBotPosition()
    db.updateServerExitStopFloor(POS, { manualStop: 58000, trailingLock: true })
    const svc = createPositionManageService(db, manager(new FakeAdapter([longPos()])))

    const view = await svc.manage({
      action: 'arm', exchange: 'deribit', symbol: SYMBOL, trail: { mode: 'fixed', trailPercentage: 2 },
    })

    expect(view.manualStop).toBe(58000)
    expect(view.trailingLock).toBe(true)
  })
})
