import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createOperationsRoutes } from './operations.js'
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js'
import { PANIC_CLOSE_REPAIR_20261006 as C } from '../services/repair-panic-close-20261006.js'

// POST /api/ops/repair/panic-close-20261006 against a real sqlite book shaped
// like the live one after the 06/10 PANIC: two Deribit rides open with no exit
// fill, MES closed by the reconciler with a priceless exit fill (id 76).

let dir: string
let db: KaiBotDatabase
let reported: Array<{ positionId: string; price: number | null; timeMs: number; orderId?: string | null }>
let lookups: Array<{ orderId: string; ctx: any }>
type Reply = { sent: boolean; reason?: string } | 'throw'
let replies: Reply[]

const [BTC, ETH, MES] = C.positions as [any, any, any]

function appAs(role: 'admin' | 'viewer') {
  const exchangeManager = {
    getSession: async (_u: string, exchange: string) => {
      if (exchange !== 'deribit') return undefined
      return {
        status: 'connected',
        adapter: {
          getOrderStatus: async (orderId: string, ctx: any) => {
            lookups.push({ orderId, ctx })
            if (orderId === ETH.orderId) throw new Error('order not found')
            return {
              orderId,
              state: 'filled',
              filledQuantity: 2950,
              averagePrice: 85561.5,
              filledAtMs: C.incidentAtMs + 900,
              commission: 1.5,
              feeNative: 0.0000175,
              feeCurrency: 'BTC',
            }
          },
        },
      }
    },
  } as unknown as ExchangeManager
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('role' as never, role as never)
    await next()
  })
  app.route(
    '/api/ops',
    createOperationsRoutes(db, exchangeManager, undefined, undefined, async (positionId, fill) => {
      const reply = replies.shift() ?? { sent: true }
      if (reply === 'throw') throw new Error('server down')
      if (reply.sent) reported.push({ positionId, ...fill })
      return reply
    }),
  )
  return app
}

