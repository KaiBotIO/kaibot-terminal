// F3 Take-over 2.0 — end-to-end on fake adapters: a bot-managed position is
// taken over (detachBot), the user re-attaches edge blocks with their OWN
// params (trail + risk guard), the trail ADOPTS the bot's resting bracket stop
// as seed (one stop owner, favourable-only from there), and a guard breach
// fully closes and cleans everything up. Plus the source-agnostic stop-seed
// rules (findAdoptableStopSeed) in isolation.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { detachBot } from './bot-detach.js'
import { botConfigsBlockSignal } from './take-over.js'
import { createPositionManageService, findAdoptableStopSeed } from './position-manage.js'
import { createPositionManagersService } from './position-managers.js'
import { LocalPositionManager } from './local-position-manager.js'
import { orderLockIdle } from './order-lock.js'
import { positionTrailKey } from './position-trail.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-takeover-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const BOT_CONFIG_ID = 'bot1:deribit:BTC-PERPETUAL:1h'
const KEY = positionTrailKey('deribit', 'acct-1', 'BTC-PERPETUAL')

// Fake adapter with a LIVE (mutable) positions array; records every order op.
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
  symbol: 'BTC-PERPETUAL',
  side: 'long',
  size: 4,
  entryPrice: 100,
  markPrice: 105,
  ...over,
})

// Seed the edge-side truth of a RUNNING bot position: config + executed entry
// signal (metadata carries the botConfigId, as the server stamps it) + bot
// bracket + an active signal-armed local trail owning the resting stop.
function seedBotPosition(opts: { withTrail?: boolean } = {}) {
  db.upsertBotConfig({
    id: BOT_CONFIG_ID,
    signalBotId: 'bot1',
    botName: 'Crash Bot',
    strategyId: 'strat-crash',
    exchange: 'deribit',
    symbol: 'BTC-PERPETUAL',
    timeframe: '1h',
    status: 'running',
  })
  db.recordSignal({
    id: 'sig-bot-1',
    strategyId: 'strat-crash',
    symbol: 'BTC-PERPETUAL',
    action: 'buy',
    quantity: 4,
    stopLoss: 95,
    metadata: { signalBotId: 'bot1', botConfigId: BOT_CONFIG_ID },
  })
  db.updateSignalStatus('sig-bot-1', 'executed')
  db.upsertBracketPair({
    signalId: 'sig-bot-1', exchange: 'deribit', slOrderId: 'sl-bot', tpOrderIds: ['tp-bot'],
  })
  if (opts.withTrail !== false) {
    db.upsertLocalTrailState({
      signalId: 'sig-bot-1', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      direction: 'long', entryPrice: 100, slOrderId: 'sl-bot', trailPercentage: 1,
      extremePrice: 104, currentStop: 96, source: 'signal',
      bracketSignalId: 'sig-bot-1',
    })
  }
}

