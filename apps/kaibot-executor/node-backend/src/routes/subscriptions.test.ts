import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Hono } from 'hono'
import { KaiBotDatabase } from '../storage/database.js'
import { createSubscriptionRoutes } from './subscriptions.js'

let dir: string
let db: KaiBotDatabase
let app: Hono

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-subs-route-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
  app = new Hono()
  app.route('/api/subscriptions', createSubscriptionRoutes(db))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// Regression (delta review 2026-07-08): sizeUnit is persisted and drives the live
// sizing path, but the GET endpoints dropped it, so the edit view could never
// show or round-trip the current unit. Both list and detail must return it.
describe('subscriptions sizeUnit round-trip', () => {
  it('GET / returns the persisted size_unit', async () => {
    db.upsertSubscription({ id: 's-usd', signalBotId: 'bot1', factor: 1, exchange: 'deribit', sizeUnit: 'usd' })
    db.upsertSubscription({ id: 's-native', signalBotId: 'bot2', factor: 1, exchange: 'deribit' })

    const res = await app.request('/api/subscriptions')
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{ id: string; sizeUnit: string }>
    expect(rows.find((r) => r.id === 's-usd')?.sizeUnit).toBe('usd')
    // Unset defaults to the effective 'native'.
    expect(rows.find((r) => r.id === 's-native')?.sizeUnit).toBe('native')
  })

  it('GET /:id returns the persisted size_unit', async () => {
    db.upsertSubscription({ id: 's1', signalBotId: 'bot1', factor: 1, exchange: 'deribit', sizeUnit: 'usd' })

    const res = await app.request('/api/subscriptions/s1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { subscription: { sizeUnit: string } }
    expect(body.subscription.sizeUnit).toBe('usd')
  })
})