const post = (app: Hono, body?: unknown) =>
  app.request('/api/ops/repair/panic-close-20261006', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

function seedRide(p: any, symbol: string, account: string, qty: number, entry: number) {
  db.insertSignalExecution({ signalId: p.executionId, symbol, exchange: 'deribit', direction: 'long', status: 'open', qtyOpened: qty, qtyClosed: 0, accountId: account, createdAtMs: 1 })
  db.insertSignalFill({ signalId: p.executionId, kind: 'entry', symbol, side: 'buy', qty, price: entry, createdAtMs: 1 })
  db.run(
    `INSERT INTO server_exit_state (position_id, entry_signal_id, exchange, symbol, direction, sl_order_id, active, created_at, updated_at)
     VALUES (?, ?, 'deribit', ?, 'long', 'stop-1', 1, 1, 1)`,
    [p.positionId, p.executionId, symbol],
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-ops-panic-repair-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  reported = []
  lookups = []
  replies = []
  seedRide(BTC, 'BTC-PERPETUAL', 'btc', 2950, 86000)
  seedRide(ETH, 'ETH-PERPETUAL', 'eth', 6424, 2718.45)
  db.insertSignalExecution({ signalId: MES.executionId, symbol: 'MESZ26', exchange: 'tradestation', direction: 'long', status: 'closed', qtyOpened: 1, qtyClosed: 1, accountId: '21084931', createdAtMs: 1 })
  db.insertSignalFill({ signalId: MES.executionId, kind: 'entry', symbol: 'MESZ26', side: 'buy', qty: 1, price: 7900, createdAtMs: 1 })
  db.run(
    `INSERT INTO signal_fills (id, signal_id, kind, symbol, side, qty, price, commission, created_at)
     VALUES (76, ?, 'exit', 'MESZ26', 'sell', 1, NULL, 0, ?)`,
    [MES.executionId, C.incidentAtMs],
  )
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const exitFill = (signalId: string) => db.getSignalFills(signalId).find((f) => f.kind === 'exit')

describe('POST /repair/panic-close-20261006', () => {
  it('dry run by default: looks up prices, writes nothing, shows the fan-out family', async () => {
    db.run(
      `INSERT INTO server_exit_state (position_id, entry_signal_id, exchange, symbol, direction, active, created_at, updated_at)
       VALUES (?, 'other-sig', 'deribit', 'BTC-PERPETUAL', 'long', 1, 1, 1)`,
      [`${BTC.positionId}~acct2`],
    )
    const res = await post(appAs('admin'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.dryRun).toBe(true)
    expect(body.items.map((i: any) => [i.local.status, i.server.status])).toEqual([
      ['would-book', 'would-report'],
      ['would-book', 'would-report'],
      ['would-book', 'would-report'],
    ])
    expect(body.items[0].familyStates).toEqual([{ positionId: `${BTC.positionId}~acct2`, entrySignalId: 'other-sig', active: true }])
    expect(lookups[0]).toEqual({ orderId: BTC.orderId, ctx: expect.objectContaining({ accountId: 'btc', symbol: 'BTC-PERPETUAL' }) })
    expect(reported).toHaveLength(0)
    expect(exitFill(BTC.executionId)).toBeUndefined()
    expect(db.getSignalExecution(BTC.executionId)?.status).toBe('open')
    expect(exitFill(MES.executionId)?.price).toBeNull()
  })

  it('books the local exits, reports them, and a rerun changes nothing', async () => {
    const app = appAs('admin')
    const body = (await (await post(app, { dryRun: false })).json()) as any
    expect(body.ok).toBe(true)
    expect(body.items.map((i: any) => [i.price, i.priceEstimate, i.local.status, i.server.status])).toEqual([
      [85561.5, false, 'booked', 'reported'],
      [2695.85, true, 'booked', 'reported'],
      [7877, true, 'booked', 'reported'],
    ])

    const btc = exitFill(BTC.executionId)!
    expect(btc).toMatchObject({ qty: 2950, price: 85561.5, side: 'sell', order_id: BTC.orderId, commission: 1.5, created_at: C.incidentAtMs + 900 })
    expect(db.getSignalExecution(BTC.executionId)).toMatchObject({ status: 'closed', qty_closed: 2950 })
    const eth = exitFill(ETH.executionId)!
    expect(eth).toMatchObject({ qty: 6424, price: 2695.85, order_id: ETH.orderId, created_at: C.incidentAtMs })
    expect(db.getSignalExecution(ETH.executionId)).toMatchObject({ status: 'closed', qty_closed: 6424 })
    expect(exitFill(MES.executionId)?.price).toBe(7877)
    expect(db.getServerExitState(BTC.positionId)?.active).toBeFalsy()
    expect(db.getServerExitState(ETH.positionId)?.active).toBeFalsy()
    expect(reported.map((r) => r.positionId)).toEqual([BTC.positionId, ETH.positionId, MES.positionId])

    const again = (await (await post(app, { dryRun: false })).json()) as any
    expect(again.items.map((i: any) => [i.local.status, i.server.status])).toEqual([
      ['skipped', 'skipped'],
      ['skipped', 'skipped'],
      ['skipped', 'skipped'],
    ])
    expect(db.getSignalFills(BTC.executionId).filter((f) => f.kind === 'exit')).toHaveLength(1)
    expect(reported).toHaveLength(3)
  })

  it('a report the server did not confirm is not marked reported and stays retryable', async () => {
    const app = appAs('admin')
    replies = [{ sent: false, reason: 'no api url' }, 'throw']
    const first = await post(app, { dryRun: false })
    expect(first.status).toBe(500)
    const body = (await first.json()) as any
    expect(body.items.map((i: any) => [i.local.status, i.server.status])).toEqual([
      ['booked', 'error'],
      ['booked', 'error'],
      ['booked', 'reported'],
    ])
    expect(body.items[0].server.detail).toBe('no api url')
    // still active: nothing confirmed it
    expect(db.getServerExitState(BTC.positionId)?.active).toBeTruthy()

    const second = (await (await post(app, { dryRun: false })).json()) as any
    expect(second.items.map((i: any) => [i.local.status, i.server.status])).toEqual([
      ['skipped', 'reported'],
      ['skipped', 'reported'],
      ['skipped', 'skipped'],
    ])
  })

  it('refuses a viewer', async () => {
    const res = await post(appAs('viewer'), { dryRun: false })
    expect(res.status).toBe(403)
    expect(reported).toHaveLength(0)
    expect(exitFill(BTC.executionId)).toBeUndefined()
  })
})
