// Ride hand-over → server close (R1 lineage): after a hand-over, a close
// signal from the ride bot (metadata.signalBotId) must find the synthetic
// entry, flatten exactly the handed-over qty on the held contract, book the
// exit onto the execution and retire the server exit state. Real executor DB.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { SignalWebSocketClient } from './signal-client.js'
import { createRideHandoverService, handoverSignalId } from '../services/ride-handover.js'
import type { Order, OrderResult, Position, Signal } from '../services/exchanges/types.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-handover-close-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

class FakeAdapter {
  name = 'tradestation'
  placed: Order[] = []
  cancelled: string[] = []
  constructor(public positions: Position[]) {}
  async getPositions(): Promise<Position[]> {
    return this.positions
  }
  async getAccounts() {
    return [{ id: 'tradestation:SIM123', accountId: 'SIM123' }]
  }
  async placeOrder(order: Order): Promise<OrderResult> {
    this.placed.push(order)
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: order.quantity, averagePrice: 20100 }
  }
  async cancelOrder(orderId: string): Promise<void> {
    this.cancelled.push(orderId)
  }
}

class FakeExchangeManager {
  constructor(public adapter: FakeAdapter) {}
  async getSession() {
    return { adapter: this.adapter, status: 'connected', userId: 'default', exchangeName: 'tradestation' }
  }
}

const POS: Position = { id: 'p', accountId: 'SIM123', symbol: 'MNQZ26', side: 'long', size: 2, entryPrice: 20000, markPrice: 20050 }

describe('server close on a handed-over lineage', () => {
  it('flattens the handed-over qty on the held contract, books the exit, retires the state', async () => {
    const adapter = new FakeAdapter([POS])
    const manager = new FakeExchangeManager(adapter)
    const ride = createRideHandoverService(db, manager as any, {
      postToServer: async (path) =>
        path === '/api/ride/handover'
          ? { ok: true, status: 200, body: { positionId: 'srv-pos-1', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'create' } }
          : { ok: true, status: 200, body: {} },
    })
    db.addManualPosition('tradestation', 'SIM123', 'MNQZ26', 'buy', 2)
    await ride.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 19800 })
    const entryId = handoverSignalId('srv-pos-1')
    expect(adapter.placed).toHaveLength(1) // the protective stop

    // The exit-signal runner's close, as the server wires it.
    const client = new SignalWebSocketClient(db as any, manager as any, null)
    const close: Signal = {
      id: 'close-1',
      strategy_id: 'strat-ride',
      symbol: 'MNQ',
      action: 'close',
      quantity: 1,
      metadata: { exchange: 'tradestation', signalBotId: 'bot-a', positionId: 'srv-pos-1', exitAuthority: 'server' },
      received_at: new Date(),
      status: 'pending',
      created_at: new Date(),
    } as Signal
    db.recordSignal({ id: close.id, strategyId: 'strat-ride', symbol: 'MNQ', action: 'close', metadata: close.metadata })
    const sub = db.getSubscriptionForBot('bot-a')
    expect(sub).toBeTruthy()
    await (client as any).executeCloseSignal(close, sub)

    const closeOrder = adapter.placed[adapter.placed.length - 1]!
    expect(closeOrder).toMatchObject({ symbol: 'MNQZ26', side: 'sell', quantity: 2, reduceOnly: true })
    const exec = db.getSignalExecution(entryId)!
    expect(exec.status).toBe('closed')
    expect(exec.qty_closed).toBe(2)
    expect(db.getSignalFills(entryId).map((f) => f.kind)).toEqual(['entry', 'exit'])
    expect(db.getServerExitState('srv-pos-1')!.active).toBe(0)
    expect(db.getOpenEntrySignals('MNQ', 'bot-a')).toHaveLength(0)
  })

  it('a close from another bot never touches the handed-over position', async () => {
    const adapter = new FakeAdapter([POS])
    const manager = new FakeExchangeManager(adapter)
    const ride = createRideHandoverService(db, manager as any, {
      postToServer: async () => ({ ok: true, status: 200, body: { positionId: 'srv-pos-1', runId: 'run-1', timeframe: '1h', subscriptionId: null, plan: 'create' } }),
    })
    db.addManualPosition('tradestation', 'SIM123', 'MNQZ26', 'buy', 2)
    await ride.handover({ exchange: 'tradestation', symbol: 'MNQZ26', botId: 'bot-a', stopPrice: 19800 })
    const placedBefore = adapter.placed.length

    const client = new SignalWebSocketClient(db as any, manager as any, null)
    const close: Signal = {
      id: 'close-2',
      strategy_id: 'strat-other',
      symbol: 'MNQ',
      action: 'close',
      quantity: 1,
      metadata: { exchange: 'tradestation', signalBotId: 'bot-z' },
      received_at: new Date(),
      status: 'pending',
      created_at: new Date(),
    } as Signal
    db.recordSignal({ id: close.id, strategyId: 'strat-other', symbol: 'MNQ', action: 'close', metadata: close.metadata })
    await (client as any).executeCloseSignal(close, { id: 'bot-z', account_id: 'SIM123' })
    expect(adapter.placed).toHaveLength(placedBefore)
    expect(db.getSignalExecution(handoverSignalId('srv-pos-1'))!.status).toBe('open')
  })
})
