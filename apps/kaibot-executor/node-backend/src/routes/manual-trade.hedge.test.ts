// API validation + happy path for /api/trade/hedge (edge hedge guard surface).

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KaiBotDatabase } from '../storage/database.js'
import { createManualTradeRoutes } from './manual-trade.js'

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-hedge-route-test-'))
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
  accountId: 'acct-1', symbol: 'ETH-MAIN', side: 'long',
  size: 2, entryPrice: 2000, markPrice: 2000,
}

const post = (app: ReturnType<typeof createManualTradeRoutes>, body: unknown) =>
  app.request('/hedge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /hedge', () => {
  it('rejects a bad or missing action', async () => {
    const app = createManualTradeRoutes(db, fakeManager([LONG_POS]))
    for (const action of [undefined, 'open', 'attach']) {
      const res = await post(app, { action, exchange: 'paper', symbol: 'ETH-MAIN' })
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error).toMatch(/action must be one of/)
    }
  })

  it('rejects missing exchange/symbol, bad enums and non-finite numbers', async () => {
    const app = createManualTradeRoutes(db, fakeManager([LONG_POS]))
    let res = await post(app, { action: 'arm', symbol: 'ETH-MAIN', triggerPrice: 1900 })
    expect(res.status).toBe(400)
    res = await post(app, {
      action: 'arm', exchange: 'paper', symbol: 'ETH-MAIN', triggerPrice: 1900, sizeMode: 'native',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/sizeMode/)
    res = await post(app, {
      action: 'arm', exchange: 'paper', symbol: 'ETH-MAIN', triggerPrice: 1900, onMainClose: 'freeze',
    })
    expect(res.status).toBe(400)
    res = await post(app, {
      action: 'arm', exchange: 'paper', symbol: 'ETH-MAIN', triggerPrice: 'soon',
    })
    expect(res.status).toBe(400)
    res = await post(app, { action: 'arm', exchange: 'paper', symbol: 'ETH-MAIN' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/triggerPrice required/)
  })

  it('refuses a same-instrument hedge (netting) as a service-level 400', async () => {
    const app = createManualTradeRoutes(db, fakeManager([LONG_POS]))
    const res = await post(app, {
      action: 'arm', exchange: 'paper', symbol: 'ETH-MAIN', triggerPrice: 1900, hedgeSymbol: 'ETH-MAIN',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/must differ/)
  })

  it('arms, lists, updates and disarms through the route', async () => {
    const app = createManualTradeRoutes(db, fakeManager([LONG_POS]))
    let res = await post(app, {
      action: 'arm', exchange: 'paper', symbol: 'ETH-MAIN', triggerPrice: 1900, hedgeSymbol: 'ETH-HEDGE',
    })
    expect(res.status).toBe(200)
    const armed = (await res.json()) as any
    expect(armed.status).toBe('armed')
    expect(armed.hedgeSymbol).toBe('ETH-HEDGE')

    const listRes = await app.request('/hedge')
    expect(listRes.status).toBe(200)
    expect(((await listRes.json()) as any).hedges.length).toBe(1)

    res = await post(app, {
      action: 'update', exchange: 'paper', symbol: 'ETH-MAIN', recoveryPrice: 1990,
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).recoveryPrice).toBe(1990)

    res = await post(app, { action: 'disarm', exchange: 'paper', symbol: 'ETH-MAIN' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).status).toBe('closed')
  })

  it("close without an open hedge is a 400 ('no open hedge')", async () => {
    const app = createManualTradeRoutes(db, fakeManager([LONG_POS]))
    await post(app, {
      action: 'arm', exchange: 'paper', symbol: 'ETH-MAIN', triggerPrice: 1900, hedgeSymbol: 'ETH-HEDGE',
    })
    const res = await post(app, { action: 'close', exchange: 'paper', symbol: 'ETH-MAIN' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/no open hedge/)
  })
})
