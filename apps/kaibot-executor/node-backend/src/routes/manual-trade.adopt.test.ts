// API surface of /api/trade/adopt: validation, a sub without a refused entry
// is a 400, and the candidates listing.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { createManualTradeRoutes } from './manual-trade.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-adopt-route-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const POS = { accountId: 'acct1/eth', symbol: 'ETH-PERPETUAL', side: 'long', size: 981, entryPrice: 4468, markPrice: 4480 }

function fakeManager(positions: any[], placed: any[] = []) {
  const adapter = {
    getPositions: async () => positions,
    getAccounts: async () => [{ id: 'deribit:acct1/eth', accountId: 'acct1/eth' }],
    placeOrder: async (o: any) => {
      placed.push(o)
      return { orderId: `ord-${placed.length}`, status: 'pending' }
    },
    cancelOrder: async () => {},
  }
  return { getSession: async () => ({ status: 'connected', adapter }) } as any
}

const post = (app: ReturnType<typeof createManualTradeRoutes>, body: unknown) =>
  app.request('/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

function seedSub() {
  db.upsertSubscription({
    id: 'sub-acct1', signalBotId: 'bot-a', botName: 'Fault-Line ETH 4h', selectedMarkets: [], factor: 1,
    status: 'active', exchange: 'deribit', accountId: 'acct1/eth', accountKey: 'acct1',
  })
}

describe('POST /adopt', () => {
  it('validates the body', async () => {
    const app = createManualTradeRoutes(db, fakeManager([POS]))
    for (const body of [
      { symbol: 'ETH-PERPETUAL', signalId: 's' },
      { exchange: 'deribit', signalId: 's' },
      { exchange: 'deribit', symbol: 'ETH-PERPETUAL' },
      { exchange: 'deribit', symbol: 'ETH-PERPETUAL', signalId: 's', stopPrice: 'low' },
    ]) {
      const res = await post(app, body)
      expect(res.status).toBe(400)
    }
  })

  it('a sub without a refused entry on this position is a 400 and places nothing', async () => {
    seedSub()
    const placed: any[] = []
    const app = createManualTradeRoutes(db, fakeManager([POS], placed))
    // Unknown signal.
    let res = await post(app, { exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', signalId: 'nope' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/signal not found/)
    // The bot's entry was executed, not refused.
    db.recordSignal({ id: 'sig-ok', strategyId: 'x', symbol: 'ETH', action: 'buy', price: 4500, stopLoss: 4000, metadata: { signalBotId: 'bot-a' } })
    db.updateSignalStatus('sig-ok', 'executed')
    res = await post(app, { exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', signalId: 'sig-ok' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/already executed/)
    expect(placed).toHaveLength(0)
    expect(db.getSignalExecution('sig-ok')).toBeFalsy()
  })

  it('adopts a refused entry and lists it as a candidate first', async () => {
    seedSub()
    db.recordSignal({ id: 'sig-rej', strategyId: 'x', symbol: 'ETH', action: 'buy', price: 4500, stopLoss: 4000, metadata: { signalBotId: 'bot-a', exchange: 'deribit' } })
    db.updateSignalStatus('sig-rej', 'rejected', undefined, 'basis guard: 71 bps > 50')
    const placed: any[] = []
    const app = createManualTradeRoutes(db, fakeManager([POS], placed), {
      ackAdoptedEntry: async () => ({ ok: true, positionId: null }),
    })
    const list = await app.request('/adopt/candidates?exchange=deribit&symbol=ETH-PERPETUAL&accountId=acct1%2Feth&side=long')
    expect(list.status).toBe(200)
    expect(((await list.json()) as any).candidates.map((c: any) => c.signalId)).toEqual(['sig-rej'])

    const res = await post(app, { exchange: 'deribit', symbol: 'ETH-PERPETUAL', accountId: 'acct1/eth', signalId: 'sig-rej' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ signalId: 'sig-rej', qty: 981, avgPrice: 4468, stop: { price: 4000, slOrderId: 'ord-1', source: 'placed' } })
    expect(placed).toHaveLength(1)
    expect(db.getSignalExecution('sig-rej')).toMatchObject({ status: 'open', qty_opened: 981 })

    // Adopted → no longer a candidate.
    const after = await app.request('/adopt/candidates?exchange=deribit&symbol=ETH-PERPETUAL&accountId=acct1%2Feth')
    expect(((await after.json()) as any).candidates).toEqual([])
  })
})
