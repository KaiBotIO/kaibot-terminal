// REGRESSION prod 22/09 23:25 UTC (executor 0.4.14, first real adopt on
// acct1/eth): findAdoptableStopSeed filtered bracket pairs on exchange and
// symbol but not on account. The adoption on connection 'acct1' took over
// the DEFAULT connection's manual stop (order ETH-SLTS-7976384, already
// adopted by a ride hand-over there, server_exit_state 4ba43102), dropped
// that bracket row and re-registered the order under the signal with account
// acct1/eth; acct1's own stop ETH-SLTS-7976385 stayed orphaned. The next
// server exit update then cancelled 7976384 through the acct1 session.
//
// Now: every stop candidate is scoped to the position's account, and an exit
// update never cancels a stop whose bracket row sits on another account.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { SignalWebSocketClient } from '../websocket/signal-client.js'
import { createAdoptPositionService } from './adopt-position.js'
import { findAdoptableStopSeed } from './position-manage.js'
import { rowOnAccount } from './exchanges/account-scope.js'
import type { Order, OrderResult, Position } from './exchanges/types.js'
import type { Signal } from '../storage/types.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-adopt-stop-scope-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const SIGNAL_ID = 'e347521a-086f-46db-91fd-1776c7fac26e'
const POSITION_ID = '6a876333-8392-488e-935a-a3e5439a314b'
const BOT_ID = 'bot-fault-line-eth-4h'
const RIDE_POSITION_ID = '4ba43102-0000-0000-0000-000000000000'
const DEFAULT_STOP = 'ETH-SLTS-7976384'
const ACCT1_STOP = 'ETH-SLTS-7976385'
const MANUAL_DEFAULT = 'manual:faultline-eth-4h-20260915-eth'
const MANUAL_ACCT1 = 'manual:faultline-eth-4h-20260920-acct1'
const META = {
  signalBotId: BOT_ID,
  positionId: POSITION_ID,
  exitAuthority: 'server',
  exchange: 'deribit',
  venueSymbols: { deribit: 'ETH-PERPETUAL', bybit: 'ETHUSDT' },
}

class FakeAdapter {
  placed: Order[] = []
  cancelled: string[] = []
  constructor(public label: string, public positions: Position[]) {}
  async getPositions(): Promise<Position[]> {
    return this.positions
  }
  async getAccounts() {
    return this.positions.map((p) => ({ id: `deribit:${p.accountId}`, accountId: p.accountId }))
  }
  async placeOrder(order: Order): Promise<OrderResult> {
    this.placed.push(order)
    return { orderId: `${this.label}-ord-${this.placed.length}`, status: 'pending', filledQuantity: 0, averagePrice: 0 }
  }
  async cancelOrder(orderId: string): Promise<void> {
    this.cancelled.push(orderId)
  }
}

class FakeExchangeManager {
  keys: Array<string | undefined> = []
  constructor(public byKey: Record<string, FakeAdapter>) {}
  async getSession(_user: string, exchangeName: string, key?: string) {
    this.keys.push(key)
    const adapter = this.byKey[key ?? 'default']
    if (!adapter) return null
    return { adapter, status: 'connected', userId: 'default', exchangeName }
  }
}

const DEFAULT_POS: Position = { id: 'p0', accountId: 'eth', symbol: 'ETH-PERPETUAL', side: 'long', size: 500, entryPrice: 4400, markPrice: 4480 }
const ACCT1_POS: Position = { id: 'p1', accountId: 'acct1/eth', symbol: 'ETH-PERPETUAL', side: 'long', size: 981, entryPrice: 4468, markPrice: 4480 }

