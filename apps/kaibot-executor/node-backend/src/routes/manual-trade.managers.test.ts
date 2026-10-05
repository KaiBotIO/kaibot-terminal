// API validation for /api/trade/managers (F2 attach surface).

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { createManualTradeRoutes } from './manual-trade.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-managers-route-test-'))
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
  accountId: 'acct-1', symbol: 'BTC-PERPETUAL', side: 'long',
  size: 2, entryPrice: 100, markPrice: 105,
}

const post = (app: ReturnType<typeof createManualTradeRoutes>, body: unknown) =>
  app.request('/managers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /managers validation', () => {
  it('rejects a bad or missing action', async () => {
    const app = createManualTradeRoutes(db, fakeManager([LONG_POS]))
    for (const action of [undefined, 'arm', 'delete']) {
      const res = await post(app, { action, exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'tp-ladder' })
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error).toMatch(/action must be one of/)
    }
  })

  it('rejects missing exchange/symbol/managerId and non-object params', async () => {
    const app = createManualTradeRoutes(db, fakeManager([LONG_POS]))
    let res = await post(app, { action: 'attach', symbol: 'BTC-PERPETUAL', managerId: 'tp-ladder' })
    expect(res.status).toBe(400)
    res = await post(app, { action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/managerId required/)
    res = await post(app, {
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'tp-ladder', params: [1, 2],
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/params must be an object/)
  })

  it('surfaces allowlist + param-schema errors from the service as 400s', async () => {
    const app = createManualTradeRoutes(db, fakeManager([LONG_POS]))
    let res = await post(app, {
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'hedge-mirror',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/non-attachable/)
    res = await post(app, {
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL', managerId: 'tp-ladder', params: {},
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/either explicit prices or a target/)
  })

  it('attach happy path returns the managed-position view; GET lists it', async () => {
    const app = createManualTradeRoutes(db, fakeManager([LONG_POS]))
    const res = await post(app, {
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'risk-guard', params: { globalStopPrice: 90 },
    })
    expect(res.status).toBe(200)
    const view = (await res.json()) as any
    expect(view.key).toBe('pos:deribit:acct-1:BTC-PERPETUAL')
    expect(view.managers[0].managerId).toBe('risk-guard')
    expect(view.managers[0].params).toEqual({ globalStopPrice: 90 })

    const listRes = await app.request('/managers')
    expect(listRes.status).toBe(200)
    const { positions } = (await listRes.json()) as any
    expect(positions).toHaveLength(1)
    expect(positions[0].managers).toHaveLength(1)
  })

  it('protective-direction violations come back as 400s', async () => {
    const app = createManualTradeRoutes(db, fakeManager([LONG_POS]))
    const res = await post(app, {
      action: 'attach', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      managerId: 'risk-guard', params: { globalStopPrice: 120 },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/below the current price/)
  })
})
