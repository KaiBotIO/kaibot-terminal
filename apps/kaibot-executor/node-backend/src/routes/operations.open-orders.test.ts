// GET /api/ops/open-orders: venue resting orders of one connection's account
// next to the local bracket book, so a stop's existence can be verified.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { createOperationsRoutes } from './operations.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-open-orders-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function manager(byKey: Record<string, any>) {
  const keys: Array<string | undefined> = []
  return {
    keys,
    getSession: async (_u: string, exchangeName: string, key?: string) => {
      keys.push(key)
      const adapter = byKey[key ?? 'default']
      return adapter ? { adapter, status: 'connected', exchangeName } : null
    },
  } as any
}

const stop = (orderId: string, triggerPrice: number) => ({
  orderId, symbol: 'ETH-PERPETUAL', side: 'sell', type: 'stop_market', amount: 981, price: null,
  triggerPrice, reduceOnly: true, label: 'kaibot-sl', state: 'untriggered', createdAtMs: 1, raw: { secret: 'x' },
})

describe('GET /open-orders', () => {
  it('asks the connection of the given account and marks which venue orders the local book tracks', async () => {
    const acct1 = { getOpenOrders: async (ctx?: { symbol?: string }) => [stop('ETH-SLTS-7976385', 4300), stop('ETH-SLTS-8019526', 2635.59)].filter((o) => !ctx?.symbol || o.symbol === ctx.symbol) }
    const dflt = { getOpenOrders: async () => [stop('ETH-SLTS-7976384', 4200)] }
    const m = manager({ default: dflt, acct1 })
    db.upsertBracketPair({ signalId: 'sig-a', exchange: 'deribit', accountId: 'acct1/eth', slOrderId: 'ETH-SLTS-7976384' })
    db.upsertBracketPair({ signalId: 'manual:x', exchange: 'deribit', accountId: 'eth', slOrderId: 'ETH-SLTS-7976384' })
    db.insertSignalExecution({ signalId: 'sig-a', symbol: 'ETH-PERPETUAL', exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: 981, accountId: 'acct1/eth' })
    db.upsertServerExitState({ positionId: 'pos-a', entrySignalId: 'sig-a', exchange: 'deribit', symbol: 'ETH-PERPETUAL', direction: 'long', currentStop: 2635.59, slOrderId: 'ETH-SLTS-8019526' })

    const app = createOperationsRoutes(db, m)
    const res = await app.request('/open-orders?exchange=deribit&accountId=acct1%2Feth&symbol=ETH-PERPETUAL')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(m.keys).toEqual(['acct1'])
    expect(body.connection).toBe('acct1')
    expect(body.venue.map((o: any) => [o.orderId, o.tracked])).toEqual([
      ['ETH-SLTS-7976385', false],
      ['ETH-SLTS-8019526', true],
    ])
    expect(body.venue[0].raw).toBeUndefined()
    // The acct1 bracket row claims 7976384, which this account does not hold.
    const local = body.local as Array<{ source: string; signalId: string; orderId: string; atVenue: boolean; accountId: string | null }>
    expect(local).toContainEqual({ source: 'bracket_pairs', signalId: 'sig-a', orderId: 'ETH-SLTS-7976384', accountId: 'acct1/eth', atVenue: false })
    expect(local).toContainEqual({ source: 'server_exit_state', signalId: 'sig-a', orderId: 'ETH-SLTS-8019526', accountId: 'acct1/eth', atVenue: true })
    expect(local.find((l) => l.signalId === 'manual:x')).toBeUndefined() // another account's row
  })

  it('400 without exchange, when not connected, or when the venue has no open-orders API', async () => {
    const app = createOperationsRoutes(db, manager({ default: {} }))
    expect((await app.request('/open-orders')).status).toBe(400)
    expect((await app.request('/open-orders?exchange=deribit&accountId=acct9%2Feth')).status).toBe(400)
    const res = await app.request('/open-orders?exchange=deribit')
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/does not expose open orders/)
  })
})