// The prod book right before the adoption.
function seedProdBook() {
  db.upsertSubscription({
    id: 'sub-default', signalBotId: BOT_ID, botName: 'Fault-Line ETH 4h', selectedMarkets: [], factor: 1,
    status: 'active', exchange: 'deribit', accountId: 'eth',
  })
  db.upsertSubscription({
    id: 'sub-acct1', signalBotId: BOT_ID, botName: '[ALLOC] Fault-Line ETH 4h (acct1)', selectedMarkets: [], factor: 1,
    status: 'active', exchange: 'deribit', accountId: 'acct1/eth', accountKey: 'acct1',
  })
  db.recordSignal({
    id: SIGNAL_ID, strategyId: 'fault-line', strategyName: 'Fault-Line', symbol: 'ETH', action: 'buy',
    quantity: 0.08, price: 4500, type: 'market', stopLoss: 1353.72, metadata: META,
  })
  db.updateSignalStatus(SIGNAL_ID, 'rejected', undefined, 'basis guard: signal 4500 vs venue 4468 (71 bps > 50)')

  // Default connection: manual entry + bracket, then handed to a ride bot
  // (synthetic entry, server_exit_state carrying the same stop order).
  db.insertOrderSettlement({
    signalId: MANUAL_DEFAULT, exchange: 'deribit', accountId: 'eth', symbol: 'ETH-PERPETUAL',
    kind: 'entry', side: 'buy', qty: 500, orderId: 'ETH-7976383', status: 'filled',
  })
  db.upsertBracketPair({ signalId: MANUAL_DEFAULT, exchange: 'deribit', accountId: 'eth', slOrderId: DEFAULT_STOP })
  const rideEntry = `handover:${RIDE_POSITION_ID}`
  db.recordSignal({
    id: rideEntry, strategyId: 'ride', strategyName: 'Ride ETH', symbol: 'ETH', action: 'buy', quantity: 500, price: 4400,
    metadata: { source: 'handover', signalBotId: 'bot-ride', positionId: RIDE_POSITION_ID, exitAuthority: 'server', exchange: 'deribit', venueSymbol: 'ETH-PERPETUAL' },
  })
  db.updateSignalStatus(rideEntry, 'executed')
  db.insertSignalExecution({ signalId: rideEntry, symbol: 'ETH-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 500, accountId: 'eth' })
  db.upsertServerExitState({ positionId: RIDE_POSITION_ID, entrySignalId: rideEntry, exchange: 'deribit', symbol: 'ETH-PERPETUAL', direction: 'long', currentStop: 4200, slOrderId: DEFAULT_STOP })

  // acct1: the manual entry the user opened on 20/09 with its own stop.
  db.insertOrderSettlement({
    signalId: MANUAL_ACCT1, exchange: 'deribit', accountId: 'acct1/eth', symbol: 'ETH-PERPETUAL',
    kind: 'entry', side: 'buy', qty: 981, orderId: 'ETH-7976382', status: 'filled',
  })
  db.upsertBracketPair({ signalId: MANUAL_ACCT1, exchange: 'deribit', accountId: 'acct1/eth', slOrderId: ACCT1_STOP })
}

function build() {
  const dflt = new FakeAdapter('dflt', [DEFAULT_POS])
  const acct1 = new FakeAdapter('acct1', [ACCT1_POS])
  const manager = new FakeExchangeManager({ default: dflt, acct1 })
  const svc = createAdoptPositionService(db, manager as any, {
    ackAdoptedEntry: async () => ({ ok: true, positionId: POSITION_ID }),
    registerBracket: (exchange, signalId, slOrderId, _tps, accountId) =>
      db.upsertBracketPair({ signalId, exchange, accountId: accountId ?? null, slOrderId: slOrderId ?? null }),
  })
  return { dflt, acct1, manager, svc }
}

describe('rowOnAccount', () => {
  it('legacy rows without an account belong to the default connection only', () => {
    expect(rowOnAccount(null, 'eth')).toBe(true)
    expect(rowOnAccount(null, 'acct1/eth')).toBe(false)
    expect(rowOnAccount('eth', 'eth')).toBe(true)
    expect(rowOnAccount('eth', 'acct1/eth')).toBe(false)
    expect(rowOnAccount('acct1/eth', 'acct1/eth')).toBe(true)
    expect(rowOnAccount('acct1/eth', null)).toBe(true) // unscoped caller
  })
})

describe('findAdoptableStopSeed per account', () => {
  it('returns the stop of the asked account, never another connection\'s', () => {
    seedProdBook()
    const live = { direction: 'long' as const, mark: 4480 }
    expect(findAdoptableStopSeed(db, 'deribit', 'ETH-PERPETUAL', live, 'acct1/eth')).toMatchObject({ slOrderId: ACCT1_STOP, bracketSignalId: MANUAL_ACCT1 })
    expect(findAdoptableStopSeed(db, 'deribit', 'ETH-PERPETUAL', live, 'eth')).toMatchObject({ slOrderId: DEFAULT_STOP, bracketSignalId: MANUAL_DEFAULT })
    // An account without any stop: nothing, not the neighbour's.
    expect(findAdoptableStopSeed(db, 'deribit', 'ETH-PERPETUAL', live, 'acct2/eth')).toBeNull()
  })

  it('a legacy bracket row without account counts for the default connection only', () => {
    db.insertOrderSettlement({ signalId: 'manual:legacy', exchange: 'deribit', symbol: 'ETH-PERPETUAL', kind: 'entry', side: 'buy', qty: 1, orderId: 'o', status: 'filled' })
    db.upsertBracketPair({ signalId: 'manual:legacy', exchange: 'deribit', slOrderId: 'legacy-sl' })
    const live = { direction: 'long' as const, mark: 4480 }
    expect(findAdoptableStopSeed(db, 'deribit', 'ETH-PERPETUAL', live, 'eth')).toMatchObject({ slOrderId: 'legacy-sl' })
    expect(findAdoptableStopSeed(db, 'deribit', 'ETH-PERPETUAL', live, 'acct1/eth')).toBeNull()
    expect(findAdoptableStopSeed(db, 'deribit', 'ETH-PERPETUAL', live)).toMatchObject({ slOrderId: 'legacy-sl' })
  })

  it('a retired trail of another account is not a seed', () => {
    db.upsertLocalTrailState({
      signalId: 'trail-default', exchange: 'deribit', symbol: 'ETH-PERPETUAL', direction: 'long', entryPrice: 4400,
      slOrderId: 'trail-sl', trailPercentage: 1, trailPoints: null, maxPercentage: null, maxPoints: null, breakevenFee: 0,
      extremePrice: 4480, currentStop: 4300, accountId: 'eth',
    } as any)
    db.deactivateLocalTrail('trail-default')
    const live = { direction: 'long' as const, mark: 4480 }
    expect(findAdoptableStopSeed(db, 'deribit', 'ETH-PERPETUAL', live, 'eth')).toMatchObject({ slOrderId: 'trail-sl', currentStop: 4300 })
    expect(findAdoptableStopSeed(db, 'deribit', 'ETH-PERPETUAL', live, 'acct1/eth')).toBeNull()
  })
})

describe('REGRESSION prod 22/09 23:25: two connections, two manual stops', () => {
  it('adopt on acct1 takes over 7976385 and leaves the default connection\'s 7976384 and its ride state alone', async () => {
    seedProdBook()
    const { dflt, acct1, svc } = build()
    const res = await svc.adopt({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', signalId: SIGNAL_ID, stopPrice: 4300 })
    expect(res.stop).toEqual({ price: 4300, slOrderId: ACCT1_STOP, source: 'manual' })
    // No order placed or cancelled anywhere.
    expect(acct1.placed).toHaveLength(0)
    expect(acct1.cancelled).toHaveLength(0)
    expect(dflt.placed).toHaveLength(0)
    expect(dflt.cancelled).toHaveLength(0)
    // acct1's manual pair moved under the signal, on acct1.
    expect(db.getBracketPair(MANUAL_ACCT1)).toBeFalsy()
    expect(db.getBracketPair(SIGNAL_ID)).toMatchObject({ sl_order_id: ACCT1_STOP, account_id: 'acct1/eth' })
    // The default connection's book is untouched.
    expect(db.getBracketPair(MANUAL_DEFAULT)).toMatchObject({ sl_order_id: DEFAULT_STOP, account_id: 'eth' })
    expect(db.getServerExitState(RIDE_POSITION_ID)).toMatchObject({ sl_order_id: DEFAULT_STOP, active: 1 })
    expect(db.getServerExitState(POSITION_ID)).toMatchObject({ sl_order_id: ACCT1_STOP, current_stop: 4300 })
  })

  it('the server exit update then amends 7976385 through the acct1 session only', async () => {
    seedProdBook()
    const { dflt, acct1, manager, svc } = build()
    await svc.adopt({ exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', signalId: SIGNAL_ID, stopPrice: 4300 })
    manager.keys.length = 0
    const client = new SignalWebSocketClient(db as any, manager as any, null)
    const update: Signal = {
      id: 'upd-1', strategy_id: 'fault-line', symbol: 'ETH-PERPETUAL', action: 'buy', price: 4350,
      metadata: { positionId: POSITION_ID, exitSeq: 1, exitAuthority: 'server' },
      received_at: new Date(), status: 'pending', created_at: new Date(),
    } as Signal
    db.recordSignal({ id: update.id, strategyId: 'fault-line', symbol: 'ETH-PERPETUAL', action: 'update', metadata: update.metadata })
    // The caller resolved the DEFAULT session (first sub of the bot), as prod did.
    await (client as any).handleServerExitUpdate(update, { adapter: dflt, status: 'connected' }, 'deribit')
    expect(manager.keys).toContain('acct1')
    expect(dflt.cancelled).toHaveLength(0)
    expect(dflt.placed).toHaveLength(0)
    expect(acct1.cancelled).toEqual([ACCT1_STOP])
    expect(acct1.placed[acct1.placed.length - 1]).toMatchObject({ accountId: 'acct1/eth', orderType: 'stop', stopPrice: 4350, quantity: 981, reduceOnly: true })
    expect(db.getServerExitState(POSITION_ID)).toMatchObject({ current_stop: 4350, sl_order_id: 'acct1-ord-1', last_exit_seq: 1 })
    expect(db.getServerExitState(RIDE_POSITION_ID)).toMatchObject({ sl_order_id: DEFAULT_STOP, active: 1 })
  })

  it('an exit update never cancels a stop whose bracket row sits on another account', async () => {
    seedProdBook()
    const { dflt, acct1, manager } = build()
    // The corrupt shape: the lineage on acct1/eth, but its state and bracket
    // point at the default connection's stop.
    db.updateSignalStatus(SIGNAL_ID, 'executed')
    db.insertSignalExecution({ signalId: SIGNAL_ID, symbol: 'ETH-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 981, accountId: 'acct1/eth' })
    db.upsertBracketPair({ signalId: SIGNAL_ID, exchange: 'deribit', accountId: 'eth', slOrderId: DEFAULT_STOP })
    db.updateSignalOrderIds(SIGNAL_ID, DEFAULT_STOP, undefined)
    db.upsertServerExitState({ positionId: POSITION_ID, entrySignalId: SIGNAL_ID, exchange: 'deribit', symbol: 'ETH-PERPETUAL', direction: 'long', currentStop: 4200, slOrderId: DEFAULT_STOP })

    const client = new SignalWebSocketClient(db as any, manager as any, null)
    const update: Signal = {
      id: 'upd-2', strategy_id: 'fault-line', symbol: 'ETH-PERPETUAL', action: 'buy', price: 4350,
      metadata: { positionId: POSITION_ID, exitSeq: 1, exitAuthority: 'server' },
      received_at: new Date(), status: 'pending', created_at: new Date(),
    } as Signal
    db.recordSignal({ id: update.id, strategyId: 'fault-line', symbol: 'ETH-PERPETUAL', action: 'update', metadata: update.metadata })
    await (client as any).handleServerExitUpdate(update, { adapter: acct1, status: 'connected' }, 'deribit')
    // 7976384 stays; the acct1 position still gets its new stop.
    expect(acct1.cancelled).toHaveLength(0)
    expect(dflt.cancelled).toHaveLength(0)
    expect(acct1.placed[acct1.placed.length - 1]).toMatchObject({ accountId: 'acct1/eth', stopPrice: 4350, quantity: 981 })
    expect(db.getServerExitState(POSITION_ID)).toMatchObject({ current_stop: 4350, sl_order_id: 'acct1-ord-1' })
    const logged = db.all("SELECT message FROM logs WHERE message LIKE '%belongs to another account%'", []) as Array<{ message: string }>
    expect(logged.length).toBeGreaterThan(0)
  })
})