describe('take-over → re-attach (F3, end to end)', () => {
  it('detach pauses the bot, retires its trail, and gates its signals — closes nothing', () => {
    seedBotPosition()
    const configsFor = () => db.getBotConfigs(false).filter((c) => c.signalBotId === 'bot1')
    expect(botConfigsBlockSignal(configsFor(), 'BTC-PERPETUAL')).toBe(false)

    const result = detachBot(db, BOT_CONFIG_ID)
    expect(result).toMatchObject({ needed: true, paused: true, retiredManagers: 1, manager: 'manual' })
    expect(db.getBotConfig(BOT_CONFIG_ID)!.status).toBe('paused')
    expect(db.listActiveLocalTrails()).toHaveLength(0)
    // The retired trail keeps its stop knowledge for later seed adoption.
    const retired = db.getLocalTrail('sig-bot-1')!
    expect(retired.active).toBe(0)
    expect(retired.sl_order_id).toBe('sl-bot')
    // Guard rail: any signal from this bot on the symbol is now blocked.
    expect(botConfigsBlockSignal(configsFor(), 'BTC-PERPETUAL')).toBe(true)
  })

  it('re-attach arms a trail that ADOPTS the bot stop as seed and improves favourable-only', async () => {
    seedBotPosition()
    detachBot(db, BOT_CONFIG_ID)

    const positions = [pos()]
    const stack = fakeStack(positions)
    const manageSvc = createPositionManageService(db, stack.exchangeManager as any)

    // "Keep a 10% trail while I work this by hand."
    const view = await manageSvc.manage({
      action: 'arm', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      trail: { mode: 'fixed', trailPercentage: 10 },
    })
    expect(view.source).toBe('manual')
    // One stop owner: the new position-scoped row adopted the bot's resting
    // stop order + its last level; the retired bot row stays retired.
    const active = db.listActiveLocalTrails()
    expect(active).toHaveLength(1)
    expect(active[0].signal_id).toBe(KEY)
    expect(active[0].sl_order_id).toBe('sl-bot')
    expect(active[0].current_stop).toBe(96)
    expect(active[0].bracket_signal_id).toBe('sig-bot-1')
    expect(db.getLocalTrail('sig-bot-1')!.active).toBe(0)

    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })

    // 10% off mark 105 = 94.5 < adopted 96 → NOT favourable → the bot's stop
    // stays resting untouched (adoption seeded the ratchet).
    await mgr.tick()
    await orderLockIdle()
    expect(stack.placed).toHaveLength(0)
    expect(stack.cancelled).toHaveLength(0)

    // Price runs: 10% off 110 = 99 > 96 → improve. Cancel/replace the adopted
    // order, one new resting stop.
    positions[0].markPrice = 110
    await mgr.tick()
    await orderLockIdle()
    expect(stack.cancelled).toEqual(['sl-bot'])
    const stops = stack.placed.filter((o) => o.orderType === 'stop')
    expect(stops).toHaveLength(1)
    expect(stops[0].stopPrice).toBeCloseTo(99, 9)
    expect(stops[0].reduceOnly).toBe(true)

    // Adverse move: candidate falls back below the ratchet → no loosening.
    positions[0].markPrice = 103
    await mgr.tick()
    await orderLockIdle()
    expect(stack.placed.filter((o) => o.orderType === 'stop')).toHaveLength(1)
    expect(db.getLocalTrail(KEY)!.current_stop).toBeCloseTo(99, 9)
  })

  it('guard breach after re-attach → full reduce-only close cleans trails + managers', async () => {
    seedBotPosition()
    detachBot(db, BOT_CONFIG_ID)

    const positions = [pos()]
    const stack = fakeStack(positions)
    const manageSvc = createPositionManageService(db, stack.exchangeManager as any)
    const managersSvc = createPositionManagersService(db, stack.exchangeManager as any)

    await manageSvc.manage({
      action: 'arm', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      trail: { mode: 'fixed', trailPercentage: 10 },
    })
    await managersSvc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'risk-guard', params: { globalStopPrice: 92 },
    })
    expect(db.listActiveManagedPositions()).toHaveLength(1)

    const mgr = new LocalPositionManager(db, stack.exchangeManager as any, null, {
      tickMs: 999999, signalTrailingEnabled: false,
    })

    // Crash through the guard: FULL close at market, reduce-only, and every
    // edge attachment on the position is retired with it.
    positions[0].markPrice = 90
    await mgr.tick()
    await orderLockIdle()
    const close = stack.placed.find((o) => o.orderType === 'market')
    expect(close).toBeDefined()
    expect(close.quantity).toBeCloseTo(4, 9)
    expect(close.reduceOnly).toBe(true)
    expect(close.side).toBe('sell')
    // The adopted bot stop was cancelled, no trail or manager stays active.
    expect(stack.cancelled).toContain('sl-bot')
    expect(db.listActiveLocalTrails()).toHaveLength(0)
    expect(db.listActiveManagedPositions()).toHaveLength(0)
  })

  it('stop-emitting manager attach after take-over gets the bot stop as shell seed', async () => {
    seedBotPosition()
    detachBot(db, BOT_CONFIG_ID)

    const positions = [pos()]
    const stack = fakeStack(positions)
    const managersSvc = createPositionManagersService(db, stack.exchangeManager as any)
    await managersSvc.manage({
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'break-even-mover', params: { feePercentage: 0.001 },
    })
    const shell = db.getLocalTrail(KEY)!
    expect(shell.active).toBe(1)
    expect(shell.sl_order_id).toBe('sl-bot')
    expect(shell.current_stop).toBe(96)
  })

  it('take-over on a bot without local trails (static bracket only) still seeds from the signal bracket', async () => {
    seedBotPosition({ withTrail: false })
    const result = detachBot(db, BOT_CONFIG_ID)
    expect(result).toMatchObject({ needed: true, paused: true, retiredManagers: 0 })

    const stack = fakeStack([pos()])
    const manageSvc = createPositionManageService(db, stack.exchangeManager as any)
    await manageSvc.manage({
      action: 'arm', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      trail: { mode: 'fixed', trailPercentage: 2 },
    })
    const row = db.getLocalTrail(KEY)!
    expect(row.sl_order_id).toBe('sl-bot')
    expect(row.bracket_signal_id).toBe('sig-bot-1')
    // Level seeded from the signal's own bracket stop (95, protective vs 105).
    expect(row.current_stop).toBe(95)
  })
})

