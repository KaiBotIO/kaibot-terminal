import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createOperationsRoutes } from './operations.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'
import { clearMarks, recordMarks } from '../services/mark-cache.js'

// GET /api/ops/executions/:id carries the last cached mark, never a venue call.

let dir: string
let db: KaiBotDatabase

// Any adapter access would throw: the route must not reach the venue.
const noVenue = new Proxy({}, { get: () => { throw new Error('venue touched') } }) as ExchangeManager

const get = (id: string) => {
  const a = new Hono()
  a.route('/api/ops', createOperationsRoutes(db, noVenue))
  return a.request(`/api/ops/executions/${id}`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-ops-exec-mark-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  clearMarks()
  db.insertSignalExecution({ signalId: 'sig-mgc', symbol: 'MGCZ26', exchange: 'tradestation', direction: 'long', status: 'open', qtyOpened: 1, accountId: '21084931' })
  db.insertSignalFill({ signalId: 'sig-mgc', kind: 'entry', symbol: 'MGCZ26', side: 'buy', qty: 1, price: 4102.3 })
})
afterEach(() => {
  clearMarks()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('/api/ops/executions/:id mark', () => {
  it('sends the mark of the last position fetch', async () => {
    recordMarks('tradestation', [{ symbol: 'MGCZ26', accountId: '21084931', markPrice: 4138.7 }], Date.now() - 5_000)
    const res = await get('sig-mgc')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.markPrice).toBe(4138.7)
    expect(body.markAt).toBeGreaterThan(0)
    expect(body.pnl.multiplier).toBe(10)
  })

  it('is null without a cached mark', async () => {
    const body = (await (await get('sig-mgc')).json()) as any
    expect(body.markPrice).toBeNull()
    expect(body.markAt).toBeNull()
  })

  it('is null once the cached mark is stale', async () => {
    recordMarks('tradestation', [{ symbol: 'MGCZ26', accountId: '21084931', markPrice: 4138.7 }], Date.now() - 11 * 60_000)
    expect(((await (await get('sig-mgc')).json()) as any).markPrice).toBeNull()
  })
})
