import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createOperationsRoutes } from './operations.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'

// POST /api/ops/fills/backfill-commissions against a real sqlite ledger and a
// fake connection per account key: dry run by default, apply on request,
// second apply is a no-op.

let dir: string
let db: KaiBotDatabase
let app: Hono
let sessionsAsked: Array<[string, string, string | undefined]>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-ops-backfill-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  sessionsAsked = []
  const adapter = {
    name: 'tradestation',
    getOrderStatus: async (orderId: string) => ({ orderId, state: 'filled' as const, filledQuantity: 1, averagePrice: 7700, commission: 0.62 }),
  }
  const exchangeManager = {
    getSession: async (userId: string, exchange: string, accountKey?: string) => {
      sessionsAsked.push([userId, exchange, accountKey])
      return exchange === 'tradestation' ? { adapter, status: 'connected' } : undefined
    },
  } as unknown as ExchangeManager
  app = new Hono()
  app.route('/api/ops', createOperationsRoutes(db, exchangeManager))

  db.insertSignalExecution({ signalId: 's1', symbol: 'MESU26', exchange: 'tradestation', direction: 'long', status: 'closed', qtyOpened: 1, qtyClosed: 1, accountId: '21084931' })
  db.insertSignalFill({ signalId: 's1', kind: 'entry', symbol: 'MESU26', side: 'buy', qty: 1, price: 7700, orderId: 'o-1', createdAtMs: 1 })
  db.insertSignalFill({ signalId: 's1', kind: 'exit', symbol: 'MESU26', side: 'sell', qty: 1, price: 7702, orderId: 'o-2', createdAtMs: 2 })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const post = async (body?: unknown, query = '') => {
  const res = await app.request(`/api/ops/fills/backfill-commissions${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as any
}

describe('POST /api/ops/fills/backfill-commissions', () => {
  it('dry runs without a body and leaves the ledger untouched', async () => {
    const report = await post()
    expect(report.dryRun).toBe(true)
    expect(report.fills.map((f: any) => f.status)).toEqual(['dry-run', 'dry-run'])
    expect(db.getSignalFills('s1').map((f) => f.commission)).toEqual([0, 0])
    // Asked the connection that holds the account (default: no key).
    expect(sessionsAsked[0]).toEqual(['default', 'tradestation', undefined])
  })

  it('applies on dryRun:false and is a no-op the second time', async () => {
    const first = await post({ dryRun: false })
    expect(first).toMatchObject({ dryRun: false, updated: 2, unchanged: 0 })
    expect(db.getSignalFills('s1').map((f) => f.commission)).toEqual([0.62, 0.62])
    const second = await post({ dryRun: false })
    expect(second).toMatchObject({ updated: 0, unchanged: 2 })
  })

  it('?dry=0 applies too', async () => {
    const report = await post(undefined, '?dry=0')
    expect(report.dryRun).toBe(false)
    expect(report.updated).toBe(2)
  })
})
