import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createSyntheticUsdRoutes } from './synthetic-usd.js'

let dir: string
let db: KaiBotDatabase
let app: Hono

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-synthetic-route-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  app = new Hono()
  // GET routes never touch the exchange manager (only mint/scale/close do).
  app.route('/api/synthetic-usd', createSyntheticUsdRoutes(db, {} as never))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// Regression (delta review 2026-07-08): the page only kept mutations set after an
// action performed this session, so history was empty on load and autonomous
// auto_rebalance orders never showed. The frontend now fetches GET /:id on mount;
// this locks that the endpoint returns the full history — including auto_rebalance
// rows with a timestamp.
describe('GET /api/synthetic-usd/:id', () => {
  it('returns the position plus its full mutation history, incl. auto_rebalance', async () => {
    db.insertSyntheticUsdPosition({
      id: 'p1',
      exchange: 'deribit',
      account_id: 'btc',
      symbol: 'BTC-PERPETUAL',
      target_usd: 10000,
      holdings_basis_usd: 20000,
      leverage: 0.5,
      short_size: 10000,
      leverage_cap: 2,
    })
    db.insertSyntheticUsdMutation({
      position_id: 'p1',
      kind: 'mint',
      target_usd_before: 0,
      target_usd_after: 10000,
      short_size_before: 0,
      short_size_after: 10000,
    })
    db.insertSyntheticUsdMutation({
      position_id: 'p1',
      kind: 'auto_rebalance',
      target_usd_before: 10000,
      target_usd_after: 12000,
      short_size_before: 10000,
      short_size_after: 12000,
      order_side: 'sell',
      order_qty: 2000,
    })

    const res = await app.request('/api/synthetic-usd/p1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      position: { id: string }
      mutations: Array<{ kind: string; created_at: number }>
    }
    expect(body.position.id).toBe('p1')
    expect(body.mutations).toHaveLength(2)
    const auto = body.mutations.find((m) => m.kind === 'auto_rebalance')
    expect(auto).toBeDefined()
    expect(typeof auto!.created_at).toBe('number')
  })

  it('404s for an unknown id', async () => {
    const res = await app.request('/api/synthetic-usd/nope')
    expect(res.status).toBe(404)
  })
})

// The list endpoint must surface the global loop gate so the UI can disable the
// per-position auto-rebalance switch when the env var is off.
describe('GET /api/synthetic-usd', () => {
  it('surfaces the rebalanceEnabled gate flag', async () => {
    const res = await app.request('/api/synthetic-usd')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rebalanceEnabled: boolean }
    expect(typeof body.rebalanceEnabled).toBe('boolean')
  })
})

// Armed (dynamic) synthetic: list/detail carry the computed `armed` view and
// the arm/arm-update/disarm routes drive the guard without touching a venue.
describe('armed synthetic routes', () => {
  it('lists armed rows with the planned floor and disarms them', async () => {
    db.setHoldingsBasis('manual:cold', 200_000, true)
    const arm = await app.request('/api/synthetic-usd/arm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exchange: 'paper', accountId: 'paper', symbol: 'BTC-X',
        triggerPrice: 90_000, holdingsCoin: 2, recoveryPct: 5, trailPct: 10,
      }),
    })
    expect(arm.status).toBe(200)
    const armed = (await arm.json()) as any
    expect(armed.position.status).toBe('armed')
    expect(armed.position.armed.protectedUsd).toBe(180_000)
    expect(armed.position.armed.protection).toBe('planned')
    expect(armed.mutations.map((m: any) => m.kind)).toEqual(['arm'])

    const list = (await (await app.request('/api/synthetic-usd')).json()) as any
    expect(list.positions).toHaveLength(1)
    expect(list.positions[0].armed.triggerPrice).toBe(90_000)
    expect(list.positions[0].sizingBasis).toBeNull()

    // Flag the armed row: it becomes the sizing basis on its planned floor.
    const fb = await app.request(`/api/synthetic-usd/${armed.position.id}/factor-basis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(fb.status).toBe(200)
    expect(((await fb.json()) as any).position.sizingBasis).toEqual({ usd: 180_000, kind: 'armed' })

    const upd = await app.request(`/api/synthetic-usd/${armed.position.id}/arm-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggerPrice: 95_000 }),
    })
    expect(((await upd.json()) as any).position.armed.protectedUsd).toBe(190_000)

    const bad = await app.request(`/api/synthetic-usd/${armed.position.id}/arm-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trailPct: 5, trailAbs: 10 }),
    })
    expect(bad.status).toBe(400)

    const dis = await app.request(`/api/synthetic-usd/${armed.position.id}/disarm`, { method: 'POST' })
    expect(((await dis.json()) as any).position.status).toBe('closed')
    expect((((await (await app.request('/api/synthetic-usd')).json()) as any).positions)).toHaveLength(0)
  })

  it('rejects an arm without a trigger', async () => {
    const res = await app.request('/api/synthetic-usd/arm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange: 'paper', accountId: 'paper', symbol: 'BTC-X' }),
    })
    expect(res.status).toBe(400)
  })
})
