// Regime size factor (C1 weekly label) on the entry pipeline: a sub with lateBull 1,5 on a late-bull market
// sizes entries 1,5x after the base factor; closes are never scaled; unknown or missing label = 1x.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KaiBotDatabase } from '../storage/database.js'
import { orderLockIdle } from '../services/order-lock.js'
import { SignalWebSocketClient } from './signal-client.js'
import type { Signal } from '../storage/types.js'
import type { Order, OrderResult, Position } from '../services/exchanges/types.js'
import type { RegimeApiResponse, RegimeLabel } from '@kaibot/types/core'

class FakeTs {
  name = 'tradestation'
  alwaysOpen = true
  placed: Order[] = []
  positions: Position[] = []
  async getPositions() {
    return this.positions
  }
  async placeOrder(o: Order): Promise<OrderResult> {
    this.placed.push(o)
    const signed = (o.side === 'buy' ? 1 : -1) * o.quantity
    const cur = this.positions.find((p) => p.symbol === o.symbol)
    const size = (cur ? (cur.side === 'long' ? cur.size : -cur.size) : 0) + signed
    this.positions = size === 0 ? [] : [{ symbol: o.symbol, side: size > 0 ? 'long' : 'short', size: Math.abs(size), entryPrice: 20_000, markPrice: 20_000 } as Position]
    return { orderId: `ord-${this.placed.length}`, status: 'filled', filledQuantity: o.quantity, averagePrice: 20_000 }
  }
  async cancelOrder() {}
}

const snapshot = (label: RegimeLabel): RegimeApiResponse => ({
  computedAt: '2026-10-12T01:00:00.000Z',
  markets: { MNQ: { label, since: '2026-04-06', phaseSince: '2026-04-13', weekClosed: '2026-10-05', close: 1, sma40: 1, sma40_4ago: 1 } },
})

let dir: string
let db: KaiBotDatabase
let ts: FakeTs
let client: SignalWebSocketClient

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-regime-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  ts = new FakeTs()
  const session = { exchangeName: 'tradestation', status: 'connected', adapter: ts, userId: 'default', label: 'default' }
  const manager = { getSession: async () => session, getAllSessions: async () => [session] }
  db.upsertSubscription({
    id: 'sub-1', signalBotId: 'bot-1', factor: 1, exchange: 'tradestation', accountId: 'ACC1',
    selectedMarkets: ['MNQZ26'], status: 'active',
  })
  db.setSubscriptionRegime('sub-1', { regimeFactors: { lateBull: 1.5, notBull: 0.5 } })
  db.setAccountSize('tradestation', 'ACC1', 'MNQ', 10) // the seeded cap would clip the 1,5x
  db.saveRegimeSnapshot(snapshot('late_bull'))
  client = new SignalWebSocketClient(db, manager as any, null)
  client.setSettleOptions(2, 1)
})

afterEach(async () => {
  await orderLockIdle()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function signal(action: 'buy' | 'close', quantity: number): Signal {
  return {
    id: `sig-${++seq}`, strategy_id: 'strat-1', symbol: 'MNQZ26', action, quantity, price: 20_000,
    metadata: { exchange: 'tradestation', signalBotId: 'bot-1' }, received_at: new Date(), status: 'pending', created_at: new Date(),
  } as unknown as Signal
}
const clips = (id: string) => db.listSafetyClips(id).map((c) => ({ reason: c.reason, from: c.original_quantity, to: c.adjusted_quantity, detail: c.detail }))

describe('regime factor on entries', () => {
  it('late bull x1,5: 2 contracts become 3, logged with the label', async () => {
    const s = signal('buy', 2)
    await (client as any).handleSignalInner(s)
    expect(ts.placed.map((o) => o.quantity)).toEqual([3])
    expect(clips(s.id)).toContainEqual({ reason: 'regime_factor_applied', from: 2, to: 3, detail: 'late bull MNQ' })
  })

  it('applies after the base factor', async () => {
    db.run(`UPDATE executor_subscriptions SET factor = 2 WHERE id = 'sub-1'`)
    await (client as any).handleSignalInner(signal('buy', 1))
    expect(ts.placed.map((o) => o.quantity)).toEqual([3])
  })

  it('TradeStation rounds down: 1 contract x 1,5 = 1', async () => {
    await (client as any).handleSignalInner(signal('buy', 1))
    expect(ts.placed.map((o) => o.quantity)).toEqual([1])
  })

  it('the close is not scaled: it flattens what the entry opened', async () => {
    await (client as any).handleSignalInner(signal('buy', 2))
    const close = signal('close', 2)
    await (client as any).handleSignalInner(close)
    expect(ts.placed.map((o) => [o.side, o.quantity])).toEqual([['buy', 3], ['sell', 3]])
    expect(clips(close.id).map((c) => c.reason)).not.toContain('regime_factor_applied')
  })

  it('unknown label = 1x, no regime clip', async () => {
    db.saveRegimeSnapshot(snapshot('unknown'))
    const s = signal('buy', 2)
    await (client as any).handleSignalInner(s)
    expect(ts.placed.map((o) => o.quantity)).toEqual([2])
    expect(clips(s.id).map((c) => c.reason)).not.toContain('regime_factor_applied')
  })

  it('no snapshot stored = 1x', async () => {
    db.run('DELETE FROM regime_snapshot')
    await (client as any).handleSignalInner(signal('buy', 2))
    expect(ts.placed.map((o) => o.quantity)).toEqual([2])
  })

  it('label without a factor for it = 1x', async () => {
    db.saveRegimeSnapshot(snapshot('early_bull'))
    await (client as any).handleSignalInner(signal('buy', 2))
    expect(ts.placed.map((o) => o.quantity)).toEqual([2])
  })

  it('factor 0 skips the entry', async () => {
    db.setSubscriptionRegime('sub-1', { regimeFactors: { notBull: 0 } })
    db.saveRegimeSnapshot(snapshot('not_bull'))
    const s = signal('buy', 2)
    await (client as any).handleSignalInner(s)
    expect(ts.placed).toHaveLength(0)
    expect(db.get('SELECT status, error_message FROM signals WHERE id = ?', [s.id])).toMatchObject({
      status: 'rejected',
      error_message: 'regime factor 0 (not bull MNQ)',
    })
  })

  it('regimeMarket on the sub overrides the derived group', async () => {
    db.setSubscriptionRegime('sub-1', { regimeMarket: 'MGC' })
    await (client as any).handleSignalInner(signal('buy', 2))
    expect(ts.placed.map((o) => o.quantity)).toEqual([2]) // no MGC label in the snapshot
  })
})