describe('findAdoptableStopSeed — source-agnostic rules', () => {
  const live = { direction: 'long' as const, mark: 105 }

  it('returns null with nothing to adopt', () => {
    expect(findAdoptableStopSeed(db, 'deribit', 'BTC-PERPETUAL', live)).toBeNull()
  })

  it('manual entry bracket wins over a bot bracket', () => {
    seedBotPosition()
    db.insertOrderSettlement({
      signalId: 'manual:abc', exchange: 'deribit', accountId: 'acct-1',
      symbol: 'BTC-PERPETUAL', kind: 'entry', side: 'buy', qty: 1,
      orderId: 'entry-m', targetLabel: 'entry', status: 'filled',
    })
    db.upsertBracketPair({ signalId: 'manual:abc', exchange: 'deribit', slOrderId: 'sl-manual' })
    const seed = findAdoptableStopSeed(db, 'deribit', 'BTC-PERPETUAL', live)!
    expect(seed.slOrderId).toBe('sl-manual')
    expect(seed.bracketSignalId).toBe('manual:abc')
  })

  it('ignores an opposing-direction entry signal bracket', () => {
    seedBotPosition({ withTrail: false })
    const seed = findAdoptableStopSeed(db, 'deribit', 'BTC-PERPETUAL', {
      direction: 'short', mark: 105,
    })
    expect(seed).toBeNull()
  })

  it('drops a wrong-side stop level but keeps the order id (bot bracket)', () => {
    seedBotPosition({ withTrail: false })
    // Original signal stop 95 would be wrong-side for a mark of 90.
    const seed = findAdoptableStopSeed(db, 'deribit', 'BTC-PERPETUAL', {
      direction: 'long', mark: 90,
    })!
    expect(seed.slOrderId).toBe('sl-bot')
    expect(seed.currentStop).toBeNull()
  })

  it('prefers the retired trail level over the signal original for the same order', () => {
    seedBotPosition()
    detachBot(db, BOT_CONFIG_ID)
    const seed = findAdoptableStopSeed(db, 'deribit', 'BTC-PERPETUAL', live)!
    expect(seed.slOrderId).toBe('sl-bot')
    // 96 (trail-moved) over 95 (original signal stop).
    expect(seed.currentStop).toBe(96)
  })

  it('falls back to the retired trail when no bracket pair survives', () => {
    seedBotPosition()
    detachBot(db, BOT_CONFIG_ID)
    db.deleteBracketPair('sig-bot-1')
    db.markEntrySignalClosed('sig-bot-1')
    const seed = findAdoptableStopSeed(db, 'deribit', 'BTC-PERPETUAL', live)!
    expect(seed.slOrderId).toBe('sl-bot')
    expect(seed.currentStop).toBe(96)
    expect(seed.bracketSignalId).toBe('sig-bot-1')
  })

  it('skips a stale retired trail whose stop already fired (wrong side)', () => {
    seedBotPosition()
    detachBot(db, BOT_CONFIG_ID)
    db.deleteBracketPair('sig-bot-1')
    db.markEntrySignalClosed('sig-bot-1')
    // Mark below the retired stop → that stop would have fired → stale row.
    const seed = findAdoptableStopSeed(db, 'deribit', 'BTC-PERPETUAL', {
      direction: 'long', mark: 94,
    })
    expect(seed).toBeNull()
  })
})

describe('botConfigsBlockSignal — guard rail decision', () => {
  const cfg = (symbol: string, status: 'running' | 'paused' | 'stopped') => ({ symbol, status })

  it('never blocks a bot without local configs (subscription gate owns those)', () => {
    expect(botConfigsBlockSignal([], 'BTC-PERPETUAL')).toBe(false)
  })

  it('blocks when every config for the symbol is non-running', () => {
    expect(botConfigsBlockSignal([cfg('BTC-PERPETUAL', 'paused')], 'BTC-PERPETUAL')).toBe(true)
    expect(botConfigsBlockSignal([cfg('BTC-PERPETUAL', 'stopped')], 'btc-perpetual')).toBe(true)
  })

  it('does not block while any config for the symbol still runs', () => {
    expect(
      botConfigsBlockSignal(
        [cfg('BTC-PERPETUAL', 'paused'), cfg('BTC-PERPETUAL', 'running')],
        'BTC-PERPETUAL',
      ),
    ).toBe(false)
  })

  it('a paused config on ANOTHER market does not block this one', () => {
    expect(
      botConfigsBlockSignal(
        [cfg('ETH-PERPETUAL', 'paused'), cfg('BTC-PERPETUAL', 'running')],
        'BTC-PERPETUAL',
      ),
    ).toBe(false)
  })

  it('fully-detached fallback: no symbol match + nothing running → blocked', () => {
    expect(botConfigsBlockSignal([cfg('BTC', 'paused')], 'BTC-PERPETUAL')).toBe(true)
    expect(
      botConfigsBlockSignal([cfg('BTC', 'paused'), cfg('ETH', 'running')], 'SOL-PERP'),
    ).toBe(false)
  })
})
